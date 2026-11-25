import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { Api } from "./api";
import { useSuperDevice } from "./superdevice-connection";
import { useVoltage, type VoltageState } from "./useVoltage";

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
  /** Which library the app works on: real cars, or the simulator's sandbox copy. Changes only once the switch is done. */
  library: "real" | "sim";
  /** The connected car's supply voltage, kept current in the background. */
  voltage: VoltageState;
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
  // A virtual vehicle on the device, as last reported. Kept through a lost poll or a dropped
  // connection — "cannot ask" is not "no simulator" — and forgotten only for another device.
  const [virtualCar, setVirtualCar] = useState(false);
  const [library, setLibrary] = useState<"real" | "sim">("real");

  const setIface = (v: string) => { setIfaceState(v); try { localStorage.setItem(IFACE_KEY, v); } catch { /* private mode */ } };

  // Is a virtual vehicle answering instead of a car, and is the device read-only?
  useEffect(() => {
    if (!online) { setSim(null); setGate(null); return; }
    let stop = false;
    const poll = () => {
      void Api.superDevice.get<SimStatus>(sd.host, "/api/sim/status")
        .then((s) => { if (!stop) { setSim(s); setVirtualCar(!!s?.running); } }).catch(() => { if (!stop) setSim(null); });
      void Api.superDevice.get<{ mode?: string }>(sd.host, "/api/write-gate")
        .then((g) => { if (!stop) setGate(g?.mode ?? null); }).catch(() => { if (!stop) setGate(null); });
    };
    poll();
    const iv = window.setInterval(poll, 8000);
    return () => { stop = true; window.clearInterval(iv); };
  }, [online, sd.host]);

  const demo = online && sd.host === DESK_SIM;
  const voltage = useVoltage({ host: sd.host, iface, online, rx: sd.status?.ifaces.find((i) => i.name === iface)?.rx ?? null });

  // Real data only in the real library: whenever a simulator answers — the desk simulator,
  // the virtual bus vcan0, a virtual vehicle running on the device — the main process works
  // on a sandbox copy of the library, so nothing a simulator does can reach a real car's record.
  useEffect(() => { setVirtualCar(false); }, [sd.host]);
  const simulated = sd.host === DESK_SIM || iface === "vcan0" || virtualCar;
  useEffect(() => {
    let stop = false;
    void Api.vehicleLib.setSimulation({ on: simulated })
      .then(() => { if (!stop) setLibrary(simulated ? "sim" : "real"); })
      .catch(() => { /* old main process: nothing to switch */ });
    return () => { stop = true; };
  }, [simulated]);

  return (
    <Ctx.Provider value={{ iface, setIface, gate, sim, demo, simCar: simCarName(sim), library, voltage }}>
      {children}
    </Ctx.Provider>
  );
}

export function useWorkbench(): WorkbenchCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkbench must be used inside <WorkbenchProvider>");
  return v;
}
