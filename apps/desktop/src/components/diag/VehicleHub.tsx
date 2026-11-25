import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { applyCensus, censusInputFor, inventoryFor, lastScanFor, protectedModule, recordScan } from "@ecu/vehicle-db";
import type { SystemScanResult, VehicleModule, VehicleProfile, VehicleScanRecord } from "@ecu/vehicle-db";

import { Api, type DiscoveredModule, type VehicleExplorerEvent } from "../../lib/api";
import { CATEGORY_LABEL, CATEGORY_ORDER, addressedSystems, clean, clearDtcs, readDtcs, scanResult, splitLabel, ymmLabel } from "../../lib/diag";

export { splitLabel };
import { voltageView, voltsText } from "../../lib/voltage";
import { useWorkbench } from "../../lib/workbench";
import type { PendingWrite } from "../../lib/writeActions";
import { WriteConfirmModal } from "../WriteConfirmModal";
import { Icon } from "./icons";
import { LiveMap, useLiveRun } from "./LiveMap";
import { ModuleInventory } from "./ModuleInventory";

/**
 * The vehicle page (B1 layout) — what a scan tool shows once the car is identified:
 *   left column    the vehicle, its VIN and spec, Auto Scan / Fault Scan, its scans;
 *   Systems        counters that double as filters, a tile per system grouped by
 *                  area (faults show their count), then the faults grouped by system;
 *   Modules        this car's module inventory: part numbers, versions, serial numbers;
 *   Live map       while a scan runs: the address search, systems appearing, identities
 *                  filling in — the car being mapped, as it happens;
 *   Service        whole-vehicle actions (read all, erase all, learn all);
 *   History        this car's earlier scans.
 * A car that has been here before opens with its systems and its last scan
 * already on screen — nothing has to be re-discovered to start working.
 */

export type HubTab = "scan" | "units" | "identity" | "service" | "history";
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

type Filter = "all" | "fault" | "clean" | "unread" | "protected";
type Kind = "fault" | "clean" | "unread" | "scanning";

function kindOf(r: RowState | undefined): Kind {
  if (r === "scanning") return "scanning";
  if (!r) return "unread";
  if (r.status === "fault") return "fault";
  if (r.status === "ok") return "clean";
  return "unread";
}

const CHIP: Record<string, { cls: string; text: string }> = {
  ok: { cls: "clean", text: "No faults" },
  no_response: { cls: "unread", text: "No response" },
  unknown: { cls: "warn", text: "Not readable" },
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
  const [busy, setBusy] = useState<null | "auto" | "fault" | "erase" | "learn" | "identify">(null);
  const live = useLiveRun();
  const [showLive, setShowLive] = useState(false);
  const [phase, setPhase] = useState("");
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [write, setWrite] = useState<{ pending: PendingWrite; commit: () => void } | null>(null);
  const [learnAsk, setLearnAsk] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const stop = useRef(false);

  const systems = addressedSystems(profile);
  const last = lastScanFor(profile, vin);
  const lastBy = new Map((last?.systems ?? []).map((s) => [s.moduleId, s]));
  const fresh = Object.keys(rows).length > 0;
  const stateOf = (m: VehicleModule): RowState | undefined => rows[m.id] ?? lastBy.get(m.id);
  const shown = systems.map((m) => stateOf(m)).filter((r): r is SystemScanResult => !!r && r !== "scanning");
  const learned = systems.filter((m) => m.explored).length;
  const volt = useWorkbench().voltage;
  const { setModules } = volt;
  // modules that may report their own supply voltage (the main process keeps only the standard OBD addresses)
  const voltSources = systems.filter((m) => !protectedModule({ category: m.category, label: m.label })).map((m) => ({ id: m.id, req: clean(m.addressing?.request), resp: clean(m.addressing?.response) }));
  const voltSig = JSON.stringify(voltSources);
  useEffect(() => { setModules(JSON.parse(voltSig) as typeof voltSources, `${profile.id}|${vin}`); }, [voltSig, profile.id, vin, setModules]);

  async function scan(kind: "auto" | "fault", opts: { fullSearch?: boolean } = {}) {
    if (!online) { setErr("Not connected to the vehicle — connect a device with the pill at the top right, then scan."); return; }
    stop.current = false; setBusy(kind); setErr(null); setNote(null); setRows({});
    if (kind === "auto") { live.reset(); setShowLive(true); }
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
        const firstVisit = !cur.fingerprint || !!opts.fullSearch;
        setPhase(firstVisit ? `${opts.fullSearch ? "Full re-map" : "First scan of this model"}: searching every diagnostic address (about a minute)…` : "Detecting systems on the bus…");
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
        cur = await Api.vehicleExplorer.commitDiscovery({ host, iface, profile: cur, discovered: found });
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
      // Identity of every module that answered: part numbers, versions, serial numbers.
      // Identification reads only (airbag / immobiliser in their current session only).
      if (kind === "auto" && responders && responders.size && !stop.current) {
        const ids = addressedSystems(cur).filter((m) => responders!.has(clean(m.addressing?.response))).map((m) => m.id);
        setPhase(`Reading the identity of ${ids.length} module${ids.length === 1 ? "" : "s"}…`); setProg(null);
        const offId = Api.vehicleExplorer.onEvent((e: VehicleExplorerEvent) => {
          if (e.type === "ident-module" && e.phase === "start") { setPhase(`Identity: ${e.label}`); setProg({ done: e.index, total: e.total }); }
        });
        try {
          const r = await Api.vehicleExplorer.identifyModules({ host, iface, profile: cur, vin: v || undefined, moduleIds: ids, sim: p.simName ?? null });
          cur = r.profile; p.adoptProfile(cur);
        } catch (e) { setNote(`The identity read did not finish (${(e as Error).message}); fault memory is read anyway.`); }
        finally { offId(); }
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
    finally { setBusy(null); setPhase(""); setProg(null); void volt.readNow(); }
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

  async function readIdentity() {
    if (!online) { setErr("Not connected — connect a device with the pill at the top right."); return; }
    stop.current = false; setBusy("identify"); setErr(null); setNote(null);
    live.reset(); setShowLive(true);
    const t0 = Date.now();
    const off = Api.vehicleExplorer.onEvent((e: VehicleExplorerEvent) => {
      if (e.type === "ident-module" && e.phase === "start") { setPhase(`Identity: ${e.label}`); setProg({ done: e.index, total: e.total }); }
    });
    try {
      const r = await Api.vehicleExplorer.identifyModules({ host, iface, profile, vin: vin || undefined, sim: p.simName ?? null });
      p.adoptProfile(r.profile);
      const ok = r.inventory.modules.filter((m) => m.status === "ok").length;
      const serials = r.inventory.modules.filter((m) => m.summary.serial).length;
      setNote(`Identity read in ${Math.round((Date.now() - t0) / 1000)} s — ${ok}/${r.inventory.modules.length} modules identified, ${serials} serial number${serials === 1 ? "" : "s"}.${vin ? " Filed under this car." : " Read the VIN to keep serial numbers per car."}`);
    } catch (e) { setErr((e as Error).message); }
    finally { off(); setBusy(null); setPhase(""); setProg(null); }
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

  const scans = (profile.knownVins?.find((o) => o.vin === vin)?.scans ?? []).slice().reverse();
  const unit = profile.knownVins?.find((o) => o.vin === vin);
  const prot = (m: VehicleModule) => !!protectedModule({ category: m.category, label: m.label });

  const kinds = new Map(systems.map((m) => [m.id, kindOf(stateOf(m))]));
  const count = (k: Kind) => systems.filter((m) => kinds.get(m.id) === k).length;
  const faultSystems = systems.filter((m) => kinds.get(m.id) === "fault");
  const codeCount = faultSystems.reduce((n, m) => n + (stateOf(m) as SystemScanResult).dtcs.length, 0);
  const protCount = systems.filter(prot).length;
  const visible = (m: VehicleModule) =>
    filter === "all" ? true
    : filter === "protected" ? prot(m)
    : filter === "unread" ? kinds.get(m.id) === "unread" || kinds.get(m.id) === "scanning"
    : kinds.get(m.id) === filter;
  const bus = profile.buses[0];
  const view = tab === "units" ? "scan" : tab;
  const scanning = !!busy && busy !== "erase";

  const tile = (m: VehicleModule) => {
    const r = stateOf(m);
    const k = kinds.get(m.id)!;
    const { short, name } = splitLabel(m.label);
    const chip = r === "scanning" ? { cls: "info", text: "Reading…" }
      : !r ? { cls: "unread", text: "Not scanned" }
      : r.status === "fault" ? { cls: "fault", text: "Faults" }
      : CHIP[r.status] ?? { cls: "unread", text: r.status };
    const guard = protectedModule({ category: m.category, label: m.label });
    return (
      <button key={m.id} className={`ual-tile ${k === "fault" ? "fault" : ""} ${r && r !== "scanning" && r.status === "no_response" ? "quiet" : ""}`}
        onClick={() => p.onEnter(m.id)} title={`${m.label} — open this system`}>
        <span className="top">
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span className="short">{short}</span>
            <span className="name" style={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{name}</span>
          </span>
          {k === "fault" && r && r !== "scanning" && <span className="big">{r.dtcs.length}</span>}
        </span>
        <span className="foot">
          <span className={`ual-chip ${chip.cls}`}>{chip.text}</span>
          {guard && <span className="dg-tile-lock" title={guard.reason}><Icon name="shield" size={13} />protected</span>}
          <span className="addr">{m.addressing?.request ?? "?"}</span>
        </span>
      </button>
    );
  };

  const counter = (f: Filter, n: number, label: string, cls: string) => (
    <button key={f} className={`ual-counter ${cls} ${filter === f ? "on" : ""}`} aria-pressed={filter === f}
      onClick={() => setFilter(filter === f && f !== "all" ? "all" : f)}>
      <b>{n}</b><span>{label}</span>
    </button>
  );

  return (
    <div className="dg-hub">
      <aside className="dg-hub-aside">
        <section className="ual-card pad">
          <span className="ual-eyebrow">{p.demo ? "Simulated vehicle" : "Vehicle on the bus"}</span>
          <h1 className="ual-h1">{ymmLabel(profile)}</h1>
          {profile.trim && <span className="ual-muted" style={{ marginTop: -8 }}>{profile.trim}</span>}
          <span className="ual-vin">{vin || "VIN not read yet"}</span>
          <dl className="ual-dl">
            {profile.decoded?.engine && <><dt>Engine</dt><dd>{profile.decoded.engine}</dd></>}
            {profile.decoded?.bodyClass && <><dt>Body</dt><dd>{profile.decoded.bodyClass}</dd></>}
            {profile.decoded?.driveType && <><dt>Drive</dt><dd>{profile.decoded.driveType}</dd></>}
            {bus && <><dt>Bus</dt><dd>{bus.label}{bus.bitrate ? ` ${Math.round(bus.bitrate / 1000)}k` : ""}{bus.obdPins ? ` · pins ${bus.obdPins}` : ""}</dd></>}
            {online && volt.reading?.volts != null && (() => { const w = voltageView(volt.reading.volts, volt.reading.rpm); return (
              <><dt>Voltage</dt><dd title={w.hint}><span className={`ual-chip strong ${w.level === "ok" ? "clean" : w.level === "warn" ? "warn" : w.level === "low" ? "fault" : "info"}`}>{voltsText(volt.reading.volts)}</span> {w.what}{volt.status ? " · not current" : ""}</dd></>
            ); })()}
            <dt>Systems</dt><dd>{systems.length} · {learned} learned</dd>
            {unit && <><dt>Seen</dt><dd>{unit.reads}× since {new Date(unit.firstReadAt).toLocaleDateString()}</dd></>}
          </dl>
          <button className="primary big" disabled={!!busy} onClick={() => { p.onTab("scan"); void scan("auto"); }}>Auto Scan</button>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
            <button disabled={!!busy || systems.length === 0} onClick={() => { p.onTab("scan"); void scan("fault"); }}>Fault Scan</button>
            <button disabled={!!busy} onClick={() => { p.onTab("scan"); quickErase(); }} title="Clears fault memory — the device refuses it while it is read-only">Erase codes…</button>
          </div>
          {scanning && <button className="danger" onClick={() => { stop.current = true; void Api.vehicleExplorer.stop(); }}>Stop</button>}
          <span className="ual-muted" style={{ fontSize: 12 }}>{online ? `${p.demo ? "Desk simulator" : "Device"} · ${iface}` : "No device connected — showing what is on file"}</span>
        </section>

        <section className="ual-card pad" style={{ gap: 8 }}>
          <span className="ual-eyebrow">This car’s scans</span>
          {!vin && <span className="ual-muted" style={{ fontSize: 13 }}>Kept per car — read the VIN first.</span>}
          {vin && scans.length === 0 && <span className="ual-muted" style={{ fontSize: 13 }}>No scan on file yet.</span>}
          {scans.slice(0, 5).map((s, i) => {
            const n = s.systems.filter((x) => x.status === "fault").reduce((k, x) => k + x.dtcs.length, 0);
            return (
              <button key={s.at + i} className="ghost" onClick={() => p.onTab("history")}
                style={{ display: "flex", justifyContent: "space-between", width: "100%", color: "var(--ual-ink)", fontWeight: 500, padding: "6px 4px", minHeight: 0 }}>
                <span>{new Date(s.at).toLocaleDateString()} · {s.sim ? "simulator" : "real car"}</span>
                <span style={{ color: n ? "var(--ual-fault)" : "var(--ual-muted)", fontWeight: 600 }}>{n ? `${n} fault${n === 1 ? "" : "s"}` : "no faults"}</span>
              </button>
            );
          })}
        </section>
      </aside>

      <div className="dg-hub-main">
        <div className="dg-seg" role="tablist" aria-label="Vehicle sections">
          {([["scan", "Systems"], ["identity", "Modules & serials"], ["service", "Service"], ["history", `History${scans.length ? ` (${scans.length})` : ""}`]] as [HubTab, string][]).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={view === id} className={view === id ? "on" : ""} onClick={() => p.onTab(id)}>{label}</button>
          ))}
        </div>

        {!vin && <div className="dg-note warn" style={{ margin: 0 }}>VIN not read yet. Auto Scan reads it first and checks it against this selection — if the car turns out to be a different model, it switches.</div>}
        {err && <div className="dg-note err" style={{ margin: 0 }}>{err}</div>}
        {note && <div className="dg-note" style={{ margin: 0 }}>{note}</div>}
        {busy && (
          <div className="ual-card pad" style={{ gap: 10 }}>
            <span style={{ fontWeight: 600 }}>{phase || "Working…"}</span>
            {prog && <div className="ual-progress"><i style={{ width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%` }} /></div>}
          </div>
        )}
        {(showLive || (busy === "auto" || busy === "identify")) && (
          <LiveMap run={live.run} carVin={vin || undefined} busy={busy === "auto" || busy === "identify"} onClose={() => setShowLive(false)} />
        )}

        {view === "scan" && (
          <>
            {systems.length > 0 && (
              <div className="ual-counters" role="group" aria-label="Filter systems">
                {counter("all", systems.length, "all systems", "")}
                {counter("fault", codeCount, `fault${codeCount === 1 ? "" : "s"} in ${faultSystems.length} system${faultSystems.length === 1 ? "" : "s"}`, codeCount ? "fault" : "")}
                {counter("clean", count("clean"), "clean", "clean")}
                {counter("unread", count("unread") + count("scanning"), "not read yet", "unread")}
                {protCount > 0 && counter("protected", protCount, "protected", "protected")}
              </div>
            )}
            <span className="ual-muted" style={{ fontSize: 13 }}>
              {systems.length === 0 ? "No systems known for this vehicle yet."
                : fresh ? `This scan: ${summary(shown)}`
                : last ? `Showing this car’s last scan (${new Date(last.at).toLocaleString()}): ${summary(last.systems)}`
                : `${systems.length} systems on file for this model — not scanned on this car yet.`}
            </span>
            {systems.length === 0 && <div className="dg-empty">Press <b>Auto Scan</b>: it probes every diagnostic address, reads what each system says it is, names them, and reads their fault memory. The result is saved — the next {ymmLabel(profile)} opens with all of it.</div>}
            {CATEGORY_ORDER.filter((c) => systems.some((m) => m.category === c && visible(m))).map((c) => {
              const list = systems.filter((m) => m.category === c && visible(m));
              return (
                <section key={c} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <h2 className="ual-group-title">{CATEGORY_LABEL[c]} <span style={{ fontWeight: 500 }}>· {list.length}</span></h2>
                  <div className="ual-grid-auto">{list.map(tile)}</div>
                </section>
              );
            })}

            {faultSystems.length > 0 && (filter === "all" || filter === "fault") && (
              <section className="ual-card dg-faults">
                <div className="dg-faults-head">
                  <h2 className="ual-h2">Faults</h2>
                  <span className="ual-muted" style={{ fontSize: 13 }}>confirmed or pending · history-only records are not counted</span>
                </div>
                {faultSystems.map((m) => {
                  const r = stateOf(m) as SystemScanResult;
                  const { short, name } = splitLabel(m.label);
                  return (
                    <div key={m.id}>
                      <button className="dg-fgroup ghost" onClick={() => p.onEnter(m.id)}
                        style={{ width: "100%", borderRadius: 0, border: "none", borderTop: "1px solid #eeefea", color: "var(--ual-ink)", fontWeight: 400, minHeight: 0, padding: "10px 20px" }}>
                        <b>{short}</b>
                        <span className="ual-muted">{[name, m.identity?.supplier].filter(Boolean).join(" · ")}</span>
                        <span className="ual-chip fault" style={{ marginLeft: "auto", fontWeight: 700 }}>{r.dtcs.length}</span>
                      </button>
                      {r.dtcs.map((d, k) => (
                        <div className="dg-fline" key={k}>
                          <span className="c">{d.code}</span>
                          <span style={{ color: d.description ? "var(--ual-ink)" : "var(--ual-muted)" }}>{d.description || "No description on file yet — maker-specific code"}</span>
                          <span className="s">{d.status}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </section>
            )}
          </>
        )}

        {view === "identity" && (
          <ModuleInventory
            inventory={inventoryFor(profile, vin)}
            changes={unit?.inventoryChanges ?? []}
            carVin={vin || undefined}
            busy={!!busy}
            canRead={online}
            onRead={() => void readIdentity()}
            voltage={online ? volt.byModule : {}}
          />
        )}

        {view === "service" && (
          <>
            <div className="dg-tiles" style={{ margin: 0 }}>
              <button className="dg-tile" disabled={!!busy} onClick={() => { p.onTab("scan"); void scan("fault"); }}>
                <span className="ico"><Icon name="alert" size={22} /></span><span className="t">Read all codes</span><span className="d">Ask every known system for its fault codes (no re-detection — fast).</span>
              </button>
              <button className="dg-tile" disabled={!!busy} onClick={() => { p.onTab("scan"); quickErase(); }}>
                <span className="ico"><Icon name="broom" size={22} /></span><span className="t">Erase all codes</span><span className="d">Clear the fault memory of every system that reports a fault. Confirms first; the device refuses it while it is read-only.</span>
              </button>
              <button className="dg-tile" disabled={!!busy} onClick={() => { p.onTab("scan"); void scan("auto", { fullSearch: true }); }}>
                <span className="ico"><Icon name="car" size={22} /></span><span className="t">Full re-map</span><span className="d">Search every diagnostic address again (about a minute, tester-present only), identify every module, read every fault memory — watch it on the live map.</span>
              </button>
              <button className="dg-tile" disabled={!!busy} onClick={() => { p.onTab("identity"); void readIdentity(); }}>
                <span className="ico"><Icon name="id" size={22} /></span><span className="t">Read identity</span><span className="d">Part numbers, software and hardware versions, serial numbers and the VIN of every module. Identification reads only.</span>
              </button>
              <button className="dg-tile" disabled={!!busy} onClick={() => setLearnAsk(true)}>
                <span className="ico"><Icon name="spark" size={22} /></span><span className="t">Learn all systems</span><span className="d">The AI explores every system not learned yet, read-only, and saves what each can do. Airbag and immobiliser are left out.</span>
                <span className="cnt">{learned}/{systems.length} learned</span>
              </button>
            </div>
            {learnAsk && (
              <div className="dg-note warn" style={{ margin: 0 }}>
                Learn {systems.filter((m) => !m.explored).length} system(s) now? Each takes 3–5 minutes and one AI session on your API key; the car must stay connected with the ignition on.
                <span style={{ marginLeft: 10, display: "inline-flex", gap: 8 }}><button className="primary tiny" onClick={() => void learnAll()}>Start</button><button className="tiny" onClick={() => setLearnAsk(false)}>Cancel</button></span>
              </div>
            )}
            <div className="dg-note" style={{ margin: 0 }}>Service resets (oil life, electronic parking brake, steering-angle calibration, battery registration…) are maker-specific routines. None is mapped for this vehicle yet, so none is offered here — a routine you know can be started from a system’s <b>Special Functions</b>.</div>
          </>
        )}

        {view === "history" && (
          <div className="dg-history">
            {!vin && <div className="dg-empty">History is kept per car (VIN). Read the VIN first.</div>}
            {vin && scans.length === 0 && <div className="dg-empty">No scan on file for this car yet.</div>}
            {scans.map((s, i) => (
              <div className="dg-panel" key={s.at + i}>
                <div className="row spread">
                  <b>{new Date(s.at).toLocaleString()}</b>
                  <span className="ual-muted" style={{ fontSize: 12 }}>{s.sim ? <span className="dg-chip demo" style={{ marginRight: 8 }}>SIMULATOR</span> : null}{s.kind === "auto" ? "Auto Scan" : "Fault scan"}{s.durationMs ? ` · ${Math.round(s.durationMs / 1000)} s` : ""}{s.iface ? ` · ${s.iface}` : ""}</span>
                </div>
                <div className="ual-muted" style={{ fontSize: 13, margin: "4px 0 6px" }}>{summary(s.systems)}</div>
                {s.systems.filter((x) => x.status === "fault").map((x) => (
                  <div key={x.moduleId} style={{ marginTop: 6 }}>
                    <b>{splitLabel(x.label).short}</b> <span className="ual-muted" style={{ fontSize: 12 }}>{splitLabel(x.label).name} · {x.responseId}</span>
                    {x.dtcs.map((d, k) => (
                      <div className="dg-fline" key={k} style={{ padding: "6px 0" }}>
                        <span className="c">{d.code}</span>
                        <span>{d.description || <span className="ual-muted">no description on file</span>}</span>
                        <span className="s">{d.status}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <WriteConfirmModal target={p.demo ? "demo" : "vehicle"} pending={write?.pending ?? null} onCancel={() => setWrite(null)} onConfirm={() => { const c = write?.commit; setWrite(null); c?.(); }} />
    </div>
  );
}
