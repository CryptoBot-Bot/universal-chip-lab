/**
 * Real data only in the real library (Dmytro, 2026-11-24). Anything answered by a
 * simulator — the desk simulator on this PC, the virtual bus vcan0, a virtual vehicle
 * running on the device — works on a SANDBOX copy of the library instead. It starts as
 * a copy of the real one, so the simulated car opens with everything known about it,
 * and nothing done there can reach a real car's record.
 *
 *   <workspace>/vehicle-library       real cars
 *   <workspace>/vehicle-library-sim   the sandbox
 */
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const REAL_LIBRARY = "vehicle-library";
export const SIM_LIBRARY = "vehicle-library-sim";

export const realLibraryDir = (workspaceRoot: string) => path.join(workspaceRoot, REAL_LIBRARY);
export const simLibraryDir = (workspaceRoot: string) => path.join(workspaceRoot, SIM_LIBRARY);

/** Is the device we talk to a simulator by address or by bus? (A virtual vehicle running ON a
 *  real device is a third case the caller adds from its /api/sim/status.) */
export function isSimulatorTarget(host: string | undefined, iface: string | undefined): boolean {
  const h = (host ?? "").trim().replace(/^https?:\/\//, "").toLowerCase();
  if (/^(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(h)) return true;
  return (iface ?? "").trim().toLowerCase() === "vcan0";
}

/** Bring the sandbox up to the real library: a vehicle the real library learned more about since
 *  replaces its sandbox copy (simulated work on it is throwaway); a sandbox copy changed later by a
 *  simulator stays until then. Never the other way. */
export async function ensureSimLibrary(realDir: string, simDir: string): Promise<void> {
  await mkdir(simDir, { recursive: true });
  let files: string[] = [];
  try { files = (await readdir(realDir)).filter((f) => f.endsWith(".vehicle.json")); } catch { return; }
  for (const f of files) {
    const real = await stat(path.join(realDir, f));
    const sim = await stat(path.join(simDir, f)).catch(() => null);
    if (!sim || real.mtimeMs > sim.mtimeMs) await copyFile(path.join(realDir, f), path.join(simDir, f));
  }
}
