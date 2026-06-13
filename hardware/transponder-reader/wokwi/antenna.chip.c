// 125 kHz antenna = LC tank: coil L (~1.2 mH) in parallel with resonant cap
// Cres (~1.5 nF C0G) + a small series/damping resistor. Tuned so the tank
// resonates at the EM4095 carrier (125 kHz). This is what couples to the
// transponder coil in the key. Modelled as one block (coil + Cres + Rser).
//
//   ANT1 / ANT2 -> EM4095 ANT1 / ANT2
//
// Tuning: f = 1 / (2*pi*sqrt(L*Cres)). With L = 1.2 mH, Cres = 1.5 nF -> ~118
// kHz; trim Cres to land on 125 kHz. Bigger coil = lower cap. See BUILD.md.
#include "wokwi-api.h"
void chip_init(void) {}
