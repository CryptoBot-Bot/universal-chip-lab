/**
 * Bench-module profiles — the growing knowledge base behind "Bench Module Master".
 *
 * A BenchModuleProfile captures everything needed to take a control module out of
 * a car, wire it up on the bench, and talk to it: how to HOOK IT UP (power / ground
 * / ignition-wake / CAN-H / CAN-L / K-line), which bus + IDs + speed to use, and
 * what you can DO with it once it's alive (sessions, DTCs, live data, capabilities).
 *
 * It carries the SAME trust ladder as chip profiles: an AI-mapped module is only
 * `ai_suggested` until a real bench session confirms it (`bench_verified`). The
 * write gate (isBenchWriteTrusted) mirrors chip-db's isWriteTrusted — an AI guess
 * never authorises a write. This file is browser-safe (no node imports).
 */

// ---- trust / provenance (mirrors chip-db ChipProvenance) --------------------

export type BenchModuleSource = "seed" | "operator" | "ai_resolved";
/** ascending trust — writes require bench_verified */
export type BenchModuleConfidence = "unverified" | "ai_suggested" | "bench_verified";

export interface BenchModuleEvidence {
  markings?: string;            // top-label / silkscreen text the operator typed or the AI read
  observedPartNumber?: string;  // part number confirmed on the bench (F187 / stamped)
  photoRefs?: string[];         // workspace-relative photo paths / asset ids
  observedOn?: string;          // e.g. bench VIN / plate (user's own vehicle)
  model?: string;               // AI model id, if ai_resolved
}

export interface BenchModuleProvenance {
  source: BenchModuleSource;
  confidence: BenchModuleConfidence;
  createdAt: string;            // ISO
  updatedAt?: string;           // ISO — stamped on save
  notes?: string;               // AI rationale / operator note
  evidence?: BenchModuleEvidence;
}

// ---- hookup (the whole point of the Identify step) --------------------------

export type HookupSignal =
  | "power"        // permanent 12V battery +
  | "ignition"     // switched / KL15 12V — wakes the transceiver
  | "ground"       // chassis / power ground
  | "can_h"        // CAN High
  | "can_l"        // CAN Low
  | "kline"        // ISO 9141 / KWP K-line
  | "lin"          // LIN bus
  | "wake"         // dedicated wake / enable line
  | "flexray"      // FlexRay (info only)
  | "other";

export const HOOKUP_SIGNALS: readonly HookupSignal[] = [
  "power", "ignition", "ground", "can_h", "can_l", "kline", "lin", "wake", "flexray", "other",
];

export interface HookupPin {
  pin: string;             // connector pin id as printed, e.g. "A12", "3", "K73"
  signal: HookupSignal;
  connectTo: string;       // human wiring target, e.g. "12V battery +", "Chassis GND", "HS-CAN High"
  required: boolean;       // must be connected for the module to power up / respond
  note?: string;
}

/** A pin in the visual connector builder. `unused` = a physical pin we don't touch. */
export interface ConnectorPin {
  pin: string;                        // printed pin id, e.g. "12", "A3"
  signal: HookupSignal | "unused";
  connectTo?: string;                 // wiring target when assigned
  required?: boolean;
  note?: string;
}

/** The connector drawn as rows of pin boxes — user-editable. */
export interface ConnectorLayout {
  rows: ConnectorPin[][];
}

/** Assigned pins (signal !== "unused") flattened into the canonical hookup list. */
export function hookupFromConnector(layout: ConnectorLayout): HookupPin[] {
  const out: HookupPin[] = [];
  for (const row of layout.rows) {
    for (const c of row) {
      if (c.signal !== "unused" && c.pin.trim()) {
        out.push({ pin: c.pin, signal: c.signal, connectTo: c.connectTo ?? "", required: !!c.required, ...(c.note ? { note: c.note } : {}) });
      }
    }
  }
  return out;
}

/** Seed a connector layout from an existing flat hookup list (chunked into rows). */
export function connectorFromHookup(hookup: HookupPin[], perRow = 6): ConnectorLayout {
  const cells: ConnectorPin[] = hookup.map((h) => ({ pin: h.pin, signal: h.signal, connectTo: h.connectTo, required: h.required, note: h.note }));
  const rows: ConnectorPin[][] = [];
  for (let i = 0; i < cells.length; i += perRow) rows.push(cells.slice(i, i + perRow));
  if (rows.length === 0) rows.push([]);
  return { rows };
}

export type BenchBusProtocol = "uds" | "kwp2000" | "obd2" | "canfd" | "kline" | "unknown";
export const BENCH_BUS_PROTOCOLS: readonly BenchBusProtocol[] = ["uds", "kwp2000", "obd2", "canfd", "kline", "unknown"];

export interface BenchBus {
  name: string;               // "HS-CAN", "MS-CAN", "K-line"
  protocol: BenchBusProtocol;
  bitrate: number;            // 500000, 125000, ...
  fd?: boolean;               // CAN-FD
  requestId?: string;         // tester → module diagnostic id, hex e.g. "7E1"
  responseId?: string;        // module → tester, hex e.g. "7E9"
  termination: boolean;       // bench needs a 120Ω terminator on this bus
}

// ---- diagnostics / what you can do ------------------------------------------

export type BenchModuleCategory =
  | "ecm" | "tcm" | "abs" | "srs" | "bcm" | "ipc" | "hvac"
  | "gateway" | "immo" | "eps" | "adas" | "radio" | "other";

export const BENCH_MODULE_CATEGORIES: readonly BenchModuleCategory[] = [
  "ecm", "tcm", "abs", "srs", "bcm", "ipc", "hvac", "gateway", "immo", "eps", "adas", "radio", "other",
];

export interface BenchModuleDtc {
  code: string;               // "P0740"
  desc: string;
}

/** A concrete identification record read from the module (part no / calibration / date). */
export interface BenchIdRecord {
  id: string;                 // request that returns it, e.g. "21 F0" or "22 F190"
  label: string;              // "Hardware ID", "Calibration", "Program date"…
  value: string;              // decoded/ascii value, e.g. "1XJ3A"
  session?: string;           // session it must be read in, e.g. "10 C0"
  raw?: string;               // raw hex payload, optional
}

/** A live-data measurement block the module exposes (session-gated on many makers). */
export interface BenchLiveBlock {
  id: string;                 // read request, e.g. "21 02"
  label: string;              // "Live measurement block (ATF temp / pressures)"
  session?: string;           // session required, e.g. "10 C0"
  note?: string;              // decode hint / contents
}

/** A frame the module continuously broadcasts on the bus (its "live data on the wire"). */
export interface BenchBroadcastFrame {
  canId: string;              // "0x174"
  dlc?: number;
  hz?: number;                // broadcast rate
  label?: string;             // "Motor_1" / friendly name
  decode?: string;            // what the bytes carry, e.g. "gear/output in bytes 4-5"
}

// ---- the canonical capability model (the "golden format") -------------------
// Every module — any maker, any protocol — is described by the SAME fixed set of
// operations. Each is proven present / gated / absent / unknown, so the Real Device
// cockpit renders one uniform board for every module, and a NEW module is data the
// AI explorer fills in rather than code anyone writes.

export type CapabilityStatus = "supported" | "gated" | "unsupported" | "unknown";
export type CapabilityGroup = "read" | "action";

/** The fixed catalog entry — the definition of one canonical operation. */
export interface CapabilitySpec {
  id: string;              // canonical op id, stable
  label: string;
  group: CapabilityGroup;  // read = pull data out; action = changes the module
  write: boolean;          // true = mutates the module → routes to the Cloning Ceremony / simulator
  blurb: string;           // one-line, human explanation
}

/** What a specific module supports for one operation (fills a catalog slot). */
export interface ModuleCapability {
  op: string;              // matches a CapabilitySpec.id
  status: CapabilityStatus;
  request?: string;        // exact hex to invoke (reads), e.g. "21 02"
  session?: string;        // session it must run in, e.g. "10 C0"
  nrc?: string;            // why gated/unsupported, e.g. "0x12"
  trust?: BenchModuleConfidence;
  detail?: string;
}

/** A catalog spec resolved against a module — what the cockpit actually renders. */
export interface ResolvedCapability extends CapabilitySpec, Omit<ModuleCapability, "op"> {}

/** The canonical operation catalog — the checklist every module fills out. */
export const CAPABILITY_CATALOG: readonly CapabilitySpec[] = [
  // READ — pull data out (safe on real hardware)
  { id: "read_identification", label: "Identification", group: "read", write: false, blurb: "Part numbers, hardware/software, calibration, serial, VIN, dates." },
  { id: "read_dtcs", label: "Fault codes (DTCs)", group: "read", write: false, blurb: "Stored diagnostic trouble codes with status bytes." },
  { id: "read_freeze_frames", label: "Freeze frames", group: "read", write: false, blurb: "Snapshots of conditions captured when a fault set." },
  { id: "read_live_data", label: "Live data", group: "read", write: false, blurb: "Live measurement blocks — sensors, pressures, speeds, currents." },
  { id: "read_broadcast", label: "Broadcast (passive)", group: "read", write: false, blurb: "Frames the module continuously puts on the wire." },
  { id: "read_memory", label: "Memory read", group: "read", write: false, blurb: "ReadMemoryByAddress — the diagnostic-side clone source (often gated)." },
  { id: "read_scaling", label: "Scaling / definitions", group: "read", write: false, blurb: "Physical scaling for raw data identifiers." },
  // ACTION — changes the module (gated → Cloning Ceremony or simulator only)
  { id: "clear_dtcs", label: "Clear fault codes", group: "action", write: true, blurb: "Erase stored DTCs." },
  { id: "security_access", label: "Security access", group: "action", write: true, blurb: "Seed/key unlock for protected functions." },
  { id: "coding_adaptation", label: "Coding / adaptation", group: "action", write: true, blurb: "Write coding, adaptation and configuration values." },
  { id: "actuator_test", label: "Actuator tests", group: "action", write: true, blurb: "Drive outputs (solenoids, valves, relays) for testing." },
  { id: "routine_control", label: "Routines", group: "action", write: true, blurb: "Start/stop on-board routines (resets, calibrations)." },
  { id: "ecu_reset", label: "ECU reset", group: "action", write: true, blurb: "Reboot the module." },
  { id: "flash_write", label: "Flash / memory write", group: "action", write: true, blurb: "Write flash/EEPROM — the clone target, gated by the Cloning Ceremony." },
];

export interface BenchModuleDiagnostics {
  simTemplateKey?: string;    // links to moduleCatalog MODULE_TEMPLATES key for the simulator
  sessions: { id: string; label: string }[];   // e.g. { id:"10 03", label:"Extended session" }
  sampleServices: string[];   // service ids known present, e.g. ["10","22","19","27"]
  knownDtcs: BenchModuleDtc[];
  capabilities: string[];     // legacy free-text actions (kept for context)
  operations?: ModuleCapability[];   // the canonical capability model (golden format)
  identification?: BenchIdRecord[];   // ID records the module exposes (grows with Explorer runs)
  liveData?: BenchLiveBlock[];        // live measurement blocks + their session
  broadcastFrames?: BenchBroadcastFrame[]; // frames it puts on the wire
}

/** Derive read-op statuses from a module's structured knowledge, so a module lights
 * up the board from what we already know even without an explicit operations[]. */
function deriveCapabilities(diag: BenchModuleDiagnostics): Map<string, ModuleCapability> {
  const m = new Map<string, ModuleCapability>();
  const svc = new Set(diag.sampleServices.map((s) => s.toUpperCase()));
  const isFreeze = (label: string) => /freeze|snapshot/i.test(label);
  const id0 = diag.identification?.[0];
  if (diag.identification && diag.identification.length) m.set("read_identification", { op: "read_identification", status: "supported", request: id0?.id, session: id0?.session, detail: `${diag.identification.length} record(s)` });
  if (diag.knownDtcs.length || svc.has("19")) m.set("read_dtcs", { op: "read_dtcs", status: "supported", request: "19 02 FF", detail: diag.knownDtcs.length ? `${diag.knownDtcs.length} known` : undefined });
  const live = (diag.liveData ?? []).filter((b) => !isFreeze(b.label));
  const freeze = (diag.liveData ?? []).filter((b) => isFreeze(b.label));
  if (live.length) m.set("read_live_data", { op: "read_live_data", status: "supported", request: live[0].id, session: live[0].session, detail: `${live.length} block(s)` });
  if (freeze.length) m.set("read_freeze_frames", { op: "read_freeze_frames", status: "supported", request: freeze[0].id, session: freeze[0].session, detail: `${freeze.length} block(s)` });
  if (diag.broadcastFrames && diag.broadcastFrames.length) m.set("read_broadcast", { op: "read_broadcast", status: "supported", detail: `${diag.broadcastFrames.length} frame(s)` });
  if (svc.has("23")) m.set("read_memory", { op: "read_memory", status: "supported", request: "23" });
  if (svc.has("17")) m.set("read_scaling", { op: "read_scaling", status: "supported" });
  return m;
}

/** Resolve the full canonical catalog against a module — explicit operations[] win,
 * else derive from structured knowledge, else "unknown". This is what the cockpit renders. */
export function moduleCapabilities(diag: BenchModuleDiagnostics): ResolvedCapability[] {
  const explicit = new Map((diag.operations ?? []).map((o) => [o.op, o]));
  const derived = deriveCapabilities(diag);
  return CAPABILITY_CATALOG.map((spec) => {
    const cap = explicit.get(spec.id) ?? derived.get(spec.id) ?? { op: spec.id, status: "unknown" as CapabilityStatus };
    const { op: _op, ...rest } = cap;
    return { ...spec, ...rest };
  });
}

// ---- clone guidance (memory-read → bench clone) -----------------------------

export type BenchCloneVerdict = "cloneable-bench" | "cloneable-advanced" | "partial" | "not-cloneable";
export interface BenchCloneMethod {
  name: string;
  tier: "reliable" | "supplemental" | "partial" | "last-resort";
  how: string;
  tools?: string;
}
export interface BenchCloneRegion { region: string; size: string; holds: string; readVia: string; }
export interface BenchCloneGuide {
  verdict: BenchCloneVerdict;
  headline: string;           // one line, plain language
  summary: string;            // a paragraph on how cloning this unit really works
  methods: BenchCloneMethod[];
  memoryMap?: BenchCloneRegion[];
  donorNote?: string;         // donor-matching + immobiliser reality
  safeOrder?: string[];       // the safe step order, tied to the Cloning Ceremony
}

// ---- the record -------------------------------------------------------------

export interface BenchModuleReference { label: string; url: string; }

export interface BenchModuleProfile {
  id: string;                 // stable slug, e.g. "aisin-tcm-tf80sc"
  displayName: string;
  brand: string;              // "Aisin", "Bosch", "Continental", "VAG", "Ford"...
  category: BenchModuleCategory;
  partNumbers: string[];
  applications: string[];     // vehicles this module appears in
  yearRange?: [number, number];
  powerNote: string;          // one line: how to power/wake it on the bench
  hookup: HookupPin[];        // pin-by-pin wiring (canonical; derived from connector when present)
  connector?: ConnectorLayout; // optional user-editable visual pinout (rows of pin boxes)
  buses: BenchBus[];
  asciiConnector: string;     // ASCII connector diagram (like chip guide asciiPinout)
  cautions: string[];
  references: BenchModuleReference[];
  diagnostics: BenchModuleDiagnostics;
  cloneGuide?: BenchCloneGuide;   // how to clone this unit (memory read → bench clone)
  provenance: BenchModuleProvenance;
}

// ---- helpers ----------------------------------------------------------------

/** Stable id from identity. */
export function benchModuleId(brand: string, displayName: string): string {
  return [brand, displayName].join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** Legacy/synthesised provenance so seed records without a block still validate. */
export function effectiveBenchProvenance(p: BenchModuleProfile): BenchModuleProvenance {
  if (p.provenance) return p.provenance;
  return { source: "seed", confidence: "bench_verified", createdAt: "1970-01-01T00:00:00.000Z" };
}

/** The single write gate — an AI guess never authorises a write. */
export function isBenchWriteTrusted(p: BenchModuleProfile): boolean {
  return effectiveBenchProvenance(p).confidence === "bench_verified";
}

export function validateBenchModuleProfile(p: Partial<BenchModuleProfile>): string[] {
  const errs: string[] = [];
  if (!p.id) errs.push("missing id");
  if (!p.displayName) errs.push("missing displayName");
  if (!p.brand) errs.push("missing brand");
  if (!p.category || !BENCH_MODULE_CATEGORIES.includes(p.category)) errs.push("missing/invalid category");
  if (!Array.isArray(p.hookup)) errs.push("hookup must be an array");
  if (!Array.isArray(p.buses)) errs.push("buses must be an array");
  if (!p.diagnostics) errs.push("missing diagnostics");
  if (!p.provenance) errs.push("missing provenance");
  else {
    const src: BenchModuleSource[] = ["seed", "operator", "ai_resolved"];
    const conf: BenchModuleConfidence[] = ["unverified", "ai_suggested", "bench_verified"];
    if (!src.includes(p.provenance.source)) errs.push("invalid provenance.source");
    if (!conf.includes(p.provenance.confidence)) errs.push("invalid provenance.confidence");
    if (!p.provenance.createdAt) errs.push("missing provenance.createdAt");
  }
  return errs;
}
