/**
 * Vehicle-profile merge layer (browser-safe, mirrors busKnowledgeRegistry).
 *
 * Precedence low→high: seed → community → learned, keyed by profile id. So a
 * user's learned profile supersedes the baked community one, which supersedes
 * the shipped seed. This is the self-growing library the cockpit reads from.
 */

import communityCatalog from "./vehicleProfileCommunity.json";
import { SEED_VEHICLE_PROFILES } from "./vehicleProfileSeed.js";
import { validateVehicleProfile, profileMatchesYmm } from "./vehicleProfile.schema.js";
import { resolveVehicleIdentity } from "./vehicleIdentity.js";
import type { VehicleProfile } from "./vehicleProfile.schema.js";

const COMMUNITY_VEHICLE_PROFILES: VehicleProfile[] = (communityCatalog as VehicleProfile[]).filter(
  (p) => validateVehicleProfile(p).length === 0,
);

export function mergeVehicleProfiles(learned: VehicleProfile[]): VehicleProfile[] {
  const byId = new Map<string, VehicleProfile>();
  for (const p of SEED_VEHICLE_PROFILES) byId.set(p.id, p);
  for (const p of COMMUNITY_VEHICLE_PROFILES) byId.set(p.id, p);
  for (const p of learned) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`));
}

/**
 * STRICT library match for a VIN — returns a profile only when it is certain
 * (exact VIN, learned VIN pattern, or a confirmed Year/Make/Model). WMI / make
 * alone are NOT a match: a WMI spans many models. Use `resolveVehicleIdentity`
 * when you also want the ranked hints for the operator / AI.
 */
export function findProfileForVin(
  profiles: VehicleProfile[],
  vin: string,
  _wmi?: string,
  _make?: string | null,
  _year?: number | null,
  confirmed?: { year: number | null; make: string; model: string } | null,
): VehicleProfile | null {
  return resolveVehicleIdentity(profiles, vin, confirmed).bound?.profile ?? null;
}

export function findProfileByYmm(
  profiles: VehicleProfile[],
  year: number | null,
  make: string,
  model: string,
): VehicleProfile | null {
  return profiles.find((p) => profileMatchesYmm(p, year, make, model)) ?? null;
}
