import Anthropic from "@anthropic-ai/sdk";

import {
  ChipIdentification,
  RESOLVER_FAMILIES,
  RESOLVER_PROTOCOLS,
} from "@ecu/chip-db";

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

export async function resolveChip(input: ResolveChipInput): Promise<ChipIdentification> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to your .env file to use the AI chip resolver.",
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
