import type { ChipFamily, MemoryType, Protocol } from "./chipProfile.schema.js";

/**
 * Output of the AI photo-resolver's identification pass (Phase 4). This is a
 * *hypothesis* read off the chip's markings — NOT trusted for any operation
 * until the pinout is set (Phase 5) and confirmed on real silicon (Phase 6).
 * Voltage is flattened to three numbers so the structured-output JSON schema
 * stays simple.
 */
export interface ChipIdentification {
  /** Raw top-marking text the model read off the package. */
  markings: string;
  /** Best-guess full part number, e.g. "W25Q64JVSSIQ". "" if unreadable. */
  partNumber: string;
  manufacturer: string;
  family: ChipFamily | "unknown";
  protocol: Protocol | "unknown";
  /** Package, e.g. "SOIC-8", "TSSOP-8". "" if unknown. */
  packageType: string;
  voltageMin: number;
  voltageTypical: number;
  voltageMax: number;
  /** Capacity in bytes, 0 if not determinable from the markings. */
  sizeBytes: number;
  confidence: "low" | "medium" | "high";
  /** One short paragraph: what the model saw and why it concluded this. */
  reasoning: string;
  /** Other plausible part numbers, best-first. */
  alternates: string[];
}

/** Allowed `family` values the resolver may return (our taxonomy + unknown). */
export const RESOLVER_FAMILIES: readonly (ChipFamily | "unknown")[] = [
  "24xxx_i2c_eeprom",
  "25xxx_spi_eeprom",
  "93xxx_microwire_eeprom",
  "spi_nor_flash",
  "mcu_internal_flash",
  "mcu_internal_eeprom",
  "unknown",
];

/** Allowed `protocol` values the resolver may return. */
export const RESOLVER_PROTOCOLS: readonly (Protocol | "unknown")[] = [
  "i2c",
  "spi",
  "microwire",
  "uart",
  "can",
  "jtag",
  "swd",
  "unknown",
];

/** Maps a chip family to its memory type, for building a profile later. */
export function memoryTypeForFamily(family: ChipFamily): MemoryType {
  switch (family) {
    case "24xxx_i2c_eeprom":
    case "25xxx_spi_eeprom":
    case "93xxx_microwire_eeprom":
      return "serial_eeprom";
    case "spi_nor_flash":
      return "serial_flash";
    case "mcu_internal_flash":
      return "mcu_flash";
    case "mcu_internal_eeprom":
      return "mcu_eeprom";
  }
}
