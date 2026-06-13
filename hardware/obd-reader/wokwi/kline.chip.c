// K-line front-end (black box) = L9637D ISO-9141/KWP2000 transceiver + 510 Ohm
// pull-up to 12 V + series protection diode + a 3.3 V level shifter on TX/RX.
// Modelled as one chip the same way carprotect bundles the protection discretes.
//
//   K    = the single bidirectional bus wire        -> OBD pin 7
//   V12  = protected 12 V rail (L9637D Vs + pull-up) <- carprotect OUT
//   VCC  = 3.3 V logic reference (level-shifter low) <- Pico 3V3
//   TX   = 3.3 V logic in  (Pico drives the bus)     <- Pico GP8
//   RX   = 3.3 V logic out (bus data to the Pico)    -> Pico GP9
//
// Passive visual placeholder — there is no live K-line bus in the sim. The real
// discrete circuit (and why the level shifter is mandatory) is in BUILD.md.
#include "wokwi-api.h"
void chip_init(void) {}
