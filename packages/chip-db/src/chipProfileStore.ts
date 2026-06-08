import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ChipProfile, validateChipProfile } from "./chipProfile.schema.js";

/**
 * Disk-backed persistence for chip profiles the operator creates or the AI
 * resolver produces. Built-in seed/catalog profiles are NOT stored here — only
 * custom ones, so this directory is the durable record of "chips we figured
 * out", surviving restarts and re-installs.
 *
 * This module imports `node:fs` and must only be used from the Node/Electron
 * main process. It is intentionally excluded from the package's main entry
 * (`@ecu/chip-db`) so the browser renderer never bundles it — import it as
 * `@ecu/chip-db/store`.
 */

const PROFILE_SUFFIX = ".profile.json";

/** Result of loading the store, including any files that failed to parse. */
export interface StoreLoadResult {
  profiles: ChipProfile[];
  errors: { file: string; message: string }[];
}

/** Maps a chipProfileId to a safe, collision-resistant filename. */
function fileNameForId(chipProfileId: string): string {
  const safe = chipProfileId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!safe) {
    throw new Error(`chipProfileId produces an empty filename: "${chipProfileId}"`);
  }
  return `${safe}${PROFILE_SUFFIX}`;
}

export function storedProfilePath(dir: string, chipProfileId: string): string {
  return path.join(dir, fileNameForId(chipProfileId));
}

/** Loads and validates every stored custom profile from `dir`. */
export async function loadStoredProfiles(dir: string): Promise<StoreLoadResult> {
  await mkdir(dir, { recursive: true });
  const profiles: ChipProfile[] = [];
  const errors: { file: string; message: string }[] = [];

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(PROFILE_SUFFIX)) continue;
    const full = path.join(dir, entry.name);
    try {
      const raw = await readFile(full, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      validateChipProfile(parsed);
      profiles.push(parsed);
    } catch (err) {
      errors.push({
        file: entry.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { profiles, errors };
}

/**
 * Validates and writes a single profile, stamping `updatedAt` if the profile
 * carries provenance. Returns the absolute path written.
 */
export async function saveStoredProfile(
  dir: string,
  profile: ChipProfile,
  now: string,
): Promise<string> {
  validateChipProfile(profile);
  const toWrite: ChipProfile = profile.provenance
    ? { ...profile, provenance: { ...profile.provenance, updatedAt: now } }
    : profile;
  await mkdir(dir, { recursive: true });
  const target = storedProfilePath(dir, profile.chipProfileId);
  await writeFile(target, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
  return target;
}

/** Deletes a stored profile. Returns true if a file was removed. */
export async function deleteStoredProfile(
  dir: string,
  chipProfileId: string,
): Promise<boolean> {
  const target = storedProfilePath(dir, chipProfileId);
  try {
    await rm(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
