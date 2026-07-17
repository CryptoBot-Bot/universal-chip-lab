import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExplorerResult } from "./resolver/moduleExplorer";

/**
 * On-disk record of one AI Module Explorer run against a module, kept for the
 * record and to power the self-improving run-to-run loop. Runs live under
 * <workspace>/explorer-runs/<moduleId>/<runId>.json — newest first.
 */
export interface StoredExplorerRun {
  id: string;
  moduleId: string;
  displayName: string;
  iface: string;
  tx: string;
  rx: string;
  startedAt: string;
  endedAt: string;
  outcome: ExplorerResult["outcome"] | "error";
  result: ExplorerResult | null;
  newFindings: string[];
  priorRunCount: number;
  tokensIn: number;
  tokensOut: number;
  steps: number;
  transcript: string;
}

function safe(id: string): string { return (id || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_"); }

export async function saveExplorerRun(dir: string, run: StoredExplorerRun): Promise<void> {
  const d = path.join(dir, safe(run.moduleId));
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, `${safe(run.id)}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

export async function listExplorerRuns(dir: string, moduleId: string): Promise<StoredExplorerRun[]> {
  const d = path.join(dir, safe(moduleId));
  let files: string[];
  try { files = await readdir(d); } catch { return []; }
  const runs: StoredExplorerRun[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try { runs.push(JSON.parse(await readFile(path.join(d, f), "utf8")) as StoredExplorerRun); }
    catch { /* skip a corrupt run file */ }
  }
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return runs;
}

export async function deleteExplorerRun(dir: string, moduleId: string, runId: string): Promise<boolean> {
  const p = path.join(dir, safe(moduleId), `${safe(runId)}.json`);
  try { await rm(p); return true; } catch { return false; }
}
