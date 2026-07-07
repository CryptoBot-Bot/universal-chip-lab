import Anthropic from "@anthropic-ai/sdk";

import type { BusModuleKnowledge } from "@ecu/vehicle-db";

import { getApiKey } from "../settings";

/**
 * AI bus mapper — turns a snapshot of a live CAN network into structured
 * {@link BusModuleKnowledge} drafts.
 *
 * Main-process only (holds the Anthropic key). The renderer sends what it can
 * see on the wire — the node list, plus any request→response log the operator
 * captured — and gets back one knowledge record per identified system:
 * addressing, protocol, the sessions/services/data-ids it answers, and concrete
 * capabilities with exact command bytes. Results are DRAFTS (ai_suggested); the
 * operator reviews and saves, and can confirm them against silicon later.
 */

export interface BusObservationNode {
  /** Arbitration id, hex (e.g. "7E9", "1F0"). */
  id: string;
  name: string;
  kind: "module" | "obd" | "bcast";
  hz: number;
  count: number;
  /** Latest payload bytes, hex. */
  lastData: string;
}

export interface BusMapInput {
  nodes: BusObservationNode[];
  /** Request→response pairs the operator captured (console log / sweep output). */
  probeLog?: string;
  /** The full troubleshoot snapshot text, if available. */
  snapshot?: string;
  notes?: string;
}

export const BUS_MAP_MODEL = "claude-opus-4-8";

const CATEGORIES = ["ECU", "TCU", "BCM", "IC", "IMMO", "ABS", "SRS", "HVAC", "RADIO", "AC", "OTHER"] as const;
const BRANDS = ["VAG", "BMW", "Mercedes", "GM", "Ford", "Stellantis", "Toyota", "Honda", "Hyundai_Kia", "Nissan", "Subaru", "Mazda", "Volvo", "Other"] as const;
const PROTOCOLS = ["uds", "kwp2000", "obd2", "j1939", "gmlan", "proprietary", "unknown"] as const;
const RISKS = ["read", "write", "caution"] as const;

const MODULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    brand: { type: "string", enum: [...BRANDS] },
    appliesTo: { type: "string" },
    protocol: { type: "string", enum: [...PROTOCOLS] },
    addressing: {
      type: "object",
      additionalProperties: false,
      properties: { request: { type: "string" }, response: { type: "string" } },
      required: ["request", "response"],
    },
    fingerprint: {
      type: "object",
      additionalProperties: false,
      properties: {
        responseId: { type: "string" },
        broadcastIds: { type: "array", items: { type: "string" } },
        signature: { type: "string" },
      },
      required: ["responseId", "broadcastIds", "signature"],
    },
    sessions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          request: { type: "string" },
          name: { type: "string" },
          response: { type: "string" },
          note: { type: "string" },
        },
        required: ["request", "name", "response", "note"],
      },
    },
    services: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sid: { type: "string" },
          name: { type: "string" },
          supported: { type: "boolean" },
          nrc: { type: "string" },
          note: { type: "string" },
        },
        required: ["sid", "name", "supported", "nrc", "note"],
      },
    },
    dataIdentifiers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          request: { type: "string" },
          name: { type: "string" },
          session: { type: "string" },
          sampleResponse: { type: "string" },
          decoded: { type: "string" },
        },
        required: ["request", "name", "session", "sampleResponse", "decoded"],
      },
    },
    capabilities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          how: { type: "string" },
          commands: { type: "array", items: { type: "string" } },
          risk: { type: "string", enum: [...RISKS] },
          note: { type: "string" },
        },
        required: ["title", "how", "commands", "risk", "note"],
      },
    },
    notes: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "id", "label", "category", "brand", "appliesTo", "protocol", "addressing",
    "fingerprint", "sessions", "services", "dataIdentifiers", "capabilities",
    "notes", "confidence",
  ],
} as const;

const MAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    modules: { type: "array", items: MODULE_SCHEMA },
    summary: { type: "string" },
  },
  required: ["modules", "summary"],
} as const;

const SYSTEM_PROMPT = `You are an expert automotive diagnostics engineer reverse-engineering a live vehicle CAN bus from an observation snapshot. You turn what was seen on the wire into a structured map of each electronic system, so the operator's tool can grow a permanent, reusable knowledge base of "what we can do with this vehicle".

You are given: the list of CAN nodes currently seen (arbitration id, a guessed name, message rate, last payload), and — when available — a log of diagnostic requests the operator sent and the responses that came back. Diagnostic responders answer at (request id + 8): 7E8←7E0 engine, 7E9←7E1 transmission, 7EA–7EF other modules.

Produce one knowledge record per IDENTIFIABLE system. Rules:
- id: a stable lowercase slug, e.g. "kwp_tcm_7e9" or "obd2_ecu_7e8". Same physical module MUST get the same slug across runs (base it on protocol + response id).
- addressing.request / .response: hex ids like "7E1" / "7E9". fingerprint.responseId = the response id; broadcastIds = any non-diagnostic ids that clearly belong to this module (else []); signature = a distinctive data pattern or "".
- protocol: infer from the responses. Positive response 0x50 to a 0x10 sub-function and 0x21 reads = kwp2000. 0x22 ReadDataByIdentifier / 0x19 DTCs = uds. Modes 01/03/09 = obd2. Use "unknown" if there is not enough evidence — do NOT guess a protocol from the id alone.
- sessions/services/dataIdentifiers: fill ONLY from evidence in the log. A response 0x7F <sid> <nrc> means that service is NOT supported (nrc 11=serviceNotSupported, 12=subFunctionNotSupported, 7F=notSupportedInActiveSession, 31=requestOutOfRange). A response 0x40+sid is positive — record the request, name it, and decode the payload (ASCII, counters, VIN, part numbers) in "decoded". Put the captured bytes in sampleResponse.
- capabilities: concrete, valuable things to DO, each with the exact command byte sequence(s) in order. Bias to READ operations; mark anything that writes/clears/programs as risk "write" or "caution" and NEVER invent a security-unlock or write sequence you don't have evidence for.
- Be honest. If a node is just a broadcast id with no diagnostic evidence, either omit it or record it with protocol "unknown", empty sessions/services, and a capability to reverse-engineer its payload. Do not fabricate services, sessions, or data ids that were not observed.
- Every string field is required by the schema; use "" for unknowns and [] for empty lists. "brand" must be one of the allowed values — use "Other" when unsure.
- "summary" is one or two sentences describing the network as a whole.`;

function coerceModule(raw: unknown, now: string): BusModuleKnowledge | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const bool = (v: unknown): boolean => v === true;
  const arr = <T>(v: unknown, f: (x: unknown) => T): T[] =>
    Array.isArray(v) ? v.map(f) : [];

  const id = str(r.id).trim();
  const addr = (r.addressing ?? {}) as Record<string, unknown>;
  if (!id || !str(addr.request) || !str(addr.response)) return null;

  const fp = (r.fingerprint ?? {}) as Record<string, unknown>;
  const confidence =
    r.confidence === "high" || r.confidence === "medium" ? r.confidence : "low";
  const brand = (BRANDS as readonly string[]).includes(str(r.brand)) ? (str(r.brand) as BusModuleKnowledge["brand"]) : undefined;

  return {
    id,
    label: str(r.label) || id,
    category: ((CATEGORIES as readonly string[]).includes(str(r.category)) ? r.category : "OTHER") as BusModuleKnowledge["category"],
    ...(brand ? { brand } : {}),
    ...(str(r.appliesTo) ? { appliesTo: str(r.appliesTo) } : {}),
    protocol: ((PROTOCOLS as readonly string[]).includes(str(r.protocol)) ? r.protocol : "unknown") as BusModuleKnowledge["protocol"],
    addressing: { request: str(addr.request), response: str(addr.response) },
    fingerprint: {
      responseId: str(fp.responseId) || str(addr.response),
      broadcastIds: arr(fp.broadcastIds, (x) => str(x)).filter(Boolean),
      ...(str(fp.signature) ? { signature: str(fp.signature) } : {}),
    },
    sessions: arr(r.sessions, (s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return {
        request: str(o.request),
        name: str(o.name),
        ...(str(o.response) ? { response: str(o.response) } : {}),
        ...(str(o.note) ? { note: str(o.note) } : {}),
      };
    }).filter((s) => s.request),
    services: arr(r.services, (s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return {
        sid: str(o.sid),
        name: str(o.name),
        supported: bool(o.supported),
        ...(str(o.nrc) ? { nrc: str(o.nrc) } : {}),
        ...(str(o.note) ? { note: str(o.note) } : {}),
      };
    }).filter((s) => s.sid),
    dataIdentifiers: arr(r.dataIdentifiers, (d) => {
      const o = (d ?? {}) as Record<string, unknown>;
      return {
        request: str(o.request),
        name: str(o.name),
        ...(str(o.session) ? { session: str(o.session) } : {}),
        ...(str(o.sampleResponse) ? { sampleResponse: str(o.sampleResponse) } : {}),
        ...(str(o.decoded) ? { decoded: str(o.decoded) } : {}),
      };
    }).filter((d) => d.request),
    capabilities: arr(r.capabilities, (c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return {
        title: str(o.title),
        how: str(o.how),
        commands: arr(o.commands, (x) => str(x)).filter(Boolean),
        risk: ((RISKS as readonly string[]).includes(str(o.risk)) ? o.risk : "read") as BusModuleKnowledge["capabilities"][number]["risk"],
        ...(str(o.note) ? { note: str(o.note) } : {}),
      };
    }).filter((c) => c.title),
    notes: str(r.notes),
    provenance: {
      source: "ai_suggested",
      confidence,
      createdAt: now,
      model: BUS_MAP_MODEL,
      observedOn: now.slice(0, 10),
    },
  };
}

export interface BusMapResult {
  modules: BusModuleKnowledge[];
  summary: string;
}

export async function mapBus(input: BusMapInput): Promise<BusMapResult> {
  const apiKey = getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("No Anthropic API key set. Open Settings and paste your key to use the AI bus mapper.");
  }
  if (!input.nodes || input.nodes.length === 0) {
    throw new Error("No bus traffic captured yet — go live and let some frames arrive before mapping.");
  }

  const client = new Anthropic({ apiKey });

  const nodeLines = input.nodes
    .map((n) => `  ${n.id}  ${n.name}  [${n.kind}]  ${n.hz}Hz  x${n.count}  data=${n.lastData || "—"}`)
    .join("\n");

  const parts: string[] = [
    "Live CAN nodes observed:",
    nodeLines,
  ];
  if (input.probeLog && input.probeLog.trim()) {
    parts.push("\nDiagnostic request→response log (the strongest evidence):\n" + input.probeLog.trim());
  }
  if (input.snapshot && input.snapshot.trim()) {
    parts.push("\nFull troubleshoot snapshot:\n" + input.snapshot.trim());
  }
  if (input.notes && input.notes.trim()) {
    parts.push("\nOperator notes: " + input.notes.trim());
  }
  parts.push("\nMap every identifiable system on this bus into knowledge records.");

  const response = await client.messages.create({
    model: BUS_MAP_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: MAP_SCHEMA } },
    messages: [{ role: "user", content: parts.join("\n") }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("The model returned no bus map.");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(textBlock.text) as Record<string, unknown>;
  } catch {
    throw new Error("Could not parse the model's bus-map response.");
  }

  const now = new Date().toISOString();
  const modules = (Array.isArray(parsed.modules) ? parsed.modules : [])
    .map((m) => coerceModule(m, now))
    .filter((m): m is BusModuleKnowledge => m !== null);

  return { modules, summary: typeof parsed.summary === "string" ? parsed.summary : "" };
}
