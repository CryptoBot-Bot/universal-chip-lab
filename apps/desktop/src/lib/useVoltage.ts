import { useCallback, useEffect, useRef, useState } from "react";

import { Api, type VoltageReading, type VoltageSource } from "./api";
import { ageText } from "./voltage";

/** Seconds between background reads. */
const EVERY_MS = 10_000;
/** Reads without an answer before the background read stops asking (ignition off). */
const SILENT_MAX = 2;
/** With the engine off, the background read stops after this long, so a parked car is not kept awake. */
const PARKED_MAX_MS = 15 * 60_000;

export interface VoltageState {
  /** The last real answer, if any. */
  reading: VoltageReading | null;
  /** Why there is no fresh number right now, in words ("" = fresh). */
  status: string;
  reading_now: boolean;
  /** Voltage per module id, from the last answer of each. */
  byModule: Record<string, { volts: number; at: string }>;
  /** Read now, on the operator's request (also ends a pause). */
  readNow: () => Promise<void>;
  /** The modules of the open vehicle that may report their own voltage. */
  /** `of`: whose modules they are — another vehicle starts with no module voltages. */
  setModules: (list: VoltageSource[], of: string) => void;
}

/**
 * The car's voltage, kept current while a device is connected. Background reads give way to
 * every scan (the main process decides), pause when nothing answers, and pause on a parked
 * car after a while; traffic on the bus or a click resumes them.
 */
export function useVoltage(o: { host: string; iface: string; online: boolean; rx: number | null }): VoltageState {
  const [reading, setReading] = useState<VoltageReading | null>(null);
  const [status, setStatus] = useState("");
  const [busyNow, setBusyNow] = useState(false);
  const [byModule, setByModule] = useState<VoltageState["byModule"]>({});
  const modules = useRef<VoltageSource[]>([]);
  const modulesOf = useRef("");
  const st = useRef({ silent: 0, parkedSince: 0, paused: "", inFlight: false, rxAtPause: null as number | null });

  const key = `${o.host}|${o.iface}`;
  const keyRef = useRef(key); keyRef.current = key;
  useEffect(() => {                                   // another device or bus: nothing known yet
    st.current = { silent: 0, parkedSince: 0, paused: "", inFlight: false, rxAtPause: null };
    setReading(null); setByModule({}); setStatus("");
  }, [key]);

  const run = useCallback(async (asked: boolean) => {
    const s = st.current;
    if (s.inFlight || !o.host) return;
    s.inFlight = true; if (asked) setBusyNow(true);
    const k = key;
    try {
      const r = await Api.voltage.read({ host: o.host, iface: o.iface, modules: modules.current, asked });
      if (keyRef.current !== k) return;
      if (r.state === "ok") {
        s.silent = 0; s.paused = ""; setStatus("");
        if ((r.rpm ?? 0) >= 300) s.parkedSince = 0; else if (!s.parkedSince || asked) s.parkedSince = Date.now();
        if (r.volts !== null) setReading(r);
        if (r.modules.length) setByModule((m) => ({ ...m, ...Object.fromEntries(r.modules.map((x) => [x.id, { volts: x.volts, at: r.at }])) }));
        if (s.parkedSince && Date.now() - s.parkedSince > PARKED_MAX_MS) { s.paused = "parked"; s.rxAtPause = null; setStatus("paused so the parked car can sleep — click to read"); }
      } else if (r.state === "silent") {
        s.silent += 1; setStatus("no answer — ignition off?");
        if (s.silent >= SILENT_MAX) { s.paused = "silent"; s.rxAtPause = null; }
      } else if (r.state === "down") setStatus("bus not up yet — click to read");
      else if (asked) setStatus("a scan is using the bus");
    } catch { if (asked) setStatus("the device did not answer"); }
    finally { s.inFlight = false; if (asked) setBusyNow(false); }
  }, [o.host, o.iface, key]);

  useEffect(() => {
    if (!o.online) return;
    void run(false);
    const iv = window.setInterval(() => { if (!st.current.paused && !document.hidden) void run(false); }, EVERY_MS);
    return () => window.clearInterval(iv);
  }, [o.online, run]);

  // the window comes back to the front: read at once instead of showing what was true before
  useEffect(() => {
    const back = () => { if (!document.hidden && o.online && !st.current.paused) void run(false); };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [o.online, run]);

  // age of the reading, so an old number is never shown as current (hidden window, a long scan)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const iv = window.setInterval(() => setNow(Date.now()), 5000); return () => window.clearInterval(iv); }, []);
  const age = reading ? ageText(reading.at, Math.max(now, Date.parse(reading.at))) : "";

  // traffic on the bus after a silent pause (somebody switched the ignition on and scanned) resumes it
  useEffect(() => {
    const s = st.current;
    if (s.paused !== "silent" || o.rx === null) return;
    if (s.rxAtPause === null) { s.rxAtPause = o.rx; return; }
    if (o.rx !== s.rxAtPause) { s.paused = ""; s.silent = 0; }
  }, [o.rx]);

  const readNow = useCallback(async () => { st.current.paused = ""; st.current.silent = 0; await run(true); }, [run]);
  const setModules = useCallback((list: VoltageSource[], of: string) => {
    if (modulesOf.current !== of) { modulesOf.current = of; setByModule({}); }
    modules.current = list;
  }, []);
  return { reading, status: status || age, reading_now: busyNow, byModule, readNow, setModules };
}
