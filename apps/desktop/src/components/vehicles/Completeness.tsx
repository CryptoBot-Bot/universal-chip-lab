import { useEffect, useState } from "react";

import { coverageOf } from "@ecu/vehicle-db";
import type { VehicleModule, VehicleProfile } from "@ecu/vehicle-db";

import { Api, type VehicleExplorerEvent } from "../../lib/api";
import { useSuperDevice } from "../../lib/superdevice-connection";
import { useWorkbench } from "../../lib/workbench";
import { fmtDate, plural } from "./vehicleFacts";

/**
 * Completeness of one system's map: the sweep (fixed code read every identifier of
 * the module) against what the AI map knows. Shows the share covered, the moving
 * values the map does not list as live data, and lets the operator sweep again.
 */
const CONDITIONS = ["ignition on, engine off", "engine idling"];

export function Completeness({ profile, m, onProfile }: { profile: VehicleProfile; m: VehicleModule; onProfile?: (p: VehicleProfile) => void }) {
  const sd = useSuperDevice();
  const wb = useWorkbench();
  const online = sd.link === "online";
  const [condition, setCondition] = useState(CONDITIONS[0]);
  const [busy, setBusy] = useState<{ asked: number; of: number; answered: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    const off = Api.vehicleExplorer.onEvent((e: VehicleExplorerEvent) => {
      if (e.type === "sweep-module" && e.moduleId === m.id) setBusy({ asked: e.asked, of: e.of, answered: e.answered });
    });
    return () => { off(); };
  }, [busy !== null, m.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const c = coverageOf(m);
  const last = m.sweeps?.length ? m.sweeps[m.sweeps.length - 1] : null;
  const pct = c.ratio === null ? null : Math.round(c.ratio * 100);

  async function sweep() {
    setErr(null); setBusy({ asked: 0, of: 0, answered: 0 });
    try {
      const r = await Api.vehicleExplorer.sweepModules({
        host: sd.host, iface: wb.iface, profile, moduleIds: [m.id], condition,
        sim: wb.demo ? (wb.simCar ?? "desk simulator") : null,
      });
      onProfile?.(r.profile);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <div className="vdb-cov" aria-label="Completeness of this system's map">
      <div className="vdb-cov-head">
        <span className="vdb-caps-title">Completeness</span>
        {pct !== null && <b className="vdb-cov-pct">{pct}%</b>}
      </div>
      {last ? (
        <>
          <div className="vdb-cov-bar" role="img" aria-label={`${c.known} of ${c.answered} answering identifiers are in the map`}><i style={{ width: `${pct ?? 0}%` }} /></div>
          <span>
            {c.known} of {plural(c.answered, "identifier")} this system answers are in the map
            {c.moving ? ` · ${c.movingKnown} of ${plural(c.moving, "moving value")} listed as live data` : ""}
          </span>
          {c.missedLive.length > 0 && (
            <details className="vdb-list"><summary>Moving, not in the map <span className="ual-muted">· {c.missedLive.length}</span></summary>
              <p className="ual-mono vdb-cov-ids">{c.missedLive.join("  ")}</p></details>
          )}
          {c.missed.length > 0 && (
            <details className="vdb-list"><summary>Answering, never mentioned <span className="ual-muted">· {c.answered - c.known}</span></summary>
              <p className="ual-mono vdb-cov-ids">{c.missed.join("  ")}{c.answered - c.known > c.missed.length ? "  …" : ""}</p></details>
          )}
          {c.unseen.length > 0 && <span className="ual-muted">In the map but not seen answering: <span className="ual-mono">{c.unseen.join(", ")}</span></span>}
          <span className="ual-muted">
            {m.sweeps!.map((s) => `${s.condition}${s.sim ? " (simulator)" : ""} · ${fmtDate(s.at)} · ${s.counts.answered} answered`).join("  —  ")}
          </span>
        </>
      ) : (
        <span className="ual-muted">Not swept yet. A sweep reads every identifier of this system twice — no AI — and shows how much of it the map covers.</span>
      )}
      <div className="vdb-cov-actions">
        <label className="vdb-cov-cond">
          <span className="vdb-sr">What the car is doing</span>
          <select value={condition} onChange={(e) => setCondition(e.target.value)} disabled={!!busy}>
            {CONDITIONS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <button type="button" disabled={!online || !!busy} onClick={() => void sweep()}>
          {busy ? (busy.of ? `Sweeping ${busy.asked}/${busy.of} · ${busy.answered} answered` : "Sweeping…") : last ? "Sweep again" : "Sweep this system"}
        </button>
        <span className="ual-muted">{online ? "Read-only · about a minute · no AI" : "Connect a device to sweep"}</span>
      </div>
      {err && <div className="ual-note err">{err}</div>}
    </div>
  );
}
