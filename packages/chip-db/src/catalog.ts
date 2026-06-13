import type { ChipProfile } from "./chipProfile.schema.js";
import {
  epromProfile,
  i2cEepromProfile,
  m95Profile,
  mcuProfile,
  microwireProfile,
  nandProfile,
  parallelEepromProfile,
  parallelNorProfile,
  spi25EepromProfile,
  spiNorProfile,
} from "./factories.js";

// =========================================================================
// SERIAL MEMORY — read & write with PicoForge (3.3 V, SPI / I²C / Microwire).
// These four families are the core of what the Pico clip can reach.
// =========================================================================

// --- M95 SPI EEPROM family (ST). Bosch/Conti/Siemens/Delphi immo & adaptations.
const M95_VARIANTS = [
  "95010", "95020", "95040", "95080", "95128",
  "95160", "95256", "95320", "95512", "95640",
  "95M01", "95M02",
] as const;
const M95_PROFILES: ChipProfile[] = M95_VARIANTS.map((v) => m95Profile({ variant: v }));

// --- Generic 25xx SPI EEPROM (Microchip 25LC/25AA, Atmel AT25). Same pinout as M95.
const SPI25_PROFILES: ChipProfile[] = [
  // Microchip 25LC (2.5–5.5 V) — 25LC256 ships as a seed JSON, so it's omitted here.
  spi25EepromProfile({ manufacturer: "Microchip", variant: "25LC010", sizeBytes: 128,    pageSize: 16,  addressBytes: 1 }),
  spi25EepromProfile({ manufacturer: "Microchip", variant: "25LC020", sizeBytes: 256,    pageSize: 16,  addressBytes: 1 }),
  spi25EepromProfile({ manufacturer: "Microchip", variant: "25LC040", sizeBytes: 512,    pageSize: 16,  addressBytes: 1 }),
  spi25EepromProfile({ manufacturer: "Microchip", variant: "25LC080", sizeBytes: 1024,   pageSize: 16,  addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "Microchip", variant: "25LC160", sizeBytes: 2048,   pageSize: 16,  addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "Microchip", variant: "25LC320", sizeBytes: 4096,   pageSize: 32,  addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "Microchip", variant: "25LC640", sizeBytes: 8192,   pageSize: 32,  addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "Microchip", variant: "25LC128", sizeBytes: 16384,  pageSize: 64,  addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "Microchip", variant: "25LC512", sizeBytes: 65536,  pageSize: 128, addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "Microchip", variant: "25LC1024", sizeBytes: 131072, pageSize: 256, addressBytes: 3 }),
  // Atmel / Renesas AT25 family.
  spi25EepromProfile({ manufacturer: "Atmel", variant: "AT25010B", sizeBytes: 128,   pageSize: 8,   addressBytes: 1 }),
  spi25EepromProfile({ manufacturer: "Atmel", variant: "AT25040B", sizeBytes: 512,   pageSize: 8,   addressBytes: 1 }),
  spi25EepromProfile({ manufacturer: "Atmel", variant: "AT25080B", sizeBytes: 1024,  pageSize: 32,  addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "Atmel", variant: "AT25320B", sizeBytes: 4096,  pageSize: 32,  addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "Atmel", variant: "AT25640B", sizeBytes: 8192,  pageSize: 32,  addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "Atmel", variant: "AT25256B", sizeBytes: 32768, pageSize: 64,  addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "Atmel", variant: "AT25512",  sizeBytes: 65536, pageSize: 128, addressBytes: 2 }),
  // ABLIC / Seiko Instruments (SII) S-25A — automotive 125 °C SPI EEPROM, common in
  // ECU/TCU/cluster/immobiliser modules. Top-marked like "S25A32" (= S-25A320A).
  spi25EepromProfile({ manufacturer: "ABLIC", variant: "S-25A080A", sizeBytes: 1024, pageSize: 32, addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "ABLIC", variant: "S-25A160A", sizeBytes: 2048, pageSize: 32, addressBytes: 2 }),
  spi25EepromProfile({ manufacturer: "ABLIC", variant: "S-25A320A", sizeBytes: 4096, pageSize: 32, addressBytes: 2 }),
];

// --- 24Cxx I²C EEPROM — clusters, BCMs, immobilisers, airbag/SRS.
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
  i2cEepromProfile({ variant: "24C256",  sizeBytes: 32768,  pageSize: 64,  addressBytes: 2 }),
  i2cEepromProfile({ variant: "24C512",  sizeBytes: 65536,  pageSize: 128, addressBytes: 2 }),
  i2cEepromProfile({ variant: "24C1024", sizeBytes: 131072, pageSize: 256, addressBytes: 2,
    extraWarnings: ["1 Mbit parts span two I²C device-address blocks — the tool must read both halves."],
  }),
  // ST M24-series equivalents (same protocol, ST branding on many EU modules).
  i2cEepromProfile({ variant: "M24C32",  sizeBytes: 4096,   pageSize: 32,  addressBytes: 2, manufacturer: "STMicroelectronics" }),
  i2cEepromProfile({ variant: "M24C64",  sizeBytes: 8192,   pageSize: 32,  addressBytes: 2, manufacturer: "STMicroelectronics" }),
  i2cEepromProfile({ variant: "M24M01",  sizeBytes: 131072, pageSize: 256, addressBytes: 2, manufacturer: "STMicroelectronics" }),
  i2cEepromProfile({ variant: "M24M02",  sizeBytes: 262144, pageSize: 256, addressBytes: 2, manufacturer: "STMicroelectronics" }),
];

// --- 93Cxx Microwire — clusters, BCMs, immobilisers. ORG pin matters.
const MICROWIRE_PROFILES: ChipProfile[] = [
  microwireProfile({ variant: "93C46" }),
  microwireProfile({ variant: "93C56" }),
  microwireProfile({ variant: "93C66" }),
  microwireProfile({ variant: "93C76" }),
  microwireProfile({ variant: "93C46", manufacturer: "STMicroelectronics" }),
  microwireProfile({ variant: "93C56", manufacturer: "STMicroelectronics" }),
  microwireProfile({ variant: "93C66", manufacturer: "STMicroelectronics" }),
  microwireProfile({ variant: "93C86", manufacturer: "STMicroelectronics" }),
  microwireProfile({ variant: "93C46", manufacturer: "Atmel" }),
  microwireProfile({ variant: "93C66", manufacturer: "Atmel" }),
];

// --- SPI NOR Flash — calibration / firmware on newer ECUs. Always 3.3 V.
const SPI_NOR_PROFILES: ChipProfile[] = [
  // Winbond W25Q — the most common family.
  spiNorProfile({ manufacturer: "Winbond", variant: "W25Q16",  sizeBytes:  2 * 1024 * 1024, jedecId: "EF4015" }),
  spiNorProfile({ manufacturer: "Winbond", variant: "W25Q32",  sizeBytes:  4 * 1024 * 1024, jedecId: "EF4016" }),
  spiNorProfile({ manufacturer: "Winbond", variant: "W25Q64",  sizeBytes:  8 * 1024 * 1024, jedecId: "EF4017" }),
  spiNorProfile({ manufacturer: "Winbond", variant: "W25Q128", sizeBytes: 16 * 1024 * 1024, jedecId: "EF4018" }),
  spiNorProfile({ manufacturer: "Winbond", variant: "W25Q256", sizeBytes: 32 * 1024 * 1024, jedecId: "EF4019",
    extraWarnings: ["256 Mbit needs 4-byte addressing — enable it or the read wraps at 16 MB."] }),
  // Macronix MX25L — common in Bosch / Continental modules.
  spiNorProfile({ manufacturer: "Macronix", variant: "MX25L8005",   sizeBytes:  1 * 1024 * 1024, jedecId: "C22014" }),
  spiNorProfile({ manufacturer: "Macronix", variant: "MX25L1606E",  sizeBytes:  2 * 1024 * 1024, jedecId: "C22015" }),
  spiNorProfile({ manufacturer: "Macronix", variant: "MX25L3206E",  sizeBytes:  4 * 1024 * 1024, jedecId: "C22016" }),
  spiNorProfile({ manufacturer: "Macronix", variant: "MX25L6406E",  sizeBytes:  8 * 1024 * 1024, jedecId: "C22017" }),
  spiNorProfile({ manufacturer: "Macronix", variant: "MX25L12835F", sizeBytes: 16 * 1024 * 1024, jedecId: "C22018" }),
  spiNorProfile({ manufacturer: "Macronix", variant: "MX25L25635F", sizeBytes: 32 * 1024 * 1024, jedecId: "C22019" }),
  // GigaDevice GD25Q — ubiquitous modern replacement.
  spiNorProfile({ manufacturer: "GigaDevice", variant: "GD25Q16",  sizeBytes:  2 * 1024 * 1024, jedecId: "C84015" }),
  spiNorProfile({ manufacturer: "GigaDevice", variant: "GD25Q32",  sizeBytes:  4 * 1024 * 1024, jedecId: "C84016" }),
  spiNorProfile({ manufacturer: "GigaDevice", variant: "GD25Q64",  sizeBytes:  8 * 1024 * 1024, jedecId: "C84017" }),
  spiNorProfile({ manufacturer: "GigaDevice", variant: "GD25Q128", sizeBytes: 16 * 1024 * 1024, jedecId: "C84018" }),
  // Micron / Numonyx N25Q.
  spiNorProfile({ manufacturer: "Micron", variant: "N25Q032", sizeBytes:  4 * 1024 * 1024, jedecId: "20BA16" }),
  spiNorProfile({ manufacturer: "Micron", variant: "N25Q064", sizeBytes:  8 * 1024 * 1024, jedecId: "20BA17" }),
  spiNorProfile({ manufacturer: "Micron", variant: "N25Q128", sizeBytes: 16 * 1024 * 1024, jedecId: "20BA18" }),
  // ISSI IS25LP.
  spiNorProfile({ manufacturer: "ISSI", variant: "IS25LP032", sizeBytes:  4 * 1024 * 1024, jedecId: "9D6016" }),
  spiNorProfile({ manufacturer: "ISSI", variant: "IS25LP064", sizeBytes:  8 * 1024 * 1024, jedecId: "9D6017" }),
  spiNorProfile({ manufacturer: "ISSI", variant: "IS25LP128", sizeBytes: 16 * 1024 * 1024, jedecId: "9D6018" }),
  // Microchip SST26VF (note: needs a global block-protect unlock before write).
  spiNorProfile({ manufacturer: "Microchip", variant: "SST26VF016B", sizeBytes: 2 * 1024 * 1024, jedecId: "BF2641",
    extraWarnings: ["SST26 powers up with all blocks write-protected — send Global Block-Protect Unlock before erase/write."] }),
  spiNorProfile({ manufacturer: "Microchip", variant: "SST26VF032B", sizeBytes: 4 * 1024 * 1024, jedecId: "BF2642" }),
  spiNorProfile({ manufacturer: "Microchip", variant: "SST26VF064B", sizeBytes: 8 * 1024 * 1024, jedecId: "BF2643" }),
  // Cypress / Spansion S25FL (JEDEC omitted — verify by ID on the bench).
  spiNorProfile({ manufacturer: "Cypress", variant: "S25FL064L", sizeBytes:  8 * 1024 * 1024 }),
  spiNorProfile({ manufacturer: "Cypress", variant: "S25FL128L", sizeBytes: 16 * 1024 * 1024 }),
  spiNorProfile({ manufacturer: "Cypress", variant: "S25FL256L", sizeBytes: 32 * 1024 * 1024 }),
  // Adesto / Dialog AT25SF.
  spiNorProfile({ manufacturer: "Adesto", variant: "AT25SF081", sizeBytes: 1 * 1024 * 1024 }),
  spiNorProfile({ manufacturer: "Adesto", variant: "AT25SF161", sizeBytes: 2 * 1024 * 1024 }),
  spiNorProfile({ manufacturer: "Adesto", variant: "AT25SF321", sizeBytes: 4 * 1024 * 1024 }),
  // Eon — common Winbond-mimic clone family.
  spiNorProfile({ manufacturer: "Eon", variant: "EN25Q16",  sizeBytes:  2 * 1024 * 1024, jedecId: "1C3015" }),
  spiNorProfile({ manufacturer: "Eon", variant: "EN25Q32",  sizeBytes:  4 * 1024 * 1024, jedecId: "1C3016" }),
  spiNorProfile({ manufacturer: "Eon", variant: "EN25Q64",  sizeBytes:  8 * 1024 * 1024, jedecId: "1C3017" }),
  spiNorProfile({ manufacturer: "Eon", variant: "EN25Q128", sizeBytes: 16 * 1024 * 1024, jedecId: "1C3018" }),
  // Zbit — another Winbond-mimic clone family.
  spiNorProfile({ manufacturer: "Zbit", variant: "ZB25VQ16",  sizeBytes:  2 * 1024 * 1024, jedecId: "5E4015" }),
  spiNorProfile({ manufacturer: "Zbit", variant: "ZB25VQ32",  sizeBytes:  4 * 1024 * 1024, jedecId: "5E4016" }),
  spiNorProfile({ manufacturer: "Zbit", variant: "ZB25VQ64",  sizeBytes:  8 * 1024 * 1024, jedecId: "5E4017" }),
  spiNorProfile({ manufacturer: "Zbit", variant: "ZB25VQ128", sizeBytes: 16 * 1024 * 1024, jedecId: "5E4018" }),
  // XTX — yet another Winbond-mimic clone family.
  spiNorProfile({ manufacturer: "XTX", variant: "XT25F32B", sizeBytes:  4 * 1024 * 1024, jedecId: "0B4016" }),
  spiNorProfile({ manufacturer: "XTX", variant: "XT25F64B", sizeBytes:  8 * 1024 * 1024, jedecId: "0B4017" }),
  // Puya — common low-cost clone family.
  spiNorProfile({ manufacturer: "Puya", variant: "P25Q16H", sizeBytes: 2 * 1024 * 1024 }),
  spiNorProfile({ manufacturer: "Puya", variant: "P25Q32H", sizeBytes: 4 * 1024 * 1024 }),
  spiNorProfile({ manufacturer: "Puya", variant: "P25Q64H", sizeBytes: 8 * 1024 * 1024 }),
  // ST Micro M25P — older Bosch EDC16/17 calibration banks.
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P05", sizeBytes:  64 * 1024, jedecId: "202010" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P10", sizeBytes: 128 * 1024, jedecId: "202011" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P20", sizeBytes: 256 * 1024, jedecId: "202012" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P40", sizeBytes: 512 * 1024, jedecId: "202013" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P80", sizeBytes:  1 * 1024 * 1024, jedecId: "202014" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P16", sizeBytes:  2 * 1024 * 1024, jedecId: "202015" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P32", sizeBytes:  4 * 1024 * 1024, jedecId: "202016" }),
  spiNorProfile({ manufacturer: "STMicroelectronics", variant: "M25P64", sizeBytes:  8 * 1024 * 1024, jedecId: "202017" }),
];

// =========================================================================
// PARALLEL MEMORY — read & write with the T48 (XGecu) universal programmer.
// Many pins (address + data bus) — a PicoForge clip cannot reach these.
// =========================================================================

// --- Parallel NOR flash (29F / 39SF / 28F) — old ECU program/maps, BIOS.
const PARALLEL_NOR_PROFILES: ChipProfile[] = [
  parallelNorProfile({ manufacturer: "AMD", variant: "AM29F010", sizeBytes: 128 * 1024, package: "DIP-32" }),
  parallelNorProfile({ manufacturer: "AMD", variant: "AM29F010", sizeBytes: 128 * 1024, package: "PLCC-32" }),
  parallelNorProfile({ manufacturer: "AMD", variant: "AM29F040", sizeBytes: 512 * 1024, package: "DIP-32" }),
  parallelNorProfile({ manufacturer: "AMD", variant: "AM29F040", sizeBytes: 512 * 1024, package: "PLCC-32" }),
  parallelNorProfile({ manufacturer: "AMD", variant: "AM29F002", sizeBytes: 256 * 1024, package: "PLCC-32" }),
  parallelNorProfile({ manufacturer: "SST", variant: "SST39SF010", sizeBytes: 128 * 1024, package: "DIP-32" }),
  parallelNorProfile({ manufacturer: "SST", variant: "SST39SF020", sizeBytes: 256 * 1024, package: "DIP-32" }),
  parallelNorProfile({ manufacturer: "SST", variant: "SST39SF040", sizeBytes: 512 * 1024, package: "DIP-32" }),
  parallelNorProfile({ manufacturer: "SST", variant: "SST39SF040", sizeBytes: 512 * 1024, package: "PLCC-32" }),
  parallelNorProfile({ manufacturer: "Macronix", variant: "MX29F040", sizeBytes: 512 * 1024, package: "PLCC-32" }),
  parallelNorProfile({ manufacturer: "Winbond", variant: "W29EE011", sizeBytes: 128 * 1024, package: "PLCC-32" }),
  parallelNorProfile({ manufacturer: "Intel", variant: "28F010", sizeBytes: 128 * 1024, package: "DIP-32" }),
];

// --- Parallel EEPROM (28C) — byte-writable parallel.
const PARALLEL_EEPROM_PROFILES: ChipProfile[] = [
  parallelEepromProfile({ manufacturer: "Atmel", variant: "AT28C64",  sizeBytes:  8 * 1024, package: "DIP-28" }),
  parallelEepromProfile({ manufacturer: "Atmel", variant: "AT28C256", sizeBytes: 32 * 1024, package: "DIP-28" }),
  parallelEepromProfile({ manufacturer: "Xicor", variant: "X28C256",  sizeBytes: 32 * 1024, package: "DIP-28" }),
  parallelEepromProfile({ manufacturer: "ST", variant: "M28C256", sizeBytes: 32 * 1024, package: "PLCC-32" }),
];

// --- EPROM (27C) — UV/OTP, read-only on the programmer. Old ECU maps.
const EPROM_PROFILES: ChipProfile[] = [
  epromProfile({ manufacturer: "STMicroelectronics", variant: "27C64",  sizeBytes:   8 * 1024, package: "DIP-28" }),
  epromProfile({ manufacturer: "STMicroelectronics", variant: "27C128", sizeBytes:  16 * 1024, package: "DIP-28" }),
  epromProfile({ manufacturer: "STMicroelectronics", variant: "27C256", sizeBytes:  32 * 1024, package: "DIP-28" }),
  epromProfile({ manufacturer: "STMicroelectronics", variant: "27C512", sizeBytes:  64 * 1024, package: "DIP-28" }),
  epromProfile({ manufacturer: "STMicroelectronics", variant: "27C010", sizeBytes: 128 * 1024, package: "DIP-32" }),
  epromProfile({ manufacturer: "STMicroelectronics", variant: "27C020", sizeBytes: 256 * 1024, package: "DIP-32" }),
  epromProfile({ manufacturer: "STMicroelectronics", variant: "27C040", sizeBytes: 512 * 1024, package: "DIP-32" }),
  epromProfile({ manufacturer: "AMD", variant: "27C256", sizeBytes: 32 * 1024, package: "PLCC-32" }),
];

// --- NAND flash (TSOP-48) — bulk storage; ECC + bad-block aware.
const NAND_PROFILES: ChipProfile[] = [
  nandProfile({ manufacturer: "Samsung", variant: "K9F1G08U0", sizeBytes: 128 * 1024 * 1024, package: "TSOP-48" }),
  nandProfile({ manufacturer: "Micron",  variant: "MT29F2G08", sizeBytes: 256 * 1024 * 1024, package: "TSOP-48" }),
  nandProfile({ manufacturer: "Macronix", variant: "MX30LF1G08", sizeBytes: 128 * 1024 * 1024, package: "TSOP-48" }),
];

// =========================================================================
// MCU INTERNAL MEMORY — read with the mcu-debugger board (BDM/JTAG/bootloader)
// or a T48 socket for the programmable ones. NOT reachable by PicoForge.
// =========================================================================

const MCU_PROFILES: ChipProfile[] = [
  mcuProfile({ manufacturer: "NXP", variant: "MC9S12 (HCS12)", sizeBytes: 256 * 1024, package: "QFP-112", iface: "bdm",
    note: "Classic body/cluster ECU MCU. Read over BDM (single-wire BKGD)." }),
  mcuProfile({ manufacturer: "Freescale", variant: "MC68HC11E9", sizeBytes: 512, package: "PLCC-52", iface: "bootloader",
    family: "mcu_internal_eeprom", note: "Internal EEPROM read via bootstrap mode; the program ROM is mask/OTP." }),
  mcuProfile({ manufacturer: "Infineon", variant: "TC1767 (TriCore)", sizeBytes: 2 * 1024 * 1024, package: "LQFP-176", iface: "jtag",
    note: "Bosch MED17/EDC17-class. Read over JTAG/DAP (FT232H + OpenOCD)." }),
  mcuProfile({ manufacturer: "STMicroelectronics", variant: "ST10F269", sizeBytes: 256 * 1024, package: "PQFP-144", iface: "jtag",
    note: "Older Bosch/Siemens ECUs. JTAG/OCDS." }),
  mcuProfile({ manufacturer: "Renesas", variant: "SH7058", sizeBytes: 1024 * 1024, package: "QFP-256", iface: "jtag",
    note: "Common in Japanese ECUs. AUD/JTAG." }),
  mcuProfile({ manufacturer: "STMicroelectronics", variant: "STM32F407", sizeBytes: 1024 * 1024, package: "LQFP-100", iface: "swd",
    note: "ARM Cortex-M4. Read over SWD (debugprobe + OpenOCD) unless RDP-locked." }),
  mcuProfile({ manufacturer: "Atmel", variant: "AT89C51", sizeBytes: 4 * 1024, package: "PLCC-44", iface: "bootloader",
    note: "8051-class. Parallel-programmed in a T48 socket; lock bits may block readback." }),
  mcuProfile({ manufacturer: "Microchip", variant: "PIC16F877", sizeBytes: 14 * 1024, package: "PLCC-44", iface: "bootloader",
    note: "Read over ICSP, or in a T48 socket. Code-protect fuse may block readback." }),
];

// =========================================================================
// Combined catalog. The three seed JSON profiles (24LC256, 25LC256, 93C86)
// are loaded separately in chipRegistry.ts and merged in.
// =========================================================================

export const CATALOG_PROFILES: ReadonlyArray<ChipProfile> = [
  ...M95_PROFILES,
  ...SPI25_PROFILES,
  ...I2C_EEPROM_PROFILES,
  ...MICROWIRE_PROFILES,
  ...SPI_NOR_PROFILES,
  ...PARALLEL_NOR_PROFILES,
  ...PARALLEL_EEPROM_PROFILES,
  ...EPROM_PROFILES,
  ...NAND_PROFILES,
  ...MCU_PROFILES,
];
