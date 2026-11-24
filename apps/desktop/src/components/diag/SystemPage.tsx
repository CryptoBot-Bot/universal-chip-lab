import { useEffect, useMemo, useRef, useState } from "react";

import type { ScanDtc, SystemScanResult, VehicleModule, VehicleProfile } from "@ecu/vehicle-db";

import { Api, type VehicleExplorerEvent } from "../../lib/api";
import {
  clean, clearDtcs, fmt, isObdEcu, liveItems, nrcText, obdSupportedPids, preferredSession, readDtcs, readIdent, readLive, seq, storedIdent,
  type IdentRow, type LiveItem, type LiveValue,
} from "../../lib/diag";
import type { PendingWrite } from "../../lib/writeActions";
import { LiveModuleOps } from "../LiveModuleOps";
import { WriteConfirmModal } from "../WriteConfirmModal";

/**
 * One system (control unit) of the vehicle — the function menu a scan tool shows
 * after "enter system": ECU Information, Read Codes, Erase Codes, Live Data,
 * Active Test, Special Functions, Coding. Each tile says what the library knows
 * about that function on THIS system (works / locked / refused / not tried yet),
 * and everything the map already holds is shown before the car is asked again.
 * Reads run freely; anything that changes the module goes through the confirm
 * dialog first.
 */

export type FnId = "info" | "codes" | "erase" | "live" | "active" | "special" | "coding" | "learn" | "expert";

interface Props {
  host: string; iface: string; online: boolean; demo: boolean;
  profile: VehicleProfile; module: VehicleModule; vin: string;
  fn: FnId | null; onFn: (f: FnId | null) => void;
  last?: SystemScanResult;                        // this system in the unit's last scan
  onModuleUpdate: (m: VehicleModule) => void;     // opsLog etc. — saved by the parent
  onProfile: (p: VehicleProfile) => void;         // a profile that is already saved (AI map)
  onCodes: (r: SystemScanResult) => void;         // fresh fault read, for the scan list
}

const FNS: { id: FnId; ico: string; title: string; blurb: string; op?: string; write?: boolean }[] = [
  { id: "info", ico: "🪪", title: "ECU Information", blurb: "Part number, software, hardware, serial, VIN as this unit holds them.", op: "read_identification" },
  { id: "codes", ico: "⚠️", title: "Read Codes", blurb: "Stored, pending and permanent fault codes.", op: "read_dtcs" },
  { id: "erase", ico: "🧹", title: "Erase Codes", blurb: "Clear this system's fault memory.", op: "clear_dtcs", write: true },
  { id: "live", ico: "📈", title: "Live Data", blurb: "Measured values, read continuously.", op: "read_live_data" },
  { id: "active", ico: "🔧", title: "Active Test", blurb: "Drive an output to check it (relay, valve, motor).", op: "actuator_test", write: true },
  { id: "special", ico: "⭐", title: "Special Functions", blurb: "Resets, calibrations and service routines.", op: "routine_control", write: true },
  { id: "coding", ico: "🧬", title: "Coding", blurb: "Configuration and adaptation values.", op: "coding_adaptation", write: true },
  { id: "learn", ico: "🧠", title: "Learn this system", blurb: "The AI explores it live, read-only, and saves everything it finds." },
  { id: "expert", ico: "⌨️", title: "Expert console", blurb: "Raw requests, sessions, security access." },
];

const TAG: Record<string, { cls: string; text: string }> = {
  supported: { cls: "yes", text: "works on this system" },
  gated: { cls: "gated", text: "locked — needs session / security" },
  unsupported: { cls: "no", text: "refused by this system" },
  unknown: { cls: "", text: "not tried yet" },
};

export function SystemPage(p: Props) {
  const { host, iface, online, profile, module: mod, fn } = p;
  const ops = useMemo(() => new Map((mod.explored?.operations ?? []).map((o) => [o.op, o])), [mod.explored]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [write, setWrite] = useState<{ pending: PendingWrite; commit: () => void } | null>(null);
  const moduleRef = useRef(mod); moduleRef.current = mod;

  // ---- ECU information ----
  const stored = useMemo(() => storedIdent(mod), [mod]);
  const [ident, setIdent] = useState<IdentRow[] | null>(null);
  // ---- codes ----
  const [codes, setCodes] = useState<{ status: SystemScanResult["status"]; dtcs: ScanDtc[]; note?: string; at: string } | null>(null);
  const [eraseMsg, setEraseMsg] = useState<string | null>(null);
  // ---- live ----
  // An emissions ECU is asked which standard PIDs it supports, so Live Data offers
  // everything this car has (55 on a 2015 Sprinter), not a fixed starter set.
  const [obdPids, setObdPids] = useState<number[] | undefined>(undefined);
  useEffect(() => {
    setObdPids(undefined);
    if (!online || !isObdEcu(mod)) return;
    let live = true;
    obdSupportedPids(host, iface, mod).then((p) => { if (live) setObdPids(p); }).catch(() => { /* keep the starter set */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.id, online, host, iface]);
  const items = useMemo(() => liveItems(mod, obdPids), [mod, obdPids]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [liveOn, setLiveOn] = useState(false);
  const [values, setValues] = useState<Map<string, LiveValue>>(new Map());
  // ---- manual write forms ----
  const [did, setDid] = useState(""); const [data, setData] = useState(""); const [ctl, setCtl] = useState("03");
  const [rid, setRid] = useState(""); const [ridData, setRidData] = useState("");
  const [writeLog, setWriteLog] = useState<string[]>([]);
  // ---- learn ----
  const [feed, setFeed] = useState<string[]>([]);

  useEffect(() => { setIdent(null); setCodes(null); setEraseMsg(null); setLiveOn(false); setValues(new Map()); setFeed([]); setWriteLog([]); setErr(null); }, [mod.id]);
  useEffect(() => { setPicked(new Set(items.slice(0, 16).map((i) => i.key))); }, [items]);

  const guard = async (label: string, work: () => Promise<void>) => {
    if (!online) { setErr("Not connected to the vehicle — connect the device (top right) to run this."); return; }
    setBusy(label); setErr(null);
    try { await work(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const doIdent = () => guard("Reading ECU information", async () => { setIdent(await readIdent(host, iface, mod)); });
  const doCodes = () => guard("Reading codes", async () => {
    const r = await readDtcs(host, iface, mod);
    setCodes({ ...r, at: new Date().toISOString() });
    p.onCodes({ moduleId: mod.id, label: mod.label, requestId: mod.addressing?.request, responseId: clean(mod.addressing?.response), status: r.status, dtcs: r.dtcs, note: r.note });
  });
  const doErase = () => setWrite({
    pending: { moduleLabel: mod.label, label: "Erase fault codes", request: "14 FF FF FF", kind: "clear", risk: "write", note: "Clears this system's fault memory on the REAL module. A fault that is still present sets again by itself." },
    commit: () => void guard("Erasing codes", async () => {
      const r = await clearDtcs(host, iface, mod);
      setEraseMsg(r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`);
      const again = await readDtcs(host, iface, mod);
      setCodes({ ...again, at: new Date().toISOString() });
      p.onCodes({ moduleId: mod.id, label: mod.label, requestId: mod.addressing?.request, responseId: clean(mod.addressing?.response), status: again.status, dtcs: again.dtcs, note: again.note });
    }),
  });

  // live polling
  useEffect(() => {
    if (!liveOn || !online) return;
    let stop = false; let running = false;
    const sel = items.filter((i) => picked.has(i.key));
    const tick = async () => {
      if (running || stop) return;
      running = true;
      try {
        const vals = await readLive(host, iface, mod, sel);
        if (!stop) setValues(new Map(vals.map((v) => [v.key, v])));
      } catch (e) { if (!stop) { setErr((e as Error).message); setLiveOn(false); } }
      finally { running = false; }
    };
    void tick();
    const iv = window.setInterval(() => void tick(), 1000);
    return () => { stop = true; window.clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveOn, online, picked, mod.id, host, iface]);

  /** A hand-entered write: confirm, send in the extended session, show the raw answer. */
  const manualWrite = (label: string, kind: string, request: string, note: string) => {
    if (clean(request).length < 4) { setErr("Fill in the identifier first (hex)."); return; }
    setWrite({
      pending: { moduleLabel: mod.label, label, request: fmt(request), kind, risk: "write", note },
      commit: () => void guard(label, async () => {
        const session = preferredSession(mod) || "1003";
        const res = await seq(host, iface, mod, [session, request], 3.0);
        const it = res[res.length - 1];
        const line = !it?.response ? (it?.error || "no response") : it.negative ? `refused — ${nrcText(it.nrc)}` : `accepted → ${fmt(it.response)}`;
        setWriteLog((l) => [...l.slice(-20), `${new Date().toLocaleTimeString()}  ${fmt(request)}  →  ${line}`]);
      }),
    });
  };

  const doLearn = () => guard("AI is exploring this system", async () => {
    setFeed([`▶ exploring ${mod.label} — read-only`]);
    const off = Api.vehicleExplorer.onEvent((e: VehicleExplorerEvent) => {
      const push = (s: string) => setFeed((f) => [...f.slice(-200), s]);
      if (e.type === "module-event") {
        const ev = e.event;
        if (ev.type === "thought" && ev.text) push(`· ${ev.text.replace(/\s+/g, " ").slice(0, 200)}`);
        else if (ev.type === "action" && ev.tool !== "record" && ev.tool !== "conclude") push(`→ ${ev.tool}${(ev.input as { purpose?: string })?.purpose ? `: ${(ev.input as { purpose?: string }).purpose}` : ""}`);
        else if (ev.type === "finding") push(`✓ ${ev.kind}: ${ev.title}`);
        else if (ev.type === "error") push(`! ${ev.text}`);
      } else if (e.type === "module-done") {
        const n = (e.result.operations ?? []).filter((o) => o.status === "supported").length;
        push(`■ done — ${n} function(s) confirmed, ${e.result.liveData?.length ?? 0} live value(s), ${e.result.dtcs.length} code(s). Saved.`);
      } else if (e.type === "error") push(`! ${e.text}`);
    });
    try {
      const proto = profile.buses.find((b) => b.id === mod.bus)?.protocol === "K-Line" ? "kwp2000" : "uds";
      const updated = await Api.vehicleExplorer.start({
        host, iface, profile,
        targets: [{ moduleId: mod.id, displayName: mod.label, brand: profile.make, category: mod.category, protocol: proto, requestId: mod.addressing?.request ?? "", responseId: mod.addressing?.response ?? "" }],
      });
      p.onProfile(updated);
    } finally { off(); }
  });

  const tag = (op?: string) => TAG[ops.get(op ?? "")?.status ?? "unknown"];
  const shownCodes = codes ?? (p.last ? { status: p.last.status, dtcs: p.last.dtcs, note: p.last.note, at: "" } : null);
  const x = mod.explored;

  return (
    <>
      <div className="dg-veh">
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="name">{mod.label}</div>
          <div className="meta">{mod.summary || x?.summary || "Not described yet — “Learn this system” fills this in."}</div>
        </div>
        <div className="kv">Address<b>{mod.addressing?.request ?? "?"} → {mod.addressing?.response ?? "?"}</b></div>
        <div className="kv">Part number<b>{mod.identity?.partNo || "—"}</b></div>
        <div className="kv">Supplier<b>{mod.identity?.supplier || "—"}</b></div>
        <div className="kv">Mapped<b>{x ? `${x.runCount}× · ${x.confidence}` : "not yet"}</b></div>
      </div>

      <div className="dg-fns">
        {FNS.map((f) => {
          const t = f.op ? tag(f.op) : null;
          return (
            <button key={f.id} className={`dg-fn ${fn === f.id ? "on" : ""}`} onClick={() => p.onFn(fn === f.id ? null : f.id)}>
              <span className="ico">{f.ico}</span>
              <span className="t">{f.title}</span>
              <span className="d">{f.blurb}</span>
              {t && <span className={`tag ${t.cls}`}>{t.text}</span>}
              {f.id === "learn" && <span className={`tag ${x ? "yes" : ""}`}>{x ? `learned ${x.runCount}× — run again to go deeper` : "not learned yet"}</span>}
            </button>
          );
        })}
      </div>

      {err && <div className="dg-note err">{err}</div>}
      {busy && <div className="dg-note">● {busy}…</div>}

      {fn === "info" && (
        <div className="dg-panel">
          <div className="row spread"><h3>ECU Information</h3><button className="primary" disabled={!!busy} onClick={() => void doIdent()}>Read from vehicle</button></div>
          <table className="dg-tbl"><thead><tr><th>Item</th><th>Value</th><th>Source</th></tr></thead><tbody>
            {(ident ?? stored).map((r) => (
              <tr key={r.key + r.label} className={r.live ? "" : "stale"}><td>{r.label}</td><td className="v">{r.value}</td><td className="dim tiny">{r.live ? "read just now" : "on file"}{r.request ? ` · ${fmt(r.request)}` : ""}</td></tr>
            ))}
            {!(ident ?? stored).length && <tr><td colSpan={3} className="dg-empty">Nothing on file for this system yet. “Read from vehicle” asks it for the standard identification records.</td></tr>}
          </tbody></table>
        </div>
      )}

      {(fn === "codes" || fn === "erase") && (
        <div className="dg-panel">
          <div className="row spread">
            <h3>{fn === "erase" ? "Erase Codes" : "Trouble Codes"}</h3>
            <div className="row">
              <button className={fn === "codes" ? "primary" : ""} disabled={!!busy} onClick={() => void doCodes()}>Read codes</button>
              <button className={fn === "erase" ? "danger" : ""} disabled={!!busy} onClick={doErase}>Erase codes…</button>
            </div>
          </div>
          {eraseMsg && <div className={`dg-note ${eraseMsg.startsWith("✓") ? "ok" : "err"}`}>{eraseMsg}</div>}
          {!shownCodes && <div className="dg-empty">Not read yet on this visit. “Read codes” asks the system for its stored, pending and permanent codes.</div>}
          {shownCodes && (
            <>
              <p className="tiny dim" style={{ margin: "0 0 8px" }}>{codes ? `Read just now (${new Date(codes.at).toLocaleTimeString()})` : "From this car’s last scan — read again for the current state."}{shownCodes.note ? ` · ${shownCodes.note}` : ""}</p>
              {shownCodes.status === "no_response" && <div className="dg-note warn">The system did not answer.</div>}
              {shownCodes.status === "unknown" && <div className="dg-note warn">The system answered but would not report its fault memory{shownCodes.note ? ` (${shownCodes.note})` : ""}.</div>}
              {shownCodes.status === "ok" && <div className="dg-note ok">No fault codes stored.</div>}
              {shownCodes.dtcs.length > 0 && (
                <table className="dg-tbl"><thead><tr><th>Code</th><th>Description</th><th>Status</th></tr></thead><tbody>
                  {shownCodes.dtcs.map((d, i) => <tr key={i}><td className="v bad"><b>{d.code}</b></td><td>{d.description || <span className="dim">no description on file</span>}</td><td className="dim">{d.status}</td></tr>)}
                </tbody></table>
              )}
            </>
          )}
        </div>
      )}

      {fn === "live" && (
        <div className="dg-panel">
          <div className="row spread">
            <h3>Live Data <span className="dim tiny">— {picked.size} of {items.length} selected</span></h3>
            <div className="row">
              <button className="tiny" onClick={() => setPicked(new Set(picked.size ? [] : items.map((i) => i.key)))}>{picked.size ? "Clear selection" : "Select all"}</button>
              <button className={liveOn ? "danger" : "primary"} disabled={!items.length || !picked.size} onClick={() => { if (!online) { setErr("Not connected to the vehicle."); return; } setLiveOn((v) => !v); }}>{liveOn ? "■ Stop" : "▶ Start"}</button>
            </div>
          </div>
          {!items.length && <div className="dg-empty">No live values are known for this system yet. “Learn this system” finds them (it sweeps the data identifiers and keeps the ones that answer).</div>}
          {items.length > 0 && (
            <table className="dg-tbl"><thead><tr><th style={{ width: 28 }}></th><th>Name</th><th>Value</th><th>Request</th></tr></thead><tbody>
              {items.map((it: LiveItem) => {
                const v = values.get(it.key);
                return (
                  <tr key={it.key}>
                    <td><input type="checkbox" checked={picked.has(it.key)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(it.key)) n.delete(it.key); else n.add(it.key); return n; })} /></td>
                    <td>{it.label}{it.note && <div className="tiny dim">{it.note}</div>}</td>
                    <td className={`v ${v && !v.ok ? "warn" : ""}`}>{v ? v.value : liveOn && picked.has(it.key) ? "…" : "—"}</td>
                    <td className="v dim tiny">{it.session ? `${fmt(it.session)} · ` : ""}{fmt(it.request)}</td>
                  </tr>
                );
              })}
            </tbody></table>
          )}
        </div>
      )}

      {(fn === "active" || fn === "special" || fn === "coding") && (
        <div className="dg-panel">
          <h3>{fn === "active" ? "Active Test" : fn === "special" ? "Special Functions" : "Coding"}</h3>
          <div className="dg-note">
            {fn === "active" && <>No actuator tests are mapped for this system yet. An output test cannot be discovered by reading — it has to be known (maker data) or tried. Status on file: <b>{tag("actuator_test").text}</b>.</>}
            {fn === "special" && <>No service routines are mapped for this system yet. Like actuator tests they cannot be found read-only. Status on file: <b>{tag("routine_control").text}</b>.</>}
            {fn === "coding" && <>Coding values this system exposes show up under Live Data once it has been learned (identifiers that hold configuration rather than a measurement). Writing one is below. Status on file: <b>{tag("coding_adaptation").text}</b>.</>}
            {" "}If you know the identifier, you can send it here — it is confirmed first and sent in the extended session.
          </div>
          {fn === "active" && (
            <div className="dg-form">
              <span className="tiny dim">I/O identifier</span><input className="dg-in" style={{ width: 90 }} placeholder="0300" value={did} onChange={(e) => setDid(e.target.value)} />
              <span className="tiny dim">control</span>
              <select className="dg-in" value={ctl} onChange={(e) => setCtl(e.target.value)}><option value="03">03 short-term adjust</option><option value="00">00 return control to ECU</option><option value="02">02 freeze current state</option></select>
              <span className="tiny dim">state (hex)</span><input className="dg-in" style={{ width: 110 }} placeholder="01" value={data} onChange={(e) => setData(e.target.value)} />
              <button disabled={!!busy} onClick={() => manualWrite(`Active test ${clean(did)}`, "actuator", `2F${clean(did)}${ctl}${clean(data)}`, "InputOutputControl on the REAL module: the output moves for real. Keep clear of moving parts; return control to the ECU afterwards.")}>⚠ Run…</button>
            </div>
          )}
          {fn === "special" && (
            <div className="dg-form">
              <span className="tiny dim">Routine identifier</span><input className="dg-in" style={{ width: 90 }} placeholder="FF00" value={rid} onChange={(e) => setRid(e.target.value)} />
              <span className="tiny dim">parameters (hex, optional)</span><input className="dg-in" style={{ width: 160 }} value={ridData} onChange={(e) => setRidData(e.target.value)} />
              <button disabled={!!busy} onClick={() => manualWrite(`Start routine ${clean(rid)}`, "routine", `3101${clean(rid)}${clean(ridData)}`, "RoutineControl start on the REAL module — a reset or calibration runs for real.")}>⚠ Start…</button>
            </div>
          )}
          {fn === "coding" && (
            <div className="dg-form">
              <span className="tiny dim">Identifier</span><input className="dg-in" style={{ width: 90 }} placeholder="0200" value={did} onChange={(e) => setDid(e.target.value)} />
              <span className="tiny dim">new value (hex)</span><input className="dg-in" style={{ width: 200 }} value={data} onChange={(e) => setData(e.target.value)} />
              <button disabled={!!busy} onClick={() => manualWrite(`Write ${clean(did)} = ${fmt(data)}`, "coding", `2E${clean(did)}${clean(data)}`, "WriteDataByIdentifier on the REAL module. Read and note the current value first; most modules want security access before they accept it.")}>⚠ Write…</button>
            </div>
          )}
          {writeLog.length > 0 && <div className="dg-feed">{writeLog.join("\n")}</div>}
        </div>
      )}

      {fn === "learn" && (
        <div className="dg-panel">
          <div className="row spread">
            <h3>Learn this system</h3>
            <div className="row">
              {busy && <button onClick={() => void Api.vehicleExplorer.stop()}>Stop</button>}
              <button className="primary" disabled={!!busy} onClick={() => void doLearn()}>{x ? "Learn more (run again)" : "Start learning"}</button>
            </div>
          </div>
          <p className="tiny dim" style={{ margin: 0 }}>The AI talks to the system live — sessions, identification, a sweep of its data identifiers, fault memory — strictly read-only, for 3–5 minutes (one AI session, billed to your API key). What it confirms is saved to this vehicle and fills the tiles above: next time this model comes in, it is already there.</p>
          {x && <p className="tiny" style={{ margin: "8px 0 0" }}>On file: {(x.identification ?? []).length} identification records · {(x.liveData ?? []).length} live values · {(x.operations ?? []).filter((o) => o.status === "supported").length} functions confirmed · last learned {new Date(x.lastMappedAt).toLocaleString()}</p>}
          {feed.length > 0 && <div className="dg-feed">{feed.join("\n")}</div>}
        </div>
      )}

      {fn === "expert" && (
        <div className="dg-panel">
          <h3>Expert console</h3>
          {online
            ? <LiveModuleOps host={host} iface={iface} profile={profile} module={mod} onModuleUpdate={p.onModuleUpdate} />
            : <div className="dg-empty">Connect the device to use the console.</div>}
        </div>
      )}

      {!fn && <div className="dg-empty">Pick a function above.{p.last ? ` Last scan of this car: ${p.last.status === "fault" ? `${p.last.dtcs.length} fault code(s)` : p.last.status === "ok" ? "no fault" : p.last.status === "no_response" ? "no response" : "fault memory not readable"}.` : ""}</div>}

      <WriteConfirmModal target={p.demo ? "demo" : "vehicle"} pending={write?.pending ?? null} onCancel={() => setWrite(null)} onConfirm={() => { const c = write?.commit; setWrite(null); c?.(); }} />
    </>
  );
}
