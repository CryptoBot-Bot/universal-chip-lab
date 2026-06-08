import type { ChipProfile } from "./chipProfile.schema.js";
import {
  i2cEepromProfile,
  m95Profile,
  microwireProfile,
  spiNorProfile,
} from "./factories.js";

// =========================================================================
// M95 SPI EEPROM family (STMicroelectronics). Extremely common in automotive
// modules — Bosch, Continental, Siemens, Delphi all use these for immo and
// adaptations.
// =========================================================================

const M95_VARIANTS = [
  "95010", "95020", "95040", "95080", "95128",
  "95160", "95256", "95320", "95512", "95640",
  "95M01", "95M02",
] as const;

const M95_PROFILES: ChipProfile[] = M95_VARIANTS.map((v) =>
  m95Profile({ variant: v }),
);

// =========================================================================
// Microchip-compatible variants (24LC family is functionally identical to
// 24C family — different vendors, same protocol).
// =========================================================================

const I2C_EEPROM_PROFILES: ChipProfile[] = [
  i2cEepromProfile({ variant: "24C01",   sizeBytes: 128,    pageSize: 8,   addressBytes: 1 }),
  i2cEepromProfile({ variant: "24C02",   sizeBytes: 256,    pageSize: 8,   addressBytes: 1 }),
  i2cEepromProfile({ variant: "24C04",   sizeBytes: 512,    pageSize: 16,  addressBytes: 1 }),
  i2cEepromProfile({ variant: "24C08",   sizeBytes: 1024,   pageSize: 16,  addressBytes: 1 }),
  i2cEepromProfile({ variant: "24C16",   sizeBytes: 2048,   pageSize: 16,  addressBytes: 1,
    extraWarnings: ["24C16 uses all three A0/A1/A2 pins as address-block-select internally — they must not be wired to slave-address selectors on most modules."],
  }),
  i2cEepromProfile({ variant: "24C32",   sizeBytes: 4096,   pageSize: 32,  addressBytes: 2 }),
  i2cEepromProfile({ variant: "24C64",   sizeBytes: 8192,   pageSize: 32,  addressBytes: 2 }),
  i2cEepromProfile({ variant: "24C128",  sizeBytes: 16384,  pageSize: 64,  addressBytes: 2 }),
  i2cEepromProfile({ variant: "24C512",  sizeBytes: 65536,  pageSize: 128, addressBytes: 2 }),
];

// =========================================================================
// 93Cxx Microwire — clusters, BCMs, immobilisers. ORG pin matters.
// =========================================================================

const MICROWIRE_PROFILES: ChipProfile[] = [
  microwireProfile({ variant: "93C46" }),
  microwireProfile({ variant: "93C56" }),
  microwireProfile({ variant: "93C66" }),
  microwireProfile({ variant: "93C76" }),
];

// =========================================================================
// SPI NOR Flash — calibration storage on newer ECUs. Always 3.3 V.
// =========================================================================

const SPI_NOR_PROFILES: ChipProfile[] = [
  // Winbond W25Q family — extremely common.
  spiNorProfile({ manufacturer: "Winbond", variant: "W25Q16",  sizeBytes:  2 * 1024 * 1024, jedecId: "EF4015" }),
  spiNorProfile({ manufacturer: "Winbond", variant: "W25Q32",  sizeBytes:  4 * 1024 * 1024, jedecId: "EF4016" }),
  spiNorProfile({ manufacturer: "Winbond", variant: "W25Q64",  sizeBytes:  8 * 1024 * 1024, jedecId: "EF4017" }),
  spiNorProfile({ manufacturer: "Winbond", variant: "W25Q128", sizeBytes: 16 * 1024 * 1024, jedecId: "EF4018" }),
  // Macronix MX25L — common in automotive Bosch / Continental modules.
  spiNorProfile({ manufacturer: "Macronix", variant: "MX25L8005",   sizeBytes:  1 * 1024 * 1024, jedecId: "C22014" }),
  spiNorProfile({ manufacturer: "Macronix", variant: "MX25L1606E",  sizeBytes:  2 * 1024 * 1024, jedecId: "C22015" }),
  spiNorProfile({ manufacturer: "Macronix", variant: "MX25L3206E",  sizeBytes:  4 * 1024 * 1024, jedecId: "C22016" }),
  spiNorProfile({ manufacturer: "Macronix", variant: "MX25L6406E",  sizeBytes:  8 * 1024 * 1024, jedecId: "C22017" }),
  // Eon Silicon Solutions — extremely common as cheap "Amazon training"
  // SPI flash chips, often silkscreen-mimicking Winbond W25Q parts. Same
  // pinout, same SPI command set, only the JEDEC ID and write-suspend timing
  // differ. If a "W25Q32JV"-marked chip identifies as Eon EN25Q32 via JEDEC,
  // it's a clone — works identically for read/write/erase.
  spiNorProfile({ manufacturer: "Eon", variant: "EN25Q16", sizeBytes:  2 * 1024 * 1024, jedecId: "1C3015" }),
  spiNorProfile({ manufacturer: "Eon", variant: "EN25Q32", sizeBytes:  4 * 1024 * 1024, jedecId: "1C3016" }),
  spiNorProfile({ manufacturer: "Eon", variant: "EN25Q64", sizeBytes:  8 * 1024 * 1024, jedecId: "1C3017" }),
  spiNorProfile({ manufacturer: "Eon", variant: "EN25Q128", sizeBytes: 16 * 1024 * 1024, jedecId: "1C3018" }),
  // Zbit — another common Winbond-mimic clone family.
  spiNorProfile({ manufacturer: "Zbit", variant: "ZB25VQ16",  sizeBytes:  2 * 1024 * 1024, jedecId: "5E4015" }),
  spiNorProfile({ manufacturer: "Zbit", variant: "ZB25VQ32",  sizeBytes:  4 * 1024 * 1024, jedecId: "5E4016" }),
  spiNorProfile({ manufacturer: "Zbit", variant: "ZB25VQ64",  sizeBytes:  8 * 1024 * 1024, jedecId: "5E4017" }),
  spiNorProfile({ manufacturer: "Zbit", variant: "ZB25VQ128", sizeBytes: 16 * 1024 * 1024, jedecId: "5E4018" }),
  // XTX Technology — yet another Winbond-mimic clone family.
  spiNorProfile({ manufacturer: "XTX", variant: "XT25F32B", sizeBytes:  4 * 1024 * 1024, jedecId: "0B4016" }),
  spiNorProfile({ manufacturer: "XTX", variant: "XT25F64B", sizeBytes:  8 * 1024 * 1024, jedecId: "0B4017" }),
  // ST Micro M25P — older but found on many Bosch EDC16/17 calibration banks.
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P05",  sizeBytes:  64 * 1024, jedecId: "202010" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P10",  sizeBytes: 128 * 1024, jedecId: "202011" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P20",  sizeBytes: 256 * 1024, jedecId: "202012" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P40",  sizeBytes: 512 * 1024, jedecId: "202013" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P80",  sizeBytes:  1 * 1024 * 1024, jedecId: "202014" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P16",  sizeBytes:  2 * 1024 * 1024, jedecId: "202015" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P32",  sizeBytes:  4 * 1024 * 1024, jedecId: "202016" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P64",  sizeBytes:  8 * 1024 * 1024, jedecId: "202017" }),
];

// =========================================================================
// Combined catalog. The three seed JSON profiles (24LC256, 25LC256, 93C86)
// are loaded separately in chipRegistry.ts and merged in.
// =========================================================================

export const CATALOG_PROFILES: ReadonlyArray<ChipProfile> = [
  ...M95_PROFILES,
  ...I2C_EEPROM_PROFILES,
  ...MICROWIRE_PROFILES,
  ...SPI_NOR_PROFILES,
];
