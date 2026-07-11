/**
 * Vehicle-profile merge layer (browser-safe, mirrors busKnowledgeRegistry).
 *
 * Precedence low→high: seed → community → learned, keyed by profile id. So a
 * user's learned profile supersedes the baked community one, which supersedes
 * the shipped seed. This is the self-growing library the cockpit reads from.
 */

import communityCatalog from "./vehicleProfileCommunity.json";
import { SEED_VEHICLE_PROFILES } from "./vehicleProfileSeed.js";
import { validateVehicleProfile, profileMatchesVin, profileMatchesYmm } from "./vehicleProfile.schema.js";
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

/** Find the best library match for a decoded VIN (WMI/pattern first, then make+year). */
export function findProfileForVin(
  profiles: VehicleProfile[],
  vin: string,
  wmi: string,
  make: string | null,
  year: number | null,
): VehicleProfile | null {
  const byVin = profiles.find((p) => profileMatchesVin(p, vin, wmi));
  if (byVin) return byVin;
  if (make) {
    const byMakeYear = profiles.find((p) => p.make.toLowerCase() === make.toLowerCase() && (year == null || p.year === year));
    if (byMakeYear) return byMakeYear;
  }
  return null;
}

export function findProfileByYmm(
  profiles: VehicleProfile[],
  year: number | null,
  make: string,
  model: string,
): VehicleProfile | null {
  return profiles.find((p) => profileMatchesYmm(p, year, make, model)) ?? null;
}
