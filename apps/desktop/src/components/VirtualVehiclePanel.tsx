import { useCallback, useEffect, useState } from "react";

import { Api } from "../lib/api";

/**
 * Virtual Vehicle control — powers the simulated car on the Pi's can1 channel.
 * Wire can1 ↔ can0 and the whole real pipeline (VIN read, discovery, deep-map)
 * runs against it on can0 exactly as against a real vehicle. Talks to the daemon's
 * /api/sim/* endpoints through the generic SuperDevice pass-through.
 */

interface SimStatus { running: boolean; vehicle: string | null; iface: string | null; pid: number | null }

export function VirtualVehiclePanel({ host, onChange }: { host: string; onChange?: (running: boolean) => void }) {
  const [status, setStatus] = useState<SimStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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
      const r = await Api.superDevice.post<SimStatus & { ok: boolean; error?: string; bus?: string }>(host, "/api/sim/start", { iface: "can1", vehicle: "corolla" });
      if (!r.ok) { setMsg(r.error || "Could not start the virtual vehicle."); }
      else setMsg("Simulated 2020 Toyota Corolla is live on CAN1 (11 ECUs).");
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
                ? <>🚗 <b>2020 Toyota Corolla</b> live on <span className="mono">{status?.iface || "can1"}</span> · 11 ECUs answering</>
                : "A full simulated car on CAN1 — real ISO-TP, real UDS/OBD, for testing the whole pipeline."}
            </div>
          </div>
        </div>
        <div className="row">
          {running
            ? <button onClick={() => void powerOff()} disabled={!!busy}>{busy === "stop" ? "Stopping…" : "Power off"}</button>
            : <button className="primary" onClick={() => void powerOn()} disabled={!!busy}>{busy === "start" ? "Powering on…" : "⚡ Power on simulated vehicle (CAN1)"}</button>}
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
.vvp-wire { margin-top: 10px; padding: 8px 10px; background: var(--bg-2); border: 1px dashed var(--border); border-radius: 8px; color: var(--fg-2); }
`;
