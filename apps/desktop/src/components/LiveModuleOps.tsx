import { useEffect, useRef, useState } from "react";

import { CAPABILITY_CATALOG, appendOpLog, type VehicleProfile, type VehicleModule, type ModuleOpLog } from "@ecu/vehicle-db";

import { Api } from "../lib/api";
import { parseUdsDtcsFromHex, parseObdDtcsFromHex, identifierAscii, decodeObdPid, type DtcRow } from "../lib/uds";
import type { PendingWrite } from "../lib/writeActions";
import { WriteConfirmModal } from "./WriteConfirmModal";

/**
 * Live Module Ops — READ and WRITE a module on the REAL bus, using what the
 * deep-map learned about it. Reads run freely (identification, DTCs, live data,
 * broadcast, raw requests). Every write (clear DTCs, coding write, routine,
 * ECU reset, security access key) opens WriteConfirmModal first and is sent
 * only on explicit confirmation. Each operation is appended to the module's
 * opsLog on the vehicle profile — the "what actually worked on this car"
 * memory. Flash/memory writes are deliberately NOT here: those are the bench
 * path and go through the Cloning Ceremony.
 */

interface SeqItem { request: string; response?: string; ok?: boolean; negative?: boolean; nrc?: number | null; error?: string }
interface Frame { id: string; dlc: number; bytes: string; count: number; hz: number }

const IDENT_READS = ["22F190", "22F187", "22F18A", "22F195", "22F191", "22F18C", "22F18B", "22F189"];
const IDENT_LABEL: Record<string, string> = {
  F190: "VIN", F187: "Part number", F18A: "Supplier", F195: "Software", F191: "Hardware", F18C: "Serial", F18B: "Build date", F189: "SW version (alt)",
};
const SESSIONS: { id: string; label: string }[] = [
  { id: "", label: "no session opener" }, { id: "1001", label: "10 01 default" }, { id: "1003", label: "10 03 extended" },
  { id: "1002", label: "10 02 programming" }, { id: "1081", label: "10 81 KWP default" }, { id: "10C0", label: "10 C0 KWP rich" },
];
const NRC: Record<number, string> = {
  0x10: "general reject", 0x11: "service not supported", 0x12: "sub-function not supported", 0x13: "wrong length/format",
  0x22: "conditions not correct", 0x24: "request sequence error", 0x31: "request out of range", 0x33: "security access denied",
  0x35: "invalid key", 0x36: "exceeded attempts", 0x37: "required time delay", 0x7E: "sub-function not in active session", 0x7F: "service not in active session",
};

const clean = (h: string) => (h || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
const fmt = (h?: string) => clean(h || "").replace(/(..)/g, "$1 ").trim();
const nrcText = (n?: number | null) => (n == null ? "" : `NRC 0x${n.toString(16).toUpperCase().padStart(2, "0")} ${NRC[n] ?? ""}`.trim());

export function LiveModuleOps({ host, iface, profile, module, onModuleUpdate }: {
  host: string; iface: string; profile: VehicleProfile; module: VehicleModule;
  onModuleUpdate: (m: VehicleModule) => void;
}) {
  const tx = clean(module.addressing?.request ?? "");
  const rx = clean(module.addressing?.response ?? "");
  const ops = new Map((module.explored?.operations ?? []).map((o) => [o.op, o]));
  const defaultSession = module.explored?.sessions?.some((s) => clean(s.id).startsWith("1003")) ? "1003"
    : module.explored?.sessions?.[0] ? clean(module.explored.sessions[0].id).slice(0, 4) : "";

  const [session, setSession] = useState<string>(defaultSession);
  const [busy, setBusy] = useState<string | null>(null);
  const [lines, setLines] = useState<{ t: string; kind: "req" | "ok" | "neg" | "err" | "info"; text: string }[]>([]);
  const [ident, setIdent] = useState<{ did: string; label: string; value: string }[] | null>(null);
  const [dtcs, setDtcs] = useState<DtcRow[] | null>(null);
  const [liveOn, setLiveOn] = useState(false);
  const [live, setLive] = useState<{ id: string; label: string; value: string; raw: string }[]>([]);
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [raw, setRaw] = useState("3E 00");
  const [did, setDid] = useState("");
  const [didData, setDidData] = useState("");
  const [rid, setRid] = useState("");
  const [ridData, setRidData] = useState("");
  const [key, setKey] = useState("");
  const [seed, setSeed] = useState<string | null>(null);
  const [op, setOp] = useState<{ pending: PendingWrite; commit: () => void } | null>(null);
  const liveTimer = useRef<number | null>(null);
  const moduleRef = useRef(module);
  moduleRef.current = module;

  const log = (kind: "req" | "ok" | "neg" | "err" | "info", text: string) =>
    setLines((l) => [...l.slice(-120), { t: new Date().toLocaleTimeString(), kind, text }]);

  async function seq(requests: string[]): Promise<SeqItem[]> {
    const reqs = requests.map(clean).filter(Boolean);
    const r = await Api.superDevice.post<{ ok: boolean; results?: SeqItem[]; error?: string }>(
      host, "/api/isotp/seq", { iface, tx, rx, requests: reqs, timeout: 2.0 },
    );
    if (!r.ok && !r.results) throw new Error(r.error || "device error");
    return r.results ?? [];
  }
  const withSession = (reqs: string[]) => (session ? [session, ...reqs] : reqs);

  function record(kind: "read" | "write", label: string, items: SeqItem[]) {
    const last = items[items.length - 1];
    if (!last) return;
    const entry: ModuleOpLog = {
      at: new Date().toISOString(), kind, label,
      request: fmt(last.request), response: last.response ? fmt(last.response) : undefined,
      ok: !!last.response && !last.negative,
      nrc: last.negative && last.nrc != null ? `0x${Number(last.nrc).toString(16).toUpperCase().padStart(2, "0")}` : undefined,
      vin: profile.knownVins?.[0]?.vin,
    };
    onModuleUpdate(appendOpLog(moduleRef.current, entry));
  }

  function logItems(items: SeqItem[]) {
    for (const it of items) {
      if (it.error) log("err", `${fmt(it.request)} → ${it.error}`);
      else if (!it.response) log("err", `${fmt(it.request)} → no response`);
      else if (it.negative) log("neg", `${fmt(it.request)} → ${fmt(it.response)}  ${nrcText(it.nrc)}`);
      else log("ok", `${fmt(it.request)} → ${fmt(it.response)}`);
    }
  }

  async function run(label: string, kind: "read" | "write", requests: string[], after?: (items: SeqItem[]) => void) {
    setBusy(label);
    try {
      log("req", `${label} on ${tx}→${rx}${session ? ` (session ${fmt(session)})` : ""}`);
      const items = await seq(withSession(requests));
      logItems(items);
      record(kind, label, session ? items.slice(1) : items);
      after?.(session ? items.slice(1) : items);
    } catch (e) { log("err", (e as Error).message); }
    finally { setBusy(null); }
  }

  // ---- READS ----------------------------------------------------------------
  const readIdent = () => {
    const extra = (module.explored?.identification ?? []).map((i) => clean(i.id)).filter((h) => h.length >= 6 && !IDENT_READS.includes(h));
    return run("Read identification", "read", [...IDENT_READS, ...extra], (items) => {
      const rows = items.filter((it) => it.response && !it.negative).map((it) => {
        const d = clean(it.request).slice(2, 6);
        const ascii = identifierAscii(it.response!);
        return { did: d, label: IDENT_LABEL[d] ?? (module.explored?.identification?.find((i) => clean(i.id) === clean(it.request))?.label ?? d), value: ascii || fmt(it.response) };
      });
      setIdent(rows);
    });
  };
  const readDtcs = () => run("Read DTCs", "read", rx === "7E8" ? ["1902FF", "03", "07", "0A"] : ["1902FF"], (items) => {
    const rows: DtcRow[] = [];
    for (const it of items) if (it.response && !it.negative) rows.push(...parseUdsDtcsFromHex(it.response), ...parseObdDtcsFromHex(it.response));
    setDtcs(rows);
  });
  const liveReqs = () => {
    const ids = (module.explored?.liveData ?? []).map((l) => clean(l.id)).filter((h) => h.length >= 4);
    return ids.length ? ids : rx === "7E8" ? ["010C", "010D", "0105", "0104", "0111"] : [];
  };
  async function pollLive() {
    const reqs = liveReqs();
    if (!reqs.length) { log("info", "No live-data blocks known for this module — deep-map it first."); setLiveOn(false); return; }
    try {
      const items = await seq(withSession(reqs));
      const body = session ? items.slice(1) : items;
      setLive(body.map((it) => {
        const id = clean(it.request);
        const label = module.explored?.liveData?.find((l) => clean(l.id) === id)?.label ?? id;
        const dec = it.response && !it.negative ? decodeObdPid(id, it.response) : null;
        const value = it.negative ? nrcText(it.nrc) : !it.response ? "no response" : dec ?? fmt(it.response).slice(0, 60);
        return { id, label, value, raw: it.response ? fmt(it.response) : "" };
      }));
    } catch (e) { log("err", (e as Error).message); setLiveOn(false); }
  }
  useEffect(() => {
    if (!liveOn) { if (liveTimer.current) window.clearInterval(liveTimer.current); liveTimer.current = null; return; }
    void pollLive();
    liveTimer.current = window.setInterval(() => void pollLive(), 1500);
    return () => { if (liveTimer.current) window.clearInterval(liveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveOn, session]);
  useEffect(() => () => { if (liveTimer.current) window.clearInterval(liveTimer.current); }, []);

  async function readBroadcast() {
    setBusy("broadcast");
    try {
      const r = await Api.superDevice.get<{ ok: boolean; frames?: Frame[] }>(host, `/api/bus/monitor?iface=${encodeURIComponent(iface)}&ms=800`);
      setFrames(r.frames ?? []);
      log("info", `bus monitor: ${(r.frames ?? []).length} id(s) in 800 ms`);
    } catch (e) { log("err", (e as Error).message); }
    finally { setBusy(null); }
  }
  const sendRaw = () => { const h = clean(raw); if (h) void run(`Raw ${fmt(h)}`, h.startsWith("22") || h.startsWith("19") || h.startsWith("01") || h.startsWith("09") || h.startsWith("21") || h.startsWith("3E") || h.startsWith("10") ? "read" : "write", [h]); };

  // ---- WRITES (confirm first) ----------------------------------------------
  const confirmThen = (pending: PendingWrite, requests: string[], label: string, after?: (items: SeqItem[]) => void) =>
    setOp({ pending, commit: () => void run(label, "write", requests, after) });

  const clearDtcs = () => confirmThen(
    { moduleLabel: module.label, label: "Clear DTCs", request: "14 FF FF FF", kind: "clear", risk: "write", note: "Sent to the REAL module over the bus. Active faults will re-set on their own." },
    ["14FFFFFF"], "Clear DTCs", () => setDtcs(null),
  );
  const writeDid = () => {
    const d = clean(did), v = clean(didData);
    if (d.length !== 4 || !v) { log("err", "Write DID needs a 4-hex DID and a data payload."); return; }
    confirmThen(
      { moduleLabel: module.label, label: `Write DID ${d} = ${fmt(v)}`, request: `2E ${fmt(d)} ${fmt(v)}`, kind: "coding", risk: "write", note: "WriteDataByIdentifier on the REAL module. Most ECUs require security access first (NRC 0x33 if not)." },
      [`2E${d}${v}`], `Write DID ${d}`,
    );
  };
  const routine = () => {
    const r = clean(rid), v = clean(ridData);
    if (r.length !== 4) { log("err", "Routine needs a 4-hex routine id."); return; }
    confirmThen(
      { moduleLabel: module.label, label: `Start routine ${r}`, request: `31 01 ${fmt(r)}${v ? " " + fmt(v) : ""}`, kind: "routine", risk: "write", note: "RoutineControl start on the REAL module — resets/calibrations/self-tests run for real." },
      [`3101${r}${v}`], `Routine ${r}`,
    );
  };
  const ecuReset = () => confirmThen(
    { moduleLabel: module.label, label: "ECU hard reset", request: "11 01", kind: "reset", risk: "caution", note: "Reboots the REAL module. It drops off the bus for a moment; the session is lost." },
    ["1101"], "ECU reset",
  );
  const requestSeed = () => run("Security access · request seed", "read", ["2701"], (items) => {
    const it = items[items.length - 1];
    if (it?.response && !it.negative) { setSeed(fmt(it.response).slice(6)); log("info", "Seed received — compute the key with the OEM algorithm and send it below."); }
    else setSeed(null);
  });
  const sendKey = () => {
    const k = clean(key);
    if (!k) { log("err", "Enter the computed key bytes."); return; }
    confirmThen(
      { moduleLabel: module.label, label: "Security access · send key", request: `27 02 ${fmt(k)}`, kind: "security", risk: "caution", note: "Unlocks protected services on the REAL module for this session. A wrong key counts toward the ECU's attempt limit." },
      ["2701", `2702${k}`], "Security key", () => setSeed(null),
    );
  };

  const status = (opId: string) => ops.get(opId)?.status ?? "unknown";
  const badge = (opId: string) => {
    const s = status(opId);
    return <span className={`badge ${s === "supported" ? "ok" : s === "gated" ? "warn" : ""}`} title={ops.get(opId)?.detail}>{s === "supported" ? "yes" : s === "gated" ? "gated" : s === "unsupported" ? "no" : "?"}</span>;
  };
  const label = (opId: string) => CAPABILITY_CATALOG.find((c) => c.id === opId)?.label ?? opId;

  if (!tx || !rx) return <p className="tiny dim">No addressing for this module yet — discover first.</p>;

  return (
    <div className="lmo">
      <style>{styles}</style>
      <div className="row lmo-top">
        <span className="tiny"><b className="mono">{tx}→{rx}</b> on <span className="mono">{iface}</span></span>
        <label className="tiny dim">Session
          <select value={session} onChange={(e) => setSession(e.target.value)} className="lmo-sel">
            {SESSIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            {(module.explored?.sessions ?? []).filter((s) => !SESSIONS.some((k) => k.id === clean(s.id).slice(0, 4))).map((s) => (
              <option key={s.id} value={clean(s.id).slice(0, 4)}>{fmt(clean(s.id).slice(0, 4))} {s.label}</option>
            ))}
          </select>
        </label>
        {busy && <span className="tiny warn">● {busy}…</span>}
      </div>

      <div className="lmo-grid">
        <div className="lmo-col">
          <div className="lmo-h tiny">READ</div>
          <div className="lmo-ops">
            <button className="tiny" disabled={!!busy} onClick={() => void readIdent()}>{badge("read_identification")} {label("read_identification")}</button>
            <button className="tiny" disabled={!!busy} onClick={() => void readDtcs()}>{badge("read_dtcs")} {label("read_dtcs")}</button>
            <button className={`tiny ${liveOn ? "primary" : ""}`} disabled={!!busy && !liveOn} onClick={() => setLiveOn((v) => !v)}>{badge("read_live_data")} {liveOn ? "■ Stop live data" : `${label("read_live_data")} ▶`}</button>
            <button className="tiny" disabled={!!busy} onClick={() => void readBroadcast()}>{badge("read_broadcast")} {label("read_broadcast")}</button>
          </div>
          {ident && (
            <table className="lmo-tbl tiny"><tbody>
              {ident.length === 0 && <tr><td className="dim">no identification records answered</td></tr>}
              {ident.map((r) => <tr key={r.did}><td className="dim">{r.label}</td><td className="mono">{r.value}</td></tr>)}
            </tbody></table>
          )}
          {dtcs && (
            <table className="lmo-tbl tiny"><tbody>
              {dtcs.length === 0 && <tr><td className="ok">no fault codes stored</td></tr>}
              {dtcs.map((d, i) => <tr key={i}><td className="mono"><b>{d.code}</b></td><td>{d.description}</td><td className="dim">{d.status}</td></tr>)}
            </tbody></table>
          )}
          {liveOn && (
            <table className="lmo-tbl tiny"><tbody>
              {live.map((l) => <tr key={l.id}><td className="dim">{l.label}</td><td className="mono">{l.value}</td></tr>)}
              {!live.length && <tr><td className="dim">polling…</td></tr>}
            </tbody></table>
          )}
          {frames && (
            <table className="lmo-tbl tiny mono"><tbody>
              {frames.length === 0 && <tr><td className="dim">bus quiet</td></tr>}
              {frames.slice(0, 24).map((f) => <tr key={f.id}><td><b>{f.id}</b></td><td>{f.bytes}</td><td className="dim">{f.hz} Hz</td></tr>)}
            </tbody></table>
          )}
        </div>

        <div className="lmo-col">
          <div className="lmo-h tiny">WRITE <span className="dim">— every action confirms first</span></div>
          <div className="lmo-ops">
            <button className="tiny" disabled={!!busy} onClick={clearDtcs}>{badge("clear_dtcs")} ⚠ {label("clear_dtcs")}…</button>
            <button className="tiny" disabled={!!busy} onClick={ecuReset}>{badge("ecu_reset")} ⚠ {label("ecu_reset")}…</button>
          </div>
          <div className="lmo-row tiny">
            {badge("security_access")} <span>{label("security_access")}</span>
            <button className="tiny" disabled={!!busy} onClick={() => void requestSeed()}>Request seed</button>
            {seed && <span className="mono dim">seed {seed}</span>}
            <input className="lmo-in mono" placeholder="key hex" value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="tiny" disabled={!!busy} onClick={sendKey}>⚠ Send key…</button>
          </div>
          <div className="lmo-row tiny">
            {badge("coding_adaptation")} <span>{label("coding_adaptation")}</span>
            <input className="lmo-in mono" style={{ width: 64 }} placeholder="DID" value={did} onChange={(e) => setDid(e.target.value)} />
            <input className="lmo-in mono" placeholder="data hex" value={didData} onChange={(e) => setDidData(e.target.value)} />
            <button className="tiny" disabled={!!busy} onClick={writeDid}>⚠ Write DID…</button>
          </div>
          <div className="lmo-row tiny">
            {badge("routine_control")} <span>{label("routine_control")}</span>
            <input className="lmo-in mono" style={{ width: 64 }} placeholder="RID" value={rid} onChange={(e) => setRid(e.target.value)} />
            <input className="lmo-in mono" placeholder="data (opt)" value={ridData} onChange={(e) => setRidData(e.target.value)} />
            <button className="tiny" disabled={!!busy} onClick={routine}>⚠ Start routine…</button>
          </div>
          <div className="lmo-row tiny dim">
            {badge("flash_write")} <span>{label("flash_write")}</span> <span>— bench path only (Read → Dumps → Cloning Ceremony), never over the cockpit.</span>
          </div>
          <div className="lmo-row tiny">
            <span className="dim">Raw</span>
            <input className="lmo-in mono" style={{ flex: 1 }} value={raw} onChange={(e) => setRaw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendRaw(); }} />
            <button className="tiny" disabled={!!busy} onClick={sendRaw}>Send</button>
          </div>
        </div>
      </div>

      {lines.length > 0 && (
        <div className="lmo-log mono">
          {lines.map((l, i) => <div key={i} className={`lmo-${l.kind}`}><span className="dim">{l.t}</span> {l.text}</div>)}
        </div>
      )}
      {(module.opsLog?.length ?? 0) > 0 && (
        <div className="tiny dim" style={{ marginTop: 6 }}>
          {module.opsLog!.length} operation(s) remembered on this module · last: {module.opsLog![module.opsLog!.length - 1].label} {module.opsLog![module.opsLog!.length - 1].ok ? "✓" : "✗"}
        </div>
      )}

      <WriteConfirmModal pending={op?.pending ?? null} onCancel={() => setOp(null)} onConfirm={() => { const c = op?.commit; setOp(null); c?.(); }} />
    </div>
  );
}

const styles = `
.lmo { margin-top: 8px; }
.lmo-top { gap: 12px; align-items: center; flex-wrap: wrap; }
.lmo-sel { margin-left: 6px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; color: var(--fg-0); padding: 3px 6px; font-size: 11.5px; }
.lmo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
@media (max-width: 1100px) { .lmo-grid { grid-template-columns: 1fr; } }
.lmo-col { background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.lmo-h { font-weight: 700; letter-spacing: .06em; margin-bottom: 6px; }
.lmo-ops { display: flex; flex-wrap: wrap; gap: 6px; }
.lmo-ops button .badge { margin-right: 4px; }
.lmo-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.lmo-in { background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; color: var(--fg-0); padding: 3px 6px; font-size: 11.5px; width: 120px; }
.lmo-tbl { width: 100%; margin-top: 6px; border-collapse: collapse; }
.lmo-tbl td { padding: 2px 6px; border-top: 1px solid var(--border); vertical-align: top; }
.lmo-log { margin-top: 8px; max-height: 180px; overflow-y: auto; background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 11px; line-height: 1.5; }
.lmo-req { color: var(--fg-1); font-weight: 600; } .lmo-ok { color: var(--accent); } .lmo-neg { color: var(--warn); } .lmo-err { color: var(--danger); } .lmo-info { color: var(--fg-2); }
.lmo .ok { color: var(--accent); } .lmo .warn { color: var(--warn); }
`;
