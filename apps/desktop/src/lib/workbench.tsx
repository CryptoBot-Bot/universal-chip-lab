import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { Api } from "./api";
import { useSuperDevice } from "./superdevice-connection";

/**
 * The workbench: what the whole app is talking to right now.
 *
 * One place for the things every tab (and the header's connection pill) needs to
 * agree on: which bus on the device we use, whether the device's write gate is
 * read-only, and whether a virtual car is answering instead of a real one. Before
 * this lived inside the Diagnostics page; the header now shows it everywhere.
 */

/** The desk simulator on this PC (hardware/super-device/webui/desk_sim.py). */
export const DESK_SIM = "127.0.0.1:8765";

export interface SimStatus {
  running: boolean;
  vehicle?: string | null;
  name?: string | null;
  /** Recording ids being played back (desk simulator replay mode). */
  replay?: string[] | null;
}

interface WorkbenchCtx {
  iface: string;
  setIface: (iface: string) => void;
  /** The device's write gate: "read-only", "disarmed", "armed" — null when unknown. */
  gate: string | null;
  sim: SimStatus | null;
  /** True when the desk simulator on this PC is the connected device. */
  demo: boolean;
  /** Short human name of the car the simulator plays, if any ("2015 Sprinter 3500 diesel"). */
  simCar: string | null;
}

const IFACE_KEY = "diag.iface";
const Ctx = createContext<WorkbenchCtx | null>(null);

/** "20261123-183159-2015-Sprinter-3500-diesel" → "2015 Sprinter 3500 diesel". */
export function simCarName(sim: SimStatus | null): string | null {
  if (!sim?.running) return null;
  for (const id of sim.replay ?? []) {
    const m = /^\d{8}-\d{6}-(.+)$/.exec(id);
    if (m) return m[1].replace(/-/g, " ");
  }
  if (sim.replay?.length) return "recorded car";
  return sim.name || sim.vehicle || null;
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const sd = useSuperDevice();
  const online = sd.link === "online";
  const [iface, setIfaceState] = useState(() => localStorage.getItem(IFACE_KEY) || "can0");
  const [gate, setGate] = useState<string | null>(null);
  const [sim, setSim] = useState<SimStatus | null>(null);

  const setIface = (v: string) => { setIfaceState(v); try { localStorage.setItem(IFACE_KEY, v); } catch { /* private mode */ } };

  // Is a virtual vehicle answering instead of a car, and is the device read-only?
  useEffect(() => {
    if (!online) { setSim(null); setGate(null); return; }
    let stop = false;
    const poll = () => {
      void Api.superDevice.get<SimStatus>(sd.host, "/api/sim/status")
        .then((s) => { if (!stop) setSim(s); }).catch(() => { if (!stop) setSim(null); });
      void Api.superDevice.get<{ mode?: string }>(sd.host, "/api/write-gate")
        .then((g) => { if (!stop) setGate(g?.mode ?? null); }).catch(() => { if (!stop) setGate(null); });
    };
    poll();
    const iv = window.setInterval(poll, 8000);
    return () => { stop = true; window.clearInterval(iv); };
  }, [online, sd.host]);

  const demo = online && sd.host === DESK_SIM;
  return (
    <Ctx.Provider value={{ iface, setIface, gate, sim, demo, simCar: simCarName(sim) }}>
      {children}
    </Ctx.Provider>
  );
}

export function useWorkbench(): WorkbenchCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkbench must be used inside <WorkbenchProvider>");
  return v;
}
