/**
 * Bench-module merge layer (browser-safe, mirrors vehicleProfileRegistry).
 *
 * Precedence low→high: seed → community → learned, keyed by profile id. A user's
 * learned module supersedes the baked community one, which supersedes the shipped
 * seed. This is the self-growing module library the Bench Module Master reads from.
 */

import communityCatalog from "./benchModuleCommunity.json";
import { SEED_BENCH_MODULES } from "./benchModuleSeed.js";
import { validateBenchModuleProfile } from "./benchModule.schema.js";
import type { BenchModuleProfile } from "./benchModule.schema.js";

const COMMUNITY_BENCH_MODULES: BenchModuleProfile[] = (communityCatalog as BenchModuleProfile[]).filter(
  (p) => validateBenchModuleProfile(p).length === 0,
);

const SEED_BY_ID = new Map(SEED_BENCH_MODULES.map((p) => [p.id, p]));

/**
 * A saved (learned) profile supersedes the seed, but the seed also acts as a source
 * of DEFAULTS: structured knowledge fields added after a profile was first saved
 * (identification / liveData / broadcastFrames / cloneGuide) are backfilled from the
 * seed when the saved copy has none — so enriching a seed reaches existing installs
 * without discarding anything the user has learned.
 */
function backfillFromSeed(p: BenchModuleProfile): BenchModuleProfile {
  const seed = SEED_BY_ID.get(p.id);
  if (!seed) return p;
  const d = p.diagnostics, sd = seed.diagnostics;
  const has = <T>(a?: T[]) => Array.isArray(a) && a.length > 0;
  // Sessions/services are additive knowledge — union them so a richer seed lifts an
  // existing saved copy (learned entries stay first / authoritative).
  const sess = new Map<string, { id: string; label: string }>();
  for (const s of d.sessions) sess.set(s.id.replace(/\s+/g, "").toLowerCase(), s);
  for (const s of sd.sessions) { const k = s.id.replace(/\s+/g, "").toLowerCase(); if (!sess.has(k)) sess.set(k, s); }
  const services = [...new Set([...d.sampleServices.map((s) => s.toUpperCase()), ...sd.sampleServices.map((s) => s.toUpperCase())])];
  return {
    ...p,
    cloneGuide: p.cloneGuide ?? seed.cloneGuide,
    diagnostics: {
      ...d,
      sessions: [...sess.values()],
      sampleServices: services,
      operations: has(d.operations) ? d.operations : sd.operations,
      identification: has(d.identification) ? d.identification : sd.identification,
      liveData: has(d.liveData) ? d.liveData : sd.liveData,
      broadcastFrames: has(d.broadcastFrames) ? d.broadcastFrames : sd.broadcastFrames,
    },
  };
}

export function mergeBenchModules(learned: BenchModuleProfile[]): BenchModuleProfile[] {
  const byId = new Map<string, BenchModuleProfile>();
  for (const p of SEED_BENCH_MODULES) byId.set(p.id, p);
  for (const p of COMMUNITY_BENCH_MODULES) byId.set(p.id, p);
  for (const p of learned) byId.set(p.id, backfillFromSeed(p));
  return [...byId.values()].sort((a, b) => `${a.brand} ${a.displayName}`.localeCompare(`${b.brand} ${b.displayName}`));
}

export function findBenchModule(profiles: BenchModuleProfile[], id: string): BenchModuleProfile | null {
  return profiles.find((p) => p.id === id) ?? null;
}
