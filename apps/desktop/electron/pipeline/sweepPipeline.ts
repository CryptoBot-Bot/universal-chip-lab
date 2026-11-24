/**
 * Completeness sweep (deep map, part 5a) — fixed code reads every identifier in the
 * standard ranges of each module, twice, and files what answers on the model's
 * module (`module.sweeps`, one per condition). The AI map is then measured against
 * it (coverageOf). No AI here, nothing chosen: the same requests every time.
 *
 * Safety: airbag / immobiliser modules are never swept; every request goes through
 * the read-only policy (readSeq); a session opened is closed again (10 01).
 */
import { addSweep, asciiOf, dataOf, protectedModule, rangeLabel, rangeRequests, requestId, sweepPlan } from "@ecu/vehicle-db";
import type { ModuleSweep, SweepHit, VehicleModule, VehicleProfile } from "@ecu/vehicle-db";
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
}

/** Requests per sequence (the device takes at most 24, one is the session opener). */
const CHUNK = 20;
/** Seconds per request: modules answer a read (or refuse it) within ~50 ms. */
const TIMEOUT = 0.4;
/** KWP diagnostic sessions tried, in order, when the default session refuses every local-ID read. */
const KWP_SESSIONS = ["89", "92", "86", "81"];

function clean(s?: string | null): string { return (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, ""); }
function nrcOf(it?: SeqItem): number | null {
  if (!it) return null;
  if (typeof it.nrc === "number") return it.nrc;
  const r = (it.response ?? "").replace(/\s+/g, "").toLowerCase();
  return r.startsWith("7f") && r.length >= 6 ? parseInt(r.slice(4, 6), 16) : null;
}
const positive = (it: SeqItem | undefined, sid: number) => !!it?.response && it.response.replace(/\s+/g, "").toLowerCase().startsWith((sid + 0x40).toString(16));

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
  if (protocol === "uds") {
    const s = (await seq(["1003"]))[0];
    sessions.push({ id: "03", ok: positive(s, 0x10), ...(nrcOf(s) !== null ? { nrc: nrcOf(s)! } : {}) });
    if (positive(s, 0x10)) session = "03";
  } else {
    const first = await seq(["2101", "2102", "2103", "2104"]);
    const refusedAll = first.every((it) => { const n = nrcOf(it); return n === 0x7f || n === 0x22 || n === 0x11 || n === 0x12 || !it.response; });
    sessions.push({ id: "01", ok: !refusedAll });
    if (refusedAll) {
      for (const sid of KWP_SESSIONS) {
        const s = (await seq([`10${sid}`]))[0];
        sessions.push({ id: sid, ok: positive(s, 0x10), ...(nrcOf(s) !== null ? { nrc: nrcOf(s)! } : {}) });
        if (positive(s, 0x10)) { session = sid; break; }
      }
    }
  }
  const open = session === "01" ? [] : [`10${session}`];

  const plan = sweepPlan(protocol, m.category, { wide: o.wide });
  const all = plan.flatMap(rangeRequests);
  const hits: SweepHit[] = [];
  let asked = 0;
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
        const ascii = asciiOf(data);
        hits.push({ id: requestId(q), session, bytes: data.slice(0, 128), moving: false, ...(ascii ? { ascii } : {}) });
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
        if (data !== null && data.slice(0, 128) !== h.bytes) { h.again = data.slice(0, 128); h.moving = true; }
      });
    }
  } finally {
    if (open.length) { try { await seq(["1001"]); } catch { /* it falls back to default on its own */ } }
  }

  const sweep: ModuleSweep = {
    at: new Date().toISOString(), condition: o.condition, protocol, sessions,
    ranges: plan.map((rg) => rangeLabel(rg, session)), hits,
    counts: { asked, answered: hits.filter((h) => !h.gated).length, moving: hits.filter((h) => h.moving).length, gated: hits.filter((h) => h.gated).length, ms: Date.now() - t0 },
    ...(o.sim ? { sim: o.sim } : {}),
  };
  emit({ type: "sweep-module", moduleId: m.id, label: m.label, index, total, phase: "done", asked, of: all.length, answered: sweep.counts.answered, sweep });
  return sweep;
}

/** Sweep the targets and file each result on the model's module (fresh profile from disk each time). */
export async function sweepAndSave(vehicleLibDir: string, o: SweepOptions): Promise<{ profile: VehicleProfile; sweeps: Record<string, ModuleSweep>; skipped: string[] }> {
  const targets = sweepTargets(o.profile, o.moduleIds);
  const skipped = o.profile.modules
    .filter((m) => clean(m.addressing?.response) && protectedModule({ category: m.category, label: m.label }) && (!o.moduleIds?.length || o.moduleIds.includes(m.id)))
    .map((m) => m.label);
  const sweeps: Record<string, ModuleSweep> = {};
  let current = o.profile;
  for (let i = 0; i < targets.length; i++) {
    if (o.shouldStop?.()) break;
    const m = targets[i];
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
