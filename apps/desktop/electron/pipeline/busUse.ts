/**
 * Who is using a car's bus through this process. The Pi opens a fresh ISO-TP socket per call
 * and has no lock: two calls to the same module at the same moment can each receive the
 * other's answer. Scans are sequential by construction; the only thing that runs by itself in
 * the background is the voltage read, so it must never overlap anything else:
 *
 *   - it starts only when nothing is in flight and nothing was for a while (`idleFor`);
 *   - while it runs (well under a second), everything else waits for it (`onBus`).
 *
 * Work from another process (the command line) is seen on the device's recorder instead —
 * see voltage.ts.
 */
interface Use { inFlight: number; last: number; quick: Promise<unknown> | null }

const uses = new Map<string, Use>();
function use(host: string): Use {
  let u = uses.get(host);
  if (!u) { u = { inFlight: 0, last: 0, quick: null }; uses.set(host, u); }
  return u;
}

/** Device calls that put requests on the bus (or reconfigure it). Status polls do not count. */
export function touchesBus(pathq: string): boolean {
  const p = pathq.split("?")[0];
  return ["/api/isotp", "/api/isotp/seq", "/api/vin", "/api/scan/sweep", "/api/send", "/api/up", "/api/down"].includes(p);
}

/** Run a device call; a bus call waits for a running quick read and is counted. */
export async function onBus<T>(host: string, pathq: string, run: () => Promise<T>): Promise<T> {
  if (!touchesBus(pathq)) return run();
  const u = use(host);
  while (u.quick) await u.quick.catch(() => undefined);
  u.inFlight += 1;
  try { return await run(); }
  finally { u.inFlight -= 1; u.last = Date.now(); }
}

/** True when nothing from this process is on the bus and nothing was for `ms`. */
export function idleFor(host: string, ms: number): boolean {
  const u = use(host);
  return u.inFlight === 0 && !u.quick && Date.now() - u.last >= ms;
}

/** A short background read: refused (null) unless the bus is idle; everything else waits for it. */
export async function quickRead<T>(host: string, quietMs: number, run: () => Promise<T>): Promise<T | null> {
  if (!idleFor(host, quietMs)) return null;
  const u = use(host);
  const p = run();
  u.quick = p;
  try { return await p; }
  finally { u.quick = null; }
}
