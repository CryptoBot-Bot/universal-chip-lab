/**
 * Saving from an older copy. Every save writes a whole profile, and several steps work on a copy
 * for a while (an Auto Scan, an AI deep map of half an hour, a screen that was open). If the file
 * on disk moved on meanwhile, writing the old copy would silently drop what was measured since —
 * on 2026-11-24 a fault scan dropped a completeness sweep this way.
 *
 * So the store compares the copy's `updatedAt` with the file's. Same → the save stands as it is
 * (deleting something on purpose works). Different → `keepMeasured` adds back everything measured
 * that the copy does not have. Newer wins per item; nothing measured is dropped.
 */
import type { ModuleSweep } from "./moduleSweep.js";
import type { VehicleModule, VehicleProfile, VinObservation } from "./vehicleProfile.schema.js";

const norm = (s?: string) => (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
const newer = (a?: string, b?: string) => (a ?? "") > (b ?? "");

function unionBy<T>(a: T[] | undefined, b: T[] | undefined, key: (x: T) => string, at: (x: T) => string): T[] | undefined {
  if (!a?.length) return b;
  if (!b?.length) return a;
  const m = new Map<string, T>();
  for (const x of [...a, ...b]) m.set(key(x), x);
  return [...m.values()].sort((x, y) => at(x).localeCompare(at(y)));
}

/** How much a sweep holds — the same sweep may exist in a shorter, older form. */
const weight = (s: ModuleSweep) => s.hits.reduce((n, h) => n + h.bytes.length + (h.again?.length ?? 0), 0) + (s.refs ? 1 : 0);

/** One sweep per condition (real and simulated kept apart), the newest of each; of one sweep, its fuller form. */
function mergeSweeps(a?: ModuleSweep[], b?: ModuleSweep[]): ModuleSweep[] | undefined {
  const key = (s: ModuleSweep) => `${s.condition}|${!!s.sim}|${s.at}`;
  const union = unionBy(a, b, key, (s) => s.at);
  if (!union) return undefined;
  const all = union.map((s) => [...(a ?? []), ...(b ?? [])].filter((x) => key(x) === key(s)).reduce((best, x) => (weight(x) > weight(best) ? x : best), s));
  const last = new Map<string, ModuleSweep>();
  for (const s of all) last.set(`${s.condition}|${!!s.sim}`, s);
  return all.filter((s) => last.get(`${s.condition}|${!!s.sim}`) === s);
}

function mergeModule(disk: VehicleModule, mine: VehicleModule): VehicleModule {
  const out: VehicleModule = { ...mine };
  const sweeps = mergeSweeps(disk.sweeps, mine.sweeps);
  if (sweeps?.length) out.sweeps = sweeps;
  if (disk.explored && (!mine.explored || newer(disk.explored.lastMappedAt, mine.explored.lastMappedAt))) out.explored = disk.explored;
  if (disk.labels && (!mine.labels || newer(disk.labels.at, mine.labels.at))) out.labels = disk.labels;
  if (disk.identity && (!mine.identity || newer(disk.identity.observedAt, mine.identity.observedAt))) out.identity = disk.identity;
  if (newer(disk.lastSeenAt, mine.lastSeenAt)) out.lastSeenAt = disk.lastSeenAt;
  if (newer(disk.censusAt, mine.censusAt)) {
    out.censusAt = disk.censusAt; out.label = disk.label; out.category = disk.category;
    if (disk.summary) out.summary = disk.summary;
    if (disk.protocol) out.protocol = disk.protocol;
    if (disk.memoryRead) out.memoryRead = disk.memoryRead;
  }
  const ops = unionBy(disk.opsLog, mine.opsLog, (x) => JSON.stringify(x), (x) => String((x as { at?: string }).at ?? ""));
  if (ops?.length) out.opsLog = ops.slice(-Math.max(disk.opsLog?.length ?? 0, mine.opsLog?.length ?? 0, 20));
  return out;
}

function mergeUnit(disk: VinObservation, mine: VinObservation): VinObservation {
  const out: VinObservation = {
    ...mine,
    firstReadAt: disk.firstReadAt && disk.firstReadAt < mine.firstReadAt ? disk.firstReadAt : mine.firstReadAt,
    lastReadAt: newer(disk.lastReadAt, mine.lastReadAt) ? disk.lastReadAt : mine.lastReadAt,
    reads: Math.max(disk.reads ?? 0, mine.reads ?? 0),
  };
  const scans = unionBy(disk.scans, mine.scans, (s) => `${s.at}|${s.kind}`, (s) => s.at);
  if (scans?.length) out.scans = scans.slice(-12);
  if (disk.inventory && (!mine.inventory || newer(disk.inventory.at, mine.inventory.at))) out.inventory = disk.inventory;
  const changes = unionBy(disk.inventoryChanges, mine.inventoryChanges, (c) => JSON.stringify(c), (c) => c.at);
  if (changes?.length) out.inventoryChanges = changes;
  return out;
}

/** `mine` (an older copy, with its own changes) plus everything measured on disk since it was loaded. */
export function keepMeasured(disk: VehicleProfile, mine: VehicleProfile): VehicleProfile {
  const modules = mine.modules.map((m) => {
    const d = disk.modules.find((x) => x.id === m.id);
    return d ? mergeModule(d, m) : m;
  });
  // a module found meanwhile — unless the copy already has that address under another id (a healed duplicate)
  const have = new Set(modules.map((m) => norm(m.addressing?.response)).filter(Boolean));
  for (const d of disk.modules) {
    if (modules.some((m) => m.id === d.id)) continue;
    const a = norm(d.addressing?.response);
    if (a && have.has(a)) continue;
    modules.push(d);
  }
  const units = (mine.knownVins ?? []).map((u) => {
    const d = disk.knownVins?.find((x) => x.vin === u.vin);
    return d ? mergeUnit(d, u) : u;
  });
  for (const d of disk.knownVins ?? []) if (!units.some((u) => u.vin === d.vin)) units.push(d);
  return {
    ...mine,
    modules,
    ...(units.length ? { knownVins: units } : {}),
    ...(disk.fingerprint && (!mine.fingerprint || newer(disk.fingerprint.takenAt, mine.fingerprint.takenAt)) ? { fingerprint: disk.fingerprint } : {}),
  };
}
