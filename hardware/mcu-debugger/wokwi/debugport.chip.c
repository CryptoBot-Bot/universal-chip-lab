// Target debug port = the connectors that touch the ECU's MCU. One block that
// fans out to the standard headers (BUILD.md has the per-connector pinouts):
//   * ARM Cortex Debug 10-pin (1.27 mm) — SWD + JTAG
//   * Legacy JTAG 20-pin (2.54 mm)
//   * BDM 6-pin (Freescale/NXP S12/HC12) — single-wire BKGD
//   * BSL / UART header — bootloader (boot pin + TX/RX)
//
//   VTREF       target IO voltage (sensed -> sets shifter HV side). DO NOT power
//               the target from here unless you know it is safe.
//   TCK/TMS/TDI/TDO   JTAG ;  TMS=SWDIO, TCK=SWCLK for SWD ;  TDO=SWO
//   RESET       target nRESET
//   TRST_BKGD   JTAG nTRST  OR  BDM BKGD (jumper-selected — never both)
//   UART_TX/RX  serial bootloader
//   GND         common
//
// Passive visual placeholder. Every target line goes through a level shifter and
// a series resistor — see BUILD.md.
#include "wokwi-api.h"
void chip_init(void) {}
