import type { ChipProfile } from "./chipProfile.schema.js";

/**
 * Maps a chip to the PicoForge firmware MODE that reads/writes it:
 *   0 SPI Flash | 1 SPI EEPROM | 2 I2C EEPROM | 3 Microwire
 * Returns null for families PicoForge can't reach (internal-MCU memory).
 */
export type PicoMode = 0 | 1 | 2 | 3;

export interface PicoModeInfo {
  mode: PicoMode;
  label: string;
}

export function picoModeForChip(profile: ChipProfile): PicoModeInfo | null {
  switch (profile.family) {
    case "spi_nor_flash":
      return { mode: 0, label: "SPI Flash" };
    case "25xxx_spi_eeprom":
      return { mode: 1, label: "SPI EEPROM" };
    case "24xxx_i2c_eeprom":
      return { mode: 2, label: "I2C EEPROM" };
    case "93xxx_microwire_eeprom":
      return { mode: 3, label: "Microwire" };
    case "parallel_nor_flash":
    case "parallel_eeprom":
    case "parallel_eprom":
    case "nand_flash":
      return null; // parallel memory — needs the T48's address/data bus, not a 4-wire clip
    case "mcu_internal_flash":
    case "mcu_internal_eeprom":
      return null; // internal-MCU memory — not reachable via PicoForge clips
  }
}
