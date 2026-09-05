import Anthropic from "@anthropic-ai/sdk";

import { getApiKey } from "../settings";

/**
 * AI Vehicle Identifier — decodes a vehicle "to the fullest extent" when the
 * library cannot resolve it with certainty.
 *
 * Evidence it reasons over, strongest first:
 *   • the VIN structure (WMI → maker/plant, VDS pos 4-8 → model/body/engine/
 *     restraint codes per manufacturer scheme, pos 10 → year, pos 11 → plant);
 *   • what the bus itself says — every responding diagnostic address and each
 *     module's part number / supplier / software id read via UDS 22 F187/F18A/
 *     F195… (e.g. Toyota part numbers carry the model series code after the
 *     dash; Ford's prefix encodes platform+year; VAG's first 3 chars are the
 *     platform) plus the ECM's OBD calibration id;
 *   • library candidates for the same maker (how their known module maps
 *     compare to this bus).
 *
 * It returns a structured identity with a confidence and the evidence used,
 * and it MUST say "unknown" rather than invent a model. The operator confirms
 * before anything is bound — the AI proposes, the library learns only on
 * confirmation.
 */

const MODEL = "claude-opus-5";

export interface IdentifyEcuEvidence {
  responseId: string; requestId?: string; label?: string;
  partNo?: string; supplier?: string; sw?: string; hw?: string; serial?: string; vin?: string;
}

export interface IdentifyCandidate {
  id: string; year: number | null; make: string; model: string; trim?: string; bodyType?: string;
  wmi?: string[]; responders: string[]; similarity: number; explored: number; hintKind?: string;
}

export interface IdentifyInput {
  vin: string;
  decode: { valid: boolean; wmi: string; vds: string; make: string | null; year: number | null; country: string; region: string; bodyTypeHint: string; checkDigitValid: boolean };
  bus: { iface?: string; responders: string[]; ecus: IdentifyEcuEvidence[]; calId?: string; cvn?: string };
  candidates: IdentifyCandidate[];
  operatorNote?: string;
}

export interface IdentifyResult {
  year: number | null;
  make: string;
  model: string;          // "unknown" when it truly cannot tell
  trim?: string;
  bodyType: "sedan" | "suv" | "truck" | "van" | "minivan" | "hatchback" | "coupe" | "wagon";
  platform?: string;
  engine?: string;
  market?: string;
  confidence: "high" | "medium" | "low";
  matchedProfileId: string | null;   // a candidate id when the bus + VIN say it IS that library vehicle
  rationale: string;
  evidence: string[];
  warnings: string[];
  modules: { responseId: string; label: string; category: string; supplier?: string }[]; // names for every responder
  tokensIn: number;
  tokensOut: number;
}

const BODY = ["sedan", "suv", "truck", "van", "minivan", "hatchback", "coupe", "wagon"] as const;
const CATS = ["powertrain", "transmission", "chassis", "body", "infotainment", "safety", "network", "hvac", "other"] as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    year: { type: ["integer", "null"] },
    make: { type: "string" },
    model: { type: "string", description: "Exact model name, or the literal string 'unknown' if the evidence does not determine it." },
    trim: { type: "string" },
    bodyType: { type: "string", enum: [...BODY] },
    platform: { type: "string", description: "Platform / generation code if known (e.g. 'TNGA-C / E210', 'MQB', 'F30', 'P552'), else empty." },
    engine: { type: "string" },
    market: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    matchedProfileId: { type: ["string", "null"], description: "The candidate id ONLY if VIN + bus evidence establish this is that same year/make/model; otherwise null." },
    rationale: { type: "string" },
    evidence: { type: "array", items: { type: "string" }, description: "Each concrete fact used, quoting the VIN positions / part numbers / addresses." },
    warnings: { type: "array", items: { type: "string" }, description: "Contradictions, guesses, or anything the operator must verify." },
    modules: {
      type: "array",
      description: "One entry per responding address: the best name for what module lives there on THIS vehicle, from its part number / supplier / address.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          responseId: { type: "string" }, label: { type: "string" },
          category: { type: "string", enum: [...CATS] }, supplier: { type: "string" },
        },
        required: ["responseId", "label", "category"],
      },
    },
  },
  required: ["year", "make", "model", "bodyType", "confidence", "matchedProfileId", "rationale", "evidence", "warnings", "modules"],
} as const;

const SYSTEM = `You are an automotive vehicle-identification expert working inside a diagnostic tool that is physically connected to a car's OBD port. Your task: determine the exact YEAR / MAKE / MODEL (and trim, platform, engine when determinable) of the connected vehicle from hard evidence, and name what module sits at each responding diagnostic address.

Evidence rules — apply in this order and cite what you use:
1. VIN structure. WMI (pos 1-3) gives manufacturer and plant/region; VDS (pos 4-8) encodes model line, body, engine and restraint per that maker's published scheme; pos 10 is the model year; pos 11 the assembly plant. Decode the VDS with the maker's real code tables (e.g. Toyota pos 4-5 model series and pos 6-7 body/engine; Ford pos 4-5 body series like 'W1' = F-150 SuperCrew 4x2; Honda pos 4-8 model/body/engine; Nissan pos 4-6 engine/model; VAG pos 4-6 model/body). Say when a VDS code is ambiguous.
2. The bus. Manufacturer part numbers read from the modules are decisive: Toyota 5-5 part numbers carry the vehicle SERIES code in the middle group (89661-02xxx = Corolla-series ECM, -06 = Camry, -47 = Prius, -0R = RAV4, -0E = Highlander …); Ford part prefixes encode platform and model-year (JL3A = 2018 F-150); VAG numbers start with the platform (5Q0 = MQB, 8W0 = A4 B9); Honda numbers carry the model code (TVA = Accord CV, TBA = Civic FC); Nissan suffixes carry the model (6CA = Altima L34); BMW 7-digit numbers map to series via known ranges; Mercedes A-numbers carry the model series (A 205 = W205 C-Class). Also weigh the address map (which ids answer — Ford FEPS, VAG +0x6A offset, Toyota 7B0/7A6/7C4 layout …) and the OBD calibration id.
3. Library candidates are prior knowledge from this tool's own database for the same maker. Return matchedProfileId ONLY when VIN + bus evidence establish the connected car IS that same year/make/model — never because it is the only candidate of that make.

Honesty rules: never invent a model. If the VDS and the part numbers do not determine the model, set model to "unknown" with confidence "low" and list in warnings exactly what a human should check. Never contradict the VIN's year. If part numbers and VIN disagree, say so in warnings (swapped module? wrong car?). Keep rationale to a few sentences; put the specifics in evidence[].`;

function candidatesSection(c: IdentifyCandidate[]): string {
  if (!c.length) return "Library candidates: none for this maker yet.";
  return "Library candidates (same maker — prior knowledge, NOT proof):\n" + c.map((k) =>
    `  • id=${k.id}: ${k.year ?? "?"} ${k.make} ${k.model}${k.trim ? ` (${k.trim})` : ""}${k.bodyType ? `, ${k.bodyType}` : ""}; WMIs ${k.wmi?.join("/") || "—"}; known responders ${k.responders.join(" ") || "—"}; bus-map similarity to THIS car ${(k.similarity * 100).toFixed(0)}%; ${k.explored} module(s) deep-mapped${k.hintKind ? `; hint: ${k.hintKind}` : ""}`,
  ).join("\n");
}

function busSection(b: IdentifyInput["bus"]): string {
  if (!b.responders.length) return "Bus evidence: no discovery scan yet (VIN only).";
  const lines = b.ecus.map((e) => {
    const bits = [
      e.partNo ? `part "${e.partNo}"` : null, e.supplier ? `supplier "${e.supplier}"` : null,
      e.sw ? `sw "${e.sw}"` : null, e.hw ? `hw "${e.hw}"` : null, e.serial ? `serial "${e.serial}"` : null,
      e.vin ? `vin "${e.vin}"` : null,
    ].filter(Boolean).join(", ");
    return `  • ${e.responseId}${e.requestId ? ` (req ${e.requestId})` : ""}${e.label ? ` [${e.label}]` : ""}: ${bits || "answered, no identification strings"}`;
  });
  return [
    `Bus evidence (${b.responders.length} responding address(es)${b.iface ? ` on ${b.iface}` : ""}):`,
    ...lines,
    b.calId ? `  ECM OBD calibration id: ${b.calId}` : "",
    b.cvn ? `  ECM CVN: ${b.cvn}` : "",
  ].filter(Boolean).join("\n");
}

// ---- Module census -----------------------------------------------------------
// After discovery we know every responding address and what each said it was
// (part number / supplier / software). The census turns that into the vehicle's
// KNOWN MODULE LIST: a name, role, category, protocol and memory-read estimate
// per address — the basic parameters saved before any per-module deep-map.

export interface CensusInput {
  vehicle: { year: number | null; make: string; model: string; trim?: string; platform?: string; engine?: string };
  ecus: IdentifyEcuEvidence[];
  known?: { responseId: string; label: string; category: string }[]; // what the library already calls them
}

export interface CensusModule {
  responseId: string;
  label: string;          // "PCM — Powertrain Control Module"
  shortName: string;      // "PCM"
  category: string;
  supplier?: string;
  summary: string;        // what it controls / role on this vehicle, 1-2 sentences
  protocol: "uds" | "kwp2000" | "obd2" | "unknown";
  memoryRead: "obd" | "obd_partial" | "bench";
  likelyServices: string[]; // e.g. ["10 03", "22", "19 02", "2E", "31"]
  notes?: string;
}

export interface CensusResult { modules: CensusModule[]; tokensIn: number; tokensOut: number }

const CENSUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    modules: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          responseId: { type: "string" }, label: { type: "string" }, shortName: { type: "string" },
          category: { type: "string", enum: [...CATS] }, supplier: { type: "string" },
          summary: { type: "string" },
          protocol: { type: "string", enum: ["uds", "kwp2000", "obd2", "unknown"] },
          memoryRead: { type: "string", enum: ["obd", "obd_partial", "bench"] },
          likelyServices: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
        required: ["responseId", "label", "shortName", "category", "summary", "protocol", "memoryRead", "likelyServices"],
      },
    },
  },
  required: ["modules"],
} as const;

const CENSUS_SYSTEM = `You are an automotive diagnostics expert. A tool is connected to a known vehicle and has just discovered every module that answers on its diagnostic bus, reading each one's manufacturer part number, supplier and software id. Produce the vehicle's MODULE CENSUS: for EVERY responding address, the correct module name for this make (use the maker's own naming: Toyota "Skid Control ECU", Ford "PCM / RCM / PSCM / GWM / IPMA", VAG "J623 / J104 / J533", BMW "DME / DSC / KOMBI", Mercedes "ME / ESP / SRS" …), its role on this vehicle in 1-2 sentences, its category, the diagnostic protocol it most likely speaks (uds for 2008+ CAN modules; kwp2000 for older/Nissan-JATCO style; obd2 for a module that only answers J1979), an honest memory-read estimate (obd = simple body/comfort modules usually dumpable over the bus; obd_partial = identifiers/calibration readable, code region walled; bench = engine/transmission/gateway/immobiliser/cluster and anything tamper-protected — needs bench/boot-mode), and the services a tester typically uses with it.

Rules: derive the name from the PART NUMBER and ADDRESS first (Ford base numbers: 12A650 PCM, 7A100 TCM, 2C405 ABS, 14B321 RCM, 3D070 PSCM, 10849 IPC, 14G371 GWM, 19H406 IPMA, 15604 BCM; Toyota: 89661 ECM, 89530 CVT, 44050 skid, 89170 airbag, 89220 body, 83800 meter, 88650 A/C, 89100 gateway, 88210 radar, 89784 certification, 89340 sonar, 89650 EPS; VAG: 907 551 engine, 927 750 gearbox, 614 517 ABS, 959 655 airbag, 920 xxx cluster, 907 530 gateway). If the library already names a module (known list), keep that identity unless the part number contradicts it. Never invent part numbers. If an address is truly unidentifiable, label it "Unknown module at <addr>" with category other and say why in notes.`;

export async function censusModules(input: CensusInput): Promise<CensusResult> {
  const apiKey = getApiKey();
  if (!apiKey || !apiKey.trim()) throw new Error("No Anthropic API key set. Open Settings and paste your key to run the module census.");
  const client = new Anthropic({ apiKey });
  const v = input.vehicle;
  const known = (input.known ?? []).map((k) => `  • ${k.responseId}: ${k.label} [${k.category}]`).join("\n");
  const content = [
    `Vehicle: ${v.year ?? "?"} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ""}${v.platform ? ` (${v.platform})` : ""}${v.engine ? `, ${v.engine}` : ""}`,
    "",
    busSection({ responders: input.ecus.map((e) => e.responseId), ecus: input.ecus }),
    known ? `\nLibrary already names:\n${known}` : "",
    "",
    "Produce the module census for every responding address.",
  ].join("\n");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: CENSUS_SYSTEM,
    output_config: { format: { type: "json_schema", schema: CENSUS_SCHEMA } },
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!text) throw new Error("The model returned no census.");
  let parsed: { modules?: unknown[] };
  try { parsed = JSON.parse(text.text) as { modules?: unknown[] }; } catch { throw new Error("Could not parse the module census."); }
  const s = (x: unknown, d = "") => (typeof x === "string" && x ? x : d);
  const want = new Set(input.ecus.map((e) => e.responseId.toUpperCase()));
  const modules: CensusModule[] = (Array.isArray(parsed.modules) ? parsed.modules : [])
    .map((m) => m as Record<string, unknown>)
    .filter((m) => want.has(s(m.responseId).toUpperCase()))
    .map((m) => ({
      responseId: s(m.responseId).toUpperCase(),
      label: s(m.label, `Module at ${s(m.responseId)}`), shortName: s(m.shortName, s(m.label).slice(0, 12)),
      category: (CATS as readonly string[]).includes(s(m.category)) ? s(m.category) : "other",
      supplier: s(m.supplier) || undefined,
      summary: s(m.summary),
      protocol: (["uds", "kwp2000", "obd2", "unknown"] as const).includes(s(m.protocol) as never) ? (s(m.protocol) as CensusModule["protocol"]) : "unknown",
      memoryRead: (["obd", "obd_partial", "bench"] as const).includes(s(m.memoryRead) as never) ? (s(m.memoryRead) as CensusModule["memoryRead"]) : "obd_partial",
      likelyServices: Array.isArray(m.likelyServices) ? (m.likelyServices as unknown[]).filter((x): x is string => typeof x === "string") : [],
      notes: s(m.notes) || undefined,
    }));
  return { modules, tokensIn: response.usage?.input_tokens ?? 0, tokensOut: response.usage?.output_tokens ?? 0 };
}

export async function identifyVehicle(input: IdentifyInput): Promise<IdentifyResult> {
  const apiKey = getApiKey();
  if (!apiKey || !apiKey.trim()) throw new Error("No Anthropic API key set. Open Settings and paste your key to use the AI identifier.");
  const client = new Anthropic({ apiKey });
  const d = input.decode;
  const content = [
    `VIN: ${input.vin}`,
    `Offline decode: valid=${d.valid}, check digit ${d.checkDigitValid ? "OK" : "FAILED"}, WMI ${d.wmi} → ${d.make ?? "maker not in local table"}, VDS "${d.vds}", model year ${d.year ?? "?"}, ${d.country} (${d.region}), body hint ${d.bodyTypeHint}`,
    "",
    busSection(input.bus),
    "",
    candidatesSection(input.candidates),
    input.operatorNote ? `\nOperator note: ${input.operatorNote}` : "",
    "",
    "Identify the connected vehicle and name each responding module.",
  ].join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!text) throw new Error("The model returned no identification.");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text.text) as Record<string, unknown>; } catch { throw new Error("Could not parse the model's identification."); }

  const s = (v: unknown, dflt = "") => (typeof v === "string" ? v : dflt);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const body = (BODY as readonly string[]).includes(s(parsed.bodyType)) ? (s(parsed.bodyType) as IdentifyResult["bodyType"]) : "sedan";
  const year = typeof parsed.year === "number" && Number.isFinite(parsed.year) ? Math.round(parsed.year) : null;
  const matched = typeof parsed.matchedProfileId === "string" && input.candidates.some((c) => c.id === parsed.matchedProfileId) ? parsed.matchedProfileId : null;
  const modules = (Array.isArray(parsed.modules) ? parsed.modules : [])
    .map((m) => m as Record<string, unknown>)
    .filter((m) => typeof m.responseId === "string" && typeof m.label === "string")
    .map((m) => ({
      responseId: s(m.responseId).toUpperCase(), label: s(m.label),
      category: (CATS as readonly string[]).includes(s(m.category)) ? s(m.category) : "other",
      supplier: s(m.supplier) || undefined,
    }));

  return {
    year: year ?? d.year,
    make: s(parsed.make) || d.make || "Unknown",
    model: s(parsed.model) || "unknown",
    trim: s(parsed.trim) || undefined,
    bodyType: body,
    platform: s(parsed.platform) || undefined,
    engine: s(parsed.engine) || undefined,
    market: s(parsed.market) || undefined,
    confidence: (["high", "medium", "low"] as const).includes(parsed.confidence as never) ? (parsed.confidence as IdentifyResult["confidence"]) : "low",
    matchedProfileId: matched,
    rationale: s(parsed.rationale),
    evidence: arr(parsed.evidence),
    warnings: arr(parsed.warnings),
    modules,
    tokensIn: response.usage?.input_tokens ?? 0,
    tokensOut: response.usage?.output_tokens ?? 0,
  };
}
