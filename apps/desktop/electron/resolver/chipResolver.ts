import Anthropic from "@anthropic-ai/sdk";

import {
  accessGuideFor,
  ChipIdentification,
  memoryTypeForFamily,
  PIN_ROLES,
  RESOLVER_FAMILIES,
  RESOLVER_PROTOCOLS,
} from "@ecu/chip-db";
import type {
  ChipConnectGuide,
  ChipFamily,
  ChipPin,
  ChipProfile,
  PinRole,
  Protocol,
} from "@ecu/chip-db";

import { getApiKey } from "../settings";

/**
 * AI chip-resolver — identification pass (Phase 4).
 *
 * Runs ONLY in the Electron main process: it holds the Anthropic API key and
 * makes the network call. The renderer sends base64 photos over IPC and gets
 * back a {@link ChipIdentification} hypothesis. The result is deliberately a
 * *draft* — the pinout (Phase 5) and on-silicon verification (Phase 6) come
 * later, before anything is trusted for an operation.
 */

export interface ResolverImage {
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
  /** One of image/jpeg, image/png, image/gif, image/webp. */
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface ResolveChipInput {
  images: ResolverImage[];
  /** The pillar the operator is working in, if known — biases the guess. */
  memoryClass?: "eeprom" | "flash";
  /** Optional operator hints. */
  markingsHint?: string;
  notes?: string;
}

export const RESOLVER_MODEL = "claude-opus-4-8";

const IDENTIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    markings: { type: "string" },
    partNumber: { type: "string" },
    manufacturer: { type: "string" },
    family: { type: "string", enum: [...RESOLVER_FAMILIES] },
    protocol: { type: "string", enum: [...RESOLVER_PROTOCOLS] },
    packageType: { type: "string" },
    voltageMin: { type: "number" },
    voltageTypical: { type: "number" },
    voltageMax: { type: "number" },
    sizeBytes: { type: "number" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reasoning: { type: "string" },
    alternates: { type: "array", items: { type: "string" } },
  },
  required: [
    "markings",
    "partNumber",
    "manufacturer",
    "family",
    "protocol",
    "packageType",
    "voltageMin",
    "voltageTypical",
    "voltageMax",
    "sizeBytes",
    "confidence",
    "reasoning",
    "alternates",
  ],
} as const;

const SYSTEM_PROMPT = `You identify memory chips used in automotive control modules (ECU, TCU, BCM, clusters) from high-resolution microscope photographs.

Your job is to read the top-surface markings (manufacturer logo, part number, date code) and from them identify the chip. The pinout is NOT derived from the photo — it comes from the part number's datasheet, so focus on reading the markings precisely.

Rules:
- Read the markings literally first. Transcribe exactly what you see into "markings", including line breaks as spaces. If a character is ambiguous, pick the most likely and lower your confidence.
- Identify the most likely full part number. Common automotive families: 24Cxx / 24LCxx (I2C EEPROM), 25xx / M95xxx (SPI EEPROM), 93Cxx (Microwire EEPROM), 25Qxx / W25Qxx / MX25Lxx / EN25xx (SPI NOR flash).
- Map to "family" using ONLY the allowed enum values; use "unknown" if you genuinely cannot tell.
- Give capacity in BYTES (e.g. a 64 Mbit W25Q64 is 8388608). Use 0 if the markings don't determine capacity.
- Voltages are the chip's operating range in volts (e.g. 1.8 / 3.3 / 3.6). Use your knowledge of the identified part.
- Be honest. If the photo is blurry or the markings are lasered faintly, say so in "reasoning" and set confidence "low". Never invent a part number you cannot support from the markings.
- "alternates" lists other plausible part numbers, best first (empty array if none).`;

function coerceIdentification(raw: unknown): ChipIdentification {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
  const family = RESOLVER_FAMILIES.includes(r.family as never)
    ? (r.family as ChipIdentification["family"])
    : "unknown";
  const protocol = RESOLVER_PROTOCOLS.includes(r.protocol as never)
    ? (r.protocol as ChipIdentification["protocol"])
    : "unknown";
  const confidence =
    r.confidence === "high" || r.confidence === "medium" ? r.confidence : "low";
  return {
    markings: str(r.markings),
    partNumber: str(r.partNumber),
    manufacturer: str(r.manufacturer),
    family,
    protocol,
    packageType: str(r.packageType),
    voltageMin: num(r.voltageMin),
    voltageTypical: num(r.voltageTypical),
    voltageMax: num(r.voltageMax),
    sizeBytes: num(r.sizeBytes),
    confidence,
    reasoning: str(r.reasoning),
    alternates: Array.isArray(r.alternates)
      ? r.alternates.filter((a): a is string => typeof a === "string")
      : [],
  };
}

/**
 * Validates an Anthropic key with a cheap, no-generation models.list() call.
 * If `key` is omitted, tests the currently effective key (env or stored).
 */
export async function testApiKey(key?: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = (key && key.trim()) || getApiKey();
  if (!apiKey) return { ok: false, error: "No API key to test." };
  try {
    const client = new Anthropic({ apiKey });
    await client.models.list();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function resolveChip(input: ResolveChipInput): Promise<ChipIdentification> {
  const apiKey = getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      "No Anthropic API key set. Open Settings and paste your key to use the AI chip resolver.",
    );
  }
  if (!input.images || input.images.length === 0) {
    throw new Error("At least one chip photo is required to resolve a chip.");
  }

  const client = new Anthropic({ apiKey });

  const contextLines: string[] = [];
  if (input.memoryClass) {
    contextLines.push(`Operator is working in the ${input.memoryClass.toUpperCase()} section.`);
  }
  if (input.markingsHint && input.markingsHint.trim()) {
    contextLines.push(`Operator partially read the marking as: "${input.markingsHint.trim()}".`);
  }
  if (input.notes && input.notes.trim()) {
    contextLines.push(`Operator notes: ${input.notes.trim()}`);
  }

  const userContent: Anthropic.ContentBlockParam[] = input.images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  userContent.push({
    type: "text",
    text:
      `Identify this memory chip from the photo(s).` +
      (contextLines.length ? `\n\nContext:\n${contextLines.join("\n")}` : ""),
  });

  const response = await client.messages.create({
    model: RESOLVER_MODEL,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: IDENTIFICATION_SCHEMA } },
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!textBlock) {
    throw new Error("The model returned no structured identification.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error("Could not parse the model's identification response.");
  }
  return coerceIdentification(parsed);
}

// ============================================================================
// Connection & soldering guide generation (text-only — no photo needed).
// ============================================================================

const GUIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    pin1: { type: "string" },
    wiring: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pin: { type: "string" },
          signal: { type: "string" },
          connectTo: { type: "string" },
          note: { type: "string" },
        },
        required: ["pin", "signal", "connectTo", "note"],
      },
    },
    asciiPinout: { type: "string" },
    soldering: { type: "array", items: { type: "string" } },
    cautions: { type: "array", items: { type: "string" } },
    toolNotes: { type: "string" },
  },
  required: ["summary", "pin1", "wiring", "asciiPinout", "soldering", "cautions", "toolNotes"],
} as const;

const GUIDE_SYSTEM = `You are an expert automotive bench technician writing a precise, safe CONNECTION & SOLDERING guide for reading/writing a specific memory or MCU chip in a control module (ECU/TCU/BCM/cluster/immobiliser).

You are given the chip's profile (part, family, protocol, package, pinout, voltage) and its ACCESS TYPE (how it is reached). Produce an accurate, hands-on guide for THIS exact part.

Rules:
- Map EVERY functional pin to where it connects on the relevant tool. Serial parts: use PicoForge GPIO (CS=GP17, MISO/SO=GP16, MOSI/SI=GP19, SCK=GP18, 3V3, GND; I²C SDA=GP26, SCL=GP27; tie SPI WP+HOLD high, I²C WP low + A0/A1/A2 to GND + 4.7k pull-ups). Parallel parts: "T48 ZIF socket pin N" and note the adapter. Debug parts: name the JTAG/SWD/BDM signal and "via CH347/probe".
- "pin1" explains how to physically find pin 1 on this package (dot/bevel/chamfer).
- "asciiPinout" is a small top-view ASCII diagram of the package with pin numbers and names.
- Voltages: this lab is 3.3 V-safe; warn explicitly if the part is 5 V-only or must not see 5 V.
- Be honest and safety-first: call out reverse-polarity risk, write-protect pins, read-protect/lock fuses, and "read twice + SHA-compare before writing".
- Keep every string concrete and skimmable. "note" may be an empty string if there's nothing to add.`;

export async function generateChipGuide(profile: ChipProfile): Promise<ChipConnectGuide> {
  const apiKey = getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("No Anthropic API key set. Open Settings and paste your key to generate a guide.");
  }
  const client = new Anthropic({ apiKey });
  const access = accessGuideFor(profile);
  const pinList = profile.pinout
    .map((p) => `  ${p.pin}. ${p.name} [${p.role}]${p.note ? ` — ${p.note}` : ""}`)
    .join("\n");

  const prompt =
    `Write the connection & soldering guide for this chip.\n\n` +
    `Part: ${profile.displayName}\n` +
    `Manufacturer: ${profile.manufacturer ?? "unknown"}\n` +
    `Family: ${profile.family}\nProtocol: ${profile.protocol}\nPackage: ${profile.package}\n` +
    `Capacity: ${profile.sizeBytes} bytes\n` +
    `Voltage: ${profile.voltage.min}–${profile.voltage.max} V (typ ${profile.voltage.typical} V)\n` +
    `Access type: ${access.label} (primary tool: ${access.primaryTool})\n` +
    `Pinout:\n${pinList}`;

  const response = await client.messages.create({
    model: RESOLVER_MODEL,
    max_tokens: 5000,
    thinking: { type: "adaptive" },
    system: GUIDE_SYSTEM,
    output_config: { format: { type: "json_schema", schema: GUIDE_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("The model returned no guide.");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(textBlock.text) as Record<string, unknown>;
  } catch {
    throw new Error("Could not parse the model's guide response.");
  }
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    summary: str(raw.summary),
    pin1: str(raw.pin1),
    wiring: Array.isArray(raw.wiring)
      ? raw.wiring.map((w) => {
          const r = (w ?? {}) as Record<string, unknown>;
          return { pin: str(r.pin), signal: str(r.signal), connectTo: str(r.connectTo), note: str(r.note) };
        })
      : [],
    asciiPinout: str(raw.asciiPinout),
    soldering: arr(raw.soldering),
    cautions: arr(raw.cautions),
    toolNotes: str(raw.toolNotes),
    generatedAt: new Date().toISOString(),
    model: RESOLVER_MODEL,
  };
}

// ============================================================================
// Scaffold a full chip profile from a part number — "type a name, get a chip".
// Text-only generation from the model's datasheet knowledge. The result is an
// ai_suggested DRAFT (untrusted for writes) the operator reviews, saves, and
// can immediately simulate.
// ============================================================================

const SCAFFOLD_FAMILIES = RESOLVER_FAMILIES.filter((f) => f !== "unknown") as ChipFamily[];
const SCAFFOLD_PROTOCOLS = RESOLVER_PROTOCOLS.filter((p) => p !== "unknown") as Protocol[];

const SCAFFOLD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    displayName: { type: "string" },
    manufacturer: { type: "string" },
    family: { type: "string", enum: [...SCAFFOLD_FAMILIES] },
    protocol: { type: "string", enum: [...SCAFFOLD_PROTOCOLS] },
    packageType: { type: "string" },
    sizeBytes: { type: "number" },
    voltageMin: { type: "number" },
    voltageTypical: { type: "number" },
    voltageMax: { type: "number" },
    pageSize: { type: "number" },
    addressBytes: { type: "number" },
    readOpcode: { type: "string" },
    maxClockHz: { type: "number" },
    canWrite: { type: "boolean" },
    canErase: { type: "boolean" },
    pinout: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pin: { type: "number" },
          name: { type: "string" },
          role: { type: "string", enum: [...PIN_ROLES] },
          note: { type: "string" },
        },
        required: ["pin", "name", "role", "note"],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reasoning: { type: "string" },
  },
  required: [
    "displayName", "manufacturer", "family", "protocol", "packageType", "sizeBytes",
    "voltageMin", "voltageTypical", "voltageMax", "pageSize", "addressBytes", "readOpcode",
    "maxClockHz", "canWrite", "canErase", "pinout", "warnings", "confidence", "reasoning",
  ],
} as const;

const SCAFFOLD_SYSTEM = `You scaffold a COMPLETE, datasheet-accurate profile for an automotive memory or microcontroller chip from its part number, using your best knowledge.

Rules:
- Identify the exact part and its real package, capacity (in BYTES), operating voltage range, and bus.
- Map "family" to the closest allowed enum value. Map "protocol" likewise (spi/i2c/microwire for serial memory; parallel for 27/28/29-series; jtag/swd/uart for MCUs).
- Provide the REAL pinout for the stated package: every pin with its number, name, a role from the allowed enum, and a short note (empty string if none). Use power/ground/chip_select/clock/mosi/miso/sda/scl/write_protect/hold/di/do/org/address/data/control/chip_enable/output_enable/write_enable/ready_busy/vpp/reset/nc appropriately.
- readOpcode: the read command for serial parts (e.g. "0x03" SPI, "0xA0" I2C) or "" for parallel/MCU. addressBytes/pageSize: realistic values (0 if N/A). maxClockHz: datasheet max SCK in Hz (0 if N/A).
- canWrite/canErase: true only if the part is field-programmable that way (EPROM canWrite=false; SPI-NOR canErase=true; EEPROM canErase=false).
- Voltages in volts. This lab is 3.3 V-safe — set the real range; a warning is added separately.
- Be honest: if you are not fully sure of the part, give the most likely values, set confidence "low"/"medium", and say what's uncertain in "reasoning". Never invent a part you don't recognise — say so in reasoning and give a best-effort generic for the family.`;

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export async function scaffoldChipFromName(input: { name: string; notes?: string }): Promise<ChipProfile> {
  const apiKey = getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("No Anthropic API key set. Open Settings and paste your key to scaffold chips with AI.");
  }
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Type a chip / processor part number to scaffold.");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: RESOLVER_MODEL,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    system: SCAFFOLD_SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCAFFOLD_SCHEMA } },
    messages: [
      {
        role: "user",
        content:
          `Scaffold the chip profile for: ${name}` +
          (input.notes && input.notes.trim() ? `\n\nOperator notes: ${input.notes.trim()}` : ""),
      },
    ],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("The model returned no chip profile.");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(textBlock.text) as Record<string, unknown>;
  } catch {
    throw new Error("Could not parse the scaffolded profile.");
  }

  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
  const family = (SCAFFOLD_FAMILIES.includes(raw.family as ChipFamily) ? raw.family : "25xxx_spi_eeprom") as ChipFamily;
  const protocol = (SCAFFOLD_PROTOCOLS.includes(raw.protocol as Protocol) ? raw.protocol : "spi") as Protocol;

  const pinout: ChipPin[] = Array.isArray(raw.pinout)
    ? raw.pinout.map((p, i) => {
        const r = (p ?? {}) as Record<string, unknown>;
        const role = (PIN_ROLES.includes(r.role as PinRole) ? r.role : "nc") as PinRole;
        const note = str(r.note);
        return { pin: num(r.pin) || i + 1, name: str(r.name) || `P${i + 1}`, role, ...(note ? { note } : {}) };
      }).filter((p) => p.name)
    : [];
  if (pinout.length === 0) {
    throw new Error("The model did not return a pinout. Try a more specific part number, or add the chip manually.");
  }

  const manufacturer = str(raw.manufacturer);
  const displayName = str(raw.displayName) || [manufacturer, name].filter(Boolean).join(" ").trim() || name;
  const idSlug = slugify([manufacturer, name].filter(Boolean).join("_")) || "chip";
  const readOpcode = str(raw.readOpcode);
  const maxClockHz = num(raw.maxClockHz);
  const sizeBytes = num(raw.sizeBytes);

  const profile: ChipProfile = {
    chipProfileId: `resolved_${idSlug}`,
    displayName,
    ...(manufacturer ? { manufacturer } : {}),
    family,
    memoryType: memoryTypeForFamily(family),
    protocol,
    package: str(raw.packageType) || "SOIC-8",
    sizeBytes: sizeBytes > 0 ? sizeBytes : 0,
    voltage: {
      min: num(raw.voltageMin) > 0 ? num(raw.voltageMin) : 1.8,
      typical: num(raw.voltageTypical) > 0 ? num(raw.voltageTypical) : 3.3,
      max: num(raw.voltageMax) > 0 ? num(raw.voltageMax) : 5.5,
    },
    pinout,
    operations: {
      read: true,
      write: raw.canWrite === true,
      erase: raw.canErase === true,
      verify: true,
    },
    warnings: [
      "AI-scaffolded profile — pinout and parameters are UNVERIFIED. Confirm against the datasheet and a real read before any write.",
      "Always read twice and compare before writing.",
      ...(Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === "string") : []),
    ],
    provenance: {
      source: "ai_resolved",
      confidence: "ai_suggested",
      createdAt: new Date().toISOString(),
      notes: str(raw.reasoning),
      evidence: { markings: name, model: RESOLVER_MODEL },
    },
  };
  if (readOpcode) {
    profile.readAlgorithm = {
      opcode: readOpcode,
      addressBytes: num(raw.addressBytes),
      pageSize: num(raw.pageSize),
      ...(maxClockHz > 0 ? { maxClockHz } : {}),
    };
  }
  return profile;
}
