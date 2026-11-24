import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { applyCensus, censusInputFor, lastScanFor, recordScan } from "@ecu/vehicle-db";
import type { SystemScanResult, VehicleModule, VehicleProfile, VehicleScanRecord } from "@ecu/vehicle-db";

import { Api, type DiscoveredModule, type VehicleExplorerEvent } from "../../lib/api";
import { CATEGORY_LABEL, CATEGORY_ORDER, addressedSystems, clean, clearDtcs, readDtcs, scanResult, ymmLabel } from "../../lib/diag";
import type { PendingWrite } from "../../lib/writeActions";
import { WriteConfirmModal } from "../WriteConfirmModal";

/**
 * The vehicle page — what a scan tool shows once the car is identified:
 *   Auto Scan      every system with its state (Pass / Fault | n / No response),
 *                  the systems themselves discovered and saved on the way;
 *   Control Units  the same systems by area, to enter one directly;
 *   Service        whole-vehicle actions (read all, erase all, learn all);
 *   History        this car's earlier scans.
 * A car that has been here before opens with its systems and its last scan
 * already on screen — nothing has to be re-discovered to start working.
 */

export type HubTab = "scan" | "units" | "service" | "history";
export type RowState = SystemScanResult | "scanning";

interface Props {
  host: string; iface: string; online: boolean; demo: boolean;
  /** Name of the virtual vehicle answering instead of a car, if one is. Stamped on saved scans. */
  simName?: string | null;
  profile: VehicleProfile; vin: string;
  tab: HubTab; onTab: (t: HubTab) => void;
  rows: Record<string, RowState>; setRows: Dispatch<SetStateAction<Record<string, RowState>>>;
  /** Persist a profile changed here; resolves to the stored copy. */
  saveProfile: (p: VehicleProfile) => Promise<VehicleProfile>;
  /** Take over a profile the main process already saved. */
  adoptProfile: (p: VehicleProfile) => void;
  /** Read the VIN from the car and bind it (may switch to another library vehicle). Null if it could not. */
  ensureVin: () => Promise<{ profile: VehicleProfile; vin: string } | null>;
  onEnter: (moduleId: string) => void;
}

const PILL: Record<string, { cls: string; text: (r: SystemScanResult) => string }> = {
  ok: { cls: "ok", text: () => "Pass | No fault" },
  fault: { cls: "fault", text: (r) => `Fault | ${r.dtcs.length}` },
  no_response: { cls: "none", text: () => "No response" },
  unknown: { cls: "unk", text: () => "Not readable" },
};

function summary(systems: SystemScanResult[]): string {
  const faulty = systems.filter((s) => s.status === "fault");
  const codes = faulty.reduce((n, s) => n + s.dtcs.length, 0);
  const silent = systems.filter((s) => s.status === "no_response").length;
  const bits = [`${systems.length} system${systems.length === 1 ? "" : "s"}`];
  bits.push(faulty.length ? `${faulty.length} with faults (${codes} code${codes === 1 ? "" : "s"})` : "no faults");
  if (silent) bits.push(`${silent} not answering`);
  return bits.join(" · ");
}

export function VehicleHub(p: Props) {
  const { host, iface, online, profile, vin, tab, rows, setRows } = p;
  const [busy, setBusy] = useState<null | "auto" | "fault" | "erase" | "learn">(null);
  const [phase, setPhase] = useState("");
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [write, setWrite] = useState<{ pending: PendingWrite; commit: () => void } | null>(null);
  const [learnAsk, setLearnAsk] = useState(false);
  const stop = useRef(false);

  const systems = addressedSystems(profile);
  const last = lastScanFor(profile, vin);
  const lastBy = new Map((last?.systems ?? []).map((s) => [s.moduleId, s]));
  const fresh = Object.keys(rows).length > 0;
  const stateOf = (m: VehicleModule): RowState | undefined => rows[m.id] ?? lastBy.get(m.id);
  const shown = systems.map((m) => stateOf(m)).filter((r): r is SystemScanResult => !!r && r !== "scanning");
  const learned = systems.filter((m) => m.explored).length;

  async function scan(kind: "auto" | "fault") {
    if (!online) { setErr("Not connected to the vehicle — connect the device (top right), then scan."); return; }
    stop.current = false; setBusy(kind); setErr(null); setNote(null); setRows({});
    const t0 = Date.now();
    try {
      let cur = profile; let v = vin;
      if (!v) {
        setPhase("Reading the VIN…");
        const r = await p.ensureVin();
        if (r) { cur = r.profile; v = r.vin; }
        else setNote("The VIN could not be read — scanning anyway; this scan is not filed under a car until a VIN is bound.");
      }
      let responders: Set<string> | null = null;
      if (kind === "auto") {
        // First time this model is scanned: also sweep the diagnostic address range (about a
        // minute, tester-present only) so maker-specific modules no list knows are found once;
        // after that the profile's own addresses are re-asked on every scan.
        const firstVisit = !cur.fingerprint;
        setPhase(firstVisit ? "First scan of this model: searching every diagnostic address (about a minute)…" : "Detecting systems on the bus…");
        const off = Api.vehicleExplorer.onEvent((e: VehicleExplorerEvent) => {
          if (e.type === "sweep") setPhase(e.ok ? `Address search done — ${e.found} module address${e.found === 1 ? "" : "es"} answered. Identifying…` : "Address search failed — scanning the known addresses only…");
          if (e.type === "discover") { setProg({ done: e.done, total: e.total }); setPhase(`Detecting systems on the bus… ${e.found} found`); }
        });
        const known = addressedSystems(cur).map((m) => ({ name: m.label, req: String(m.addressing?.request ?? ""), resp: String(m.addressing?.response ?? "") })).filter((k) => k.req && k.resp);
        let found: DiscoveredModule[];
        try {
          try { found = await Api.vehicleExplorer.discover({ host, iface, ident: true, known, deep: firstVisit }); }
          catch (e) {
            if (!firstVisit) throw e;
            setNote(`The address search did not run (${(e as Error).message}); scanned the known addresses only.`);
            found = await Api.vehicleExplorer.discover({ host, iface, ident: true, known });
          }
        } finally { off(); }
        if (stop.current) return;
        cur = await Api.vehicleExplorer.commitDiscovery({ profile: cur, discovered: found });
        p.adoptProfile(cur);
        responders = new Set(found.map((f) => clean(f.responseId)));
        const unnamed = addressedSystems(cur).filter((m) => responders!.has(clean(m.addressing?.response)) && !m.censusAt);
        if (unnamed.length && found.length) {
          setPhase(`Naming ${unnamed.length} new system${unnamed.length === 1 ? "" : "s"} (AI)…`); setProg(null);
          try {
            const census = await Api.vehicleExplorer.census(censusInputFor(cur, found));
            cur = await p.saveProfile(applyCensus(cur, census.modules, new Date().toISOString()));
          } catch (e) { setNote(`The systems are saved; naming them did not work (${(e as Error).message}). They keep their address-based names until the next scan.`); }
        }
      }
      const list = addressedSystems(cur);
      const results: SystemScanResult[] = [];
      for (let i = 0; i < list.length; i++) {
        if (stop.current) break;
        const m = list[i];
        setPhase(`Reading fault memory: ${m.label}`); setProg({ done: i, total: list.length });
        setRows((r) => ({ ...r, [m.id]: "scanning" }));
        let res: SystemScanResult;
        if (responders && !responders.has(clean(m.addressing?.response))) res = scanResult(m, { status: "no_response", dtcs: [] });
        else {
          try { res = scanResult(m, await readDtcs(host, iface, m)); }
          catch (e) { res = scanResult(m, { status: "unknown", dtcs: [], note: (e as Error).message }); }
        }
        results.push(res);
        setRows((r) => ({ ...r, [m.id]: res }));
      }
      if (stop.current) { setNote("Scan stopped — what was read so far is on screen, and was not filed."); return; }
      if (v && results.length) {
        const rec: VehicleScanRecord = { at: new Date().toISOString(), kind, iface, durationMs: Date.now() - t0, systems: results, ...(p.simName ? { sim: p.simName } : {}) };
        await p.saveProfile(recordScan(cur, v, rec));
      }
      setNote((n) => n ?? `Scan complete in ${Math.round((Date.now() - t0) / 1000)} s — ${summary(results)}.${v ? " Filed in this car’s history." : ""}`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); setPhase(""); setProg(null); }
  }

  function quickErase() {
    const targets = systems.filter((m) => { const r = stateOf(m); return r && r !== "scanning" && r.status === "fault"; });
    if (!online) { setErr("Not connected to the vehicle."); return; }
    if (!targets.length) { setNote("Nothing to erase — no system on screen reports a fault. Run a scan first."); return; }
    setWrite({
      pending: {
        moduleLabel: `${targets.length} system${targets.length === 1 ? "" : "s"} of ${ymmLabel(profile)}`,
        label: `Erase fault codes in ${targets.length} system${targets.length === 1 ? "" : "s"}`, request: "14 FF FF FF", kind: "clear", risk: "write",
        note: `Clears the fault memory of: ${targets.map((m) => m.label).join(", ")}. Sent to the REAL modules; faults that are still present set again.`,
      },
      commit: () => void (async () => {
        setBusy("erase"); setErr(null); setNote(null);
        try {
          const lines: string[] = [];
          for (const m of targets) {
            setPhase(`Erasing: ${m.label}`);
            try { const r = await clearDtcs(host, iface, m); lines.push(`${r.ok ? "✓" : "✗"} ${m.label} — ${r.detail}`); }
            catch (e) { lines.push(`✗ ${m.label} — ${(e as Error).message}`); }
          }
          setNote(lines.join("  ·  "));
        } finally { setBusy(null); setPhase(""); }
        await scan("fault");
      })(),
    });
  }

  async function learnAll() {
    setLearnAsk(false);
    if (!online) { setErr("Not connected to the vehicle."); return; }
    const todo = systems.filter((m) => !m.explored);
    if (!todo.length) { setNote("Every system of this vehicle has already been learned. Open one and use “Learn this system” to go deeper."); return; }
    setBusy("learn"); setErr(null); setNote(null);
    const off = Api.vehicleExplorer.onEvent((e: VehicleExplorerEvent) => {
      if (e.type === "module-start") { setPhase(`Learning ${e.index + 1}/${e.total}: ${e.displayName}`); setProg({ done: e.index, total: e.total }); }
      else if (e.type === "error") setErr(e.text);
    });
    try {
      const updated = await Api.vehicleExplorer.start({
        host, iface, profile,
        targets: todo.map((m) => ({
          moduleId: m.id, displayName: m.label, brand: profile.make, category: m.category,
          protocol: profile.buses.find((b) => b.id === m.bus)?.protocol === "K-Line" ? "kwp2000" : "uds",
          requestId: m.addressing?.request ?? "", responseId: m.addressing?.response ?? "",
        })),
      });
      p.adoptProfile(updated);
      setNote(`Learned ${updated.modules.filter((m) => m.explored).length} of ${addressedSystems(updated).length} systems — saved to ${ymmLabel(updated)}.`);
    } catch (e) { setErr((e as Error).message); }
    finally { off(); setBusy(null); setPhase(""); setProg(null); }
  }

  const sysRow = (m: VehicleModule, i: number) => {
    const r = stateOf(m);
    const pill = r === "scanning" ? { cls: "run", text: "Scanning…" } : r ? { cls: PILL[r.status].cls, text: PILL[r.status].text(r) } : { cls: "", text: "Not scanned" };
    const tags = [m.identity?.partNo, m.identity?.supplier, m.explored ? `learned ${m.explored.runCount}×` : "not learned yet"].filter(Boolean).join(" · ");
    return (
      <div key={m.id}>
        <button className={`dg-sys ${r && r !== "scanning" && r.status === "no_response" ? "quiet" : ""}`} onClick={() => p.onEnter(m.id)} title="Enter this system">
          <span className="n">{String(i + 1).padStart(2, "0")}</span>
          <span className="nm"><b>{m.label}</b><small>{tags}</small></span>
          <span className="ad">{m.addressing?.request ?? "?"} → {m.addressing?.response}</span>
          <span className={`dg-st ${pill.cls}`}>{pill.text}</span>
          <span className="dim">›</span>
        </button>
        {r && r !== "scanning" && r.dtcs.length > 0 && (
          <div className="dg-dtcs">
            {r.dtcs.map((d, k) => <div className="dg-dtc" key={k}><span className="c">{d.code}</span><span>{d.description || <span className="dim">no description on file</span>}</span><span className="s">{d.status}</span></div>)}
          </div>
        )}
      </div>
    );
  };

  const scans = (profile.knownVins?.find((o) => o.vin === vin)?.scans ?? []).slice().reverse();
  const unit = profile.knownVins?.find((o) => o.vin === vin);

  return (
    <>
      <div className="dg-veh">
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="name">{ymmLabel(profile)}{profile.trim ? <span className="dim" style={{ fontWeight: 500, fontSize: 15 }}> · {profile.trim}</span> : null}</div>
          <div className="meta">{[profile.decoded?.engine, profile.decoded?.bodyClass, profile.decoded?.driveType].filter(Boolean).join(" · ") || "No decode on file yet"}{unit ? ` · seen ${unit.reads}× since ${new Date(unit.firstReadAt).toLocaleDateString()}` : ""}</div>
        </div>
        <div className="kv">VIN<b>{vin || "not read"}</b></div>
        <div className="kv">Systems<b>{systems.length}</b></div>
        <div className="kv">Learned<b>{learned}/{systems.length}</b></div>
        <div className="kv">Last scan<b style={{ fontFamily: "var(--sans)", fontSize: 13 }}>{last ? new Date(last.at).toLocaleString() : "never"}</b></div>
      </div>

      <div className="dg-tabs">
        {([["scan", "Auto Scan"], ["units", "Control Units"], ["service", "Service"], ["history", `History${scans.length ? ` (${scans.length})` : ""}`]] as [HubTab, string][]).map(([id, label]) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => p.onTab(id)}>{label}</button>
        ))}
      </div>

      {!vin && <div className="dg-note warn">VIN not read yet. Auto Scan reads it first and checks it against this selection — if the car turns out to be a different model, it switches.</div>}
      {err && <div className="dg-note err">{err}</div>}
      {note && <div className="dg-note">{note}</div>}
      {busy && <><div className="dg-note">● {phase || "Working…"}</div>{prog && <div className="dg-prog"><i style={{ width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%` }} /></div>}</>}

      {tab === "scan" && (
        <>
          <div className="dg-scanhead">
            <span className="muted" style={{ fontSize: 13 }}>
              {systems.length === 0 ? "No systems known for this vehicle yet." : fresh ? `This scan: ${summary(shown)}` : last ? `Showing this car’s last scan (${new Date(last.at).toLocaleString()}): ${summary(last.systems)}` : `${systems.length} systems on file for this model — not scanned on this car yet.`}
            </span>
          </div>
          {systems.length === 0 && <div className="dg-empty">Press <b>Auto Scan</b>: it probes every diagnostic address, reads what each system says it is, names them, and reads their fault memory. The result is saved — the next {ymmLabel(profile)} opens with all of it.</div>}
          {systems.map(sysRow)}
        </>
      )}

      {tab === "units" && (
        <>
          {systems.length === 0 && <div className="dg-empty">No systems known yet — run Auto Scan first.</div>}
          {CATEGORY_ORDER.filter((c) => systems.some((m) => m.category === c)).map((c) => (
            <div key={c}>
              <div className="dg-cat">{CATEGORY_LABEL[c]}</div>
              {systems.filter((m) => m.category === c).map((m) => sysRow(m, systems.indexOf(m)))}
            </div>
          ))}
        </>
      )}

      {tab === "service" && (
        <>
          <div className="dg-tiles">
            <button className="dg-tile" disabled={!!busy} onClick={() => { p.onTab("scan"); void scan("fault"); }}>
              <span className="ico">⚠️</span><span className="t">Read all codes</span><span className="d">Ask every known system for its fault codes (no re-detection — fast).</span>
            </button>
            <button className="dg-tile" disabled={!!busy} onClick={() => { p.onTab("scan"); quickErase(); }}>
              <span className="ico">🧹</span><span className="t">Erase all codes</span><span className="d">Clear the fault memory of every system that reports a fault. Confirms first.</span>
            </button>
            <button className="dg-tile" disabled={!!busy} onClick={() => setLearnAsk(true)}>
              <span className="ico">🧠</span><span className="t">Learn all systems</span><span className="d">The AI explores every system not learned yet, read-only, and saves what each can do.</span>
              <span className="cnt">{learned}/{systems.length} learned</span>
            </button>
          </div>
          {learnAsk && (
            <div className="dg-note warn">
              Learn {systems.filter((m) => !m.explored).length} system(s) now? Each takes 3–5 minutes and one AI session on your API key; the car must stay connected with the ignition on.
              <span style={{ marginLeft: 10 }}><button className="primary" onClick={() => void learnAll()}>Start</button> <button onClick={() => setLearnAsk(false)}>Cancel</button></span>
            </div>
          )}
          <div className="dg-note">Service resets (oil life, electronic parking brake, steering-angle calibration, battery registration…) are maker-specific routines. None is mapped for this vehicle yet, so none is offered here — a routine you know can be started from a system’s <b>Special Functions</b>.</div>
        </>
      )}

      {tab === "history" && (
        <>
          {!vin && <div className="dg-empty">History is kept per car (VIN). Read the VIN first.</div>}
          {vin && scans.length === 0 && <div className="dg-empty">No scan on file for this car yet.</div>}
          {scans.map((s, i) => (
            <div className="dg-panel" key={s.at + i} style={{ marginBottom: 10 }}>
              <div className="row spread"><b>{new Date(s.at).toLocaleString()}</b><span className="dim tiny">{s.sim ? <span className="dg-chip demo" style={{ marginRight: 8 }}>VIRTUAL VEHICLE</span> : null}{s.kind === "auto" ? "Auto Scan" : "Fault scan"}{s.durationMs ? ` · ${Math.round(s.durationMs / 1000)} s` : ""}{s.iface ? ` · ${s.iface}` : ""}</span></div>
              <div className="muted" style={{ fontSize: 13, margin: "4px 0 6px" }}>{summary(s.systems)}</div>
              {s.systems.filter((x) => x.status === "fault").map((x) => (
                <div key={x.moduleId} style={{ fontSize: 12.5, marginTop: 4 }}>
                  <b>{x.label}</b> <span className="dim mono tiny">{x.responseId}</span>
                  <div className="dg-dtcs" style={{ marginLeft: 0 }}>{x.dtcs.map((d, k) => <div className="dg-dtc" key={k}><span className="c">{d.code}</span><span>{d.description}</span><span className="s">{d.status}</span></div>)}</div>
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      <div style={{ height: 24 }} />
      <div className="dg-foot stick">
        <button className="primary" disabled={!!busy} onClick={() => { p.onTab("scan"); void scan("auto"); }}>Auto Scan</button>
        <button disabled={!!busy || systems.length === 0} onClick={() => { p.onTab("scan"); void scan("fault"); }}>Fault Scan</button>
        <button disabled={!!busy} onClick={() => { p.onTab("scan"); quickErase(); }}>Quick Erase…</button>
        {busy && busy !== "erase" && <button className="danger" onClick={() => { stop.current = true; void Api.vehicleExplorer.stop(); }}>Stop</button>}
        <span className="dg-spacer" />
        <span className="tiny dim">{online ? `on ${iface}` : "device not connected — showing what is on file"}</span>
      </div>

      <WriteConfirmModal target={p.demo ? "demo" : "vehicle"} pending={write?.pending ?? null} onCancel={() => setWrite(null)} onConfirm={() => { const c = write?.commit; setWrite(null); c?.(); }} />
    </>
  );
}
