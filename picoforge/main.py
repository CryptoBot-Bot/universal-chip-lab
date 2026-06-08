"""
PicoForge v1.1  -  Universal serial-memory programmer firmware (RP2040 / MicroPython)
Part of the Universal Chip Lab project.

Reads & writes SPI (25/95/W25Q), I2C (24Cxx) and Microwire (93Cxx) memory chips
at a safe 3.3 V, with an OLED, a 4-LED mode panel, a MODE button, an ACTION
button, an activity LED, a power LED and a buzzer. Speaks a tiny ASCII protocol
over USB so the desktop app (or you, in a serial monitor) can drive it.

Wokwi simulator: OLED + 4 mode LEDs + both buttons + buzzer + activity LED all
run. Type in the Serial Monitor:  PING  then  HELP.  Press MODE to cycle the
family (watch the LED move); press ACTION to do a quick read of the current mode.

Serial protocol (one command per line; replies start with OK or ERR):
    PING                -> OK PicoForge v1.1
    HELP                -> command list
    INFO                -> current mode
    MODE <0..3>         -> 0 SPI Flash | 1 SPI EEPROM | 2 I2C EEPROM | 3 Microwire
    ID                  -> JEDEC id (SPI modes)
    READ  <start> <len> -> hex bytes
    WRITE <start> <hex> -> write hex bytes
"""
import sys
import select
import time
from machine import Pin, I2C, SPI, PWM

import memchips

try:
    from ssd1306 import SSD1306_I2C
    HAVE_OLED = True
except ImportError:
    HAVE_OLED = False

FIRMWARE = "PicoForge v1.2"

# ---- pin map (see README.md / BUILD.md) ----
OLED_SDA, OLED_SCL = 8, 9                                # I2C0 -> OLED
SPI_SCK, SPI_MOSI, SPI_MISO, SPI_CS = 18, 19, 16, 17     # SPI0 -> 25/95/W25Q
I2C_SDA, I2C_SCL = 26, 27                                # I2C1 -> 24Cxx
MW_CS, MW_SK, MW_DI, MW_DO = 10, 11, 12, 13              # Microwire -> 93Cxx
MODE_LED_PINS = (2, 3, 4, 5)                             # one LED per family
ACT_LED = 20
BUZZER = 15
BTN_MODE = 22
BTN_ACTION = 21

MODES = ["SPI Flash", "SPI EEPROM", "I2C EEPROM", "Microwire"]


class PicoForge:
    def __init__(self):
        self.mode = 0
        self.status = "ready"

        self.mode_leds = [Pin(p, Pin.OUT) for p in MODE_LED_PINS]
        self.act = Pin(ACT_LED, Pin.OUT)
        try:
            self.hb = Pin("LED", Pin.OUT)     # Pico W onboard LED
        except Exception:
            self.hb = Pin(25, Pin.OUT)        # classic Pico onboard LED
        self.buzzer = PWM(Pin(BUZZER))
        self.buzzer.duty_u16(0)

        self.btn_mode = Pin(BTN_MODE, Pin.IN, Pin.PULL_UP)
        self.btn_action = Pin(BTN_ACTION, Pin.IN, Pin.PULL_UP)
        self._bm_prev = 1
        self._ba_prev = 1

        self.oled = None
        if HAVE_OLED:
            try:
                i2c = I2C(0, sda=Pin(OLED_SDA), scl=Pin(OLED_SCL), freq=400000)
                self.oled = SSD1306_I2C(128, 64, i2c)
            except Exception:
                self.oled = None

        self.poll = select.poll()
        self.poll.register(sys.stdin, select.POLLIN)
        self.refresh()

    # ---------------- UI ----------------
    def _set_mode_leds(self):
        for i, led in enumerate(self.mode_leds):
            led.value(1 if i == self.mode else 0)

    def refresh(self):
        self._set_mode_leds()
        if not self.oled:
            return
        o = self.oled
        o.fill(0)
        o.text("PicoForge", 0, 0)
        o.text("----------------", 0, 10)
        o.text(MODES[self.mode], 0, 24)
        o.text("3V3 safe", 0, 38)
        o.text(self.status[:16], 0, 52)
        o.show()

    def beep(self, freq=2000, ms=60):
        try:
            self.buzzer.freq(freq)
            self.buzzer.duty_u16(20000)
            time.sleep_ms(ms)
            self.buzzer.duty_u16(0)
        except Exception:
            pass

    def set_mode(self, m):
        self.mode = m % len(MODES)
        self.status = "ready"
        self.refresh()

    def cycle_mode(self):
        self.beep(1800, 40)
        self.set_mode(self.mode + 1)
        print("OK mode=%d %s" % (self.mode, MODES[self.mode]))

    # ------------- chip helpers (real hardware) -------------
    def _spi(self):
        return SPI(0, baudrate=2_000_000, polarity=0, phase=0,
                   sck=Pin(SPI_SCK), mosi=Pin(SPI_MOSI), miso=Pin(SPI_MISO))

    def chip_id(self):
        if self.mode in (0, 1):
            return memchips.SpiMem(self._spi(), Pin(SPI_CS, Pin.OUT)).jedec_id()
        return "n/a (SPI only)"

    def read(self, start, length):
        if self.mode == 0:
            return memchips.SpiMem(self._spi(), Pin(SPI_CS, Pin.OUT), addr_bytes=3).read(start, length)
        if self.mode == 1:
            return memchips.SpiMem(self._spi(), Pin(SPI_CS, Pin.OUT), addr_bytes=2).read(start, length)
        if self.mode == 2:
            i2c = I2C(1, sda=Pin(I2C_SDA), scl=Pin(I2C_SCL), freq=400000)
            return memchips.I2cEeprom(i2c).read(start, length)
        mw = memchips.Microwire(Pin(MW_CS, Pin.OUT), Pin(MW_SK, Pin.OUT),
                                Pin(MW_DI, Pin.OUT), Pin(MW_DO, Pin.IN))
        return mw.read(start, length)

    def write(self, start, data):
        if self.mode == 0:
            memchips.SpiMem(self._spi(), Pin(SPI_CS, Pin.OUT), addr_bytes=3).write(start, data)
        elif self.mode == 1:
            memchips.SpiMem(self._spi(), Pin(SPI_CS, Pin.OUT), addr_bytes=2).write(start, data)
        elif self.mode == 2:
            i2c = I2C(1, sda=Pin(I2C_SDA), scl=Pin(I2C_SCL), freq=400000)
            memchips.I2cEeprom(i2c).write(start, data)
        else:
            mw = memchips.Microwire(Pin(MW_CS, Pin.OUT), Pin(MW_SK, Pin.OUT),
                                    Pin(MW_DI, Pin.OUT), Pin(MW_DO, Pin.IN))
            mw.write(start, data)
        return len(data)

    def erase(self):
        # Flash must be erased to 0xFF before new data can be written. EEPROMs
        # (modes 1/2/3) are byte-writable, so erase is a no-op there.
        if self.mode == 0:
            memchips.SpiMem(self._spi(), Pin(SPI_CS, Pin.OUT), addr_bytes=3).erase_chip()
            return "chip"
        return "n/a (EEPROM is byte-writable)"

    def action(self):
        """ACTION button: quick 16-byte preview read of the current mode."""
        self.act.on()
        self.beep(1400, 35)
        try:
            data = self.read(0, 16)
            self.status = "rd %d ok" % len(data)
            print("OK " + bytes(data).hex())
        except Exception as e:
            self.status = "rd err"
            print("ERR " + str(e))
        self.refresh()
        self.act.off()

    # ------------- serial command handler -------------
    def handle(self, line):
        parts = line.strip().split()
        if not parts:
            return
        cmd = parts[0].upper()
        try:
            if cmd == "PING":
                print("OK " + FIRMWARE)
            elif cmd == "HELP":
                print("OK cmds: PING INFO MODE<0-3> ID READ<start><len> WRITE<start><hex> ERASE")
            elif cmd == "INFO":
                print("OK mode=%d %s | 3V3 safe" % (self.mode, MODES[self.mode]))
            elif cmd == "MODE":
                self.set_mode(int(parts[1]))
                print("OK mode=%d %s" % (self.mode, MODES[self.mode]))
            elif cmd == "ID":
                self.status = "id"; self.refresh()
                print("OK " + self.chip_id())
            elif cmd == "READ":
                data = self.read(int(parts[1]), int(parts[2]))
                self.status = "read %d" % len(data); self.refresh()
                print("OK " + bytes(data).hex())
            elif cmd == "WRITE":
                n = self.write(int(parts[1]), bytes.fromhex(parts[2]))
                self.status = "wrote %d" % n; self.refresh()
                print("OK wrote %d" % n)
            elif cmd == "ERASE":
                self.status = "erasing"; self.refresh()
                kind = self.erase()
                self.status = "erased"; self.refresh()
                print("OK erased %s" % kind)
            else:
                print("ERR unknown cmd (try HELP)")
        except Exception as e:
            self.status = "err"; self.refresh()
            print("ERR " + str(e))

    # ------------- main loop -------------
    def run(self):
        print(FIRMWARE + " ready. Type HELP and press Enter.")
        self.beep(2200, 30)
        last_hb = time.ticks_ms()
        while True:
            now = time.ticks_ms()
            if time.ticks_diff(now, last_hb) > 500:
                self.hb.toggle()
                last_hb = now

            bm = self.btn_mode.value()
            if bm == 0 and self._bm_prev == 1:
                self.cycle_mode()
                time.sleep_ms(150)
            self._bm_prev = bm

            ba = self.btn_action.value()
            if ba == 0 and self._ba_prev == 1:
                self.action()
                time.sleep_ms(150)
            self._ba_prev = ba

            if self.poll.poll(0):
                line = sys.stdin.readline()
                if line:
                    self.act.on()
                    self.handle(line)
                    self.act.off()

            time.sleep_ms(10)


PicoForge().run()
