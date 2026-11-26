import { useEffect, useMemo, useState } from "react";

import { Api, type KnownModel } from "../../lib/api";
import { plural } from "./vehicleFacts";

/**
 * Models we know before we meet them: every make / model the outside knowledge covers, how
 * much it holds and what a first scan of one will give. Kept apart from the cars on file —
 * those are real cars only.
 */
const yearsText = (y?: [number, number][]) => {
  if (!y?.length) return "years not given";
  const lo = Math.min(...y.map((r) => r[0])), hi = Math.max(...y.map((r) => r[1]));
  return lo === hi ? String(lo) : `${lo}–${hi}`;
};

export function ModelCatalog({ onOpenCar }: { onOpenCar: (make: string, model: string) => void }) {
  const [rows, setRows] = useState<KnownModel[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [make, setMake] = useState<string | null>(null);
  useEffect(() => { Api.knowledge.models().then(setRows).catch((e) => setErr((e as Error).message)); }, []);

  const makes = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.make, (m.get(r.make) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [rows]);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (rows ?? []).filter((r) => (!make || r.make === make) && words.every((w) => `${r.make} ${r.model ?? ""} ${yearsText(r.years)}`.toLowerCase().includes(w)));
  }, [rows, q, make]);

  if (err) return <div className="ual-note err">The model list could not be read: {err}</div>;
  if (!rows) return <p className="ual-muted">Loading…</p>;
  if (!rows.length) return <div className="ual-note">No outside knowledge downloaded yet. Open a car's "What we know" card and press "Download sources".</div>;
  const withValues = rows.filter((r) => r.signals > 0 && r.model);
  const onFile = rows.filter((r) => r.onFile);

  return (
    <section className="ual-card pad vdb-models" aria-label="Models we know">
      <div className="vdb-models-head">
        <h2 className="ual-h2">Models we know</h2>
        <span className="ual-muted">before we meet them · kept apart from the cars on file</span>
      </div>
      <dl className="vdb-models-levels">
        <dt>Basic scan</dt><dd>every OBD-II vehicle (US 1996 on, CAN from 2008): VIN, every module, fault codes with their public meaning, the standard live values</dd>
        <dt>With maker values</dt><dd><b>{withValues.length}</b> models from {new Set(withValues.map((r) => r.make)).size} makes have community definitions on top — each is checked on the car at its first sweep</dd>
        <dt>Mapped on a real car</dt><dd><b>{onFile.length}</b>{onFile.length ? `: ${onFile.map((r) => `${r.make} ${r.model ?? ""}`.trim()).join(", ")}` : ""}</dd>
      </dl>
      <div className="vdb-models-tools">
        <input type="search" aria-label="Search models" placeholder="Search make, model or year" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Make" value={make ?? ""} onChange={(e) => setMake(e.target.value || null)}>
          <option value="">All makes ({makes.length})</option>
          {makes.map(([m, n]) => <option key={m} value={m}>{m} ({n})</option>)}
        </select>
        <span className="ual-muted">{plural(shown.length, "model")}</span>
      </div>
      <div className="vdb-models-list" role="list">
        {shown.slice(0, 300).map((r) => (
          <div key={r.set} role="listitem" className="vdb-models-row">
            <b>{r.make} {r.model ?? <span className="ual-muted">(make-wide)</span>}</b>
            <span className="ual-muted">{yearsText(r.years)}</span>
            <span>{r.source === "ours" ? `${r.signals.toLocaleString()} values · ${plural(r.modules, "module")} · our own mapping` : r.signals ? `${r.signals.toLocaleString()} values · ${plural(r.modules, "module")}` : <span className="ual-muted">no values yet</span>}</span>
            <span>{r.onFile ? <button type="button" className="ual-chip clean strong" onClick={() => onOpenCar(r.make, r.model ?? "")}>mapped · open</button> : r.signals ? <span className="ual-chip info">maker values</span> : <span className="ual-chip unread">basic scan</span>}</span>
          </div>
        ))}
        {shown.length > 300 && <p className="ual-muted">{shown.length - 300} more — narrow the search.</p>}
      </div>
      <p className="ual-muted vdb-small">Community definitions: OBDb (CC BY-SA 4.0). A model with no set here can still be scanned; its maker values are learned by sweeping and labelling it.</p>
    </section>
  );
}
