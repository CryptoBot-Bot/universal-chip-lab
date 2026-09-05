import { useCallback, useEffect, useState } from "react";

import { Api } from "../lib/api";

/**
 * Virtual Vehicle control — powers the simulated car on the Pi's can1 channel.
 * Wire can1 ↔ can0 and the whole real pipeline (VIN read, discovery, deep-map)
 * runs against it on can0 exactly as against a real vehicle. Talks to the daemon's
 * /api/sim/* endpoints through the generic SuperDevice pass-through.
 */

interface SimStatus { running: boolean; vehicle: string | null; iface: string | null; pid: number | null }

/** Cars the Pi's virtual_vehicle.py can play (keep in sync with its VEHICLES map). */
const VEHICLES: { key: string; label: string; ecus: number; note: string }[] = [
  { key: "corolla", label: "2020 Toyota Corolla", ecus: 12, note: "Toyota address layout · DENSO/AISIN/ADVICS parts" },
  { key: "f150", label: "2018 Ford F-150", ecus: 9, note: "Ford FEPS addresses · Continental/Visteon/Nexteer parts" },
];
const vehicleLabel = (k?: string | null) => VEHICLES.find((v) => v.key === k)?.label ?? k ?? "virtual vehicle";

export function VirtualVehiclePanel({ host, onChange }: { host: string; onChange?: (running: boolean) => void }) {
  const [status, setStatus] = useState<SimStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pick, setPick] = useState<string>(() => { try { return localStorage.getItem("vv.vehicle") || "corolla"; } catch { return "corolla"; } });

  const refresh = useCallback(async () => {
    try {
      const s = await Api.superDevice.get<SimStatus>(host, "/api/sim/status");
      setStatus(s);
      onChange?.(s.running);
    } catch { /* Pi not reachable yet */ }
  }, [host, onChange]);

  useEffect(() => {
    void refresh();
    const iv = setInterval(() => void refresh(), 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  async function powerOn() {
    setBusy("start"); setMsg(null);
    try {
      try { localStorage.setItem("vv.vehicle", pick); } catch { /* ignore */ }
      const r = await Api.superDevice.post<SimStatus & { ok: boolean; error?: string; bus?: string }>(host, "/api/sim/start", { iface: "can1", vehicle: pick });
      const v = VEHICLES.find((x) => x.key === pick);
      if (!r.ok) { setMsg(r.error || "Could not start the virtual vehicle."); }
      else setMsg(`Simulated ${v?.label ?? pick} is live on CAN1 (${v?.ecus ?? "?"} ECUs).`);
      await refresh();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  }

  async function powerOff() {
    setBusy("stop"); setMsg(null);
    try {
      await Api.superDevice.post(host, "/api/sim/stop", {});
      setMsg("Virtual vehicle stopped.");
      await refresh();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  }

  const running = !!status?.running;

  return (
    <div className={`vvp card ${running ? "on" : ""}`}>
      <style>{styles}</style>
      <div className="row spread">
        <div className="vvp-title">
          <span className={`vvp-dot ${running ? "on" : ""}`} />
          <div>
            <b>Virtual Vehicle</b>
            <div className="tiny dim">
              {running
                ? <>🚗 <b>{vehicleLabel(status?.vehicle)}</b> live on <span className="mono">{status?.iface || "can1"}</span> · {VEHICLES.find((v) => v.key === status?.vehicle)?.ecus ?? "?"} ECUs answering</>
                : "A full simulated car on CAN1 — real ISO-TP, real UDS/OBD incl. sessions, security, DTC clear, coding writes, routines — for testing the whole pipeline."}
            </div>
          </div>
        </div>
        <div className="row">
          {running
            ? <button onClick={() => void powerOff()} disabled={!!busy}>{busy === "stop" ? "Stopping…" : "Power off"}</button>
            : <>
                <select className="vvp-sel" value={pick} onChange={(e) => setPick(e.target.value)} disabled={!!busy} title={VEHICLES.find((v) => v.key === pick)?.note}>
                  {VEHICLES.map((v) => <option key={v.key} value={v.key}>{v.label} · {v.ecus} ECUs</option>)}
                </select>
                <button className="primary" onClick={() => void powerOn()} disabled={!!busy}>{busy === "start" ? "Powering on…" : "⚡ Power on (CAN1)"}</button>
              </>}
        </div>
      </div>

      {running && (
        <div className="vvp-wire tiny">
          <b>Wiring:</b> jumper <span className="mono">can1 CANH↔can0 CANH</span> and <span className="mono">can1 CANL↔can0 CANL</span>, both 120 Ω terminators ON.
          Then bring <b>CAN0</b> up below and read the VIN — you're now driving the tool against a "real" bus.
        </div>
      )}
      {msg && <div className="tiny" style={{ marginTop: 8, color: running ? "var(--accent)" : "var(--warn)" }}>{msg}</div>}
    </div>
  );
}

const styles = `
.vvp { border: 1px solid var(--border); }
.vvp.on { border-color: var(--accent); }
.vvp-title { display: flex; align-items: center; gap: 10px; }
.vvp-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border-strong, #444); flex: none; }
.vvp-dot.on { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
.vvp-sel { background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; color: var(--fg-0); padding: 6px 9px; font-size: 12.5px; margin-right: 6px; }
.vvp-wire { margin-top: 10px; padding: 8px 10px; background: var(--bg-2); border: 1px dashed var(--border); border-radius: 8px; color: var(--fg-2); }
`;
