import { useEffect, useMemo, useRef, useState } from "react";

import type { IdentRecord, ModuleInventoryEntry } from "@ecu/vehicle-db";

import { Api, type SweepProgress, type VehicleExplorerEvent } from "../../lib/api";
import { splitLabel } from "../../lib/diag";

/**
 * The live map — watch a car being mapped while it happens:
 *   1. the address search: every diagnostic address 0x600–0x7FF as one cell, lit as
 *      the device asks it (blue = a module answered, amber = an ID the car itself
 *      broadcasts on, so it is never sent to);
 *   2. the systems found, appearing as each is confirmed;
 *   3. the identity read: each module's serial / part number / software filling in.
 * It listens to the pipeline's events, so it shows whatever is running — Auto Scan
 * from this page, a deep map, or nothing (then it shows the last run).
 */

interface IdentModule {
  moduleId: string; label: string; requestId: string; responseId: string; protectedKind?: string;
  state: "wait" | "reading" | "done";
  records: IdentRecord[];
  entry?: ModuleInventoryEntry;
}

export interface LiveRun {
  sweep: SweepProgress | null;
  hits: { requestId: string; responseId: string; name: string; serial?: string; partNo?: string }[];
  discover: { done: number; total: number; found: number } | null;
  ident: { total: number; order: string[]; mods: Record<string, IdentModule>; current: string | null } | null;
  identDone: boolean;
}

export const EMPTY_RUN: LiveRun = { sweep: null, hits: [], discover: null, ident: null, identDone: false };

/** Fold one pipeline event into the live run. */
export function reduceRun(run: LiveRun, e: VehicleExplorerEvent): LiveRun {
  switch (e.type) {
    case "sweep-progress": return { ...run, sweep: e.progress };
    case "discover": return { ...run, discover: { done: e.done, total: e.total, found: e.found } };
    case "discover-hit":
      if (run.hits.some((h) => h.responseId === e.responseId)) return run;
      return { ...run, hits: [...run.hits, { requestId: e.requestId, responseId: e.responseId, name: e.name, serial: e.ident?.serial, partNo: e.ident?.partNo }] };
    case "ident-start": {
      const mods: Record<string, IdentModule> = {};
      for (const m of e.modules) mods[m.moduleId] = { ...m, state: "wait", records: [] };
      return { ...run, ident: { total: e.total, order: e.modules.map((m) => m.moduleId), mods, current: null }, identDone: false };
    }
    case "ident-module": {
      if (!run.ident) return run;
      const cur = run.ident.mods[e.moduleId];
      if (!cur) return run;
      const next: IdentModule = e.phase === "start" ? { ...cur, state: "reading" } : { ...cur, state: "done", entry: e.entry };
      return { ...run, ident: { ...run.ident, mods: { ...run.ident.mods, [e.moduleId]: next }, current: e.phase === "start" ? e.moduleId : run.ident.current } };
    }
    case "ident-record": {
      if (!run.ident) return run;
      const cur = run.ident.mods[e.moduleId];
      if (!cur) return run;
      return { ...run, ident: { ...run.ident, mods: { ...run.ident.mods, [e.moduleId]: { ...cur, records: [...cur.records, e.record] } } } };
    }
    case "ident-done": return { ...run, identDone: true, ident: run.ident ? { ...run.ident, current: null } : null };
    default: return run;
  }
}

/** Subscribe to the pipeline's events while `active`; `reset` starts a fresh run. */
export function useLiveRun(): { run: LiveRun; reset: () => void } {
  const [run, setRun] = useState<LiveRun>(EMPTY_RUN);
  useEffect(() => { const off = Api.vehicleExplorer.onEvent((e) => setRun((r) => reduceRun(r, e))); return () => { off(); }; }, []);
  return { run, reset: () => setRun(EMPTY_RUN) };
}

const LO = 0x600, HI = 0x7ff;
const isOwn = (a: number) => a === 0x7df || (a >= 0x7e0 && a <= 0x7ef);

function SweepGrid({ p }: { p: SweepProgress }) {
  const cur = p.current ? parseInt(p.current, 16) : null;
  const hitSet = useMemo(() => new Set((p.hits ?? []).map((h) => parseInt(h.req, 16))), [p.hits]);
  const skipSet = useMemo(() => new Set((p.skipped ?? []).map((h) => parseInt(h, 16))), [p.skipped]);
  const done = p.phase === "done" || p.phase === "confirm";
  const cells = [];
  for (let a = LO; a <= HI; a++) {
    const state = hitSet.has(a) ? "hit" : skipSet.has(a) ? "skip" : isOwn(a) ? "own" : done || (cur !== null && a < cur) ? "asked" : cur === a ? "now" : "todo";
    cells.push(<i key={a} className={`lm-cell ${state}`} title={`0x${a.toString(16).toUpperCase()}${state === "hit" ? " — a module answered" : state === "skip" ? " — the car broadcasts on this ID: never sent to" : state === "own" ? " — OBD block, asked by the normal list" : ""}`} />);
  }
  const pct = p.total ? Math.round(((p.probed ?? 0) / p.total) * 100) : done ? 100 : 0;
  return (
    <div className="lm-sweep">
      <div className="lm-head">
        <b>Address search</b>
        <span className="ual-muted">
          {p.phase === "listen" ? "listening to the bus first — every ID the car uses is left alone…"
            : p.phase === "confirm" ? "asking every hit a second time…"
            : p.phase === "done" ? `done in ${p.elapsed ?? "?"} s`
            : p.phase === "error" ? `stopped: ${p.error}`
            : `0x${p.current ?? "…"} · ${p.probed ?? 0}/${p.total ?? "?"} asked`}
          {" · "}{(p.hits ?? []).length} answered{(p.skipped ?? []).length ? ` · ${(p.skipped ?? []).length} broadcast IDs skipped` : ""}
        </span>
        <span className="lm-pct">{pct}%</span>
      </div>
      <div className="lm-grid" role="img" aria-label={`Diagnostic addresses 0x600 to 0x7FF: ${(p.hits ?? []).length} answered so far`}>{cells}</div>
      <div className="lm-legend">
        <span><i className="lm-cell hit" />module answered</span>
        <span><i className="lm-cell asked" />asked, silent</span>
        <span><i className="lm-cell skip" />car broadcasts here — never sent to</span>
        <span><i className="lm-cell own" />OBD block (7DF, 7E0–7EF)</span>
        <span className="ual-muted">rows: 0x600 → 0x7FF, 32 addresses each · tester-present only</span>
      </div>
    </div>
  );
}

const SHOW: (keyof NonNullable<ModuleInventoryEntry["summary"]>)[] = ["serial", "partNo", "hwPartNo", "swPartNo", "swVersion", "hwVersion", "supplier", "mfgDate", "vin"];
const SHORT: Record<string, string> = { serial: "Serial", partNo: "Part no.", hwPartNo: "HW part", swPartNo: "SW part", swVersion: "SW ver.", hwVersion: "HW ver.", supplier: "Supplier", mfgDate: "Built", vin: "VIN" };

function IdentCard({ m, carVin }: { m: IdentModule; carVin?: string }) {
  const best = new Map<string, IdentRecord>();
  for (const r of m.records) if (!best.has(r.key)) best.set(r.key, r);
  const rows = SHOW.filter((k) => best.has(k)).slice(0, 4);
  const vin = best.get("vin")?.value;
  const vinBad = !!(vin && carVin && vin !== carVin);
  const { short, name } = splitLabel(m.label);
  const status = m.entry?.status;
  return (
    <div className={`lm-card ${m.state} ${status === "no_response" ? "quiet" : ""} ${vinBad ? "bad" : ""}`}>
      <div className="lm-card-top">
        <b>{short}</b>
        <span className="ual-mono ual-muted" style={{ fontSize: 11 }}>{m.requestId}→{m.responseId}</span>
        {m.state === "reading" && <span className="lm-spin" aria-label="reading" />}
        {m.state === "done" && <span className={`ual-chip ${status === "ok" ? "clean" : status === "no_response" ? "unread" : "warn"}`} style={{ marginLeft: "auto" }}>{status === "ok" ? `${m.records.length} record${m.records.length === 1 ? "" : "s"}` : status === "no_response" ? "silent" : status}</span>}
      </div>
      <div className="lm-card-name">{name}</div>
      {m.protectedKind && <div className="lm-prot">protected · identity in its current session only</div>}
      {rows.map((k) => (
        <div key={k} className="lm-rec"><span>{SHORT[k]}</span><b className="ual-mono">{best.get(k)!.value}</b></div>
      ))}
      {vinBad && <div className="lm-rec bad"><span>VIN</span><b className="ual-mono">{vin} — not this car's VIN</b></div>}
      {m.state === "wait" && <div className="ual-muted" style={{ fontSize: 12 }}>waiting…</div>}
    </div>
  );
}

export function LiveMap({ run, carVin, busy, onClose }: { run: LiveRun; carVin?: string; busy: boolean; onClose?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const ident = run.ident;
  const order = ident?.order ?? [];
  const doneN = order.filter((id) => ident!.mods[id].state === "done").length;
  const serials = order.filter((id) => ident!.mods[id].records.some((r) => r.key === "serial")).length;
  if (!run.sweep && !run.hits.length && !ident) return null;
  return (
    <section className="ual-card lm" ref={box} aria-live="polite">
      <div className="lm-title">
        <span className={`lm-dot ${busy ? "on" : ""}`} />
        <h2 className="ual-h2">Live map</h2>
        <span className="ual-muted">{busy ? "mapping this car now — read-only" : "last run"}</span>
        {!busy && onClose && <button className="tiny ghost" style={{ marginLeft: "auto" }} onClick={onClose}>Hide</button>}
      </div>

      {run.sweep && <SweepGrid p={run.sweep} />}

      {run.hits.length > 0 && (
        <div className="lm-hits">
          <b>Systems found · {run.hits.length}{run.discover ? ` (asked ${run.discover.done}/${run.discover.total} addresses)` : ""}</b>
          <div className="lm-hit-row">
            {run.hits.map((h) => (
              <span key={h.responseId} className="lm-hit"><span className="ual-mono">{h.requestId}→{h.responseId}</span>{h.partNo ? <span className="ual-muted"> · {h.partNo}</span> : null}</span>
            ))}
          </div>
        </div>
      )}

      {ident && (
        <div className="lm-ident">
          <div className="lm-head">
            <b>Identity of every module</b>
            <span className="ual-muted">{doneN}/{ident.total} read · {serials} serial number{serials === 1 ? "" : "s"} · identification reads only</span>
            <span className="lm-pct">{ident.total ? Math.round((doneN / ident.total) * 100) : 0}%</span>
          </div>
          <div className="ual-progress"><i style={{ width: `${ident.total ? Math.round((doneN / ident.total) * 100) : 0}%` }} /></div>
          <div className="lm-cards">
            {order.map((id) => <IdentCard key={id} m={ident.mods[id]} carVin={carVin} />)}
          </div>
        </div>
      )}
    </section>
  );
}
