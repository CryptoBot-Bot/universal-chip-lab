import { useState } from "react";

import { connectorFromHookup, hookupFromConnector, type BenchModuleProfile, type ConnectorLayout, type HookupSignal } from "@ecu/vehicle-db";

import { ConnectorEditor } from "./ConnectorEditor";
import { ModulePhotos } from "./ModulePhotos";

/**
 * The hookup guide — how to bring a module up on the bench. Renders a saved (or
 * freshly-mapped, ai_suggested) BenchModuleProfile: power/ignition/ground + the
 * CAN pins, an ASCII connector, the bus + speed to use, cautions and references.
 * From here you save it to the library or step into the cockpit.
 */

const SIGNAL_META: Record<HookupSignal, { label: string; glyph: string; tone: string }> = {
  power:    { label: "12V power (B+)", glyph: "⏻", tone: "danger" },
  ignition: { label: "Ignition / KL15", glyph: "🔑", tone: "warn" },
  ground:   { label: "Ground", glyph: "⏚", tone: "dim" },
  can_h:    { label: "CAN-H", glyph: "▲", tone: "info" },
  can_l:    { label: "CAN-L", glyph: "▼", tone: "info" },
  kline:    { label: "K-line", glyph: "—", tone: "info" },
  lin:      { label: "LIN", glyph: "~", tone: "info" },
  wake:     { label: "Wake / enable", glyph: "☼", tone: "warn" },
  flexray:  { label: "FlexRay", glyph: "≡", tone: "dim" },
  other:    { label: "Other", glyph: "•", tone: "dim" },
};

export function ModuleGuide(props: {
  profile: BenchModuleProfile;
  saved: boolean;
  onSave: (p: BenchModuleProfile) => Promise<void>;
  onEnterCockpit: () => void;
  onBack: () => void;
}) {
  const { profile: p, saved } = props;
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [editingConn, setEditingConn] = useState(false);
  const isDraft = p.provenance.confidence !== "bench_verified";

  async function saveConnector(layout: ConnectorLayout) {
    const next: BenchModuleProfile = { ...p, connector: layout, hookup: hookupFromConnector(layout) };
    try { await props.onSave(next); setEditingConn(false); }
    catch (e) { setSaveErr((e as Error).message); }
  }

  async function save() {
    setSaving(true); setSaveErr(null);
    try { await props.onSave(p); }
    catch (e) { setSaveErr((e as Error).message); }
    finally { setSaving(false); }
  }

  const bus = p.buses[0];

  return (
    <div className="mg">
      <style>{styles}</style>

      <div className="mg-head">
        <div>
          <div className="mg-title">{p.displayName}</div>
          <div className="mg-sub">{p.brand} · {p.category.toUpperCase()}{p.partNumbers.length ? ` · ${p.partNumbers.join(" / ")}` : ""}</div>
        </div>
        <div className="mg-head-actions">
          <button className="tiny" onClick={props.onBack}>← Identify</button>
          {!saved && <button className="tiny primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "💾 Save to library"}</button>}
          {saved && <span className="badge ok">✓ In library</span>}
          <button className="primary" onClick={props.onEnterCockpit}>Enter cockpit →</button>
        </div>
      </div>

      {isDraft && (
        <div className="mg-trust">
          <b>AI draft — not yet bench-verified.</b> This pinout is the model's best read of your photos. Confirm pin 1 and check continuity with a meter <b>before applying 12 V</b>. It promotes to “bench-verified” once the module answers on the bench.
          {p.provenance.notes && <div className="tiny dim" style={{ marginTop: 6 }}>Rationale: {p.provenance.notes}</div>}
        </div>
      )}

      {p.powerNote && (
        <div className="mg-power">
          <span className="mg-power-ico">⚡</span>
          <span>{p.powerNote}</span>
        </div>
      )}

      <div className="mg-grid">
        <section className="mg-card">
          <h4>Hook-up <button className="tiny" style={{ marginLeft: "auto" }} onClick={() => setEditingConn((v) => !v)}>{editingConn ? "Close editor" : "✎ Edit connector"}</button></h4>
          <table className="mg-pins">
            <thead><tr><th>Pin</th><th>Signal</th><th>Connect to</th><th></th></tr></thead>
            <tbody>
              {p.hookup.map((h, i) => {
                const m = SIGNAL_META[h.signal];
                return (
                  <tr key={i} className={h.required ? "req" : ""}>
                    <td className="mono">{h.pin}</td>
                    <td><span className={`badge ${m.tone}`}>{m.glyph} {m.label}</span></td>
                    <td>{h.connectTo}{h.note && <div className="tiny dim">{h.note}</div>}</td>
                    <td className="tiny dim">{h.required ? "required" : "opt"}</td>
                  </tr>
                );
              })}
              {p.hookup.length === 0 && <tr><td colSpan={4} className="tiny dim">No pinout mapped.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="mg-card">
          <h4>Connector</h4>
          {p.asciiConnector
            ? <pre className="mg-ascii">{p.asciiConnector}</pre>
            : <div className="tiny dim">No connector diagram.</div>}
          {bus && (
            <div className="mg-bus">
              <div className="mg-bus-row"><span>Bus</span><b>{bus.name} · {bus.protocol.toUpperCase()}</b></div>
              <div className="mg-bus-row"><span>Speed</span><b className="mono">{(bus.bitrate / 1000).toFixed(0)} kbit/s{bus.fd ? " (FD)" : ""}</b></div>
              {(bus.requestId || bus.responseId) && (
                <div className="mg-bus-row"><span>Diag IDs</span><b className="mono">{bus.requestId || "?"} → {bus.responseId || "?"}</b></div>
              )}
              <div className="mg-bus-row"><span>Terminate</span><b>{bus.termination ? "120Ω — yes" : "not required"}</b></div>
            </div>
          )}
        </section>
      </div>

      {editingConn && (
        <ConnectorEditor
          initial={p.connector ?? connectorFromHookup(p.hookup)}
          onSave={saveConnector}
          onCancel={() => setEditingConn(false)}
        />
      )}

      {p.cautions.length > 0 && (
        <section className="mg-card mg-cautions">
          <h4>⚠ Before you power it</h4>
          <ul>{p.cautions.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </section>
      )}

      <div className="mg-grid">
        {p.diagnostics.capabilities.length > 0 && (
          <section className="mg-card">
            <h4>What you can do</h4>
            <ul className="mg-caps">{p.diagnostics.capabilities.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </section>
        )}
        {p.diagnostics.knownDtcs.length > 0 && (
          <section className="mg-card">
            <h4>Common fault codes</h4>
            <ul className="mg-dtcs">{p.diagnostics.knownDtcs.map((d, i) => <li key={i}><b className="mono">{d.code}</b> {d.desc}</li>)}</ul>
          </section>
        )}
      </div>

      {p.references.length > 0 && (
        <section className="mg-card">
          <h4>References</h4>
          <ul className="mg-refs">
            {p.references.map((r, i) => <li key={i}><a href={r.url} target="_blank" rel="noreferrer">{r.label} ↗</a></li>)}
          </ul>
        </section>
      )}

      {saved
        ? <ModulePhotos moduleId={p.id} />
        : <div className="mg-card tiny dim">Save this module to the library to attach photos of the unit.</div>}

      {saveErr && <div className="mg-err">{saveErr}</div>}
    </div>
  );
}

const styles = `
.mg { max-width: 900px; display: flex; flex-direction: column; gap: 14px; }
.mg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.mg-title { font-size: 20px; font-weight: 700; }
.mg-sub { font-size: 12px; color: var(--fg-2); margin-top: 2px; }
.mg-head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mg-trust { font-size: 12px; color: var(--warn); background: var(--warn-dim); border: 1px solid rgba(251,191,36,.35); border-radius: 10px; padding: 10px 13px; line-height: 1.5; }
.mg-power { display: flex; gap: 10px; align-items: center; background: var(--bg-2); border: 1px solid var(--border-strong); border-left: 3px solid var(--warn); border-radius: 10px; padding: 11px 13px; font-size: 13px; }
.mg-power-ico { font-size: 18px; }
.mg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.mg-card { background: var(--bg-1); border: 1px solid var(--border); border-radius: 12px; padding: 13px 15px; }
.mg-card h4 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: var(--fg-2); display: flex; align-items: center; gap: 8px; }
.mg-pins { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.mg-pins th { text-align: left; font-weight: 500; color: var(--fg-2); font-size: 11px; padding: 0 6px 6px 0; }
.mg-pins td { padding: 5px 6px 5px 0; border-top: 1px solid var(--border); vertical-align: top; }
.mg-pins tr.req td { }
.mg-ascii { font-family: var(--mono); font-size: 11px; line-height: 1.35; color: var(--fg-1); background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow-x: auto; margin: 0 0 10px; white-space: pre; }
.mg-bus { display: flex; flex-direction: column; gap: 4px; }
.mg-bus-row { display: flex; justify-content: space-between; font-size: 12.5px; padding: 3px 0; border-top: 1px solid var(--border); }
.mg-bus-row span { color: var(--fg-2); }
.mg-cautions ul { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.7; color: var(--fg-1); }
.mg-caps, .mg-dtcs, .mg-refs { margin: 0; padding-left: 16px; font-size: 12.5px; line-height: 1.7; color: var(--fg-1); }
.mg-refs a { color: var(--info); }
.mg-err { font-size: 12px; color: var(--danger); background: var(--danger-dim); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 11px; }
@media (max-width: 720px) { .mg-grid { grid-template-columns: 1fr; } }
`;
