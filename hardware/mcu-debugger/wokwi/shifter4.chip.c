// 4-channel bidirectional level shifter (BSS138 + pull-ups, e.g. your AITIAO
// module). Two of these translate between the probe (LV = 3.3 V) and the TARGET
// MCU's IO voltage (HV = the target's VTref — 1.8 / 3.3 / 5 V). Auto-direction.
//
//   LV  = 3.3 V reference (probe / Pico 3V3)   HV  = target VTref (sensed)
//   LVn <-> HVn = channel n
//
// Passive visual placeholder. The HV side tracks whatever the target runs at —
// this is why the debug header carries VTref. See BUILD.md.
#include "wokwi-api.h"
void chip_init(void) {}
