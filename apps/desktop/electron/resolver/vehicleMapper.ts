import Anthropic from "@anthropic-ai/sdk";

import { getApiKey } from "../settings";

/**
 * AI vehicle mapper — the "brain" we're calibrating. Given a RAW bus scan (VIN +
 * every responding ECU with its response id, supported PIDs, identifier DIDs,
 * DTC codes and a live sample) it must produce the gold-standard vehicle map:
 * name/category/supplier/protocol/memory-read/capabilities per module, honestly.
 *
 * It is NOT given the ground-truth catalog — it must infer everything from the
 * scan the way it would on a genuinely unknown car. The Training Room compares
 * its output against the known Corolla so we can measure and improve it.
 */

export interface EcuObservation {
  responseId: string;
  requestId?: string;
  supportedPids: string[];
  identifiers: { did: string; ascii: string }[];
  dtcs: string[];
  liveSample: { name: string; value: string }[];
}

export interface VehicleScan {
  vin: string;
  year: number | null;
  make: string | null;
  country: string;
  ecus: EcuObservation[];
  notes?: string;
}

export interface MappedModule {
  responseId: string;
  name: string;
  category: string;
  supplier: string;
  protocol: string;
  memoryRead: string;
  capabilities: string[];
  confidence: "low" | "medium" | "high";
  rationale: string;
}

export interface VehicleMapResult {
  vehicle: { year: string; make: string; model: string; platform: string; summary: string };
  modules: MappedModule[];
}

export const VEHICLE_MAP_MODEL = "claude-opus-4-8";

const CATEGORIES = ["powertrain", "transmission", "chassis", "body", "infotainment", "safety", "network", "hvac", "other"] as const;
const PROTOCOLS = ["uds", "kwp2000", "obd2", "unknown"] as const;
const READS = ["obd", "obd_partial", "bench"] as const;

const MODULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    responseId: { type: "string" },
    name: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    supplier: { type: "string" },
    protocol: { type: "string", enum: [...PROTOCOLS] },
    memoryRead: { type: "string", enum: [...READS] },
    capabilities: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    rationale: { type: "string" },
  },
  required: ["responseId", "name", "category", "supplier", "protocol", "memoryRead", "capabilities", "confidence", "rationale"],
} as const;

const MAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    vehicle: {
      type: "object",
      additionalProperties: false,
      properties: {
        year: { type: "string" }, make: { type: "string" }, model: { type: "string" },
        platform: { type: "string" }, summary: { type: "string" },
      },
      required: ["year", "make", "model", "platform", "summary"],
    },
    modules: { type: "array", items: MODULE_SCHEMA },
  },
  required: ["vehicle", "modules"],
} as const;

const SYSTEM_PROMPT = `You are an expert automotive diagnostics engineer mapping an UNKNOWN vehicle purely from a raw OBD/UDS bus scan. Produce a structured, honest map of every module — what it is and what can be done with it — so a diagnostic tool can build a reusable profile.

You are given: the decoded VIN identity, and for every ECU that RESPONDED: its diagnostic response id, the OBD/UDS services or PIDs it supports, identifier reads (data-identifier + ASCII value, e.g. spare part numbers and supplier strings), stored DTC codes, and a small live-data sample.

For EACH responding ECU, infer:
- responseId: copy it exactly from the scan.
- name: the real module name (e.g. "Engine Control Module", "Skid Control (ABS/VSC)", "Central Gateway"). Use response-id conventions you know (7E8 engine, 7E9 transmission, 7Ex powertrain, 7B8 ABS/skid, 78x airbag/SRS, 7Cx body, 7Dx forward radar/camera, 7Ax steering/other, 75x gateway/immobiliser) AND the part-number / supplier scheme visible in the identifiers.
- category: one of powertrain, transmission, chassis, body, infotainment, safety, network, hvac, other. Cross-check with the DTC letter prefix (P=powertrain, C=chassis, B=body, U=network). Taxonomy rules to apply consistently: engine=powertrain; transmission/CVT=transmission; ABS/VSC/TRAC brakes and electric power steering=chassis; airbag/SRS and ADAS perception (forward radar/camera, pre-collision, lane/blind-spot)=safety; parking/clearance sonar and back-up assist are convenience features=body (NOT safety — reserve safety for occupant-protection and collision-avoidance); gateway/network-hub=network; smart-key/immobiliser/body-control=body; climate=hvac; cluster/head-unit=infotainment.
- supplier: read it from the identifier ASCII / part-number scheme you recognize (do not invent one — say "unknown" if there is no evidence).
- protocol: uds if 0x22/0x19/0x2E seen; obd2 if only modes 01/03/09; kwp2000 if 0x21/0x81; else unknown.
- memoryRead: your ESTIMATE of whether the full firmware image is readable over OBD. Engine/transmission/gateway/immobiliser/instrument-cluster ECUs are typically read-protected → "bench". Simple body/HVAC/parking modules → "obd". Safety/chassis (ABS, SRS, radar, EPS) → "obd_partial". State in rationale that this is an estimate.
- capabilities: concrete things you can DO, each a short phrase (e.g. "Read live engine data", "Read/clear DTCs", "Read VIN & part numbers", "Coding: change auto-lock speed", "Actuator test: door locks"). Bias to reads; call out writes/actuators explicitly. Only list capabilities the evidence supports.
- confidence: high if response id + part number + DTCs all agree; lower if you are guessing.
- rationale: one sentence citing the evidence you used.

vehicle: fill year/make/model/platform/summary from the VIN + overall picture (model/platform may be inferred — say so in summary).

Be rigorous and HONEST. Do not fabricate modules that did not respond. Do not invent suppliers, part numbers, or capabilities without evidence. When unsure, lower confidence and say why. Every field is required — use "unknown" for unknown strings and [] for empty lists.

Handling degraded / adversarial evidence (real buses are messy):
- If supplier/part-number identifiers are ABSENT, set supplier "unknown" — never guess a brand. You may still infer category from the response id, services, DTC letter prefix and live-data semantics, but lower confidence to reflect the missing evidence.
- Identify from EVIDENCE first, address second. If a module answers on a non-standard response id but its part number, DTC prefix and live data clearly indicate a function (e.g. wheel-speed data + C-codes = skid control), identify it from that evidence and note the unusual address.
- If a responder's evidence is too THIN to identify (e.g. only session/tester-present services, a generic U-code, no part number, no supplier, no live data), still include it but name it "Unknown module", set category "other", supplier "unknown", and confidence "low". Never invent a specific identity to fill the gap.`;

function coerceModule(raw: unknown): MappedModule | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const rid = str(r.responseId).trim();
  if (!rid) return null;
  const conf = r.confidence === "high" || r.confidence === "medium" ? r.confidence : "low";
  return {
    responseId: rid,
    name: str(r.name) || "unknown",
    category: (CATEGORIES as readonly string[]).includes(str(r.category)) ? str(r.category) : "other",
    supplier: str(r.supplier) || "unknown",
    protocol: (PROTOCOLS as readonly string[]).includes(str(r.protocol)) ? str(r.protocol) : "unknown",
    memoryRead: (READS as readonly string[]).includes(str(r.memoryRead)) ? str(r.memoryRead) : "obd_partial",
    capabilities: Array.isArray(r.capabilities) ? r.capabilities.map(str).filter(Boolean) : [],
    confidence: conf as MappedModule["confidence"],
    rationale: str(r.rationale),
  };
}

export async function mapVehicle(scan: VehicleScan): Promise<VehicleMapResult> {
  const apiKey = getApiKey();
  if (!apiKey || !apiKey.trim()) {
    throw new Error("No Anthropic API key set. Open Settings and paste your key to use the AI vehicle mapper.");
  }
  if (!scan.ecus || scan.ecus.length === 0) {
    throw new Error("No ECUs in the scan — run the bus scan first.");
  }

  const client = new Anthropic({ apiKey });

  const ecuLines = scan.ecus.map((e) => {
    const ids = e.identifiers.map((i) => `${i.did}="${i.ascii}"`).join(", ") || "—";
    const live = e.liveSample.map((l) => `${l.name}=${l.value}`).join(", ") || "—";
    return [
      `• Response ${e.responseId}${e.requestId ? ` (req ${e.requestId})` : ""}`,
      `    supported: ${e.supportedPids.join(" ") || "—"}`,
      `    identifiers: ${ids}`,
      `    DTCs: ${e.dtcs.join(", ") || "none"}`,
      `    live: ${live}`,
    ].join("\n");
  }).join("\n");

  const content = [
    `VIN: ${scan.vin}`,
    `Decoded: ${scan.year ?? "?"} ${scan.make ?? "?"} (${scan.country})`,
    scan.notes ? `Notes: ${scan.notes}` : "",
    "",
    `Responding ECUs (${scan.ecus.length}):`,
    ecuLines,
    "",
    "Map every responding module into the gold-standard structure.",
  ].filter(Boolean).join("\n");

  const response = await client.messages.create({
    model: VEHICLE_MAP_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: MAP_SCHEMA } },
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("The model returned no vehicle map.");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(textBlock.text) as Record<string, unknown>; }
  catch { throw new Error("Could not parse the model's vehicle-map response."); }

  const v = (parsed.vehicle ?? {}) as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  const modules = (Array.isArray(parsed.modules) ? parsed.modules : [])
    .map(coerceModule)
    .filter((m): m is MappedModule => m !== null);

  return {
    vehicle: {
      year: s(v.year), make: s(v.make), model: s(v.model),
      platform: s(v.platform), summary: s(v.summary),
    },
    modules,
  };
}
