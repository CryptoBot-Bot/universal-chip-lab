/**
 * Vehicle Profile — the unit the library is keyed on: one YEAR / MAKE / MODEL.
 *
 * A profile bundles everything we know about a vehicle so that the NEXT time we
 * plug into one, a VIN decode can find it and load the whole map instantly —
 * skipping AI re-mapping. Profiles are the "memory that travels with publishes":
 * seed (ships) + learned (disk) + community (baked), same pattern as bus knowledge.
 *
 * Renderer + node safe. Reuses `RiskLevel` from the bus schema; its own category
 * enum is named `VehicleSystemCategory` to avoid colliding with the barrel's
 * `ModuleCategory` (from moduleProfile.schema).
 */

import type { CarInventory, InventoryChange } from "./moduleIdentity.js";
import type { RiskLevel } from "./busKnowledge.schema.js";
import type { ModuleCapability } from "./benchModule.schema.js";

export type BodyType =
  | "sedan" | "suv" | "truck" | "van" | "minivan" | "hatchback" | "coupe" | "wagon";

export type VehicleSystemCategory =
  | "powertrain" | "transmission" | "chassis" | "body" | "infotainment"
  | "safety" | "network" | "hvac" | "other";

/** Where a module physically lives — used to place its hotspot on the 3D mesh. */
export type ModuleLocation =
  | "engine" | "cabin_front" | "cabin_rear" | "dash" | "trunk"
  | "front_left" | "front_right" | "rear_left" | "rear_right"
  | "wheel_fl" | "wheel_fr" | "wheel_rl" | "wheel_rr" | "roof" | "underbody";

export type VehicleProfileSource = "seed" | "bench_observed" | "ai_suggested" | "vin_decoded" | "user" | "community";

export interface VehicleBus {
  id: string;                 // "hs-can" | "ms-can" | "k-line" | ...
  label: string;              // "HS-CAN (powertrain)"
  protocol: "CAN" | "CAN-FD" | "K-Line" | "J1850" | "SW-CAN" | "LIN" | "DoIP";
  bitrate: number;            // bps (0 for non-CAN where N/A)
  obdPins?: string;           // "6/14"
}

/** Brand-correct identifying evidence for one module — overrides the generic
 * sample values on the shared ModuleTemplate so each make carries its real
 * supplier and part-number scheme (the strongest signal the AI mapper reads). */
export interface ModuleIdentity {
  supplier: string;   // e.g. "Bosch" | "ZF" | "Continental" | "Hitachi"
  partNo: string;     // brand part-number scheme → DID F187
  sw?: string;        // software version → F195
  hw?: string;        // hardware number → F191
  serial?: string;    // serial → F18C
  observedAt?: string; // ISO — set when this identity was READ off a live bus (not seeded/guessed)
}

/** One diagnostic operation actually executed against a module on a live bus —
 * the "what worked here" memory (read + write), capped per module. */
export interface ModuleOpLog {
  at: string;            // ISO
  kind: "read" | "write";
  label: string;         // "Clear DTCs", "Read identification", …
  request: string;       // hex sent (last request of the sequence)
  response?: string;     // hex received
  ok: boolean;
  nrc?: string;          // negative response code if refused
  vin?: string;          // unit it ran on
}

/** What a live bus looked like when this vehicle was identified — the set of
 * diagnostic responders plus each one's identification strings. A second unit
 * of the same YMM should fingerprint the same; a different model will not. */
export interface VehicleFingerprint {
  takenAt: string;
  iface?: string;
  responders: string[];                     // response ids that answered ("7E8", "7B8", …)
  ecus: { responseId: string; requestId?: string; partNo?: string; supplier?: string; sw?: string; serial?: string; vin?: string }[];
  calId?: string;                           // OBD 09 04 calibration id (ECM)
  cvn?: string;                             // OBD 09 06
}

/**
 * The permanent, live-verified understanding of ONE module on a specific YMM,
 * grown by the AI vehicle explorer. It uses the SAME canonical capability model
 * as the bench cockpit (ModuleCapability / CAPABILITY_CATALOG), so a module is
 * described the same way whether it was mapped on the bench or on the car — and
 * every re-map deepens it (runCount, prior knowledge, more filled operations).
 *
 * This is the "next time we already know how to talk to this vehicle" memory:
 * it travels with the YMM profile, so a matching VIN loads the whole capability
 * board instantly instead of re-deriving it.
 */
export interface VehicleModuleExploration {
  runCount: number;                 // how many explorer runs contributed
  lastMappedAt: string;             // ISO
  confidence: "low" | "medium" | "high";
  verifiedOn?: string;              // VIN the last verifying run ran against
  summary?: string;
  identity?: string;                // decoded part number / identity string
  services?: string[];              // diagnostic service ids seen (10,22,19,…)
  sessions?: { id: string; label: string }[];
  identification?: { id: string; label: string; value: string; session?: string }[];
  liveData?: { id: string; label: string; session?: string; note?: string }[];
  broadcastFrames?: { canId: string; hz?: number; decode?: string }[];
  dtcs?: { code: string; desc: string }[];
  operations?: ModuleCapability[];  // the canonical board — what we can DO in this module
}

export interface VehicleModule {
  id: string;                 // "ecm" | "tcm" | "abs" | ...
  label: string;              // "Engine Control Module"
  category: VehicleSystemCategory;
  bus: string;                // VehicleBus.id it lives on
  location: ModuleLocation;   // 3D hotspot placement
  addressing?: { request?: string; response?: string }; // e.g. "7E0" / "7E8"
  identity?: ModuleIdentity;  // brand-correct supplier + part numbers (per-vehicle overlay)
  online?: boolean;           // runtime flag (not persisted in seed)
  busKnowledgeId?: string;    // links to a BusModuleKnowledge entry (AI/bench detail)
  explored?: VehicleModuleExploration; // permanent live-verified capability memory
  lastSeenAt?: string;        // ISO — last time this module answered on a discovery scan
  opsLog?: ModuleOpLog[];     // recent real-bus operations run against this module (capped)
  summary?: string;           // census: what this module is / controls on THIS vehicle (AI, from part numbers)
  protocol?: "uds" | "kwp2000" | "obd2" | "unknown"; // census: how to talk to it
  memoryRead?: "obd" | "obd_partial" | "bench";       // census estimate until bench-verified
  censusAt?: string;          // ISO — when the census last named it
}

/** One responder from a live discovery scan (mirrors the electron DiscoveredModule). */
export interface DiscoveredIdent { partNo?: string; supplier?: string; sw?: string; hw?: string; serial?: string; vin?: string }
export interface DiscoveredModuleInput { name: string; requestId: string; responseId: string; negative?: boolean; ident?: DiscoveredIdent }

/** Canonical identity for a module at a response id (from the seed) so a live
 * responder adopts the right name/category instead of a generic stub. */
export interface CanonicalModule { id: string; label: string; category: VehicleSystemCategory; location: ModuleLocation; bus?: string }

const _respNorm = (s?: string) => (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");

/** Merge two modules that share a response id — prefer a real id over a `resp-*`
 * stub, keep the richer exploration. */
function _mergeModules(a: VehicleModule, b: VehicleModule): VehicleModule {
  const base = a.id.startsWith("resp-") && !b.id.startsWith("resp-") ? b : a;
  const other = base === a ? b : a;
  const explored = [base.explored, other.explored]
    .filter((x): x is VehicleModuleExploration => !!x)
    .sort((x, y) => y.runCount - x.runCount)[0];
  return {
    ...base,
    explored,
    lastSeenAt: base.lastSeenAt ?? other.lastSeenAt,
    addressing: base.addressing?.response ? base.addressing : other.addressing,
    busKnowledgeId: base.busKnowledgeId ?? other.busKnowledgeId,
  };
}

/** A live-read identification beats a seeded/guessed one; an empty read keeps
 * whatever we had. Pure. */
export function identityFromDiscovery(d: DiscoveredIdent | undefined, now: string, prev?: ModuleIdentity): ModuleIdentity | undefined {
  if (!d || !(d.partNo || d.supplier || d.sw || d.hw || d.serial)) return prev;
  return {
    supplier: d.supplier || prev?.supplier || "",
    partNo: d.partNo || prev?.partNo || "",
    sw: d.sw ?? prev?.sw, hw: d.hw ?? prev?.hw, serial: d.serial ?? prev?.serial,
    observedAt: now,
  };
}

/** Append a real-bus operation to a module's log (newest last, capped). Pure. */
export function appendOpLog(mod: VehicleModule, entry: ModuleOpLog, cap = 40): VehicleModule {
  const log = [...(mod.opsLog ?? []), entry].slice(-cap);
  return { ...mod, opsLog: log };
}

/**
 * Fold a live discovery scan into a profile's module list. Persisting discovery
 * as its own stage: each responder becomes (or updates) a module with its
 * address and lastSeenAt, so next time this YMM loads we already know the module
 * map. Also HEALS any pre-existing duplicates (e.g. a `resp-788` created before
 * the seed module gained its address) by merging modules that share a response
 * id. Pure.
 */
export function foldDiscoveredModules(
  modules: VehicleModule[],
  discovered: DiscoveredModuleInput[],
  defaultBus: string,
  now: string,
  canonical?: Map<string, CanonicalModule>,
): VehicleModule[] {
  const canon = canonical ?? new Map<string, CanonicalModule>();
  const byResp = new Map<string, VehicleModule>();
  const noResp: VehicleModule[] = [];
  for (const m of modules) {
    const r = _respNorm(m.addressing?.response);
    if (!r) { noResp.push(m); continue; }
    const cur = byResp.get(r);
    byResp.set(r, cur ? _mergeModules(cur, m) : m);
  }
  for (const d of discovered) {
    const r = _respNorm(d.responseId);
    if (!r) continue;
    const c = canon.get(r);
    const existing = byResp.get(r);
    if (existing) {
      // A live responder adopts the seed's canonical identity, replacing a
      // generic resp-* stub — this is what heals earlier duplicates.
      if (c && existing.id.startsWith("resp-")) {
        existing.id = c.id; existing.label = c.label; existing.category = c.category;
        existing.location = c.location; if (c.bus) existing.bus = c.bus;
      }
      existing.addressing = {
        request: existing.addressing?.request || d.requestId,
        response: existing.addressing?.response || d.responseId,
      };
      existing.lastSeenAt = now;
      const ident = identityFromDiscovery(d.ident, now, existing.identity);
      if (ident) existing.identity = ident;
    } else {
      byResp.set(r, {
        id: c?.id ?? `resp-${d.responseId.toLowerCase()}`,
        label: c?.label ?? d.name, category: c?.category ?? "other",
        bus: c?.bus ?? defaultBus, location: c?.location ?? "cabin_front",
        addressing: { request: d.requestId, response: d.responseId }, lastSeenAt: now,
        identity: identityFromDiscovery(d.ident, now),
      });
    }
  }
  // Drop stale no-address orphans now shadowed by an addressed module of the
  // same id (e.g. an old address-less "srs" copy once the real one is mapped).
  const addressedIds = new Set([...byResp.values()].map((m) => m.id));
  const cleanedNoResp = noResp.filter((m) => !addressedIds.has(m.id));
  return [...cleanedNoResp, ...byResp.values()];
}

/** The structured payload one explorer run yields for a module (mirrors the
 * electron ExplorerResult's knowledge fields — kept plain so this schema has no
 * electron dependency). */
export interface ModuleExplorationInput {
  summary?: string;
  identity?: string;
  confidence?: "low" | "medium" | "high";
  services?: string[];
  sessions?: { id: string; label: string }[];
  identification?: { id: string; label: string; value: string; session?: string }[];
  liveData?: { id: string; label: string; session?: string; note?: string }[];
  broadcastFrames?: { canId: string; hz?: number; decode?: string }[];
  dtcs?: { code: string; desc: string }[];
  operations?: ModuleCapability[];
}

/**
 * Fold a fresh explorer run into a module's stored exploration — accumulating,
 * never regressing. Operations upgrade (a newly-supported op replaces an
 * unknown), identification/liveData/DTCs union by key, runCount bumps. Pure.
 */
export function foldExploration(
  prev: VehicleModuleExploration | undefined,
  incoming: ModuleExplorationInput,
  now: string,
  vin?: string,
): VehicleModuleExploration {
  const base: VehicleModuleExploration = prev ?? { runCount: 0, lastMappedAt: now, confidence: "low" };
  // operations: keep the more-informative status (supported > gated > unsupported > unknown)
  const rank: Record<string, number> = { supported: 3, gated: 2, unsupported: 1, unknown: 0 };
  const ops = new Map<string, ModuleCapability>();
  for (const o of base.operations ?? []) ops.set(o.op, o);
  for (const o of incoming.operations ?? []) {
    const cur = ops.get(o.op);
    if (!cur || (rank[o.status] ?? 0) >= (rank[cur.status] ?? 0)) ops.set(o.op, o);
  }
  const mergeBy = <T>(a: T[] | undefined, b: T[] | undefined, key: (x: T) => string): T[] => {
    const m = new Map<string, T>();
    for (const x of a ?? []) m.set(key(x), x);
    for (const x of b ?? []) m.set(key(x), x); // newer wins
    return [...m.values()];
  };
  return {
    runCount: base.runCount + 1,
    lastMappedAt: now,
    confidence: incoming.confidence ?? base.confidence,
    verifiedOn: vin ?? base.verifiedOn,
    summary: incoming.summary ?? base.summary,
    identity: incoming.identity && incoming.identity !== "unknown" ? incoming.identity : base.identity,
    services: [...new Set([...(base.services ?? []), ...(incoming.services ?? [])])],
    sessions: mergeBy(base.sessions, incoming.sessions, (s) => s.id.toUpperCase()),
    identification: mergeBy(base.identification, incoming.identification, (i) => i.id.toUpperCase()),
    liveData: mergeBy(base.liveData, incoming.liveData, (l) => `${l.id}|${l.session ?? ""}`.toUpperCase()),
    broadcastFrames: mergeBy(base.broadcastFrames, incoming.broadcastFrames, (f) => f.canId.toUpperCase()),
    dtcs: mergeBy(base.dtcs, incoming.dtcs, (d) => d.code.toUpperCase()),
    operations: [...ops.values()],
  };
}

export interface VehicleCapability {
  id: string;
  label: string;              // "Read stored DTCs"
  category: VehicleSystemCategory | "diagnostic";
  risk: RiskLevel;            // read = always safe; write/caution gated by the Ceremony
  bus: string;                // which bus
  module?: string;            // target module id
  sequence: string[];         // ordered request commands (e.g. ["10 81", "19 02 FF"])
  note?: string;
}

/**
 * What the free NHTSA vPIC decoder said about a VIN — the trusted first step of
 * identification (year/make/model/trim/body/engine/plant). Cached per VIN in
 * the electron main; stored on the profile it filed so it travels with publishes.
 */
export interface OnlineVinDecode {
  source: "nhtsa";
  vin: string;
  ok: boolean;                 // make + model resolved
  errorCode?: string;
  errorText?: string;
  year: number | null;
  make: string;
  model: string;
  trim?: string;
  series?: string;
  bodyClass?: string;
  bodyType: BodyType | null;   // mapped from bodyClass
  vehicleType?: string;
  driveType?: string;
  engine?: string;             // "3.5L V6 EcoBoost" style summary
  engineModel?: string;
  displacementL?: string;
  cylinders?: string;
  horsepower?: string;
  fuel?: string;
  transmission?: string;
  doors?: string;
  plantCountry?: string;
  plantCity?: string;
  manufacturer?: string;
  gvwr?: string;
  fetchedAt: string;
}

export interface VehicleProvenance {
  source: VehicleProfileSource;
  confidence: number;         // 0..1
  createdAt: string;          // ISO
  updatedAt?: string;
  model?: string;             // AI model, if ai_suggested
  observedOn?: string;        // e.g. bench VIN / plate (user's own)
  contributor?: string;       // for community entries
}

/**
 * One real VIN observed for this Year/Make/Model. The self-growing library
 * decodes a car ONCE per YMM; every subsequent read of the same YMM just
 * appends its VIN here (the profile is "the decoded car", the VINs are the
 * individual units we've seen). `syncedToShop` tracks whether this unit has
 * been pushed to the linked JobCount shop garage.
 */
export interface VinObservation {
  vin: string;
  firstReadAt: string;        // ISO — first time we read this exact VIN
  lastReadAt: string;         // ISO — most recent read
  reads: number;              // how many times we've read it
  syncedToShop?: boolean;     // pushed into the JobCount garage
  scans?: VehicleScanRecord[]; // this unit's Auto Scan history, newest last (capped)
  /** What every module of THIS car said it is (part numbers, versions, serial numbers…),
   *  from the last identity read — see moduleIdentity.ts. */
  inventory?: CarInventory;
  /** Modules whose identity changed between visits (swapped, reflashed), newest last (capped). */
  inventoryChanges?: InventoryChange[];
}

/** How one system came out of an Auto Scan. "unknown" = it answered, but its fault
 * memory could not be read (service refused) — never shown as "no fault". */
export type SystemScanStatus = "ok" | "fault" | "no_response" | "unknown";

export interface ScanDtc { code: string; description?: string; status?: string }

export interface SystemScanResult {
  moduleId: string;
  label: string;
  requestId?: string;
  responseId: string;
  status: SystemScanStatus;
  dtcs: ScanDtc[];
  note?: string;              // why "unknown", or how the codes were read
}

/**
 * One Auto Scan of one real unit (a VIN): which systems answered and what fault
 * codes each held. The YMM profile keeps WHAT the vehicle has and how to talk to
 * it; the scan record keeps the STATE of this particular car on that day — the
 * vehicle history a returning car is opened with.
 */
export interface VehicleScanRecord {
  at: string;                 // ISO
  kind: "auto" | "fault";     // full scan (with discovery) or a re-read of the known systems
  iface?: string;
  durationMs?: number;
  sim?: string;               // set when a virtual vehicle answered (desk simulator / simulator on the device) — not a real car
  systems: SystemScanResult[];
}

/** Append a scan to a unit's history (newest last, capped). Pure. The VIN must
 * already be on the profile (learnVin) — a scan of an unbound car is not kept. */
export function recordScan(profile: VehicleProfile, vin: string, scan: VehicleScanRecord, cap = 12): VehicleProfile {
  const v = (vin || "").trim().toUpperCase();
  if (!profile.knownVins?.some((o) => o.vin === v)) return profile;
  return {
    ...profile,
    knownVins: profile.knownVins.map((o) => (o.vin === v ? { ...o, scans: [...(o.scans ?? []), scan].slice(-cap) } : o)),
  };
}

/** The most recent scan on file for a unit, if any. */
export function lastScanFor(profile: VehicleProfile | null | undefined, vin: string): VehicleScanRecord | null {
  const v = (vin || "").trim().toUpperCase();
  const scans = profile?.knownVins?.find((o) => o.vin === v)?.scans;
  return scans?.length ? scans[scans.length - 1] : null;
}

export interface VehicleProfile {
  id: string;                 // stable slug, e.g. "2020-toyota-corolla"
  year: number | null;
  make: string;
  model: string;
  trim?: string;
  bodyType: BodyType;
  market?: string;            // "US" | "EU" | ...
  wmi?: string[];             // WMIs seen on this YMM — a HINT only (a WMI spans many models)
  vinPattern?: string;        // legacy single regex over the full VIN
  vinPatterns?: string[];     // learned "squish" patterns (pos 1-8 + pos 10) — one per unit shape read
  fingerprint?: VehicleFingerprint; // what the bus looked like on the last identify
  decoded?: OnlineVinDecode;  // the NHTSA decode this YMM was filed from
  knownVins?: VinObservation[]; // real units of this YMM read with our OBD tool
  buses: VehicleBus[];
  modules: VehicleModule[];
  supportedPids?: number[];   // standard J1979 PIDs known present
  capabilities: VehicleCapability[];
  notes?: string;
  provenance: VehicleProvenance;
}

/**
 * Record a real VIN read against a profile: append it if new, or bump its
 * counters if we've seen it before. Pure — returns a new profile + whether the
 * VIN was new to this YMM (so the caller knows to push it to the shop garage).
 */
export function recordVinRead(
  profile: VehicleProfile,
  vin: string,
  now: string,
): { profile: VehicleProfile; vinIsNew: boolean } {
  const v = (vin || "").trim().toUpperCase();
  const list = profile.knownVins ? [...profile.knownVins] : [];
  const existing = list.find((o) => o.vin === v);
  if (existing) {
    const updated = { ...existing, lastReadAt: now, reads: existing.reads + 1 };
    return {
      profile: { ...profile, knownVins: list.map((o) => (o.vin === v ? updated : o)) },
      vinIsNew: false,
    };
  }
  list.push({ vin: v, firstReadAt: now, lastReadAt: now, reads: 1 });
  return { profile: { ...profile, knownVins: list }, vinIsNew: true };
}

// ---- helpers -------------------------------------------------------------

/** Stable id from identity. */
export function profileId(year: number | null, make: string, model: string): string {
  return [year ?? "unknown", make, model]
    .join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** Does this profile match a decoded VIN? WMI first, then optional regex. */
export function profileMatchesVin(p: VehicleProfile, vin: string, wmi: string): boolean {
  if (p.wmi && p.wmi.includes(wmi)) return true;
  if (p.vinPattern) {
    try { return new RegExp(p.vinPattern, "i").test(vin); } catch { /* bad pattern */ }
  }
  return false;
}

/** Match by identity (year/make/model), case-insensitive; year optional. */
export function profileMatchesYmm(p: VehicleProfile, year: number | null, make: string, model: string): boolean {
  const eq = (a?: string | null, b?: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  const yearOk = year == null || p.year == null || p.year === year;
  return yearOk && eq(p.make, make) && eq(p.model, model);
}

export function validateVehicleProfile(p: Partial<VehicleProfile>): string[] {
  const errs: string[] = [];
  if (!p.id) errs.push("missing id");
  if (!p.make) errs.push("missing make");
  if (!p.model) errs.push("missing model");
  if (!p.bodyType) errs.push("missing bodyType");
  if (!Array.isArray(p.buses) || p.buses.length === 0) errs.push("no buses");
  if (!Array.isArray(p.modules)) errs.push("modules must be an array");
  if (!p.provenance) errs.push("missing provenance");
  return errs;
}
