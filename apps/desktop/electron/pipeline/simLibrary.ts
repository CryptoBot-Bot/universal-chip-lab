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
import { copyFile, mkdir, readdir } from "node:fs/promises";
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

/** Copy the real library into the sandbox when the sandbox is still empty. Never the other way. */
export async function ensureSimLibrary(realDir: string, simDir: string): Promise<void> {
  await mkdir(simDir, { recursive: true });
  const have = (await readdir(simDir)).filter((f) => f.endsWith(".vehicle.json"));
  if (have.length) return;
  let files: string[] = [];
  try { files = (await readdir(realDir)).filter((f) => f.endsWith(".vehicle.json")); } catch { return; }
  for (const f of files) await copyFile(path.join(realDir, f), path.join(simDir, f));
}
