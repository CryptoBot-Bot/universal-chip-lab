// EM4095 — 125 kHz RFID read/write analog front-end (SOIC-16).
// Generates the 125 kHz carrier, drives the antenna tank, and demodulates the
// load-modulation coming back from a transponder. The Pico does the protocol.
//
//   VDD/VSS   5 V supply (4.1-5.5 V) + ground
//   ANT1/ANT2 antenna LC tank (see chip-antenna)
//   CFCAP     frequency-set cap to VSS (sets the 125 kHz carrier; ~datasheet)
//   CDEC      VDD decoupling / charge-pump cap
//   DEMOD     demodulated data OUT  -> Pico (via level shifter, 5 V logic!)
//   RDYCLK    ready + carrier clock OUT -> Pico (via level shifter)
//   SHD       shutdown IN (HIGH = off) <- Pico (via level shifter)
//   MOD       modulation IN (writing)  <- Pico (via level shifter)
//
// Passive visual placeholder — no RF in the sim. Exact pin NUMBERS and the
// CFCAP / decoupling values: follow the EM4095 datasheet typical-application
// figure. See BUILD.md. The 5 V logic pins MUST go through the level shifter.
#include "wokwi-api.h"
void chip_init(void) {}
