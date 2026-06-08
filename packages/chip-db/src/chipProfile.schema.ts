export type Protocol =
  | "i2c"
  | "spi"
  | "microwire"
  | "uart"
  | "can"
  | "jtag"
  | "swd";

export type ChipFamily =
  | "24xxx_i2c_eeprom"
  | "25xxx_spi_eeprom"
  | "93xxx_microwire_eeprom"
  | "spi_nor_flash"
  | "mcu_internal_flash"
  | "mcu_internal_eeprom";

export type MemoryType =
  | "serial_eeprom"
  | "parallel_eeprom"
  | "serial_flash"
  | "parallel_flash"
  | "mcu_flash"
  | "mcu_eeprom";

export type PinRole =
  | "power"
  | "ground"
  | "chip_select"
  | "clock"
  | "mosi"
  | "miso"
  | "sda"
  | "scl"
  | "write_protect"
  | "hold"
  | "reset"
  | "do"
  | "di"
  | "org"
  | "nc"
  | "address"
  | "data"
  | "control";

export interface ChipPin {
  pin: number;
  name: string;
  role: PinRole;
  note?: string;
}

export interface ChipVoltage {
  min: number;
  typical: number;
  max: number;
}

export interface ChipOperations {
  read: boolean;
  write: boolean;
  erase: boolean;
  verify: boolean;
}

export interface SerialReadAlgorithm {
  /** Opcode used when sending a "read" command, hex literal. */
  opcode: string;
  /** Number of address bytes following the opcode. */
  addressBytes: number;
  /** Page size in bytes (relevant for writes; informational for reads). */
  pageSize: number;
}

/** Where a profile came from. Drives trust and how it is persisted. */
export type ChipProfileSource =
  | "seed" // shipped seed JSON / catalog factory
  | "operator" // hand-authored by the operator
  | "ai_resolved"; // produced by the AI chip-resolver

/**
 * How much we trust this profile against real silicon. Ascending order of
 * trust. WRITE workflows should refuse anything below `bench_verified`.
 */
export type ChipConfidence =
  | "unverified" // exists but never confirmed against a real chip
  | "ai_suggested" // AI proposed it from a photo; pinout NOT yet trusted
  | "bench_verified" // pinout confirmed by a real ID read / continuity check
  | "clone_proven"; // a clone made with this profile booted a real module

/** Evidence gathered while resolving a previously-unknown chip. */
export interface ChipResolverEvidence {
  /** Raw top-marking text read from the chip photo. */
  markings?: string;
  /** Electronic signature, e.g. SPI JEDEC ID "EF 40 17" or an I2C address. */
  electronicSignature?: string;
  /** Workspace-relative paths to the microscope photos used. */
  photoRefs?: string[];
  /** Model id that produced an AI suggestion, e.g. "claude-opus-4-8". */
  model?: string;
}

/** Origin, trust level, and audit trail for a chip profile. */
export interface ChipProvenance {
  source: ChipProfileSource;
  confidence: ChipConfidence;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt?: string;
  /** Free-form operator notes. */
  notes?: string;
  /** Evidence gathered while resolving an unknown chip. */
  evidence?: ChipResolverEvidence;
}

export const CHIP_PROFILE_SOURCES: readonly ChipProfileSource[] = [
  "seed",
  "operator",
  "ai_resolved",
];

export const CHIP_CONFIDENCE_LEVELS: readonly ChipConfidence[] = [
  "unverified",
  "ai_suggested",
  "bench_verified",
  "clone_proven",
];

export interface ChipProfile {
  chipProfileId: string;
  displayName: string;
  manufacturer?: string;
  family: ChipFamily;
  memoryType: MemoryType;
  protocol: Protocol;
  package: string;
  sizeBytes: number;
  voltage: ChipVoltage;
  pinout: ChipPin[];
  operations: ChipOperations;
  readAlgorithm?: SerialReadAlgorithm;
  warnings: string[];
  /**
   * Origin and trust metadata. Optional for backward compatibility — seed
   * profiles without it are treated as built-in `seed` / `bench_verified`
   * by {@link effectiveProvenance}.
   */
  provenance?: ChipProvenance;
}

export type ChipProfileMap = Record<string, ChipProfile>;

export function validateChipProfile(profile: unknown): asserts profile is ChipProfile {
  if (typeof profile !== "object" || profile === null) {
    throw new Error("Chip profile must be an object.");
  }
  const p = profile as Record<string, unknown>;
  const required = [
    "chipProfileId",
    "displayName",
    "family",
    "memoryType",
    "protocol",
    "package",
    "sizeBytes",
    "voltage",
    "pinout",
    "operations",
    "warnings",
  ];
  for (const key of required) {
    if (!(key in p)) {
      throw new Error(`Chip profile is missing required field: ${key}`);
    }
  }
  if (!Array.isArray(p.pinout) || p.pinout.length === 0) {
    throw new Error("Chip profile pinout must be a non-empty array.");
  }
  const v = p.voltage as Partial<ChipVoltage>;
  if (
    typeof v.min !== "number" ||
    typeof v.typical !== "number" ||
    typeof v.max !== "number" ||
    v.min > v.max
  ) {
    throw new Error("Chip profile voltage range is invalid.");
  }
  if (typeof p.sizeBytes !== "number" || p.sizeBytes <= 0) {
    throw new Error("Chip profile sizeBytes must be a positive number.");
  }
  if (p.provenance !== undefined) {
    const prov = p.provenance as Partial<ChipProvenance>;
    if (typeof prov !== "object" || prov === null) {
      throw new Error("Chip profile provenance must be an object when present.");
    }
    if (!CHIP_PROFILE_SOURCES.includes(prov.source as ChipProfileSource)) {
      throw new Error(`Chip profile provenance.source is invalid: ${String(prov.source)}`);
    }
    if (!CHIP_CONFIDENCE_LEVELS.includes(prov.confidence as ChipConfidence)) {
      throw new Error(
        `Chip profile provenance.confidence is invalid: ${String(prov.confidence)}`,
      );
    }
    if (typeof prov.createdAt !== "string" || prov.createdAt.length === 0) {
      throw new Error("Chip profile provenance.createdAt must be a non-empty string.");
    }
  }
}

/**
 * Returns the profile's provenance, synthesising a built-in default for
 * legacy seed profiles that predate the provenance block. Built-in profiles
 * are treated as the most trusted tier so existing workflows are unchanged.
 */
export function effectiveProvenance(profile: ChipProfile): ChipProvenance {
  if (profile.provenance) return profile.provenance;
  return {
    source: "seed",
    confidence: "bench_verified",
    createdAt: "1970-01-01T00:00:00.000Z",
    notes: "Built-in profile (provenance synthesised).",
  };
}

/** True when a profile's pinout is trusted enough to drive a WRITE workflow. */
export function isWriteTrusted(profile: ChipProfile): boolean {
  const c = effectiveProvenance(profile).confidence;
  return c === "bench_verified" || c === "clone_proven";
}
