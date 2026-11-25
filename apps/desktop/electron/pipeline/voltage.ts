/**
 * Supply voltage, as the modules themselves measure it. Standard OBD reads only: 01 42
 * (control module voltage, mV) and 01 0C (rpm, to tell "battery" from "charging") on the
 * engine module, and 01 42 on the other drivetrain modules that answer it. No session
 * change, no maker-specific read, nothing on airbag / immobiliser modules.
 *
 * It runs in the background, so it gives way to everything: see busUse.ts for this process,
 * and `recorderQuiet` below for other programs on the same device.
 */
import { firstRefusal } from "@ecu/vehicle-db";

import { quickRead } from "./busUse";
import { piBase, piGet, piPostRaw } from "./vehiclePipeline";

export interface VoltageSource { id: string; req: string; resp: string }
export interface VoltageReading {
  at: string;
  /** ok = the engine module answered; silent = it did not; busy = something else is on the bus; down = the bus is not up. */
  state: "ok" | "silent" | "busy" | "down";
  volts: number | null;
  rpm: number | null;
  /** Voltage each asked module measures itself. */
  modules: { id: string; volts: number }[];
}

const hex = (s?: string | null) => (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");

/** 41 42 AA BB → volts; null for anything else. */
export function decodeVolts(resp?: string | null): number | null {
  const h = hex(resp);
  if (!/^4142[0-9A-F]{4}/.test(h)) return null;
  const v = parseInt(h.slice(4, 8), 16) / 1000;
  return v > 0 && v < 40 ? v : null;
}
/** 41 0C AA BB → rpm; null for anything else. */
export function decodeRpm(resp?: string | null): number | null {
  const h = hex(resp);
  return /^410C[0-9A-F]{4}/.test(h) ? parseInt(h.slice(4, 8), 16) / 4 : null;
}

/** Only the standard 11-bit OBD addresses are ever asked (7E0–7E7), the engine first. */
export function voltageSources(list: VoltageSource[] | undefined): VoltageSource[] {
  return (list ?? []).filter((s) => /^7E[0-7]$/.test(hex(s.req)) && hex(s.resp) === (parseInt(hex(s.req), 16) + 8).toString(16).toUpperCase());
}

/** Has anything used the bus in the last moments? The device's recorder counts every exchange,
 *  whoever asked for it (this app, the command line, another PC). */
async function recorderQuiet(host: string | undefined): Promise<boolean> {
  const count = async () => {
    const r = (await piGet(host, "/api/rec/status", 4000)) as { session?: { id?: string; bytes?: number; lines_this_run?: number } | null };
    return `${r.session?.id ?? ""}/${r.session?.bytes ?? 0}/${r.session?.lines_this_run ?? 0}`;
  };
  try {
    const a = await count();
    await new Promise((r) => setTimeout(r, 700));
    return a === await count();
  } catch { return true; }                        // a device without the recorder (or the simulator): nothing to see
}

export async function readVoltage(o: { host?: string; iface: string; modules?: VoltageSource[]; /** the operator clicked: bring the bus up if needed */ asked?: boolean; quietMs?: number }): Promise<VoltageReading> {
  const host = piBase(o.host);
  const none = (state: VoltageReading["state"]): VoltageReading => ({ at: new Date().toISOString(), state, volts: null, rpm: null, modules: [] });
  if (!o.asked) {
    // never configure a bus on our own: the speed may be wrong for this car
    const st = (await piGet(o.host, "/api/status", 6000)) as { ifaces?: { name: string; up?: boolean }[] };
    if (!st.ifaces?.find((i) => i.name === o.iface)?.up) return none("down");
  }
  if (!(await recorderQuiet(o.host))) return none("busy");

  const others = voltageSources(o.modules).filter((s) => hex(s.req) !== "7E0");
  const out = await quickRead(host, o.quietMs ?? (o.asked ? 0 : 2500), async () => {
    const ask = async (tx: string, rx: string, requests: string[]) => {
      const bad = firstRefusal(requests, { protectedKind: null });
      if (bad) throw new Error(`Refused before sending — ${bad}`);
      const r = (await piPostRaw(o.host, "/api/isotp/seq", { iface: o.iface, tx, rx, requests, timeout: 0.5 }, 8000)) as { results?: { response?: string }[] };
      return (r.results ?? []).map((x) => x.response);
    };
    const [rpm, volts] = await ask("7E0", "7E8", ["010C", "0142"]);
    const reading: VoltageReading = { ...none("silent"), rpm: decodeRpm(rpm), volts: decodeVolts(volts) };
    if (reading.volts === null && reading.rpm === null) return reading;      // nothing there: do not ask the others
    reading.state = "ok";
    const own = (o.modules ?? []).find((s) => hex(s.req) === "7E0");
    if (own && reading.volts !== null) reading.modules.push({ id: own.id, volts: reading.volts });
    for (const s of others) {
      const v = decodeVolts((await ask(hex(s.req), hex(s.resp), ["0142"]))[0]);
      if (v !== null) reading.modules.push({ id: s.id, volts: v });
    }
    return reading;
  });
  return out ?? none("busy");
}
