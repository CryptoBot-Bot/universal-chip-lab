/**
 * Completeness sweep (deep map, part 5a) — fixed code reads every identifier in the
 * standard ranges of each module, twice, and files what answers on the model's
 * module (`module.sweeps`, one per condition). The AI map is then measured against
 * it (coverageOf). No AI here, nothing chosen: the same requests every time.
 *
 * Safety: airbag / immobiliser modules are never swept; every request goes through
 * the read-only policy (readSeq); a session opened is closed again (10 01).
 */
import { addSweep, asciiOf, checkRequest, dataOf, protectedModule, rangeLabel, rangeRequests, requestId, sweepPlan, SWEEP_BYTES } from "@ecu/vehicle-db";
import type { ModuleSweep, SweepRefs, SweepHit, VehicleModule, VehicleProfile } from "@ecu/vehicle-db";
import { saveStoredVehicleProfile } from "@ecu/vehicle-db/vehicleStore";

import type { SeqItem } from "../resolver/moduleExplorer";
import type { VehicleExplorerEvent } from "../resolver/vehicleExplorer";
import { loadLibrary, readSeq } from "./vehiclePipeline";

export interface SweepOptions {
  host?: string;
  iface: string;
  profile: VehicleProfile;
  /** Modules to sweep (profile ids). Default: every addressed module that is not protected. */
  moduleIds?: string[];
  /** What the car is doing, in the operator's words — "ignition on, engine off", "engine idling". */
  condition: string;
  /** UDS: also 0400–0FFF (four times longer). */
  wide?: boolean;
  sim?: string | null;
  onEvent?: (e: VehicleExplorerEvent) => void;
  shouldStop?: () => boolean;
  /** false: do not read the car's own readings beside the sweep (tests, replays). */
  refs?: boolean;
  /** false: do not confirm the car's state before each module. Default: on for a car, off for a simulator. */
  check?: boolean;
}

/** The two states sweeps are filed under. Whatever words the operator used map onto them. */
export function normaliseCondition(s: string): "engine off" | "idling" {
  const t = (s || "").trim().toLowerCase();
  return /idl|running|engine on|engine run/.test(t) ? "idling" : "engine off";
}

export interface CarState { rpm: number | null; kmh: number | null; volts: number | null }

/** Engine speed, road speed and supply voltage from the engine module (standard OBD reads). */
export async function readCarState(o: Pick<SweepOptions, "host" | "iface">): Promise<CarState> {
  let items: SeqItem[] = [];
  try { items = await readSeq(o.host, o.iface, "7E0", "7E8", ["010C", "010D", "0142"], { timeout: 0.8 }); }
  catch { /* nothing answers */ }
  const raw = (k: number, want: string, n: number): number | null => {
    const h = clean(items[k]?.response);
    return h.startsWith(want) && h.length >= 4 + n * 2 ? parseInt(h.slice(4, 4 + n * 2), 16) : null;
  };
  const rpm = raw(0, "410C", 2), mv = raw(2, "4142", 2);
  return { rpm: rpm === null ? null : rpm / 4, kmh: raw(1, "410D", 1), volts: mv === null ? null : mv / 1000 };
}

/** Why the car is not in a state to sweep as "condition" — or null when it is. */
export function conditionProblem(condition: "engine off" | "idling", s: CarState, minVolts = 11.8): string | null {
  if (s.rpm === null) return "the engine module did not answer, so the car's state cannot be confirmed (ignition on?)";
  if (s.kmh !== null && s.kmh > 0) return `the car is moving (${s.kmh} km/h)`;
  if (condition === "idling" && s.rpm < 300) return `the engine is not running (${s.rpm} rpm) but the chosen state is "engine idling"`;
  if (condition === "engine off" && s.rpm >= 300) return `the engine is running (${s.rpm} rpm) but the chosen state is "engine off"`;
  if (s.volts !== null && s.volts < minVolts) return `the supply voltage is ${s.volts} V, below ${minVolts} V — connect a charger first`;
  return null;
}

/** Hex characters kept per identifier. */
const KEEP = SWEEP_BYTES * 2;

/** The car's own readings at this moment (standard OBD, engine module), widening [lowest, highest]. */
async function readRefs(o: SweepOptions, refs: SweepRefs): Promise<void> {
  let items: SeqItem[];
  try { items = await readSeq(o.host, o.iface, "7E0", "7E8", ["010C", "010D", "0142", "0105"], { timeout: TIMEOUT }); }
  catch { return; }                                   // no engine module on this bus: labels simply stay unchecked
  const raw = (k: number, want: string, n: number): number | null => {
    const h = clean(items[k]?.response);
    return h.startsWith(want) && h.length >= 4 + n * 2 ? parseInt(h.slice(4, 4 + n * 2), 16) : null;
  };
  const widen = (key: keyof SweepRefs, x: number | null) => { if (x !== null) refs[key] = refs[key] ? [Math.min(refs[key]![0], x), Math.max(refs[key]![1], x)] : [x, x]; };
  const rpm = raw(0, "410C", 2), kmh = raw(1, "410D", 1), mv = raw(2, "4142", 2), t = raw(3, "4105", 1);
  widen("rpm", rpm === null ? null : rpm / 4); widen("kmh", kmh); widen("volts", mv ? mv / 1000 : null); widen("coolant", t === null ? null : t - 40);
}

/** The standard values (mode 01 PIDs) a module supports: 01 00, then 01 20… while the last bit says "more". */
export async function readObdSupport(o: Pick<SweepOptions, "host" | "iface">, tx: string, rx: string): Promise<string[]> {
  const out: string[] = [];
  for (let base = 0; base <= 0xc0; base += 0x20) {
    let it: SeqItem | undefined;
    try { it = (await readSeq(o.host, o.iface, tx, rx, [`01${base.toString(16).toUpperCase().padStart(2, "0")}`], { timeout: TIMEOUT }))[0]; }
    catch { break; }
    const h = clean(it?.response);
    if (!h.startsWith(`41${base.toString(16).toUpperCase().padStart(2, "0")}`) || h.length < 12) break;
    const mask = parseInt(h.slice(4, 12), 16);
    for (let i = 1; i <= 32; i++) if ((mask >>> (32 - i)) & 1) { const p = base + i; if (p % 0x20) out.push(p.toString(16).toUpperCase().padStart(2, "0")); }
    if (!(mask & 1)) break;
  }
  return out;
}

/** Requests per sequence (the device takes at most 24, one is the session opener). */
const CHUNK = 20;
/** Seconds per request: modules answer a read (or refuse it) within ~50 ms. */
const TIMEOUT = 0.4;
/** KWP diagnostic sessions tried, in order, when the default session refuses every local-ID read. */
const KWP_SESSIONS = ["92", "81"];

function clean(s?: string | null): string { return (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, ""); }
function nrcOf(it?: SeqItem): number | null {
  if (!it) return null;
  if (typeof it.nrc === "number") return it.nrc;
  const r = (it.response ?? "").replace(/\s+/g, "").toLowerCase();
  return r.startsWith("7f") && r.length >= 6 ? parseInt(r.slice(4, 6), 16) : null;
}
const positive = (it: SeqItem | undefined, sid: number) => !!it?.response && it.response.replace(/\s+/g, "").toLowerCase().startsWith((sid + 0x40).toString(16));

/** Diagnostic sessions an earlier real map of this module proved useful, best first ("92", "81"…). Harmless sessions only. */
export function provenSessions(m: Pick<VehicleModule, "explored">): string[] {
  const x = m.explored;
  const texts = [...(x?.liveData ?? []).map((i) => i.session ?? ""), ...(x?.identification ?? []).map((i) => i.session ?? ""), ...(x?.sessions ?? []).map((i) => i.id)];
  const out: string[] = [];
  for (const t of texts) for (const h of t.toUpperCase().match(/\b[0-9A-F]{2}\b/g) ?? []) {
    if (h === "01" || out.includes(h)) continue;
    if (checkRequest(`10${h}`).ok) out.push(h);
  }
  return out;
}

/** Modules a sweep may cover: addressed, and never airbag / immobiliser. */
export function sweepTargets(profile: VehicleProfile, moduleIds?: string[]): VehicleModule[] {
  return profile.modules
    .filter((m) => clean(m.addressing?.request) && clean(m.addressing?.response))
    .filter((m) => !protectedModule({ category: m.category, label: m.label }))
    .filter((m) => !moduleIds?.length || moduleIds.includes(m.id))
    .sort((a, b) => clean(a.addressing!.response).localeCompare(clean(b.addressing!.response)));
}

export async function sweepModule(o: SweepOptions, m: VehicleModule, index: number, total: number): Promise<ModuleSweep> {
  if (protectedModule({ category: m.category, label: m.label })) throw new Error(`${m.label} is an airbag / immobiliser module — never swept`);
  const tx = clean(m.addressing!.request), rx = clean(m.addressing!.response);
  const t0 = Date.now();
  const emit = (e: VehicleExplorerEvent) => { try { o.onEvent?.(e); } catch { /* listener gone */ } };
  const seq = (requests: string[]) => readSeq(o.host, o.iface, tx, rx, requests, { timeout: TIMEOUT });

  // which protocol: the profile's word, else ask (a KWP module answers 22 with 7F 22 11)
  let protocol: "uds" | "kwp2000" = m.protocol === "kwp2000" ? "kwp2000" : "uds";
  if (m.protocol !== "uds" && m.protocol !== "kwp2000" && m.protocol !== "obd2") {
    const probe = await seq(["22F190", "1A90"]);
    if (nrcOf(probe[0]) === 0x11 && (positive(probe[1], 0x1a) || nrcOf(probe[1]) !== 0x11)) protocol = "kwp2000";
  }

  // which session to read in
  const sessions: ModuleSweep["sessions"] = [];
  let session = "01";
  const proven = provenSessions(m);
  const tryOpen = async (sid: string): Promise<boolean> => {
    const a = (await seq([`10${sid}`]))[0];
    sessions.push({ id: sid, ok: positive(a, 0x10), ...(nrcOf(a) !== null ? { nrc: nrcOf(a)! } : {}) });
    return positive(a, 0x10);
  };
  if (protocol === "uds") {
    // extended session — on a chassis module (brakes, steering, stability) only if an earlier visit proved it
    if ((m.category !== "chassis" || proven.includes("03")) && await tryOpen("03")) session = "03";
  } else {
    for (const sid of proven) { if (await tryOpen(sid)) { session = sid; break; } }
    if (session === "01") {
      const first = await seq(["2101", "2102", "2103", "2104"]);
      const refusedAll = first.every((it) => { const n = nrcOf(it); return n === 0x7f || n === 0x22 || n === 0x11 || n === 0x12 || !it.response; });
      sessions.push({ id: "01", ok: !refusedAll });
      // sessions nobody proved are tried on other modules only, and only when the default gave nothing
      if (refusedAll && m.category !== "chassis") {
        for (const sid of KWP_SESSIONS) if (!proven.includes(sid) && await tryOpen(sid)) { session = sid; break; }
      }
    }
  }
  const open = session === "01" ? [] : [`10${session}`];

  const plan = sweepPlan(protocol, m.category, { wide: o.wide });
  const all = plan.flatMap(rangeRequests);
  const hits: SweepHit[] = [];
  const whole = new Map<string, string>();
  let asked = 0;
  const refs: SweepRefs = {};
  if (o.refs !== false) await readRefs(o, refs);
  emit({ type: "sweep-module", moduleId: m.id, label: m.label, index, total, phase: "start", asked: 0, of: all.length, answered: 0 });
  try {
    for (let i = 0; i < all.length; i += CHUNK) {
      if (o.shouldStop?.()) break;
      const chunk = all.slice(i, i + CHUNK);
      const items = await seq([...open, ...chunk]);
      const body = open.length ? items.slice(1) : items;
      chunk.forEach((q, k) => {
        const it = body[k];
        const nrc = nrcOf(it);
        if (nrc === 0x33) { hits.push({ id: requestId(q), session, bytes: "", moving: false, gated: true }); return; }
        const data = dataOf(q, it?.response);
        if (data === null) return;
        const ascii = asciiOf(data.slice(0, KEEP));
        if (data.length > KEEP) whole.set(requestId(q), data);
        hits.push({ id: requestId(q), session, bytes: data.slice(0, KEEP), moving: false, ...(ascii ? { ascii } : {}) });
      });
      asked += chunk.length;
      emit({ type: "sweep-module", moduleId: m.id, label: m.label, index, total, phase: "progress", asked, of: all.length, answered: hits.length });
    }

    // second read of every answering identifier: what moves is live data
    const readable = hits.filter((h) => !h.gated);
    await new Promise((res) => setTimeout(res, 600));
    for (let i = 0; i < readable.length; i += CHUNK) {
      if (o.shouldStop?.()) break;
      const chunk = readable.slice(i, i + CHUNK);
      const reqs = chunk.map((h) => h.id.replace(" ", ""));
      const items = await seq([...open, ...reqs]);
      const body = open.length ? items.slice(1) : items;
      chunk.forEach((h, k) => {
        const data = dataOf(reqs[k], body[k]?.response);
        if (data === null) return;
        const cut = data.slice(0, KEEP);
        if (cut !== h.bytes) { h.again = cut; h.moving = true; }
        else if (data.length > KEEP && whole.get(h.id) !== data) { h.again = cut; h.moving = true; }   // the change is beyond what is kept
      });
    }
  } finally {
    // back to the module's normal session: 10 01 on UDS, 10 81 on KWP2000 (it also times back by itself)
    if (open.length) { try { await seq([protocol === "kwp2000" ? "1081" : "1001"]); } catch { /* it falls back to default on its own */ } }
  }

  if (o.refs !== false) await readRefs(o, refs);
  const obd = o.refs !== false && /^7E[0-7]$/.test(tx) ? await readObdSupport(o, tx, rx) : [];
  const sweep: ModuleSweep = {
    at: new Date().toISOString(), condition: o.condition, protocol, sessions,
    ranges: plan.map((rg) => rangeLabel(rg, session)), hits,
    counts: { asked, answered: hits.filter((h) => !h.gated).length, moving: hits.filter((h) => h.moving).length, gated: hits.filter((h) => h.gated).length, ms: Date.now() - t0 },
    ...(Object.keys(refs).length ? { refs } : {}),
    ...(obd.length ? { obd } : {}),
    ...(o.sim ? { sim: o.sim } : {}),
  };
  emit({ type: "sweep-module", moduleId: m.id, label: m.label, index, total, phase: "done", asked, of: all.length, answered: sweep.counts.answered, sweep });
  return sweep;
}

/** Sweep the targets and file each result on the model's module (fresh profile from disk each time). */
export async function sweepAndSave(vehicleLibDir: string, o0: SweepOptions): Promise<{ profile: VehicleProfile; sweeps: Record<string, ModuleSweep>; skipped: string[] }> {
  const o: SweepOptions = { ...o0, condition: normaliseCondition(o0.condition) };
  const check = o.check ?? !o.sim;
  const targets = sweepTargets(o.profile, o.moduleIds);
  const skipped = o.profile.modules
    .filter((m) => clean(m.addressing?.response) && protectedModule({ category: m.category, label: m.label }) && (!o.moduleIds?.length || o.moduleIds.includes(m.id)))
    .map((m) => m.label);
  const sweeps: Record<string, ModuleSweep> = {};
  let current = o.profile;
  for (let i = 0; i < targets.length; i++) {
    if (o.shouldStop?.()) break;
    const m = targets[i];
    // the car must be in the chosen state, standing still, with enough voltage — before every module
    if (check) {
      const problem = conditionProblem(o.condition as "engine off" | "idling", await readCarState(o));
      if (problem) throw new Error(`Sweep stopped before ${m.label}: ${problem}.${i ? ` ${i} module${i === 1 ? " was" : "s were"} swept and saved before this.` : " Nothing was swept."}`);
    }
    const sw = await sweepModule(o, m, i, targets.length);
    sweeps[m.id] = sw;
    const fresh = (await loadLibrary(vehicleLibDir)).find((p) => p.id === o.profile.id) ?? current;
    const next: VehicleProfile = { ...fresh, modules: fresh.modules.map((x) => (x.id === m.id ? { ...x, sweeps: addSweep(x.sweeps, sw) } : x)) };
    const now = new Date().toISOString();
    await saveStoredVehicleProfile(vehicleLibDir, next, now);
    current = next;
  }
  const saved = (await loadLibrary(vehicleLibDir)).find((p) => p.id === o.profile.id) ?? current;
  return { profile: saved, sweeps, skipped };
}
