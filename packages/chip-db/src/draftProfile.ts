import type {
  ChipFamily,
  ChipPin,
  ChipProfile,
  PinRole,
  SerialReadAlgorithm,
} from "./chipProfile.schema.js";
import {
  SOIC8_I2C_PINOUT,
  SOIC8_MICROWIRE_PINOUT,
  SOIC8_SPI_NOR_PINOUT,
  SOIC8_SPI_PINOUT,
} from "./factories.js";
import type { MemoryClass } from "./memoryClass.js";
import { ChipIdentification, memoryTypeForFamily } from "./resolverTypes.js";

/** All pin roles, for the manual pinout editor's role picker. */
export const PIN_ROLES: readonly PinRole[] = [
  "power",
  "ground",
  "chip_select",
  "clock",
  "mosi",
  "miso",
  "sda",
  "scl",
  "write_protect",
  "hold",
  "reset",
  "do",
  "di",
  "org",
  "nc",
  "address",
  "data",
  "control",
  "chip_enable",
  "output_enable",
  "write_enable",
  "ready_busy",
  "vpp",
];

export type PinoutTemplateId = "i2c_eeprom" | "spi_eeprom" | "microwire" | "spi_nor";

export interface PinoutTemplate {
  id: PinoutTemplateId;
  label: string;
  pinout: ChipPin[];
}

export const PINOUT_TEMPLATES: readonly PinoutTemplate[] = [
  { id: "i2c_eeprom", label: "I²C EEPROM (24Cxx)", pinout: SOIC8_I2C_PINOUT },
  { id: "spi_eeprom", label: "SPI EEPROM (25xx / M95)", pinout: SOIC8_SPI_PINOUT },
  { id: "microwire", label: "Microwire (93Cxx)", pinout: SOIC8_MICROWIRE_PINOUT },
  { id: "spi_nor", label: "SPI-NOR Flash (25Qxx)", pinout: SOIC8_SPI_NOR_PINOUT },
];

const READ_ALGORITHMS: Record<PinoutTemplateId, SerialReadAlgorithm> = {
  i2c_eeprom: { opcode: "0xA0", addressBytes: 1, pageSize: 16 },
  spi_eeprom: { opcode: "0x03", addressBytes: 2, pageSize: 32 },
  microwire: { opcode: "0x06", addressBytes: 2, pageSize: 2 },
  spi_nor: { opcode: "0x03", addressBytes: 3, pageSize: 256 },
};

const TEMPLATE_PROTOCOL: Record<PinoutTemplateId, ChipProfile["protocol"]> = {
  i2c_eeprom: "i2c",
  spi_eeprom: "spi",
  microwire: "microwire",
  spi_nor: "spi",
};

function templateForFamily(family: ChipFamily): PinoutTemplateId {
  switch (family) {
    case "24xxx_i2c_eeprom":
      return "i2c_eeprom";
    case "25xxx_spi_eeprom":
      return "spi_eeprom";
    case "93xxx_microwire_eeprom":
      return "microwire";
    case "spi_nor_flash":
    case "parallel_nor_flash":
    case "parallel_eeprom":
    case "parallel_eprom":
    case "nand_flash":
    case "mcu_internal_flash":
    case "mcu_internal_eeprom":
      // The photo-resolver drafts serial profiles; non-serial families fall back
      // to a neutral template the operator edits. (Parallel/MCU chips are added
      // from the catalog, not the resolver.)
      return "spi_nor";
  }
}

function familyForTemplate(id: PinoutTemplateId): ChipFamily {
  switch (id) {
    case "i2c_eeprom":
      return "24xxx_i2c_eeprom";
    case "spi_eeprom":
      return "25xxx_spi_eeprom";
    case "microwire":
      return "93xxx_microwire_eeprom";
    case "spi_nor":
      return "spi_nor_flash";
  }
}

/** Best-effort family from an identification, falling back to the pillar. */
function resolveFamily(id: ChipIdentification, fallback?: MemoryClass): ChipFamily {
  if (id.family !== "unknown") return id.family;
  if (id.protocol === "i2c") return "24xxx_i2c_eeprom";
  if (id.protocol === "microwire") return "93xxx_microwire_eeprom";
  if (id.protocol === "spi") return fallback === "flash" ? "spi_nor_flash" : "25xxx_spi_eeprom";
  return fallback === "flash" ? "spi_nor_flash" : "24xxx_i2c_eeprom";
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function clonePinout(pins: ChipPin[]): ChipPin[] {
  return pins.map((p) => ({ ...p }));
}

export interface DraftProfileOptions {
  /** ISO timestamp for provenance.createdAt (callers pass new Date().toISOString()). */
  createdAt: string;
  /** Force a specific pinout template; otherwise inferred from the family. */
  templateId?: PinoutTemplateId;
  /** Pillar the operator was in, used when the family is unknown. */
  fallbackClass?: MemoryClass;
  /** Model id that produced the identification, recorded in provenance. */
  model?: string;
  /** Photo references to record as evidence. */
  photoRefs?: string[];
}

/**
 * Builds an editable DRAFT chip profile from an AI identification. The pinout
 * is the standard template for the family — a *starting point* the operator
 * corrects by hand. Confidence is `ai_suggested`, so {@link isWriteTrusted}
 * keeps it out of any write path until it's verified on real silicon.
 *
 * `sizeBytes` may be 0 when the photo didn't reveal capacity; callers must
 * collect a positive size before this passes {@link validateChipProfile}.
 */
export function draftProfileFromIdentification(
  id: ChipIdentification,
  opts: DraftProfileOptions,
): ChipProfile {
  const family = opts.templateId
    ? familyForTemplate(opts.templateId)
    : resolveFamily(id, opts.fallbackClass);
  const templateId = opts.templateId ?? templateForFamily(family);
  const template = PINOUT_TEMPLATES.find((t) => t.id === templateId)!;

  const displayName =
    [id.manufacturer, id.partNumber].filter(Boolean).join(" ").trim() ||
    "Unidentified chip";
  const idSlug = slug([id.manufacturer, id.partNumber].filter(Boolean).join("_"));
  const chipProfileId = `resolved_${idSlug || "chip"}`;

  const voltage = {
    min: id.voltageMin > 0 ? id.voltageMin : 1.8,
    typical: id.voltageTypical > 0 ? id.voltageTypical : 3.3,
    max: id.voltageMax > 0 ? id.voltageMax : 5.5,
  };

  return {
    chipProfileId,
    displayName,
    manufacturer: id.manufacturer || undefined,
    family,
    memoryType: memoryTypeForFamily(family),
    protocol: id.protocol !== "unknown" ? id.protocol : TEMPLATE_PROTOCOL[templateId],
    package: id.packageType || "SOIC-8",
    sizeBytes: id.sizeBytes > 0 ? id.sizeBytes : 0,
    voltage,
    pinout: clonePinout(template.pinout),
    operations: {
      read: true,
      write: true,
      erase: family === "spi_nor_flash" || family === "93xxx_microwire_eeprom",
      verify: true,
    },
    readAlgorithm: READ_ALGORITHMS[templateId],
    warnings: [
      "AI-suggested profile — pinout and parameters are UNVERIFIED. Confirm against the chip's electronic signature and a real read before any write.",
      "Always read twice and compare before writing.",
    ],
    provenance: {
      source: "ai_resolved",
      confidence: "ai_suggested",
      createdAt: opts.createdAt,
      notes: id.reasoning,
      evidence: {
        markings: id.markings || undefined,
        model: opts.model,
        photoRefs: opts.photoRefs,
      },
    },
  };
}
