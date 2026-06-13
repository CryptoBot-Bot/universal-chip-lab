# MCU Debugger — placeholder firmware (MicroPython)
# =============================================================================
# IMPORTANT: for real use you do NOT run MicroPython on the probe. You flash the
# Pico with a debug-probe firmware and drive it from a PC tool:
#   * SWD/JTAG (ARM Cortex):  official "debugprobe" UF2  -> OpenOCD / pyOCD (CMSIS-DAP)
#   * JTAG (wider targets):   "Free-DAP" (adds JTAG)     -> OpenOCD
#   * or skip the Pico and use an FT232H/FT2232H + OpenOCD for JTAG.
#
# This file is only here so the Wokwi sim has something to run: it blinks the LED
# and prints the pin map so you can eyeball the wiring. The actual register/flash
# reads happen over the debug firmware above. See ../BUILD.md.
#
# Probe pin map (LV side of the shifters):
#   GP2 TCK/SWCLK   GP3 TMS/SWDIO   GP4 TDI   GP5 TDO/SWO
#   GP6 nRESET      GP7 nTRST/BKGD  GP0 UART_TX   GP1 UART_RX
# =============================================================================

from machine import Pin
import time

led = Pin(25, Pin.OUT)
PINS = "GP2=TCK GP3=TMS GP4=TDI GP5=TDO GP6=RESET GP7=TRST/BKGD GP0=TX GP1=RX"

print("# MCU debugger interface board — wiring check")
print("#", PINS)
print("# flash 'debugprobe' (SWD/JTAG) and drive with OpenOCD for real reads")

while True:
    led.toggle()
    time.sleep_ms(500)
