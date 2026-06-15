import type { ChipFamily, ChipProfile } from "./chipProfile.schema.js";

/**
 * The hybrid SPI-clock model for PicoForge.
 *
 * The "speed" is the SCK frequency the Pico clocks the bus at. Every edge
 * shifts one bit, so it is purely a throughput knob — SPI has no minimum, and
 * slower is always safe for reads. The maximum is per-chip (the datasheet's
 * output-valid time tV) and derates with Vcc and long jumper leads. Clocking
 * above it makes the Pico sample MISO before the chip has driven it, which
 * reads back as a wall of 0x00 (a *blank* chip reads 0xFF, so 0x00 means
 * "nobody is driving the line", not "empty").
 *
 * Effective clock = override (if the operator set one) else the chip-DB rated
 * default, both clamped to what the RP2040 can actually produce.
 */

/** RP2040 PL022 SPI ceiling: 125 MHz peripheral clock / 2 (min even prescaler). */
export const SPI_HW_MAX_HZ = 62_500_000;
/** Floor that guards typos; below this is pointless for memory work. */
export const SPI_HW_MIN_HZ = 10_000;

/** Firmware power-on default — the proven, no-regression operating clock. */
export const DEFAULT_SPI_CLOCK_HZ = 2_000_000;
/** "First contact" clock for an unknown or misbehaving chip / long leads. */
export const SAFE_FIRST_CONTACT_HZ = 1_000_000;

/**
 * Conservative per-family ceilings used when a profile has no `maxClockHz`.
 * Bench-realistic, not best-case datasheet — these are upper clamps, not the
 * speed the tool drives by default.
 */
const FAMILY_MAX_CLOCK_HZ: Partial<Record<ChipFamily, number>> = {
  "25xxx_spi_eeprom": 5_000_000, // M95 older grades top out ~5 MHz; automotive higher
  spi_nor_flash: 20_000_000, // datasheet 50–104 MHz, heavily derated for a clip
  "93xxx_microwire_eeprom": 2_000_000,
};

/** The chip's rated max bus clock (DB value, else family fallback, else undefined). */
export function chipMaxClockHz(profile: ChipProfile): number | undefined {
  const rated = profile.readAlgorithm?.maxClockHz;
  if (typeof rated === "number" && rated > 0) return rated;
  return FAMILY_MAX_CLOCK_HZ[profile.family];
}

/** Clamps any requested clock into the RP2040's usable range. */
export function clampSpiClockHz(hz: number): number {
  if (!Number.isFinite(hz) || hz <= 0) return DEFAULT_SPI_CLOCK_HZ;
  return Math.max(SPI_HW_MIN_HZ, Math.min(SPI_HW_MAX_HZ, Math.round(hz)));
}

/**
 * Resolves the clock to actually drive: the operator override if set, else the
 * chip's rated default, else the firmware default — clamped to hardware and to
 * the chip's rated ceiling (never drive a chip faster than its datasheet).
 */
export function effectiveSpiClockHz(profile: ChipProfile, overrideHz?: number): number {
  const rated = chipMaxClockHz(profile);
  const requested = overrideHz && overrideHz > 0 ? overrideHz : rated ?? DEFAULT_SPI_CLOCK_HZ;
  const ceiling = rated ? Math.min(rated, SPI_HW_MAX_HZ) : SPI_HW_MAX_HZ;
  return clampSpiClockHz(Math.min(requested, ceiling));
}

/** Human-readable clock, e.g. 1_000_000 → "1 MHz", 1_500_000 → "1.5 MHz". */
export function formatClockHz(hz: number): string {
  if (hz >= 1_000_000) {
    const mhz = hz / 1_000_000;
    return `${Number.isInteger(mhz) ? mhz : mhz.toFixed(1)} MHz`;
  }
  if (hz >= 1_000) return `${Math.round(hz / 1_000)} kHz`;
  return `${hz} Hz`;
}
