import {
  BusModuleKnowledge,
  validateBusModuleKnowledge,
} from "./busKnowledge.schema.js";
// Bundled "community" bus knowledge — records the operator/AI mapper baked into
// the build so they ship with the next release and appear on a fresh install
// anywhere. Written by the "Bake into app" action; starts empty.
import communityCatalog from "./busKnowledgeCommunity.json";
import { SEED_BUS_MODULES } from "./busKnowledgeSeed.js";

for (const m of SEED_BUS_MODULES) validateBusModuleKnowledge(m);

/** Bundled community records, validated individually (bad ones skipped). */
const COMMUNITY_BUS_MODULES: BusModuleKnowledge[] = [];
for (const raw of (communityCatalog as unknown[]) ?? []) {
  try {
    validateBusModuleKnowledge(raw);
    COMMUNITY_BUS_MODULES.push(raw);
  } catch {
    /* skip a malformed baked record rather than crash the app */
  }
}

/**
 * Merges shipped seed + baked community + learned (loaded from disk in the main
 * process). Precedence, lowest to highest: seed → community → learned. So an
 * operator who confirms/edits a module supersedes the shipped baseline, and a
 * baked record supersedes the raw seed. Result is sorted by label.
 */
export function mergeBusKnowledge(learned: BusModuleKnowledge[]): BusModuleKnowledge[] {
  const byId = new Map<string, BusModuleKnowledge>();
  for (const m of SEED_BUS_MODULES) byId.set(m.id, m);
  for (const m of COMMUNITY_BUS_MODULES) byId.set(m.id, m);
  for (const m of learned) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export { SEED_BUS_MODULES, COMMUNITY_BUS_MODULES };
