// OBD-II J1962 vehicle plug. Pins used: 16=+12V battery, 6=CAN-H, 14=CAN-L, 5=signal GND.
// (Pins 4=chassis GND, 7=K-line, 2/10=J1850 exist on a real port but are unused here.)
//
// For the Wokwi sim this chip also *drives* P16_12V to a battery voltage so the
// R1/R2 divider feeds a realistic level into the Pico's ADC (GP28). Set the
// "battery_voltage" attr on the part to fake ignition-only (~12.6) vs engine-
// running (~14.4). On the real bench the car supplies this — see BUILD.md.
#include "wokwi-api.h"

void chip_init(void) {
  pin_t v12 = pin_init("P16_12V", ANALOG);
  float volts = attr_read_float(attr_init_float("battery_voltage", 12.6));
  pin_dac_write(v12, volts);
}
