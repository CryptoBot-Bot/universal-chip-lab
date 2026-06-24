import { useState } from "react";

import { Obd, type ModuleReport } from "../lib/obd";

/**
 * Full vehicle scan: discovers every module that answers on the bus, then reads
 * each one's trouble codes (UDS 0x19) and VIN (0x22/F190). Streams per-module
 * progress and renders a card per module with a gated per-module clear.
 */
export function VehicleScan({ port, sim }: { port: string; sim: boolean }) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("");
  const [reports, setReports] = useState<ModuleReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    setError(null);
    setReports(null);
    try {
      const r = await Obd.scanAllModules(port, (addr, i, total) => {
        setProgress(`Reading ${addr.name} (${i + 1}/${total})…`);
      });
      setReports(r);
      if (r.length === 0) setError("No modules answered. Check wiring/ignition, or the bus speed (this firmware is 500 kbit/s).");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScanning(false);
      setProgress("");
    }
  }

  const totalDtcs = reports?.reduce((n, r) => n + r.dtcs.length, 0) ?? 0;

  return (
    <div className="card mt-16" style={{ borderColor: reports && totalDtcs ? "var(--warn)" : "var(--border)" }}>
      <div className="row spread">
        <h3>Full vehicle scan <span className="tiny dim">— every module · codes · VIN</span></h3>
        <button className="primary" onClick={scan} disabled={scanning}>
          {scanning ? "Scanning…" : reports ? "Re-scan all" : "Scan all modules"}
        </button>
      </div>

      {progress && <p className="tiny mono mt-8">{progress}</p>}
      {error && <p className="tiny mt-8" style={{ color: "var(--warn)" }}>{error}</p>}
      {!reports && !scanning && !error && (
        <p className="tiny dim mt-8">
          Discovers every module that answers on the bus (HS-CAN, OBD pins 6/14), then reads each one's trouble codes
          and VIN over OBD-II + UDS — engine, transmission, ABS, body, whatever responds.
          {sim && " (Simulator returns a fake 4-module vehicle.)"}
        </p>
      )}

      {reports && reports.length > 0 && (
        <>
          <p className="tiny mt-12">
            <span className="badge info">{reports.length} module{reports.length === 1 ? "" : "s"}</span>{" "}
            <span className={`badge ${totalDtcs ? "warn" : "ok"}`}>{totalDtcs} code{totalDtcs === 1 ? "" : "s"} total</span>
          </p>
          {reports.map((r) => (
            <ModuleCard key={r.addr.resp} report={r} port={port} />
          ))}
        </>
      )}
    </div>
  );
}

function ModuleCard({ report, port }: { report: ModuleReport; port: string }) {
  const m = report.addr;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cleared, setCleared] = useState(false);

  async function clear() {
    setBusy(true);
    try {
      await Obd.clearModuleDtcs(port, m.req);
      setCleared(true);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card compact mt-12">
      <div className="row spread">
        <div>
          <strong>{m.name}</strong>{" "}
          <span className="tiny dim mono">
            req {m.req.toString(16).toUpperCase()} · resp {m.resp.toString(16).toUpperCase()}
          </span>
        </div>
        <span className={`badge ${report.dtcs.length ? "warn" : "ok"}`}>
          {report.dtcs.length} code{report.dtcs.length === 1 ? "" : "s"}
        </span>
      </div>

      {report.vin && <p className="tiny mt-8">VIN <span className="mono">{report.vin}</span></p>}

      {report.dtcs.map((d) => (
        <div key={d.code} className="row" style={{ gap: 10, marginTop: 6, alignItems: "baseline" }}>
          <span className="mono" style={{ fontWeight: 700, minWidth: 78 }}>{d.code}</span>
          <span className="tiny dim">{d.description}</span>
        </div>
      ))}

      {report.notes.map((n, i) => (
        <p key={i} className="tiny dim mt-8">{n}</p>
      ))}

      {report.dtcs.length > 0 && (
        <div className="row wrap mt-8" style={{ gap: 8 }}>
          {cleared ? (
            <span className="tiny" style={{ color: "var(--accent)" }}>Cleared — re-scan to confirm.</span>
          ) : !confirm ? (
            <button className="tiny" onClick={() => setConfirm(true)} disabled={busy}>Clear this module…</button>
          ) : (
            <>
              <span className="tiny" style={{ color: "var(--danger)" }}>⚠ Writes to the car.</span>
              <button className="tiny" onClick={() => setConfirm(false)}>Cancel</button>
              <button className="tiny primary" style={{ background: "var(--danger)" }} onClick={clear} disabled={busy}>
                Yes, clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
