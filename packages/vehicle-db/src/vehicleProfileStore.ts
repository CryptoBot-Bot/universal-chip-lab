/**
 * Vehicle-profile disk persistence — node-only (mirrors busKnowledgeStore).
 *
 * One `.vehicle.json` file per profile in a caller-supplied dir (the per-user
 * "learned" store). Kept OUT of the package barrel so the renderer never bundles
 * `node:fs`; imported as `@ecu/vehicle-db/vehicleStore`.
 */

import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

import type { VehicleProfile } from "./vehicleProfile.schema.js";
import { validateVehicleProfile } from "./vehicleProfile.schema.js";

const SUFFIX = ".vehicle.json";

export interface VehicleStoreLoadResult {
  records: VehicleProfile[];
  errors: string[];
}

function slug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
}

export function storedVehiclePath(dir: string, id: string): string {
  return path.join(dir, `${slug(id)}${SUFFIX}`);
}

export async function loadStoredVehicleProfiles(dir: string): Promise<VehicleStoreLoadResult> {
  await mkdir(dir, { recursive: true });
  const records: VehicleProfile[] = [];
  const errors: string[] = [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(SUFFIX));
  for (const f of files) {
    try {
      const raw = await readFile(path.join(dir, f), "utf8");
      const parsed = JSON.parse(raw) as VehicleProfile;
      const problems = validateVehicleProfile(parsed);
      if (problems.length) { errors.push(`${f}: ${problems.join(", ")}`); continue; }
      records.push(parsed);
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  records.sort((a, b) => `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`));
  return { records, errors };
}

/** Simulator-answered content in a profile (scans, inventories, sweeps carry a `sim` tag). */
export function simulatorContent(record: VehicleProfile): string[] {
  const out: string[] = [];
  for (const o of record.knownVins ?? []) {
    if (o.scans?.some((s) => s.sim)) out.push("a scan");
    if (o.inventory?.sim) out.push("a module inventory");
  }
  for (const m of record.modules) if (m.sweeps?.some((s) => s.sim)) { out.push("a completeness sweep"); break; }
  return out;
}

/** The library of real cars. Simulator sessions use a sandbox folder (see simLibrary.ts). */
export const REAL_LIBRARY_NAME = "vehicle-library";

export async function saveStoredVehicleProfile(
  dir: string,
  record: VehicleProfile,
  now: string,
): Promise<VehicleProfile> {
  const problems = validateVehicleProfile(record);
  if (problems.length) throw new Error(`invalid vehicle profile: ${problems.join(", ")}`);
  // Backstop: real data only in the real library. Simulator sessions are redirected to a
  // sandbox before they get here; if one ever slips through, it is refused, not saved.
  if (path.basename(path.resolve(dir)) === REAL_LIBRARY_NAME) {
    const sim = simulatorContent(record);
    if (sim.length) throw new Error(`not saved: ${sim.join(" and ")} came from a simulator — the real library keeps real cars only`);
  }
  await mkdir(dir, { recursive: true });
  const stamped: VehicleProfile = {
    ...record,
    provenance: { ...record.provenance, updatedAt: now },
  };
  await writeFile(storedVehiclePath(dir, record.id), `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  return stamped;
}

export async function deleteStoredVehicleProfile(dir: string, id: string): Promise<boolean> {
  try {
    await unlink(storedVehiclePath(dir, id));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
