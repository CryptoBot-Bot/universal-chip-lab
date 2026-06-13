import type {
  ChipFamily,
  ChipPin,
  ChipProfile,
  ChipVoltage,
  MemoryType,
  Protocol,
  SerialReadAlgorithm,
} from "./chipProfile.schema.js";

// --------------------------------------------------------------------------------------
// Pinout templates for common SOIC-8 / DIP-8 serial memories. Pin order is the
// industry-standard top-view, pin 1 at top-left, counter-clockwise.
// --------------------------------------------------------------------------------------

export const SOIC8_SPI_PINOUT: ChipPin[] = [
  { pin: 1, name: "CS",   role: "chip_select" },
  { pin: 2, name: "SO",   role: "miso", note: "Serial data out from chip" },
  { pin: 3, name: "WP",   role: "write_protect", note: "Tie HIGH (VCC) to allow writes" },
  { pin: 4, name: "GND",  role: "ground" },
  { pin: 5, name: "SI",   role: "mosi", note: "Serial data in to chip" },
  { pin: 6, name: "SCK",  role: "clock" },
  { pin: 7, name: "HOLD", role: "hold", note: "Tie HIGH (VCC) in normal operation" },
  { pin: 8, name: "VCC",  role: "power" },
];

export const SOIC8_I2C_PINOUT: ChipPin[] = [
  { pin: 1, name: "A0",  role: "address", note: "I2C slave address bit 0" },
  { pin: 2, name: "A1",  role: "address", note: "I2C slave address bit 1" },
  { pin: 3, name: "A2",  role: "address", note: "I2C slave address bit 2" },
  { pin: 4, name: "GND", role: "ground" },
  { pin: 5, name: "SDA", role: "sda", note: "Open-drain, pull-up required" },
  { pin: 6, name: "SCL", role: "scl", note: "I2C clock" },
  { pin: 7, name: "WP",  role: "write_protect", note: "Tie LOW (GND) to allow writes" },
  { pin: 8, name: "VCC", role: "power" },
];

export const SOIC8_MICROWIRE_PINOUT: ChipPin[] = [
  { pin: 1, name: "CS",  role: "chip_select", note: "Active high" },
  { pin: 2, name: "SK",  role: "clock" },
  { pin: 3, name: "DI",  role: "di",   note: "Data in to chip" },
  { pin: 4, name: "DO",  role: "do",   note: "Data out from chip" },
  { pin: 5, name: "GND", role: "ground" },
  { pin: 6, name: "ORG", role: "org",  note: "Tie LOW for x8, HIGH for x16" },
  { pin: 7, name: "NC",  role: "nc" },
  { pin: 8, name: "VCC", role: "power" },
];

export const SOIC8_SPI_NOR_PINOUT: ChipPin[] = [
  { pin: 1, name: "CS",   role: "chip_select" },
  { pin: 2, name: "DO",   role: "miso", note: "Q / SO" },
  { pin: 3, name: "WP",   role: "write_protect", note: "WP / IO2 — tie HIGH on classic 3-wire SPI" },
  { pin: 4, name: "GND",  role: "ground" },
  { pin: 5, name: "DI",   role: "mosi", note: "D / SI" },
  { pin: 6, name: "CLK",  role: "clock" },
  { pin: 7, name: "HOLD", role: "hold", note: "HOLD / IO3 — tie HIGH on classic 3-wire SPI" },
  { pin: 8, name: "VCC",  role: "power" },
];

// --------------------------------------------------------------------------------------
// Family factories. Each takes a small spec and returns a fully-populated ChipProfile.
// --------------------------------------------------------------------------------------

export interface M95Spec {
  /** e.g. 95040 → 4 kbit, 95M01 → 1 Mbit. */
  variant: "95010" | "95020" | "95040" | "95080" | "95128" | "95160" | "95256" | "95320" | "95512" | "95640" | "95M01" | "95M02";
  /** Capacity in bytes, derived from variant — but you can override. */
  manufacturer?: string;
  /** Optional override of the auto-generated displayName. */
  displayName?: string;
  /** Extra warnings appended to the family-default warnings. */
  extraWarnings?: string[];
}

const M95_BYTES: Record<M95Spec["variant"], number> = {
  "95010": 128,
  "95020": 256,
  "95040": 512,
  "95080": 1024,
  "95128": 16384, // M95128 = 128 Kbit
  "95160": 2048,
  "95256": 32768,
  "95320": 4096,
  "95512": 65536,
  "95640": 8192,
  "95M01": 131072,
  "95M02": 262144,
};

const M95_PAGE: Record<M95Spec["variant"], number> = {
  "95010": 16, "95020": 16, "95040": 16, "95080": 32,
  "95160": 32, "95320": 32, "95640": 32, "95128": 64,
  "95256": 64, "95512": 128, "95M01": 256, "95M02": 256,
};

const M95_ADDR_BYTES: Record<M95Spec["variant"], number> = {
  "95010": 1, "95020": 1, "95040": 1, "95080": 1,
  "95160": 2, "95320": 2, "95640": 2, "95128": 2,
  "95256": 2, "95512": 2, "95M01": 3, "95M02": 3,
};

export function m95Profile(spec: M95Spec): ChipProfile {
  const sizeBytes = M95_BYTES[spec.variant];
  const pageSize = M95_PAGE[spec.variant];
  const addressBytes = M95_ADDR_BYTES[spec.variant];
  const manufacturer = spec.manufacturer ?? "STMicroelectronics";
  const id = `${slug(manufacturer)}_m${spec.variant}`;
  const displayName = spec.displayName ?? `${manufacturer.split(" ")[0]} M${spec.variant}`;
  const warnings = [
    "Always read twice and compare before writing.",
    "WP and HOLD must be tied HIGH (VCC) before powering for any read.",
    ...(spec.variant === "95040" ? ["M95040 uses bit 3 of the opcode as the 9th address bit — flashrom and most tools handle this transparently."] : []),
    ...(spec.extraWarnings ?? []),
  ];
  return {
    chipProfileId: id,
    displayName,
    manufacturer,
    family: "25xxx_spi_eeprom",
    memoryType: "serial_eeprom",
    protocol: "spi",
    package: "SOIC-8",
    sizeBytes,
    voltage: { min: 1.8, typical: 3.3, max: 5.5 },
    pinout: SOIC8_SPI_PINOUT,
    operations: { read: true, write: true, erase: false, verify: true },
    readAlgorithm: { opcode: "0x03", addressBytes, pageSize },
    warnings,
  };
}

export interface I2CEepromSpec {
  /** Plain marking, e.g. "24C02", "24C256", "24LC512". */
  variant: string;
  /** Capacity in bytes. */
  sizeBytes: number;
  /** Write page size in bytes. */
  pageSize: number;
  /** Number of address bytes after the I2C slave select byte (1 or 2). */
  addressBytes: 1 | 2;
  manufacturer?: string;
  /** Override voltage range. Default Microchip 24LC: 2.5–5.5 V. */
  voltage?: ChipVoltage;
  package?: string;
  extraWarnings?: string[];
}

export function i2cEepromProfile(spec: I2CEepromSpec): ChipProfile {
  const manufacturer = spec.manufacturer ?? "Microchip";
  const id = `${slug(manufacturer)}_${slug(spec.variant)}`;
  return {
    chipProfileId: id,
    displayName: `${manufacturer.split(" ")[0]} ${spec.variant}`,
    manufacturer,
    family: "24xxx_i2c_eeprom",
    memoryType: "serial_eeprom",
    protocol: "i2c",
    package: spec.package ?? "SOIC-8",
    sizeBytes: spec.sizeBytes,
    voltage: spec.voltage ?? { min: 2.5, typical: 3.3, max: 5.5 },
    pinout: SOIC8_I2C_PINOUT,
    operations: { read: true, write: true, erase: false, verify: true },
    readAlgorithm: { opcode: "0xA0", addressBytes: spec.addressBytes, pageSize: spec.pageSize },
    warnings: [
      "Always read twice and compare before writing.",
      "I2C bus requires 4.7 kΩ pull-up resistors on SDA and SCL.",
      ...(spec.extraWarnings ?? []),
    ],
  };
}

export interface MicrowireSpec {
  variant: "93C46" | "93C56" | "93C66" | "93C76" | "93C86";
  /** Bytes when configured x8 (ORG=LOW). Auto-derived. */
  manufacturer?: string;
}

const MW_BYTES: Record<MicrowireSpec["variant"], number> = {
  "93C46": 128,
  "93C56": 256,
  "93C66": 512,
  "93C76": 1024,
  "93C86": 2048,
};

export function microwireProfile(spec: MicrowireSpec): ChipProfile {
  const manufacturer = spec.manufacturer ?? "Microchip";
  const id = `${slug(manufacturer)}_${slug(spec.variant)}`;
  return {
    chipProfileId: id,
    displayName: `${manufacturer.split(" ")[0]} ${spec.variant}`,
    manufacturer,
    family: "93xxx_microwire_eeprom",
    memoryType: "serial_eeprom",
    protocol: "microwire",
    package: "SOIC-8",
    sizeBytes: MW_BYTES[spec.variant],
    voltage: { min: 2.7, typical: 5.0, max: 5.5 },
    pinout: SOIC8_MICROWIRE_PINOUT,
    operations: { read: true, write: true, erase: true, verify: true },
    readAlgorithm: { opcode: "0x06", addressBytes: 2, pageSize: 2 },
    warnings: [
      "Always read twice and compare before writing.",
      "Confirm ORG pin matches host expectation (LOW = x8, HIGH = x16).",
      "Programming/erase needs VCC ≥ 4.5 V on most 93C parts — bench-power, do not USB-bus-power.",
    ],
  };
}

export interface SpiNorSpec {
  variant: string;             // "W25Q64", "MX25L1606E", "M25P80", …
  manufacturer: string;
  /** Total size in bytes. */
  sizeBytes: number;
  package?: string;            // default SOIC-8 (208 mil) or WSON
  /** JEDEC ID as 6-hex string (manuf+memtype+capacity), if known. */
  jedecId?: string;
  voltage?: ChipVoltage;       // default 2.7–3.6 V
  extraWarnings?: string[];
}

export function spiNorProfile(spec: SpiNorSpec): ChipProfile {
  const id = `${slug(spec.manufacturer)}_${slug(spec.variant)}`;
  return {
    chipProfileId: id,
    displayName: `${spec.manufacturer} ${spec.variant}`,
    manufacturer: spec.manufacturer,
    family: "spi_nor_flash",
    memoryType: "serial_flash",
    protocol: "spi",
    package: spec.package ?? "SOIC-8 (208 mil)",
    sizeBytes: spec.sizeBytes,
    voltage: spec.voltage ?? { min: 2.7, typical: 3.3, max: 3.6 },
    pinout: SOIC8_SPI_NOR_PINOUT,
    operations: { read: true, write: true, erase: true, verify: true },
    readAlgorithm: { opcode: "0x03", addressBytes: 3, pageSize: 256 },
    warnings: [
      "Always read twice and compare before writing.",
      "3.3 V parts only — do NOT clip with a 5 V CH341A. Use the 1.8 V adapter or a 3.3 V programmer.",
      "WP and HOLD must be tied HIGH for plain 3-wire SPI reads.",
      ...(spec.jedecId ? [`Expected JEDEC ID: 0x${spec.jedecId}`] : []),
      ...(spec.extraWarnings ?? []),
    ],
  };
}

// --------------------------------------------------------------------------------------
// Generic helpers
// --------------------------------------------------------------------------------------

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildPin({
  pin,
  name,
  role,
  note,
}: {
  pin: number;
  name: string;
  role: ChipPin["role"];
  note?: string;
}): ChipPin {
  return note !== undefined ? { pin, name, role, note } : { pin, name, role };
}

// --------------------------------------------------------------------------------------
// Generic SPI 25xx EEPROM (Microchip 25LC/25AA, Atmel/Renesas AT25). Same SOIC-8
// SPI pinout & 0x03 read opcode as the ST M95 family, different vendor naming.
// --------------------------------------------------------------------------------------

export interface Spi25Spec {
  manufacturer: string;
  variant: string;        // "25LC256", "AT25320", …
  sizeBytes: number;
  pageSize: number;
  addressBytes: 1 | 2 | 3;
  voltage?: ChipVoltage;
}

export function spi25EepromProfile(spec: Spi25Spec): ChipProfile {
  return {
    chipProfileId: `${slug(spec.manufacturer)}_${slug(spec.variant)}`,
    displayName: `${spec.manufacturer.split(" ")[0]} ${spec.variant}`,
    manufacturer: spec.manufacturer,
    family: "25xxx_spi_eeprom",
    memoryType: "serial_eeprom",
    protocol: "spi",
    package: "SOIC-8",
    sizeBytes: spec.sizeBytes,
    voltage: spec.voltage ?? { min: 2.5, typical: 3.3, max: 5.5 },
    pinout: SOIC8_SPI_PINOUT,
    operations: { read: true, write: true, erase: false, verify: true },
    readAlgorithm: { opcode: "0x03", addressBytes: spec.addressBytes, pageSize: spec.pageSize },
    warnings: [
      "Always read twice and compare before writing.",
      "WP and HOLD must be tied HIGH (VCC) before powering for any read.",
    ],
  };
}

// --------------------------------------------------------------------------------------
// PARALLEL memory pinouts (JEDEC standard). These need the address+data bus of a
// universal programmer (T48) — a 4-wire PicoForge clip cannot reach them.
// --------------------------------------------------------------------------------------

/** JEDEC 28-pin EPROM (27C256-style). Pin 1 = VPP, pin 27 = A14. */
export const EPROM_DIP28_PINOUT: ChipPin[] = [
  { pin: 1, name: "VPP", role: "vpp", note: "Programming voltage (read: tie to VCC)" },
  { pin: 2, name: "A12", role: "address" }, { pin: 3, name: "A7", role: "address" },
  { pin: 4, name: "A6", role: "address" }, { pin: 5, name: "A5", role: "address" },
  { pin: 6, name: "A4", role: "address" }, { pin: 7, name: "A3", role: "address" },
  { pin: 8, name: "A2", role: "address" }, { pin: 9, name: "A1", role: "address" },
  { pin: 10, name: "A0", role: "address" }, { pin: 11, name: "D0", role: "data" },
  { pin: 12, name: "D1", role: "data" }, { pin: 13, name: "D2", role: "data" },
  { pin: 14, name: "GND", role: "ground" }, { pin: 15, name: "D3", role: "data" },
  { pin: 16, name: "D4", role: "data" }, { pin: 17, name: "D5", role: "data" },
  { pin: 18, name: "D6", role: "data" }, { pin: 19, name: "D7", role: "data" },
  { pin: 20, name: "CE#", role: "chip_enable" }, { pin: 21, name: "A10", role: "address" },
  { pin: 22, name: "OE#", role: "output_enable" }, { pin: 23, name: "A11", role: "address" },
  { pin: 24, name: "A9", role: "address" }, { pin: 25, name: "A8", role: "address" },
  { pin: 26, name: "A13", role: "address" }, { pin: 27, name: "A14", role: "address" },
  { pin: 28, name: "VCC", role: "power" },
];

/** JEDEC 28-pin parallel EEPROM (28C256-style). Pin 1 = A14, pin 27 = WE#. */
export const PEEPROM_DIP28_PINOUT: ChipPin[] = [
  { pin: 1, name: "A14", role: "address" },
  { pin: 2, name: "A12", role: "address" }, { pin: 3, name: "A7", role: "address" },
  { pin: 4, name: "A6", role: "address" }, { pin: 5, name: "A5", role: "address" },
  { pin: 6, name: "A4", role: "address" }, { pin: 7, name: "A3", role: "address" },
  { pin: 8, name: "A2", role: "address" }, { pin: 9, name: "A1", role: "address" },
  { pin: 10, name: "A0", role: "address" }, { pin: 11, name: "D0", role: "data" },
  { pin: 12, name: "D1", role: "data" }, { pin: 13, name: "D2", role: "data" },
  { pin: 14, name: "GND", role: "ground" }, { pin: 15, name: "D3", role: "data" },
  { pin: 16, name: "D4", role: "data" }, { pin: 17, name: "D5", role: "data" },
  { pin: 18, name: "D6", role: "data" }, { pin: 19, name: "D7", role: "data" },
  { pin: 20, name: "CE#", role: "chip_enable" }, { pin: 21, name: "A10", role: "address" },
  { pin: 22, name: "OE#", role: "output_enable" }, { pin: 23, name: "A11", role: "address" },
  { pin: 24, name: "A9", role: "address" }, { pin: 25, name: "A8", role: "address" },
  { pin: 26, name: "A13", role: "address" }, { pin: 27, name: "WE#", role: "write_enable" },
  { pin: 28, name: "VCC", role: "power" },
];

/** JEDEC 32-pin parallel NOR flash (29F010/39SF0x0-style). */
export const PNOR_DIP32_PINOUT: ChipPin[] = [
  { pin: 1, name: "A18", role: "address" }, { pin: 2, name: "A16", role: "address" },
  { pin: 3, name: "A15", role: "address" }, { pin: 4, name: "A12", role: "address" },
  { pin: 5, name: "A7", role: "address" }, { pin: 6, name: "A6", role: "address" },
  { pin: 7, name: "A5", role: "address" }, { pin: 8, name: "A4", role: "address" },
  { pin: 9, name: "A3", role: "address" }, { pin: 10, name: "A2", role: "address" },
  { pin: 11, name: "A1", role: "address" }, { pin: 12, name: "A0", role: "address" },
  { pin: 13, name: "D0", role: "data" }, { pin: 14, name: "D1", role: "data" },
  { pin: 15, name: "D2", role: "data" }, { pin: 16, name: "GND", role: "ground" },
  { pin: 17, name: "D3", role: "data" }, { pin: 18, name: "D4", role: "data" },
  { pin: 19, name: "D5", role: "data" }, { pin: 20, name: "D6", role: "data" },
  { pin: 21, name: "D7", role: "data" }, { pin: 22, name: "CE#", role: "chip_enable" },
  { pin: 23, name: "A10", role: "address" }, { pin: 24, name: "OE#", role: "output_enable" },
  { pin: 25, name: "A11", role: "address" }, { pin: 26, name: "A9", role: "address" },
  { pin: 27, name: "A8", role: "address" }, { pin: 28, name: "A13", role: "address" },
  { pin: 29, name: "A14", role: "address" }, { pin: 30, name: "A17", role: "address" },
  { pin: 31, name: "WE#", role: "write_enable" }, { pin: 32, name: "VCC", role: "power" },
];

/** JEDEC 32-pin EPROM (27C010-style). Pin 1 = VPP, pin 31 = PGM#. */
export const EPROM_DIP32_PINOUT: ChipPin[] = [
  { pin: 1, name: "VPP", role: "vpp", note: "read: tie to VCC" },
  { pin: 2, name: "A16", role: "address" }, { pin: 3, name: "A15", role: "address" },
  { pin: 4, name: "A12", role: "address" }, { pin: 5, name: "A7", role: "address" },
  { pin: 6, name: "A6", role: "address" }, { pin: 7, name: "A5", role: "address" },
  { pin: 8, name: "A4", role: "address" }, { pin: 9, name: "A3", role: "address" },
  { pin: 10, name: "A2", role: "address" }, { pin: 11, name: "A1", role: "address" },
  { pin: 12, name: "A0", role: "address" }, { pin: 13, name: "D0", role: "data" },
  { pin: 14, name: "D1", role: "data" }, { pin: 15, name: "D2", role: "data" },
  { pin: 16, name: "GND", role: "ground" }, { pin: 17, name: "D3", role: "data" },
  { pin: 18, name: "D4", role: "data" }, { pin: 19, name: "D5", role: "data" },
  { pin: 20, name: "D6", role: "data" }, { pin: 21, name: "D7", role: "data" },
  { pin: 22, name: "CE#", role: "chip_enable" }, { pin: 23, name: "A10", role: "address" },
  { pin: 24, name: "OE#", role: "output_enable" }, { pin: 25, name: "A11", role: "address" },
  { pin: 26, name: "A9", role: "address" }, { pin: 27, name: "A8", role: "address" },
  { pin: 28, name: "A13", role: "address" }, { pin: 29, name: "A14", role: "address" },
  { pin: 30, name: "NC", role: "nc" }, { pin: 31, name: "PGM#", role: "control" },
  { pin: 32, name: "VCC", role: "power" },
];

/** Representative x8 NAND (TSOP-48) — functional pins only. */
export const NAND_TSOP48_PINOUT: ChipPin[] = [
  { pin: 1, name: "IO0", role: "data" }, { pin: 2, name: "IO1", role: "data" },
  { pin: 3, name: "IO2", role: "data" }, { pin: 4, name: "IO3", role: "data" },
  { pin: 5, name: "IO4", role: "data" }, { pin: 6, name: "IO5", role: "data" },
  { pin: 7, name: "IO6", role: "data" }, { pin: 8, name: "IO7", role: "data" },
  { pin: 9, name: "CLE", role: "control", note: "Command latch enable" },
  { pin: 10, name: "ALE", role: "control", note: "Address latch enable" },
  { pin: 11, name: "CE#", role: "chip_enable" }, { pin: 12, name: "RE#", role: "output_enable" },
  { pin: 13, name: "WE#", role: "write_enable" }, { pin: 14, name: "WP#", role: "write_protect" },
  { pin: 15, name: "R/B#", role: "ready_busy" }, { pin: 16, name: "VCC", role: "power" },
  { pin: 17, name: "VSS", role: "ground" },
];

/** BDM single-wire debug header (Freescale/NXP S12/HC12). */
export const MCU_BDM_PINOUT: ChipPin[] = [
  { pin: 1, name: "BKGD", role: "control", note: "Single-wire background debug" },
  { pin: 2, name: "GND", role: "ground" },
  { pin: 4, name: "RESET", role: "reset" },
  { pin: 6, name: "VDD", role: "power", note: "VTref sense" },
];

/** JTAG/SWD debug header (ARM Cortex, TriCore, …). */
export const MCU_JTAG_PINOUT: ChipPin[] = [
  { pin: 1, name: "VREF", role: "power", note: "Target IO voltage" },
  { pin: 2, name: "TMS/SWDIO", role: "control" },
  { pin: 3, name: "GND", role: "ground" },
  { pin: 4, name: "TCK/SWCLK", role: "clock" },
  { pin: 6, name: "TDO/SWO", role: "do" },
  { pin: 8, name: "TDI", role: "di" },
  { pin: 10, name: "RESET", role: "reset" },
];

// --------------------------------------------------------------------------------------
// PARALLEL / EPROM / NAND / MCU factories.
// --------------------------------------------------------------------------------------

const T48_PARALLEL_WARNINGS = [
  "Parallel memory — read/write with the T48 (XGecu) universal programmer, not PicoForge.",
  "PLCC packages: use the matching PLCC→DIP adapter; mind pin-1 (chamfered corner). Verify the exact device in the T48 software.",
  "Always read twice and compare before writing.",
];

export interface ParallelSpec {
  manufacturer: string;
  variant: string;
  sizeBytes: number;
  package?: string;        // "DIP-32", "PLCC-32", "TSOP-32"…
  voltage?: ChipVoltage;
  extraWarnings?: string[];
}

export function parallelNorProfile(spec: ParallelSpec): ChipProfile {
  return {
    chipProfileId: `${slug(spec.manufacturer)}_${slug(spec.variant)}_${slug(spec.package ?? "dip32")}`,
    displayName: `${spec.manufacturer.split(" ")[0]} ${spec.variant}`,
    manufacturer: spec.manufacturer,
    family: "parallel_nor_flash",
    memoryType: "parallel_flash",
    protocol: "parallel",
    package: spec.package ?? "DIP-32",
    sizeBytes: spec.sizeBytes,
    voltage: spec.voltage ?? { min: 4.5, typical: 5.0, max: 5.5 },
    pinout: PNOR_DIP32_PINOUT,
    operations: { read: true, write: true, erase: true, verify: true },
    warnings: [...T48_PARALLEL_WARNINGS, ...(spec.extraWarnings ?? [])],
  };
}

export function parallelEepromProfile(spec: ParallelSpec): ChipProfile {
  return {
    chipProfileId: `${slug(spec.manufacturer)}_${slug(spec.variant)}_${slug(spec.package ?? "dip28")}`,
    displayName: `${spec.manufacturer.split(" ")[0]} ${spec.variant}`,
    manufacturer: spec.manufacturer,
    family: "parallel_eeprom",
    memoryType: "parallel_eeprom",
    protocol: "parallel",
    package: spec.package ?? "DIP-28",
    sizeBytes: spec.sizeBytes,
    voltage: spec.voltage ?? { min: 4.5, typical: 5.0, max: 5.5 },
    pinout: PEEPROM_DIP28_PINOUT,
    operations: { read: true, write: true, erase: false, verify: true },
    warnings: [...T48_PARALLEL_WARNINGS, ...(spec.extraWarnings ?? [])],
  };
}

export function epromProfile(spec: ParallelSpec): ChipProfile {
  const pkg = spec.package ?? "DIP-28";
  const pinout = pkg.includes("32") ? EPROM_DIP32_PINOUT : EPROM_DIP28_PINOUT;
  return {
    chipProfileId: `${slug(spec.manufacturer)}_${slug(spec.variant)}_${slug(pkg)}`,
    displayName: `${spec.manufacturer.split(" ")[0]} ${spec.variant}`,
    manufacturer: spec.manufacturer,
    family: "parallel_eprom",
    memoryType: "eprom",
    protocol: "parallel",
    package: pkg,
    sizeBytes: spec.sizeBytes,
    voltage: spec.voltage ?? { min: 4.5, typical: 5.0, max: 5.5 },
    pinout,
    operations: { read: true, write: false, erase: false, verify: true },
    warnings: [
      ...T48_PARALLEL_WARNINGS,
      "EPROM is read-only on the T48: a windowed (CERDIP) part is erased only by UV light; OTP plastic parts cannot be erased at all.",
      ...(spec.extraWarnings ?? []),
    ],
  };
}

export function nandProfile(spec: ParallelSpec): ChipProfile {
  return {
    chipProfileId: `${slug(spec.manufacturer)}_${slug(spec.variant)}_${slug(spec.package ?? "tsop48")}`,
    displayName: `${spec.manufacturer.split(" ")[0]} ${spec.variant}`,
    manufacturer: spec.manufacturer,
    family: "nand_flash",
    memoryType: "nand_flash",
    protocol: "parallel",
    package: spec.package ?? "TSOP-48",
    sizeBytes: spec.sizeBytes,
    voltage: spec.voltage ?? { min: 2.7, typical: 3.3, max: 3.6 },
    pinout: NAND_TSOP48_PINOUT,
    operations: { read: true, write: true, erase: true, verify: true },
    warnings: [
      "NAND flash — T48 with a TSOP-48 adapter. Dumps include spare/OOB bytes.",
      "Has bad blocks and needs ECC handling; a raw dump is not directly a filesystem.",
      "Always read twice and compare before writing.",
      ...(spec.extraWarnings ?? []),
    ],
  };
}

export type McuInterface = "bdm" | "jtag" | "swd" | "bootloader";

export interface McuSpec {
  manufacturer: string;
  variant: string;
  sizeBytes: number;
  package: string;          // "PLCC-44", "QFP-144", "LQFP-100"…
  iface: McuInterface;
  family?: "mcu_internal_flash" | "mcu_internal_eeprom";
  voltage?: ChipVoltage;
  note?: string;
}

export function mcuProfile(spec: McuSpec): ChipProfile {
  const protocol: Protocol =
    spec.iface === "swd" ? "swd" :
    spec.iface === "bootloader" ? "uart" :
    spec.iface === "bdm" ? "jtag" : "jtag"; // BDM modelled under the jtag/debug umbrella
  const pinout = spec.iface === "bdm" ? MCU_BDM_PINOUT : MCU_JTAG_PINOUT;
  const ifaceLabel = spec.iface.toUpperCase();
  return {
    chipProfileId: `${slug(spec.manufacturer)}_${slug(spec.variant)}`,
    displayName: `${spec.manufacturer.split(" ")[0]} ${spec.variant}`,
    manufacturer: spec.manufacturer,
    family: spec.family ?? "mcu_internal_flash",
    memoryType: spec.family === "mcu_internal_eeprom" ? "mcu_eeprom" : "mcu_flash",
    protocol,
    package: spec.package,
    sizeBytes: spec.sizeBytes,
    voltage: spec.voltage ?? { min: 3.0, typical: 3.3, max: 5.25 },
    pinout,
    operations: { read: true, write: true, erase: true, verify: true },
    warnings: [
      `Internal MCU memory — NOT on external pins. Read via ${ifaceLabel} using the mcu-debugger board (BDM/JTAG/bootloader), or a T48 socket if the device is in its list.`,
      "May be read-protected / locked — needs a chip-specific unlock or boot-mode procedure before the memory is readable.",
      ...(spec.note ? [spec.note] : []),
    ],
  };
}

export function customProfile(p: {
  id: string;
  displayName: string;
  manufacturer: string;
  family: ChipFamily;
  memoryType: MemoryType;
  protocol: Protocol;
  package: string;
  sizeBytes: number;
  voltage: ChipVoltage;
  pinout: ChipPin[];
  readAlgorithm?: SerialReadAlgorithm;
  warnings?: string[];
  canWrite?: boolean;
  canErase?: boolean;
}): ChipProfile {
  const profile: ChipProfile = {
    chipProfileId: p.id,
    displayName: p.displayName,
    manufacturer: p.manufacturer,
    family: p.family,
    memoryType: p.memoryType,
    protocol: p.protocol,
    package: p.package,
    sizeBytes: p.sizeBytes,
    voltage: p.voltage,
    pinout: p.pinout,
    operations: {
      read: true,
      write: p.canWrite ?? true,
      erase: p.canErase ?? false,
      verify: true,
    },
    warnings: p.warnings ?? [],
  };
  if (p.readAlgorithm) profile.readAlgorithm = p.readAlgorithm;
  return profile;
}
