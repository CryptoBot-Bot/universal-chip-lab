// 4-channel bidirectional level shifter (BSS138 + pull-ups, e.g. your AITIAO
// module). Translates between the EM4095's 5 V logic (HV side) and the Pico's
// 3.3 V logic (LV side). Without it, 5 V from DEMOD/RDYCLK destroys a Pico GPIO.
//
//   LV  = 3.3 V reference (Pico 3V3)      HV  = 5 V reference (Pico VBUS)
//   LVn <-> HVn = channel n (auto-direction)
//
// Passive visual placeholder. "Match the voltage domains" — same lesson as the
// car build's protection block.
#include "wokwi-api.h"
void chip_init(void) {}
