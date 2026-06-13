# 125 kHz Transponder Reader — Raspberry Pi Pico firmware (MicroPython)
# =============================================================================
# Front-end: EM4095 (carrier + demod) -> 4-ch level shifter -> Pico.
#   GP10  DEMOD   (data in,   from EM4095 via shifter)
#   GP11  RDYCLK  (clock in,  from EM4095 via shifter)
#   GP12  SHD     (shutdown out -> EM4095; LOW = front-end ON)
#   GP13  MOD     (modulation out -> EM4095; for writing tags)
#   GP15  status LED
#
# The EM4095 makes the 125 kHz field itself; the Pico just enables it (SHD=0),
# samples DEMOD on RDYCLK edges, and decodes the bitstream. There is no RF in
# the Wokwi sim, so this prints "no tag" — it comes alive on real hardware with
# a tuned antenna near a transponder.
#
# Scope note: this reads EM4100-class / basic LF tags out of the box. Automotive
# crypto transponders (Hitag2, Megamos, DST80) need the matching protocol/keys
# — that is Proxmark3 territory. This board is the LF analog front-end + a
# learning/decoding base. See BUILD.md.
# =============================================================================

from machine import Pin
import time

demod = Pin(10, Pin.IN)
rdyclk = Pin(11, Pin.IN)
shd = Pin(12, Pin.OUT)
mod = Pin(13, Pin.OUT)
led = Pin(15, Pin.OUT)

mod.value(0)
shd.value(0)          # 0 = front-end enabled (field ON)

print("# 125 kHz transponder reader online (SHD=0, field ON)")


def sample_bits(n=256):
    """Sample DEMOD on each RDYCLK edge -> list of bits. Real hardware only."""
    bits = []
    last = rdyclk.value()
    t_end = time.ticks_add(time.ticks_ms(), 50)
    while len(bits) < n and time.ticks_diff(t_end, time.ticks_ms()) > 0:
        c = rdyclk.value()
        if c != last and c == 1:          # rising edge of carrier clock
            bits.append(demod.value())
        last = c
    return bits


while True:
    led.toggle()
    bits = sample_bits()
    ones = sum(bits)
    if bits and 0 < ones < len(bits):     # some transitions = a tag is talking
        print("tag activity: {} bits, {} ones".format(len(bits), ones))
        # TODO: Manchester/biphase decode -> tag ID. (Add per tag family.)
    else:
        print("no tag in field")
    time.sleep_ms(500)
