import { isReadOnlyRequest as policyIsReadOnly } from "@ecu/vehicle-db";
import Anthropic from "@anthropic-ai/sdk";

import { getApiKey } from "../settings";

/**
 * AI Module Explorer — an autonomous, READ-ONLY diagnostic agent. Given a real
 * module on the bench (reached through the Super Device), it monitors the CAN bus,
 * systematically probes diagnostic services and identifiers, decodes what it sees,
 * records findings, and concludes with a complete structured understanding of the
 * module. It runs a tool-use loop: the model calls tools, we execute them against
 * the real hardware, and we stream its thoughts/actions/observations to the UI.
 *
 * Self-improving loop: each run is seeded with everything verified in prior runs
 * (see PriorKnowledge). The agent confirms the known surface quickly and spends its
 * budget discovering NEW behaviour; on conclude we diff against the prior to report
 * exactly what this run added. Token usage (in/out) is metered across the loop.
 *
 * Hard safety rail: only diagnostic READ services are executable. Any write /
 * coding / security-unlock / reset request is refused by the executor, regardless
 * of what the model asks — an autonomous agent never mutates a real module.
 */

/** The deep-map model. Override with ECL_EXPLORER_MODEL (the calibration bench compares
 *  models this way); keep the default on whatever the bench last proved best. */
const DEFAULT_MODEL = "claude-opus-4-8";
export function explorerModel(): string {
  return (process.env.ECL_EXPLORER_MODEL || "").trim() || DEFAULT_MODEL;
}
const MAX_STEPS = 30;
// Read-only diagnostic SIDs. Incl. OBD mode 02 (freeze-frame data) and 06 (on-board
// monitor test results) — both pure reads; 18 = KWP2000 readDTCsByStatus (Mercedes
// KWP-on-CAN modules refuse UDS 19). Writes/clears/security/reset stay refused.
// The one gate every request the autonomous agent sends goes through: the shared
// read-only policy (packages/vehicle-db/src/readPolicy.ts) — reads, tester-present,
// harmless sessions and security SEED requests only; never a key, never programming
// (10 02/82/85) or the safety-system session (10 04/84), never a write service.
export function isReadOnlyRequest(raw: string): boolean {
  return policyIsReadOnly(raw);
}

export interface SeqItem { request: string; response?: string; ok?: boolean; negative?: boolean; nrc?: number; error?: string }
export interface BusFrame { id: string; dlc: number; bytes: string; count: number; hz: number }

export interface ExplorerDeps {
  probe: (requests: string[]) => Promise<SeqItem[]>;
  scanBus: (ms: number) => Promise<{ frames: BusFrame[]; window_ms?: number }>;
  onEvent: (e: ExplorerEvent) => void;
  shouldStop: () => boolean;
}

/** Everything verified about this module in previous runs — the agent's starting prior. */
export interface PriorKnowledge {
  runCount: number;
  identity?: string;
  services: string[];
  capabilities: string[];
  dtcs: { code: string; desc: string }[];
}

/**
 * The module's FULL current record — the exact skeleton the cockpit stores. The agent
 * receives this so it knows every essential field it must verify against the real bus
 * and fill, keeping the saved record 100% aligned with ground truth.
 */
export interface ExplorerSkeleton {
  partNumbers: string[];
  applications: string[];
  bitrate?: number;
  fd?: boolean;
  sessions: { id: string; label: string }[];
  services: string[];
  identification: { id: string; label: string; value?: string; session?: string }[];
  liveData: { id: string; label: string; session?: string }[];
  broadcastFrames: { canId: string; hz?: number; decode?: string }[];
  operations: { op: string; status: string; request?: string; session?: string }[];
  dtcs: { code: string; desc: string }[];
  cloneVerdict?: string;
}

export interface ExplorerConfig {
  displayName: string; brand: string; category: string;
  protocol: string; requestId: string; responseId: string; iface: string;
  knownDtcs?: { code: string; desc: string }[];
  prior?: PriorKnowledge;
  skeleton?: ExplorerSkeleton;
  /** What discovery already read off this module (22 F187/F18A/F195/F191/F18C). */
  discovered?: { partNo?: string; supplier?: string; sw?: string; hw?: string; serial?: string };
  /** The census line: what this module is / controls on this vehicle. */
  summary?: string;
  vehicle?: string; // "2020 Toyota Corolla LE"
}

export interface ExplorerResult {
  summary: string;
  identity: string;
  services: string[];
  capabilities: string[];
  dtcs: { code: string; desc: string }[];
  confidence: "low" | "medium" | "high";
  verification: string;
  outcome: "concluded" | "partial";
  tokensIn: number;
  tokensOut: number;
  steps: number;
  newFindings: string[];
  // structured knowledge the cockpit renders — grows the module profile
  sessions?: { id: string; label: string }[];
  identification?: { id: string; label: string; value: string; session?: string }[];
  liveData?: { id: string; label: string; session?: string; note?: string }[];
  broadcastFrames?: { canId: string; hz?: number; decode?: string }[];
  // the canonical capability model — the standard board every module fills
  operations?: { op: string; status: string; request?: string; session?: string; nrc?: string; detail?: string }[];
}

// The canonical operation ids the agent maps its findings onto (mirror of
// CAPABILITY_CATALOG in @ecu/vehicle-db). Kept as a literal so the tool schema and
// prompt stay in lockstep without importing the browser-only schema module.
const CAPABILITY_OP_IDS = [
  "read_identification", "read_dtcs", "read_freeze_frames", "read_live_data", "read_broadcast", "read_memory", "read_scaling",
  "clear_dtcs", "security_access", "coding_adaptation", "actuator_test", "routine_control", "ecu_reset", "flash_write",
] as const;

export type ExplorerEvent =
  | { type: "status"; text: string }
  | { type: "prior"; knowledge: PriorKnowledge }
  | { type: "thought"; text: string }
  | { type: "action"; tool: string; input: unknown }
  | { type: "observation"; tool: string; summary: string; detail?: string }
  | { type: "finding"; kind: string; title: string; detail: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; steps: number }
  | { type: "done"; result: ExplorerResult }
  | { type: "error"; text: string };

const TOOLS: Anthropic.Tool[] = [
  {
    name: "scan_bus",
    description: "Passively monitor the CAN bus for a window and get every id the module broadcasts, with its latest data bytes and rate (Hz). Call it several times to see which bytes change (counters, live signals).",
    input_schema: { type: "object", properties: { ms: { type: "number", description: "window in ms, 300-2000" } }, required: [] },
  },
  {
    name: "probe",
    description: "Send one or more diagnostic requests over ONE ISO-TP socket (so a session persists across them). Each request is a hex payload string, e.g. '1081' or '22F190' or '1902FF'. READ-ONLY: only session control (10), tester-present (3E), ReadDataByIdentifier (22), ReadDTCInformation (19), KWP readDTCsByStatus (18), KWP read (21), KWP identification (1A), OBD modes (01/03/07/09/0A), ReadMemoryByAddress (23), ReadScalingData (17), and SecurityAccess SEED REQUESTS only (27 01 / 27 03 — never a key). Writes/clear/routines/reset/keys are refused.",
    input_schema: { type: "object", properties: { requests: { type: "array", items: { type: "string" } }, purpose: { type: "string" } }, required: ["requests", "purpose"] },
  },
  {
    name: "scan_dids",
    description: "Sweep a RANGE of ReadDataByIdentifier (22 xxxx) DIDs over one socket and return only the ones that answer (positive = data, or gated = 7F with a security/session NRC). This is how real testers find a module's measurement, coding and identification blocks without an ODX file. Up to 1024 DIDs per call; an optional session opener (e.g. '1003') is sent first in every batch. Use it on 0100-03FF (OEM measurement + coding), F180-F1FF (identification), and F400-F4FF (OBD PID mirror on powertrain modules), then read the interesting ones twice to see what changes.",
    input_schema: {
      type: "object",
      properties: {
        start: { type: "string", description: "first DID, 4 hex chars, e.g. '0100'" },
        end: { type: "string", description: "last DID inclusive, 4 hex chars, e.g. '03FF' (max 1024 DIDs per call)" },
        session: { type: "string", description: "optional session opener payload, e.g. '1003' or '10C0'" },
        purpose: { type: "string" },
      },
      required: ["start", "end", "purpose"],
    },
  },
  {
    name: "record",
    description: "Record a confirmed finding about the module so it appears in the live map.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["identity", "service", "capability", "dtc", "signal", "note"] },
        title: { type: "string" }, detail: { type: "string" },
      },
      required: ["kind", "title", "detail"],
    },
  },
  {
    name: "conclude",
    description: "Finish. Provide the complete, verified understanding of the module.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        identity: { type: "string" },
        services: { type: "array", items: { type: "string" } },
        capabilities: { type: "array", items: { type: "string" } },
        dtcs: { type: "array", items: { type: "object", additionalProperties: false, properties: { code: { type: "string" }, desc: { type: "string" } }, required: ["code", "desc"] } },
        sessions: { type: "array", description: "Every session sub-function that was accepted (50 xx)", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"] } },
        identification: { type: "array", description: "Each identification record read (part no / calibration / date), with the request and session it came from", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, label: { type: "string" }, value: { type: "string" }, session: { type: "string" } }, required: ["id", "label", "value"] } },
        liveData: { type: "array", description: "Live measurement blocks the module exposes and the session each needs", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, label: { type: "string" }, session: { type: "string" }, note: { type: "string" } }, required: ["id", "label"] } },
        broadcastFrames: { type: "array", description: "Frames the module broadcasts on the wire", items: { type: "object", additionalProperties: false, properties: { canId: { type: "string" }, hz: { type: "number" }, decode: { type: "string" } }, required: ["canId"] } },
        operations: {
          type: "array",
          description: "The canonical capability model — for EVERY operation you determined the module's stance on, its status. supported=answered positively; gated=SID recognised but refused (e.g. NRC 0x12/0x22/0x33, needs session/security/format); unsupported=serviceNotSupported (NRC 0x11); unknown=not tested. Include the request+session for reads so the cockpit can invoke it.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: [...CAPABILITY_OP_IDS] },
              status: { type: "string", enum: ["supported", "gated", "unsupported", "unknown"] },
              request: { type: "string" }, session: { type: "string" }, nrc: { type: "string" }, detail: { type: "string" },
            },
            required: ["op", "status"],
          },
        },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        verification: { type: "string" },
      },
      required: ["summary", "identity", "services", "capabilities", "dtcs", "confidence", "verification"],
    },
  },
];

function fmt(hex?: string): string { return (hex || "").toUpperCase().replace(/\s+/g, "").replace(/(..)/g, "$1 ").trim(); }
function ascii(hex?: string): string {
  const bytes = (hex || "").replace(/\s+/g, "").match(/../g) ?? [];
  const s = bytes.map((b) => { const n = parseInt(b, 16); return n >= 32 && n < 127 ? String.fromCharCode(n) : "·"; }).join("");
  return /[A-Za-z0-9]{3,}/.test(s) ? s : "";
}

function norm(s: string): string { return (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

/** Diff a result against the prior knowledge → the human-readable list of what this run added. */
function computeNew(result: Pick<ExplorerResult, "services" | "capabilities" | "dtcs" | "identity">, prior?: PriorKnowledge): string[] {
  if (!prior) return [];
  const known = new Set<string>();
  prior.services.forEach((s) => known.add("svc:" + norm(s)));
  prior.capabilities.forEach((s) => known.add("cap:" + norm(s)));
  prior.dtcs.forEach((d) => known.add("dtc:" + norm(d.code)));
  const out: string[] = [];
  result.services.forEach((s) => { if (!known.has("svc:" + norm(s))) out.push(`service · ${s}`); });
  result.capabilities.forEach((s) => { if (!known.has("cap:" + norm(s))) out.push(`capability · ${s}`); });
  result.dtcs.forEach((d) => { if (!known.has("dtc:" + norm(d.code))) out.push(`DTC · ${d.code} — ${d.desc}`); });
  if (prior.identity && result.identity && norm(prior.identity) !== norm(result.identity) && norm(result.identity).length > 3) {
    out.push(`identity · ${result.identity}`);
  }
  return out;
}

/** If the agent runs out of budget (or is stopped) before conclude, salvage a result from what it recorded. */
function buildPartial(
  recorded: { kind: string; title: string; detail: string }[],
  cfg: ExplorerConfig, tokensIn: number, tokensOut: number, steps: number, reason: string,
): ExplorerResult {
  const of = (k: string) => recorded.filter((r) => r.kind === k);
  const services = of("service").map((r) => (r.detail ? `${r.title} — ${r.detail}` : r.title));
  const capabilities = of("capability").map((r) => r.title);
  const identity = of("identity").map((r) => (r.detail ? `${r.title}: ${r.detail}` : r.title)).join("; ");
  const dtcs = of("dtc").map((r) => ({ code: r.title, desc: r.detail }));
  const notes = [...of("note"), ...of("signal")].map((r) => `${r.title}: ${r.detail}`);
  const result: ExplorerResult = {
    summary: `Partial exploration — ${reason} after ${steps} steps with ${recorded.length} finding(s) recorded.${notes.length ? " " + notes.join("; ") : ""}`,
    identity: identity || cfg.prior?.identity || "unknown",
    services, capabilities, dtcs,
    confidence: "low",
    verification: "Partial: the agent did not reach an explicit self-check. Each finding above is backed by a live response; run again to extend coverage.",
    outcome: "partial",
    tokensIn, tokensOut, steps, newFindings: [],
  };
  result.newFindings = computeNew(result, cfg.prior);
  return result;
}

function priorSection(prior?: PriorKnowledge): string {
  if (!prior || prior.runCount === 0) return "";
  const list = (arr: string[]) => (arr.length ? arr.map((x) => `  • ${x}`).join("\n") : "  (none yet)");
  return `

KNOWN SO FAR — verified across ${prior.runCount} previous run(s). Treat this as a strong prior: CONFIRM the still-true items quickly (a probe or two), then spend the bulk of your budget discovering things NOT already on this list. Do not merely re-derive what's below.
Identity: ${prior.identity || "unknown"}
Services already mapped:
${list(prior.services)}
Capabilities already known:
${list(prior.capabilities)}
DTCs already seen: ${prior.dtcs.length ? prior.dtcs.map((d) => d.code).join(", ") : "(none)"}

Your goal this run is to EXPAND this knowledge — find untried services/identifiers, changing live signals, memory regions, or behaviours not yet captured.`;
}

const ESSENTIAL_OP_COUNT = CAPABILITY_OP_IDS.length;

/** Render the full module record so the agent verifies each field and fills every gap. */
function skeletonSection(sk?: ExplorerSkeleton): string {
  if (!sk) return "";
  const mark = (n: number) => (n > 0 ? `${n} on record` : "EMPTY — fill this");
  const idLines = sk.identification.length
    ? sk.identification.map((r) => `    - ${r.id} ${r.label}${r.value ? ` = "${r.value}"` : " = (no value yet)"}${r.session ? ` [${r.session}]` : ""}`).join("\n")
    : "    (none on record — read the ID records)";
  const liveLines = sk.liveData.length
    ? sk.liveData.map((b) => `    - ${b.id} ${b.label}${b.session ? ` [${b.session}]` : ""}`).join("\n")
    : "    (none on record — find the live measurement blocks)";
  const opFilled = sk.operations.filter((o) => o.status && o.status !== "unknown").length;
  const opLine = sk.operations.length ? sk.operations.map((o) => `${o.op}=${o.status}`).join(", ") : "all unknown";
  return `

MODULE SKELETON — the complete record we currently hold for THIS exact unit. Treat every value below as a CLAIM to verify against the real bus, and FILL every essential field that is empty. If the module contradicts a stored value, correct it in conclude. Goal: the saved record must end 100% aligned with ground truth.
Identity / part numbers: ${sk.partNumbers.length ? sk.partNumbers.join(", ") : "UNKNOWN — read it and report it"}
Applications: ${sk.applications.join(", ") || "(none recorded)"}
Bus speed: ${sk.bitrate ? `${(sk.bitrate / 1000).toFixed(0)}k` : "?"}${sk.fd ? " (CAN-FD)" : ""}
Sessions (${mark(sk.sessions.length)}): ${sk.sessions.map((s) => s.id).join(", ") || "—"}
Services seen (${mark(sk.services.length)}): ${sk.services.join(", ") || "—"}
Identification records (${mark(sk.identification.length)}):
${idLines}
Live-data blocks (${mark(sk.liveData.length)}):
${liveLines}
Broadcast frames (${mark(sk.broadcastFrames.length)}): ${sk.broadcastFrames.map((f) => f.canId).join(", ") || "—"}
Capability board — ${opFilled}/${ESSENTIAL_OP_COUNT} operations determined: ${opLine}
DTCs on record (${mark(sk.dtcs.length)}): ${sk.dtcs.map((d) => d.code).join(", ") || "—"}${sk.cloneVerdict ? `\nClone verdict on record: ${sk.cloneVerdict}` : ""}

ESSENTIAL FIELDS you MUST return in conclude, populated and verified from this run: identity/part number, sessions, identification (with decoded values), liveData, dtcs, broadcastFrames, and the full operations capability board (a status for ALL ${ESSENTIAL_OP_COUNT} ops). Do not leave an essential field empty if the module can provide it, and never invent a value you did not read.`;
}

function systemPrompt(cfg: ExplorerConfig): string {
  return `You are an expert automotive control-module reverse-engineer, exploring a REAL module live on a bench through a diagnostic gateway. Your job: understand this module as completely as possible — what protocol it speaks, what it broadcasts, every diagnostic service and identifier it supports, what data and capabilities it exposes, and its stored faults — then verify and conclude.

The module under test:
- ${cfg.displayName} (${cfg.brand}, category ${cfg.category})${cfg.vehicle ? ` on a ${cfg.vehicle}` : ""}
- Bus: request id ${cfg.requestId} → response id ${cfg.responseId}, protocol hint: ${cfg.protocol}${cfg.discovered && (cfg.discovered.partNo || cfg.discovered.supplier) ? `
- Already read by discovery: part number ${cfg.discovered.partNo || "?"}${cfg.discovered.supplier ? `, supplier ${cfg.discovered.supplier}` : ""}${cfg.discovered.sw ? `, software ${cfg.discovered.sw}` : ""}${cfg.discovered.hw ? `, hardware ${cfg.discovered.hw}` : ""}${cfg.discovered.serial ? `, serial ${cfg.discovered.serial}` : ""} — confirm, don't re-derive.` : ""}${cfg.summary ? `
- Census says: ${cfg.summary}` : ""}
${cfg.knownDtcs?.length ? `- Previously seen DTCs: ${cfg.knownDtcs.map((d) => d.code).join(", ")}` : ""}${skeletonSection(cfg.skeleton)}${priorSection(cfg.prior)}

You have READ-ONLY tools:
- scan_bus: see what the module broadcasts (ids, bytes, Hz). Use it first, and again later to catch changing signals.
- scan_dids: sweep a DID range (22 xxxx) and get back only the DIDs that answer or are gated — the fastest way to find a module's measurement, coding and identification blocks. Sweep 0100-03FF and F180-F1FF on every module (in the extended session), F400-F4FF on powertrain modules; then read the hits twice with probe to see which bytes move (live signals) and which are static (coding / identification).
- probe: send diagnostic requests over one socket. Batch a session opener + reads together, e.g. ["1081","21F0"] or ["1003","22F190"]. Positive responses start with SID+0x40 (50/59/62/61…); negatives are 7F <sid> <nrc>.
- record: log each confirmed finding (identity, service, capability, dtc, signal, note). RECORD OFTEN — anything you record is salvaged even if you run out of steps.
- conclude: finish with the full structured understanding. ALWAYS end with conclude.

YOUR DELIVERABLES map 1:1 to the operator's cockpit tabs — every run should ENRICH each of these five, and you conclude by filling their structured arrays:
  🪪 ECU Information → identification[] + sessions[] : part numbers, VIN, hardware/software versions, calibration ID, serial — each with the request and session it came from, decoded to readable text.
  ⚠️ Trouble Codes → dtcs[] : stored, pending AND permanent codes, with the failure they describe.
  📈 Live Data → liveData[] : every measurement block/PID the module exposes, the session it needs, and what its bytes carry (decode where you can).
  📡 Bus Monitor → broadcastFrames[] : every id the module broadcasts, its rate, and which bytes are live counters/signals.
  🧩 Capabilities → operations[] : a status for ALL ${ESSENTIAL_OP_COUNT} canonical ops (the read/write map). This is the single most important output.
Spend the run discovering things NOT already on the skeleton so these tabs grow. If you learn nothing new for a tab, that's fine — but never regress a known-good field.

Method (be systematic and efficient — you have ~${MAX_STEPS} steps):
0. Read the MODULE SKELETON above (if present). Your mission is to VERIFY each field it holds against the live bus and FILL every essential field still empty or unknown — the stored record must match ground truth when you conclude. Skip re-deriving nothing; confirm and extend.
1. scan_bus to see the broadcast map (call it twice to spot changing live bytes).
2. Enumerate SESSIONS with service 10. Try KWP sub-functions 81, 86, 87, 89, 92, C0 and UDS 01, 03; record which are accepted (50 xx). NEVER request a programming session (10 02 / 10 82 / 10 85) or the safety-system session (10 04) — this may be a customer's car; they are refused. CRITICAL: KWP modules (Nissan/JATCO, Bosch-KWP) usually expose their richest data ONLY in a NON-STANDARD session — most often 0xC0, sometimes 0x86 — not the default 0x81.
3. Identification: 21 F0/F1/FA/FB/FC/FD/FE/FF and 1A 86/87/8A/90 (KWP) and 22 F190/F187/F18C/F191/F195/F18A (UDS). Mercedes-Benz UDS modules answer 22 F111 (hardware part no.), F121 (software part nos.), F150/F151 (HW/SW version), F154/F155 (supplier), F100 (diagnostic variant) instead of F187/F195; Mercedes KWP-on-CAN modules answer 1A 86 (BCD part no. + versions), 1A 87 (ASCII part no.), 1A 90 (VIN). Decode ASCII part numbers.
3b. DID SWEEP (UDS modules): scan_dids 0100-03FF and F180-F1FF in the extended session (F400-F4FF too on ECM/TCM). Every DID that answers is a deliverable: decode what it holds (ASCII → identification; 1-4 byte values that change between two reads → live measurement, name the physical quantity from its range/behaviour and the module's role; static small values → coding/configuration; F186 = active session; F198/F199 = tester serial / programming date). A DID that is GATED with NRC 0x33 is a security-protected read/write — record it as such.
4. LIVE DATA — the highest-value target: reads (21 xx) are SESSION-GATED — the SAME id returns different blocks in different sessions, and a 0x7F NRC means "not in THIS session" (try another), NOT "unsupported". For EACH accepted session, re-try data LIDs 21 00, 21 01, 21 02, 21 03, 21 04, 21 10, 21 20. On Nissan/JATCO the live measurement block (temps/pressures/solenoid currents) is typically 21 02 in the rich session 0xC0. Do NOT conclude "no live data" until you have tried the data LIDs in every accepted session — especially 0xC0.
5. Read DTCs (19 02 FF; a KWP module that answers 7F 19 11 keeps them behind 18 02 FF 00 → 58 <count> {hi lo status}…), decode the P/C/B/U codes and status bytes — in UDS only records with status bits 0x01/0x04/0x08/0x80 are faults, 0x40/0x10 alone mean 'test not completed'; also try snapshot/freeze blocks (21 13/16/17/18/19/1A/1B) in the rich session.
6. Probe which services answer vs return 7F, to map the real capability surface. Interpret NRCs (0x11 service not supported, 0x12 sub-function/LID not supported, 0x7F not in active session → switch sessions, 0x31 out of range).
7. record findings as you confirm them; verify by re-reading where useful.
8. conclude with a confident, honest summary — do this BEFORE you run out of steps. In conclude, FILL the structured arrays so the module's cockpit grows: sessions (every accepted 50 xx), identification (each ID record with its request + session + decoded value), liveData (each measurement block + the session it needs), broadcastFrames (each broadcast id + rate + what the bytes carry).
   Include in liveData EVERY measurement DID/LID you confirmed (id = the exact request, e.g. "22 0100" or "21 02", label = the physical quantity, note = decode/scaling), and in identification every static record (F1xx and coding DIDs) with its decoded value.
   ALSO fill the canonical **operations** array — the standard capability board every module shares. For EACH of these operations give a status: read_identification, read_dtcs, read_freeze_frames, read_live_data, read_broadcast, read_memory, read_scaling, clear_dtcs, security_access, coding_adaptation, actuator_test, routine_control, ecu_reset, flash_write. For security_access: a seed reply (67 01 xx…) = supported; 7F 27 7F/22 = gated (needs another session); 7F 27 11 = unsupported. status = supported (answered positively) | gated (SID recognised but refused — e.g. NRC 0x12/0x22/0x33; note the nrc) | unsupported (NRC 0x11 serviceNotSupported) | unknown (you did not test it — do NOT guess a write actually works; leave write ops unknown unless a read-only probe legitimately revealed their state). For supported reads include request + session. Distinguish carefully: NRC 0x11 = unsupported, but 0x12/0x22/0x33/0x7F = gated (the service exists). This is the most important output — it is how the cockpit renders what the module can do.

Rules: NEVER attempt writes, coding, security unlock, or resets — they are refused anyway. Be honest about uncertainty. Think out loud briefly before each action so the operator can follow your reasoning. Do not repeat identical probes needlessly.`;
}

/** DID sweep: batches of BATCH requests per socket (session opener first), only responders reported. */
async function execScanDids(input: Record<string, unknown>, deps: ExplorerDeps): Promise<string> {
  const start = parseInt(String(input.start ?? "").replace(/[^0-9a-fA-F]/g, ""), 16);
  const end = parseInt(String(input.end ?? "").replace(/[^0-9a-fA-F]/g, ""), 16);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 0xffff || end < start) return "scan_dids: bad range (need 4-hex start ≤ end)";
  const count = Math.min(end - start + 1, 1024);
  const session = String(input.session ?? "").replace(/\s+/g, "");
  if (session && (!session.toLowerCase().startsWith("10") || !isReadOnlyRequest(session))) return `scan_dids: session opener ${session} refused (read-only agent; programming / safety-system sessions are never entered)`;
  const BATCH = 20;
  const positives: string[] = [];
  const gated: string[] = [];
  let scanned = 0;
  for (let base = start; base < start + count; base += BATCH) {
    if (deps.shouldStop()) break;
    const dids: number[] = [];
    for (let d = base; d < Math.min(base + BATCH, start + count); d++) dids.push(d);
    const reqs = dids.map((d) => `22${d.toString(16).toUpperCase().padStart(4, "0")}`);
    const items = await deps.probe(session ? [session, ...reqs] : reqs);
    const body = session ? items.slice(1) : items;
    body.forEach((it, i) => {
      const did = dids[i].toString(16).toUpperCase().padStart(4, "0");
      scanned++;
      if (!it || !it.response) return;
      if (it.negative) {
        const nrc = it.nrc ?? 0;
        if (nrc !== 0x31 && nrc !== 0x11 && nrc !== 0x12) gated.push(`${did} → NRC 0x${nrc.toString(16).toUpperCase().padStart(2, "0")}`);
        return;
      }
      const a = ascii(it.response);
      const data = fmt(it.response).slice(9);
      positives.push(`${did} → ${data.slice(0, 60)}${data.length > 60 ? "…" : ""}${a ? `  ascii="${a.slice(0, 40)}"` : ""}`);
    });
  }
  const lines = [`scanned ${scanned} DIDs ${start.toString(16).toUpperCase().padStart(4, "0")}-${(start + count - 1).toString(16).toUpperCase().padStart(4, "0")}${session ? ` in session ${session}` : ""}: ${positives.length} answered, ${gated.length} gated`];
  if (positives.length) lines.push("ANSWERED:", ...positives);
  if (gated.length) lines.push("GATED (exists, refused):", ...gated);
  return lines.join("\n");
}

async function execProbe(requests: string[], deps: ExplorerDeps): Promise<string> {
  const cleaned = requests.map((r) => r.replace(/\s+/g, "")).filter(Boolean).slice(0, 12);
  const isAllowed = isReadOnlyRequest;
  const refused = cleaned.filter((r) => !isAllowed(r));
  const runnable = cleaned.filter(isAllowed);
  if (runnable.length === 0) return `All requests refused (read-only agent): ${refused.join(", ")}. Only session/read services are permitted.`;
  const results = await deps.probe(runnable);
  const lines = results.map((r) => {
    if (!r.response) return `${fmt(r.request)} → no response${r.error ? ` (${r.error})` : ""}`;
    if (r.negative) return `${fmt(r.request)} → NEGATIVE 7F nrc=0x${(r.nrc ?? 0).toString(16).toUpperCase().padStart(2, "0")}`;
    const a = ascii(r.response);
    return `${fmt(r.request)} → ${fmt(r.response)}${a ? `  ascii="${a}"` : ""}`;
  });
  if (refused.length) lines.push(`(refused, read-only: ${refused.join(", ")})`);
  return lines.join("\n");
}

export async function exploreModule(cfg: ExplorerConfig, deps: ExplorerDeps): Promise<ExplorerResult> {
  const apiKey = getApiKey();
  if (!apiKey || !apiKey.trim()) throw new Error("No Anthropic API key set. Open Settings and paste your key.");
  const client = new Anthropic({ apiKey });

  deps.onEvent({ type: "status", text: `Exploring ${cfg.displayName} on ${cfg.requestId}→${cfg.responseId}…` });
  if (cfg.prior && cfg.prior.runCount > 0) {
    deps.onEvent({ type: "prior", knowledge: cfg.prior });
    deps.onEvent({ type: "status", text: `Building on ${cfg.prior.runCount} prior run(s): ${cfg.prior.services.length} services, ${cfg.prior.capabilities.length} capabilities, ${cfg.prior.dtcs.length} DTCs known.` });
  }

  const recorded: { kind: string; title: string; detail: string }[] = [];
  let tokensIn = 0, tokensOut = 0;

  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: cfg.prior && cfg.prior.runCount > 0
      ? "Continue exploring the module. You already know a lot from prior runs (see the system prompt) — confirm it quickly, then focus on discovering NEW services, identifiers, signals or behaviours. Narrate your reasoning, and conclude when done."
      : "Begin exploring the module. Start by scanning the bus, then open a session and enumerate everything it supports. Narrate your reasoning as you go.",
  }];

  for (let step = 0; step < MAX_STEPS; step++) {
    if (deps.shouldStop()) {
      deps.onEvent({ type: "status", text: "Stopped by operator — saving partial result." });
      const partial = buildPartial(recorded, cfg, tokensIn, tokensOut, step, "stopped by operator");
      deps.onEvent({ type: "done", result: partial });
      return partial;
    }

    // 5.5-generation models always think and count it in max_tokens, and hide the thinking
    // text unless asked: give them room and ask for summaries (they feed the live feed).
    const model = explorerModel();
    const gen55 = /-5-5$/.test(model);
    const resp = await client.messages.create({
      model, max_tokens: gen55 ? 16000 : 8000,
      thinking: gen55 ? { type: "adaptive", display: "summarized" } : { type: "adaptive" },
      system: systemPrompt(cfg), tools: TOOLS, messages,
    });
    tokensIn += resp.usage?.input_tokens ?? 0;
    tokensOut += resp.usage?.output_tokens ?? 0;
    deps.onEvent({ type: "usage", inputTokens: tokensIn, outputTokens: tokensOut, steps: step + 1 });

    for (const block of resp.content) {
      if (block.type === "thinking" && block.thinking.trim()) deps.onEvent({ type: "thought", text: block.thinking.trim() });
      else if (block.type === "text" && block.text.trim()) deps.onEvent({ type: "thought", text: block.text.trim() });
    }
    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      deps.onEvent({ type: "status", text: "Agent stopped without an explicit conclusion — salvaging findings." });
      const partial = buildPartial(recorded, cfg, tokensIn, tokensOut, step + 1, "agent ended without conclude");
      deps.onEvent({ type: "done", result: partial });
      return partial;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      deps.onEvent({ type: "action", tool: tu.name, input });

      if (tu.name === "conclude") {
        // Defensive: if the model's conclude payload was truncated (max_tokens) or
        // under-filled, coerce every field so we never crash — and fall back to
        // recorded findings for anything missing, so the run is never lost.
        const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
        const str = (v: unknown, d = ""): string => (typeof v === "string" && v ? v : d);
        const salvage = buildPartial(recorded, cfg, tokensIn, tokensOut, step + 1, "conclude");
        const services = arr<string>(input.services);
        const capabilities = arr<string>(input.capabilities);
        const dtcs = arr<{ code: string; desc: string }>(input.dtcs);
        const base = {
          summary: str(input.summary, salvage.summary),
          identity: str(input.identity, salvage.identity),
          services: services.length ? services : salvage.services,
          capabilities: capabilities.length ? capabilities : salvage.capabilities,
          dtcs: dtcs.length ? dtcs : salvage.dtcs,
          confidence: (["low", "medium", "high"].includes(input.confidence as string) ? input.confidence : "medium") as ExplorerResult["confidence"],
          verification: str(input.verification, salvage.verification),
          sessions: arr<{ id: string; label: string }>(input.sessions),
          identification: arr<{ id: string; label: string; value: string; session?: string }>(input.identification),
          liveData: arr<{ id: string; label: string; session?: string; note?: string }>(input.liveData),
          broadcastFrames: arr<{ canId: string; hz?: number; decode?: string }>(input.broadcastFrames),
          operations: arr<{ op: string; status: string; request?: string; session?: string; nrc?: string; detail?: string }>(input.operations)
            .filter((o) => (CAPABILITY_OP_IDS as readonly string[]).includes(o.op) && ["supported", "gated", "unsupported", "unknown"].includes(o.status)),
        };
        const result: ExplorerResult = {
          ...base,
          outcome: "concluded",
          tokensIn, tokensOut, steps: step + 1,
          newFindings: computeNew(base, cfg.prior),
        };
        deps.onEvent({ type: "done", result });
        return result;
      }
      let content = "";
      try {
        if (tu.name === "scan_bus") {
          const ms = Math.max(300, Math.min(Number(input.ms) || 700, 2000));
          const snap = await deps.scanBus(ms);
          content = snap.frames.length
            ? snap.frames.map((f) => `${f.id}  [${f.dlc}]  ${f.bytes}  (${f.hz}Hz)`).join("\n")
            : "no broadcast frames (bus quiet / module not broadcasting)";
          deps.onEvent({ type: "observation", tool: "scan_bus", summary: `${snap.frames.length} id(s): ${snap.frames.map((f) => f.id).join(", ") || "none"}`, detail: content });
        } else if (tu.name === "probe") {
          content = await execProbe(Array.isArray(input.requests) ? (input.requests as string[]) : [], deps);
          deps.onEvent({ type: "observation", tool: "probe", summary: String(input.purpose || "probe"), detail: content });
        } else if (tu.name === "scan_dids") {
          content = await execScanDids(input, deps);
          deps.onEvent({ type: "observation", tool: "scan_dids", summary: `${String(input.purpose || "DID sweep")} — ${content.split("\n")[0]}`, detail: content });
        } else if (tu.name === "record") {
          const f = { kind: String(input.kind || "note"), title: String(input.title || ""), detail: String(input.detail || "") };
          recorded.push(f);
          deps.onEvent({ type: "finding", ...f });
          content = "recorded";
        } else {
          content = `unknown tool ${tu.name}`;
        }
      } catch (e) {
        content = `tool error: ${(e as Error).message}`;
        deps.onEvent({ type: "observation", tool: tu.name, summary: `error: ${(e as Error).message}` });
      }
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content });
    }

    const userContent: Anthropic.ContentBlockParam[] = [...toolResults];
    const left = MAX_STEPS - 1 - step;
    if (left <= 3) {
      userContent.push({ type: "text", text: `You have about ${left} step(s) left. Do any single highest-value untried probe now, then call conclude with your full understanding so nothing is lost.` });
    }
    messages.push({ role: "user", content: userContent });
  }

  // Ran the full budget without concluding — salvage everything recorded.
  deps.onEvent({ type: "status", text: "Reached the step budget — saving what was found." });
  const partial = buildPartial(recorded, cfg, tokensIn, tokensOut, MAX_STEPS, "reached step budget");
  deps.onEvent({ type: "done", result: partial });
  return partial;
}
