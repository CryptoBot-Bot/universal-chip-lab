/**
 * Bench-module disk persistence — node-only (mirrors vehicleProfileStore).
 *
 * One `.module.json` file per profile in a caller-supplied dir (the per-user
 * "learned" store). Kept OUT of the package barrel so the renderer never bundles
 * `node:fs`; imported as `@ecu/vehicle-db/moduleStore`.
 */

import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

import type { BenchModuleProfile } from "./benchModule.schema.js";
import { validateBenchModuleProfile } from "./benchModule.schema.js";

const SUFFIX = ".module.json";

export interface BenchModuleStoreLoadResult {
  records: BenchModuleProfile[];
  errors: string[];
}

function slug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
}

export function storedBenchModulePath(dir: string, id: string): string {
  return path.join(dir, `${slug(id)}${SUFFIX}`);
}

export async function loadStoredBenchModules(dir: string): Promise<BenchModuleStoreLoadResult> {
  await mkdir(dir, { recursive: true });
  const records: BenchModuleProfile[] = [];
  const errors: string[] = [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(SUFFIX));
  for (const f of files) {
    try {
      const raw = await readFile(path.join(dir, f), "utf8");
      const parsed = JSON.parse(raw) as BenchModuleProfile;
      const problems = validateBenchModuleProfile(parsed);
      if (problems.length) { errors.push(`${f}: ${problems.join(", ")}`); continue; }
      records.push(parsed);
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  records.sort((a, b) => `${a.brand} ${a.displayName}`.localeCompare(`${b.brand} ${b.displayName}`));
  return { records, errors };
}

export async function saveStoredBenchModule(
  dir: string,
  record: BenchModuleProfile,
  now: string,
): Promise<BenchModuleProfile> {
  const problems = validateBenchModuleProfile(record);
  if (problems.length) throw new Error(`invalid bench module profile: ${problems.join(", ")}`);
  await mkdir(dir, { recursive: true });
  const stamped: BenchModuleProfile = {
    ...record,
    provenance: { ...record.provenance, updatedAt: now },
  };
  await writeFile(storedBenchModulePath(dir, record.id), `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  return stamped;
}

export async function deleteStoredBenchModule(dir: string, id: string): Promise<boolean> {
  try {
    await unlink(storedBenchModulePath(dir, id));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
