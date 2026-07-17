import Anthropic from "@anthropic-ai/sdk";

import { getApiKey } from "../settings";

/**
 * AI module mapper — the "brain" behind Bench Module Master. Given photo(s) of an
 * automotive control module (the connector / label / board) plus whatever the
 * operator types about it, it produces a bench HOOKUP GUIDE: how to power and wake
 * it (12V / ignition / ground), which pins are CAN-H / CAN-L / K-line, the bus id
 * and speed to use, and what you can DO with it once it's alive.
 *
 * It mirrors the chip resolver's image-in recipe (claude-opus-4-8, base64 image
 * blocks, adaptive thinking, server-side JSON schema) and the vehicle mapper's
 * honesty rules. Output is a DRAFT at `ai_suggested` trust — a real bench session
 * promotes it to `bench_verified`; an AI guess never authorises a write.
 */

export interface MapperImage {
  data: string;   // base64, NO data: prefix
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface MapModuleInput {
  images: MapperImage[];
  description: string;   // free text: model/part number/vehicle the operator typed
}

const HOOKUP_SIGNALS = ["power", "ignition", "ground", "can_h", "can_l", "kline", "lin", "wake", "flexray", "other"] as const;
const CATEGORIES = ["ecm", "tcm", "abs", "srs", "bcm", "ipc", "hvac", "gateway", "immo", "eps", "adas", "radio", "other"] as const;
const BUS_PROTOCOLS = ["uds", "kwp2000", "obd2", "canfd", "kline", "unknown"] as const;
const CONFIDENCE = ["low", "medium", "high"] as const;

export interface MappedHookupPin {
  pin: string;
  signal: (typeof HOOKUP_SIGNALS)[number];
  connectTo: string;
  required: boolean;
  note: string;
}

export interface MappedBus {
  name: string;
  protocol: (typeof BUS_PROTOCOLS)[number];
  bitrate: number;
  requestId: string;
  responseId: string;
  termination: boolean;
}

export interface ModuleMapResult {
  displayName: string;
  brand: string;
  category: (typeof CATEGORIES)[number];
  partNumbers: string[];
  applications: string[];
  powerNote: string;
  hookup: MappedHookupPin[];
  buses: MappedBus[];
  asciiConnector: string;
  cautions: string[];
  references: { label: string; url: string }[];
  capabilities: string[];
  knownDtcs: { code: string; desc: string }[];
  confidence: (typeof CONFIDENCE)[number];
  rationale: string;
}

export const MODULE_MAP_MODEL = "claude-opus-4-8";

const PIN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pin: { type: "string" },
    signal: { type: "string", enum: [...HOOKUP_SIGNALS] },
    connectTo: { type: "string" },
    required: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["pin", "signal", "connectTo", "required", "note"],
} as const;

const BUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    protocol: { type: "string", enum: [...BUS_PROTOCOLS] },
    bitrate: { type: "number" },
    requestId: { type: "string" },
    responseId: { type: "string" },
    termination: { type: "boolean" },
  },
  required: ["name", "protocol", "bitrate", "requestId", "responseId", "termination"],
} as const;

const MAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    displayName: { type: "string" },
    brand: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    partNumbers: { type: "array", items: { type: "string" } },
    applications: { type: "array", items: { type: "string" } },
    powerNote: { type: "string" },
    hookup: { type: "array", items: PIN_SCHEMA },
    buses: { type: "array", items: BUS_SCHEMA },
    asciiConnector: { type: "string" },
    cautions: { type: "array", items: { type: "string" } },
    references: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: { label: { type: "string" }, url: { type: "string" } },
        required: ["label", "url"],
      },
    },
    capabilities: { type: "array", items: { type: "string" } },
    knownDtcs: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: { code: { type: "string" }, desc: { type: "string" } },
        required: ["code", "desc"],
      },
    },
    confidence: { type: "string", enum: [...CONFIDENCE] },
    rationale: { type: "string" },
  },
  required: [
    "displayName", "brand", "category", "partNumbers", "applications", "powerNote",
    "hookup", "buses", "asciiConnector", "cautions", "references", "capabilities",
    "knownDtcs", "confidence", "rationale",
  ],
} as const;

const SYSTEM_PROMPT = `You are an expert automotive control-module bench technician. From photo(s) of a control module (its case, connector, PCB, and printed labels) plus whatever the operator typed, produce a SAFE BENCH HOOKUP GUIDE so they can power the module on the bench and talk to it over its diagnostic bus.

Read the printed markings first: part numbers, supplier logos (Bosch, Continental/Siemens VDO, Denso, Aisin, Delphi, Marelli, Valeo, Hitachi, TRW, ZF), hardware/software numbers, and any connector/pin legend. Identify the module type from the markings AND the physical form (connector style, heatsink, board).

For the hookup, determine every pin you can justify:
- power: permanent 12V battery positive (B+).
- ignition: switched/KL15 12V — MANY modules will not wake their CAN transceiver or respond to diagnostics without it. Flag it required when the module type needs it.
- ground: chassis/power ground.
- can_h / can_l: the diagnostic CAN pair. State the bus name and speed.
- kline: ISO 9141 / KWP K-line for older modules.
- Mark 'required' true only for pins needed to power up and get a diagnostic response.

For buses: give the protocol (uds if 0x22/0x19/0x2E era, kwp2000 for 0x21/0x81 era K-line/CAN, obd2, canfd, else unknown), a typical bitrate (500000 HS-CAN, 125000 MS-CAN, 10400 K-line), and the likely diagnostic request/response id pair (hex, e.g. 7E0/7E8 for engine, 7E1/7E9 transmission, 7Ex powertrain) — say so in rationale when it's an estimate.

asciiConnector: draw a simple ASCII diagram of the connector with the key pins labelled, top-view, so the operator can find them.

capabilities: concrete things you can DO on the bench once connected (read ECU id/part number, read/clear DTCs, read live data appropriate to the module, read adaptation, bench memory dump for clone). Bias to reads; call out writes/actuators as risky.

knownDtcs: DTCs commonly seen on this module type, if you know them (code + short description). [] if unsure.

BE HONEST AND SAFE:
- If you cannot read a part number or are unsure of the module, lower confidence and SAY the pinout is UNVERIFIED — the operator must confirm pin 1 and continuity with a meter before applying 12V. Wrong power/ground polarity can destroy the module.
- Never invent a specific pinout you cannot justify from the photo/markings/module type. Use "other" signal and note the uncertainty rather than guessing a critical pin.
- This is lawful recovery/diagnostics only. Do NOT provide immobiliser/anti-theft defeat steps.
- Every field is required. Use [] for empty lists and "unknown" for unknown strings. Always include a caution to verify polarity with a meter before powering.`;

function coerceResult(raw: Record<string, unknown>): ModuleMapResult {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const inEnum = <T extends readonly string[]>(v: unknown, e: T, fb: T[number]): T[number] =>
    (e as readonly string[]).includes(s(v)) ? (s(v) as T[number]) : fb;

  const hookup: MappedHookupPin[] = arr(raw.hookup).map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      pin: s(o.pin) || "?",
      signal: inEnum(o.signal, HOOKUP_SIGNALS, "other"),
      connectTo: s(o.connectTo) || "unknown",
      required: o.required === true,
      note: s(o.note),
    };
  });

  const buses: MappedBus[] = arr(raw.buses).map((b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    return {
      name: s(o.name) || "CAN",
      protocol: inEnum(o.protocol, BUS_PROTOCOLS, "unknown"),
      bitrate: typeof o.bitrate === "number" && o.bitrate > 0 ? o.bitrate : 500000,
      requestId: s(o.requestId),
      responseId: s(o.responseId),
      termination: o.termination === true,
    };
  });

  const refs = arr(raw.references).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return { label: s(o.label), url: s(o.url) };
  }).filter((r) => r.label && r.url);

  const dtcs = arr(raw.knownDtcs).map((d) => {
    const o = (d ?? {}) as Record<string, unknown>;
    return { code: s(o.code), desc: s(o.desc) };
  }).filter((d) => d.code);

  return {
    displayName: s(raw.displayName) || "Unidentified module",
    brand: s(raw.brand) || "unknown",
    category: inEnum(raw.category, CATEGORIES, "other"),
    partNumbers: arr(raw.partNumbers).map(s).filter(Boolean),
    applications: arr(raw.applications).map(s).filter(Boolean),
    powerNote: s(raw.powerNote),
    hookup,
    buses,
    asciiConnector: s(raw.asciiConnector),
    cautions: arr(raw.cautions).map(s).filter(Boolean),
    references: refs,
    capabilities: arr(raw.capabilities).map(s).filter(Boolean),
    knownDtcs: dtcs,
    confidence: inEnum(raw.confidence, CONFIDENCE, "low"),
    rationale: s(raw.rationale),
  };
}

export async function mapModule(input: MapModuleInput): Promise<ModuleMapResult> {
  const apiKey = getApiKey();
  if (!apiKey || !apiKey.trim()) {
    throw new Error("No Anthropic API key set. Open Settings and paste your key to use the AI module mapper.");
  }
  if ((!input.images || input.images.length === 0) && !input.description.trim()) {
    throw new Error("Add at least one photo of the module, or type what it is.");
  }

  const client = new Anthropic({ apiKey });

  const userContent: Anthropic.ContentBlockParam[] = (input.images ?? []).map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  userContent.push({
    type: "text",
    text: [
      "Map this automotive control module for a bench hookup.",
      input.description.trim() ? `Operator says: ${input.description.trim()}` : "The operator did not add a description — identify it from the photo(s).",
      "Read every printed marking you can. Produce the full hookup guide. Always add a caution to verify polarity with a meter before applying 12V.",
    ].join("\n"),
  });

  const response = await client.messages.create({
    model: MODULE_MAP_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: MAP_SCHEMA } },
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("The model returned no module map.");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(textBlock.text) as Record<string, unknown>; }
  catch { throw new Error("Could not parse the model's module-map response."); }

  return coerceResult(parsed);
}
