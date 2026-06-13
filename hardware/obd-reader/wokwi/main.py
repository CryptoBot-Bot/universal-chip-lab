# OBD-II CAN Reader — Raspberry Pi Pico firmware (MicroPython)
# =============================================================================
# Regulated battery-voltage telemetry over USB serial, plus the CAN wiring map.
#
# Hardware (see ../BUILD.md for the full solder guide):
#   GP28 / ADC2   battery-sense divider  R1=47k (top) / R2=10k (bottom)
#   GP25          onboard LED            heartbeat (1 Hz)
#   GP4  / GP5    CAN RX / TX  -> SN65HVD230   (real bus = PIO, see CAN section)
#
# In the Wokwi sim the obd2 chip drives ~12.6 V onto the divider, so GP28 reads
# ~2.1 V and the telemetry below prints a live battery voltage. Edit the
# chip-obd2 part's "battery_voltage" attr in diagram.json to sweep it
# (12.6 = ignition, 14.4 = alternator charging, 11.5 = weak battery).
# =============================================================================

from machine import ADC, Pin, UART
import time

# ---- Calibration ------------------------------------------------------------
# Divider ratio = (R1 + R2) / R2 = (47000 + 10000) / 10000 = 5.7
# On the bench: feed a known 12.00 V, read the printed value, and nudge RATIO
# until they match (this absorbs resistor tolerance). VREF is the Pico 3V3 rail.
VREF = 3.3
RATIO = 5.7
ADC_MAX = 65535

# ---- Thresholds (12 V lead-acid) -------------------------------------------
V_LOW = 11.8        # below this: weak / discharged battery
V_CHARGING = 13.2   # at/above this: alternator is running

# ---- Pins -------------------------------------------------------------------
adc = ADC(2)              # GP28 = ADC2 = battery-sense node
led = Pin(25, Pin.OUT)    # onboard heartbeat LED

# ---- Buses (wiring reference; live bus data is real-hardware only) ----------
# HS-CAN  (powertrain, 500 kbit/s)  GP5=TX  GP4=RX  -> SN65HVD230 -> OBD 6 / 14
# MS-CAN  (body,       125 kbit/s)  GP7=TX  GP6=RX  -> SN65HVD230 -> OBD 3 / 11
# K-line  (KWP2000 / ISO 9141)      GP8=TX  GP9=RX  -> L9637D     -> OBD 7
HS_CAN_TX, HS_CAN_RX = 5, 4
MS_CAN_TX, MS_CAN_RX = 7, 6

# K-line is a plain UART (this DOES initialise in the sim; there is just no bus
# to talk to). 10400 baud is the KWP2000 fast-init rate.
kline = UART(1, baudrate=10400, tx=Pin(8), rx=Pin(9))


def read_battery(samples=16):
    """Median-of-samples ADC read -> battery volts. Median rejects spikes."""
    vals = []
    for _ in range(samples):
        vals.append(adc.read_u16())
        time.sleep_ms(1)
    vals.sort()
    raw = vals[len(vals) // 2]            # median sample
    v_adc = raw / ADC_MAX * VREF          # volts at GP28
    return v_adc * RATIO                  # scaled back to the battery


def classify(vb):
    if vb < V_LOW:
        return "LOW"
    if vb >= V_CHARGING:
        return "CHARGING"
    return "OK"


# ---- Main loop --------------------------------------------------------------
print("# OBD-II CAN Reader online")
print("# fields: ms,battery_v,state,vmin,vmax")

vmin = 99.0
vmax = 0.0
t0 = time.ticks_ms()

while True:
    led.toggle()
    vb = read_battery()
    vmin = min(vmin, vb)
    vmax = max(vmax, vb)
    ms = time.ticks_diff(time.ticks_ms(), t0)
    print("{:d},{:.2f},{},{:.2f},{:.2f}".format(ms, vb, classify(vb), vmin, vmax))
    time.sleep_ms(900)


# =============================================================================
# CAN bus — real hardware only
# -----------------------------------------------------------------------------
# The RP2040 has NO hardware CAN controller, so CAN is done in software over
# PIO into the SN65HVD230 at 500 kbit/s (OBD-II high-speed CAN). The transceiver
# in this Wokwi project is a passive visual model — there is no live bus to read
# in simulation, which is why the loop above focuses on the battery sense that
# *does* simulate. The wiring is still drawn so you solder the right pins.
#
# Proven real-hardware path:
#   * MicroPython build that includes the `can2040` PIO CAN driver, OR
#   * Arduino / C firmware using the can2040 library (Kevin O'Connor).
#
# Reference pinout for the real bus:
#   CAN_TX = Pin(5)    # -> SN65HVD230 D  (driver input)
#   CAN_RX = Pin(4)    # <- SN65HVD230 R  (receiver output)
#   bitrate = 500_000  # OBD-II high-speed CAN
#
# No 120 Ohm terminator when tapping a car — the bus is already terminated.
# =============================================================================
