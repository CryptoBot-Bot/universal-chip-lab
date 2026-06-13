// LM2596 adjustable buck module. On the real board you set OUT to 5.1 V with the
// on-board pot BEFORE wiring the Pico (BUILD.md STEP 1 — do not skip).
//
// Sim model: this chip drives OUT+ to a regulated 5.1 V (attr "vout") so you can
// drop a Wokwi voltage probe on VSYS and confirm the rail. IN+/IN- are the
// unregulated car side (fed from the protection block).
#include "wokwi-api.h"

void chip_init(void) {
  pin_t vout = pin_init("OUT+", ANALOG);
  float v = attr_read_float(attr_init_float("vout", 5.1));
  pin_dac_write(vout, v);
}
