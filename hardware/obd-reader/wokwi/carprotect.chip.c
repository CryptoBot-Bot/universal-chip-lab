// Car-power protection block = inline FUSE (0.5-1A) -> series Schottky D1 (reverse
// polarity) -> TVS D2 to GND (load-dump clamp). IN = car +12V, OUT = to LM2596 IN+.
// This is the load-bearing safety stage. See BUILD.md for the discrete parts.
//
// Sim model: OUT = the protected rail (IN minus the Schottky drop). Drive it via
// the "vout" attr, default 12.2 V (12.6 from the obd2 chip - ~0.4 V across D1) so
// you can probe the protected side. The discrete fuse/diodes are not modelled.
#include "wokwi-api.h"

void chip_init(void) {
  pin_t out = pin_init("OUT", ANALOG);
  float v = attr_read_float(attr_init_float("vout", 12.2));
  pin_dac_write(out, v);
}
