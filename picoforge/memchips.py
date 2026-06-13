"""
PicoForge chip drivers (real hardware, 3.3 V buses).

These run on the physical Pico wired to a real chip. In the Wokwi simulator
there is no flash/EEPROM model, so READ/WRITE return junk or raise — that's
expected; the simulator is for the UI + wiring, the silicon is for the bench.

Each family is a small class with read()/write() in BYTES. We tune the exact
opcodes / address widths per chip on the bench together.
"""
import time

# ============================================================
# SPI  — 25xx / 95xx EEPROM and W25Q / MX25 NOR flash
# ============================================================
_RDID = 0x9F   # JEDEC ID (NOR flash; M95/25-EEPROM usually ignore this)
_READ = 0x03   # read data
_WREN = 0x06   # write enable
_RDSR = 0x05   # read status register
_WRSR = 0x01   # write status register (clears BP block-protect bits)
_PP = 0x02     # page program / byte write
_SE = 0x20     # sector erase (4 KB)
_CE = 0xC7     # chip erase (whole device -> 0xFF)


class SpiMem:
    def __init__(self, spi, cs, addr_bytes=3, page_size=256):
        self.spi = spi
        self.cs = cs
        self.addr_bytes = addr_bytes   # 1-3 depending on capacity
        self.page_size = page_size
        self.cs.value(1)

    def _sel(self):
        self.cs.value(0)

    def _desel(self):
        self.cs.value(1)

    def _addr(self, a):
        n = self.addr_bytes
        return bytes((a >> (8 * (n - 1 - i))) & 0xFF for i in range(n))

    def jedec_id(self):
        self._sel()
        self.spi.write(bytes([_RDID]))
        b = self.spi.read(3)
        self._desel()
        return " ".join("%02X" % x for x in b)

    def read(self, addr, length):
        self._sel()
        self.spi.write(bytes([_READ]) + self._addr(addr))
        data = self.spi.read(length)
        self._desel()
        return data

    def _wait_ready(self, timeout_ms=5000):
        end = time.ticks_add(time.ticks_ms(), timeout_ms)
        while time.ticks_diff(end, time.ticks_ms()) > 0:
            self._sel()
            self.spi.write(bytes([_RDSR]))
            sr = self.spi.read(1)[0]
            self._desel()
            if not (sr & 0x01):    # WIP bit clear
                return
            time.sleep_ms(1)
        raise OSError("write timeout (chip busy)")

    def write(self, addr, data):
        # Page-aware. For NOR flash the target sectors must already be erased.
        i = 0
        while i < len(data):
            off = (addr + i) % self.page_size
            chunk = min(self.page_size - off, len(data) - i)
            self._sel(); self.spi.write(bytes([_WREN])); self._desel()
            self._sel()
            self.spi.write(bytes([_PP]) + self._addr(addr + i) + data[i:i + chunk])
            self._desel()
            self._wait_ready()
            i += chunk
        return len(data)

    def write_status(self, value=0x00):
        # Clears block-protect (BP0/BP1) so the whole EEPROM array is writable.
        # WP# must be tied HIGH for this to take when WPEN is set.
        self._sel(); self.spi.write(bytes([_WREN])); self._desel()
        self._sel(); self.spi.write(bytes([_WRSR, value & 0xFF])); self._desel()
        self._wait_ready()

    def read_status(self):
        self._sel()
        self.spi.write(bytes([_RDSR]))
        sr = self.spi.read(1)[0]
        self._desel()
        return sr

    def fill(self, addr, length, value=0xFF):
        # "Erase" for an EEPROM = write a constant byte (0xFF by convention).
        # Reuses the page-aware write(), so it respects the chip's page size.
        return self.write(addr, bytes([value & 0xFF]) * length)

    def erase_chip(self, timeout_ms=120000):
        # Whole-device erase to 0xFF. Slow on big parts (4 MB ~ 20-60 s).
        self._sel(); self.spi.write(bytes([_WREN])); self._desel()
        self._sel(); self.spi.write(bytes([_CE])); self._desel()
        self._wait_ready(timeout_ms)
        return True

    def erase_sector(self, addr, timeout_ms=5000):
        self._sel(); self.spi.write(bytes([_WREN])); self._desel()
        self._sel(); self.spi.write(bytes([_SE]) + self._addr(addr)); self._desel()
        self._wait_ready(timeout_ms)
        return True


# ============================================================
# I2C  — 24Cxx EEPROM
# ============================================================
class I2cEeprom:
    def __init__(self, i2c, addr=0x50, addr_bytes=2, page_size=32):
        self.i2c = i2c
        self.addr = addr
        self.addr_bytes = addr_bytes   # 1 for <=24C16, 2 for 24C32+
        self.page_size = page_size

    def _a(self, a):
        n = self.addr_bytes
        return bytes((a >> (8 * (n - 1 - i))) & 0xFF for i in range(n))

    def read(self, addr, length):
        self.i2c.writeto(self.addr, self._a(addr))
        return self.i2c.readfrom(self.addr, length)

    def write(self, addr, data):
        i = 0
        while i < len(data):
            off = (addr + i) % self.page_size
            chunk = min(self.page_size - off, len(data) - i)
            self.i2c.writeto(self.addr, self._a(addr + i) + data[i:i + chunk])
            time.sleep_ms(6)   # tWR
            i += chunk
        return len(data)


# ============================================================
# Microwire  — 93Cxx EEPROM (bit-banged), x16 organisation
# ============================================================
class Microwire:
    """
    93Cxx in x16 (ORG tied HIGH). addr/length are in BYTES.
    addr_bits is the word-address width (e.g. 93C86 x16 -> 10).
    Starting point — we calibrate per chip on the bench.
    """
    def __init__(self, cs, sk, di, do, addr_bits=10):
        self.cs, self.sk, self.di, self.do = cs, sk, di, do
        self.addr_bits = addr_bits
        self.cs.value(0)
        self.sk.value(0)
        self.di.value(0)

    def _clk(self):
        self.sk.value(1); time.sleep_us(2)
        self.sk.value(0); time.sleep_us(2)

    def _send(self, value, bits):
        for i in range(bits - 1, -1, -1):
            self.di.value((value >> i) & 1)
            self._clk()

    def _read_word(self):
        v = 0
        for _ in range(16):
            self.sk.value(1); time.sleep_us(2)
            v = (v << 1) | (self.do.value() & 1)
            self.sk.value(0); time.sleep_us(2)
        return v

    def _frame(self, opcode2, addr):
        # CS high, start bit, 2-bit opcode, address bits (MSB first)
        self.cs.value(1)
        self._send(1, 1)
        self._send(opcode2, 2)
        self._send(addr, self.addr_bits)

    def read(self, addr, length):
        out = bytearray()
        word = addr // 2
        for w in range((length + 1) // 2):
            self._frame(0b10, word + w)      # READ
            val = self._read_word()
            self.cs.value(0)
            out.append(val & 0xFF)
            out.append((val >> 8) & 0xFF)
        return bytes(out[:length])

    def write_enable(self):
        self._frame(0b00, 0b11 << (self.addr_bits - 2))   # EWEN
        self.cs.value(0)

    def write_disable(self):
        self._frame(0b00, 0)                              # EWDS
        self.cs.value(0)

    def _wait_done(self):
        # after a write, raise CS; DO is low (busy) then high (ready)
        time.sleep_ms(1)
        self.cs.value(1)
        for _ in range(20000):
            if self.do.value():
                break
            time.sleep_us(50)
        self.cs.value(0)

    def write(self, addr, data):
        self.write_enable()
        word = addr // 2
        i = 0
        while i < len(data):
            lo = data[i]
            hi = data[i + 1] if i + 1 < len(data) else 0xFF
            self._frame(0b01, word)                       # WRITE
            self._send((hi << 8) | lo, 16)                # 16 data bits, MSB first
            self.cs.value(0)
            self._wait_done()
            word += 1
            i += 2
        self.write_disable()
        return len(data)
