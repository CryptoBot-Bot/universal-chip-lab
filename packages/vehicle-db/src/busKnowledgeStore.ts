import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BusModuleKnowledge,
  validateBusModuleKnowledge,
} from "./busKnowledge.schema.js";

/**
 * Disk-backed persistence for bus knowledge the operator confirms or the AI
 * mapper drafts. Seed records (shipped in the package) are NOT stored here —
 * only learned ones, so this directory is the durable, growing record of "what
 * we figured out on real networks", surviving restarts and re-installs.
 *
 * Node/Electron main-process only. Imported as `@ecu/vehicle-db/store` so the
 * renderer never bundles `node:fs`.
 */

const SUFFIX = ".bus.json";

export interface BusStoreLoadResult {
  records: BusModuleKnowledge[];
  errors: { file: string; message: string }[];
}

function fileNameForId(id: string): string {
  const safe = id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) throw new Error(`bus knowledge id produces an empty filename: "${id}"`);
  return `${safe}${SUFFIX}`;
}

export function storedBusPath(dir: string, id: string): string {
  return path.join(dir, fileNameForId(id));
}

export async function loadStoredBusKnowledge(dir: string): Promise<BusStoreLoadResult> {
  await mkdir(dir, { recursive: true });
  const records: BusModuleKnowledge[] = [];
  const errors: { file: string; message: string }[] = [];

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SUFFIX)) continue;
    const full = path.join(dir, entry.name);
    try {
      const parsed = JSON.parse(await readFile(full, "utf8")) as unknown;
      validateBusModuleKnowledge(parsed);
      records.push(parsed);
    } catch (err) {
      errors.push({ file: entry.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  records.sort((a, b) => a.label.localeCompare(b.label));
  return { records, errors };
}

export async function saveStoredBusKnowledge(
  dir: string,
  record: BusModuleKnowledge,
  now: string,
): Promise<string> {
  validateBusModuleKnowledge(record);
  const toWrite: BusModuleKnowledge = {
    ...record,
    provenance: { ...record.provenance, updatedAt: now },
  };
  await mkdir(dir, { recursive: true });
  const target = storedBusPath(dir, record.id);
  await writeFile(target, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
  return target;
}

export async function deleteStoredBusKnowledge(dir: string, id: string): Promise<boolean> {
  try {
    await rm(storedBusPath(dir, id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
