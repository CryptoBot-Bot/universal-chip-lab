import type { ChipProfile, MemoryType } from "./chipProfile.schema.js";

/**
 * The two top-level "front door" categories the operator chooses between:
 * EEPROM (small serial config/immo memories) vs FLASH (larger program/data
 * stores). Derived from {@link MemoryType} so it stays in sync with the chip
 * catalog without a second source of truth.
 */
export type MemoryClass = "eeprom" | "flash";

const FLASH_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "serial_flash",
  "parallel_flash",
  "mcu_flash",
]);

/** Classifies a chip into the EEPROM or FLASH pillar. */
export function classifyMemoryClass(profile: ChipProfile): MemoryClass {
  return FLASH_MEMORY_TYPES.has(profile.memoryType) ? "flash" : "eeprom";
}

export interface MemoryClassMeta {
  id: MemoryClass;
  label: string;
  blurb: string;
}

export const MEMORY_CLASSES: readonly MemoryClassMeta[] = [
  {
    id: "eeprom",
    label: "EEPROM",
    blurb:
      "Small serial memories (24C / 25C / 93C, M95). Hold immobiliser secrets, adaptations, mileage. Byte-level read & write.",
  },
  {
    id: "flash",
    label: "FLASH",
    blurb:
      "Larger SPI-NOR & program flash. Hold calibrations and firmware. Sector-erase before write.",
  },
];
