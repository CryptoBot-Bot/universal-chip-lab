import { useState } from "react";

import { HOOKUP_SIGNALS, type ConnectorLayout, type ConnectorPin, type HookupSignal } from "@ecu/vehicle-db";

/**
 * Visual connector builder — literally build the module's connector as rows of pin
 * boxes, then name each pin and say what it connects to. Fixes the case where the
 * AI didn't get the pinout right: the operator lays out the real connector and
 * assigns power / ignition / ground / CAN pins by hand. Saving syncs the hookup.
 */

type SignalOpt = HookupSignal | "unused";
const SIGNAL_OPTS: SignalOpt[] = ["unused", ...HOOKUP_SIGNALS];

const SIG: Record<SignalOpt, { label: string; color: string }> = {
  unused:   { label: "Unused", color: "var(--border-strong)" },
  power:    { label: "12V power", color: "var(--danger)" },
  ignition: { label: "Ignition (KL15)", color: "var(--warn)" },
  ground:   { label: "Ground", color: "var(--fg-2)" },
  can_h:    { label: "CAN-H", color: "var(--info)" },
  can_l:    { label: "CAN-L", color: "var(--info)" },
  kline:    { label: "K-line", color: "var(--accent)" },
  lin:      { label: "LIN", color: "var(--accent)" },
  wake:     { label: "Wake/enable", color: "var(--warn)" },
  flexray:  { label: "FlexRay", color: "var(--fg-2)" },
  other:    { label: "Other", color: "var(--fg-1)" },
};

function clone(layout: ConnectorLayout): ConnectorLayout {
  return { rows: layout.rows.map((r) => r.map((c) => ({ ...c }))) };
}

export function ConnectorEditor({ initial, onSave, onCancel }: {
  initial: ConnectorLayout;
  onSave: (layout: ConnectorLayout) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<ConnectorPin[][]>(() => clone(initial).rows);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = sel ? rows[sel.r]?.[sel.c] : undefined;

  function mutate(fn: (rows: ConnectorPin[][]) => void) {
    setRows((prev) => { const next = prev.map((r) => r.map((c) => ({ ...c }))); fn(next); return next; });
  }
  function updateSel(patch: Partial<ConnectorPin>) {
    if (!sel) return;
    mutate((rs) => { rs[sel.r][sel.c] = { ...rs[sel.r][sel.c], ...patch }; });
  }
  function addPin(rowIdx: number) {
    mutate((rs) => { rs[rowIdx].push({ pin: String(rs[rowIdx].length + 1), signal: "unused" }); });
  }
  function addRow() { mutate((rs) => rs.push([{ pin: "1", signal: "unused" }])); }
  function removePin(r: number, c: number) {
    mutate((rs) => { rs[r].splice(c, 1); });
    setSel(null);
  }
  function removeRow(r: number) { mutate((rs) => rs.splice(r, 1)); setSel(null); }

  async function save() {
    setSaving(true);
    try { await onSave({ rows }); }
    finally { setSaving(false); }
  }

  const assignedCount = rows.flat().filter((c) => c.signal !== "unused" && c.pin.trim()).length;

  return (
    <div className="ce">
      <style>{styles}</style>
      <div className="ce-head">
        <div>
          <b>Connector builder</b>
          <div className="tiny dim">Add rows and pin boxes to match the real connector, then click a pin to name it and set what it connects to. {assignedCount} pin(s) assigned.</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="tiny" onClick={onCancel}>Cancel</button>
          <button className="tiny primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save connector"}</button>
        </div>
      </div>

      <div className="ce-legend">
        {(["power", "ignition", "ground", "can_h", "can_l", "kline"] as SignalOpt[]).map((s) => (
          <span key={s} className="ce-leg"><i style={{ background: SIG[s].color }} />{SIG[s].label}</span>
        ))}
      </div>

      <div className="ce-board">
        {rows.map((row, r) => (
          <div key={r} className="ce-row">
            <div className="ce-row-pins">
              {row.map((cell, c) => {
                const isSel = sel?.r === r && sel?.c === c;
                return (
                  <button key={c} className={`ce-pin ${isSel ? "sel" : ""} ${cell.signal === "unused" ? "unused" : ""}`}
                    style={{ borderColor: SIG[cell.signal as SignalOpt]?.color }}
                    onClick={() => setSel({ r, c })} title={cell.connectTo || SIG[cell.signal as SignalOpt]?.label}>
                    <span className="ce-pin-id">{cell.pin || "?"}</span>
                    <i className="ce-pin-dot" style={{ background: SIG[cell.signal as SignalOpt]?.color }} />
                  </button>
                );
              })}
              <button className="ce-addpin" onClick={() => addPin(r)} title="Add pin">＋</button>
            </div>
            <button className="ce-delrow" onClick={() => removeRow(r)} title="Remove row">✕ row</button>
          </div>
        ))}
        <button className="ce-addrow" onClick={addRow}>＋ Add row</button>
      </div>

      {selected && sel && (
        <div className="ce-edit">
          <div className="ce-edit-head">Pin <b className="mono">{selected.pin || "?"}</b>
            <button className="tiny" style={{ marginLeft: "auto" }} onClick={() => removePin(sel.r, sel.c)}>Delete pin</button>
          </div>
          <div className="ce-fields">
            <label className="ce-f"><span className="tiny dim">Pin label</span>
              <input className="mono" value={selected.pin} onChange={(e) => updateSel({ pin: e.target.value })} placeholder="e.g. 12 or A3" /></label>
            <label className="ce-f"><span className="tiny dim">Signal</span>
              <select value={selected.signal} onChange={(e) => updateSel({ signal: e.target.value as SignalOpt })}>
                {SIGNAL_OPTS.map((s) => <option key={s} value={s}>{SIG[s].label}</option>)}
              </select></label>
            <label className="ce-f ce-f-wide"><span className="tiny dim">Connect to</span>
              <input value={selected.connectTo ?? ""} onChange={(e) => updateSel({ connectTo: e.target.value })} placeholder="e.g. 12V battery +, HS-CAN High" disabled={selected.signal === "unused"} /></label>
            <label className="ce-f ce-check"><input type="checkbox" checked={!!selected.required} onChange={(e) => updateSel({ required: e.target.checked })} disabled={selected.signal === "unused"} /> <span className="tiny">Required</span></label>
            <label className="ce-f ce-f-wide"><span className="tiny dim">Note</span>
              <input value={selected.note ?? ""} onChange={(e) => updateSel({ note: e.target.value })} placeholder="optional" /></label>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = `
.ce { border: 1px solid var(--accent); border-radius: 12px; padding: 14px 16px; background: var(--bg-1); display: flex; flex-direction: column; gap: 12px; }
.ce-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ce-legend { display: flex; flex-wrap: wrap; gap: 12px; }
.ce-leg { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--fg-2); }
.ce-leg i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.ce-board { display: flex; flex-direction: column; gap: 8px; background: var(--bg-0); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.ce-row { display: flex; align-items: center; gap: 10px; }
.ce-row-pins { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
.ce-pin { position: relative; width: 46px; height: 42px; border-radius: 7px; border: 2px solid var(--border-strong); background: var(--bg-2); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.ce-pin.unused { opacity: .5; }
.ce-pin.sel { box-shadow: 0 0 0 2px var(--accent); }
.ce-pin-id { font-family: var(--mono); font-size: 12px; color: var(--fg-0); }
.ce-pin-dot { position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%; }
.ce-addpin { width: 34px; height: 42px; border-radius: 7px; border: 1px dashed var(--border-strong); background: transparent; color: var(--fg-2); cursor: pointer; font-size: 16px; }
.ce-delrow { background: transparent; border: 1px solid var(--border); border-radius: 6px; color: var(--fg-2); font-size: 11px; padding: 4px 8px; cursor: pointer; white-space: nowrap; }
.ce-addrow { align-self: flex-start; background: var(--bg-2); border: 1px dashed var(--border-strong); border-radius: 7px; color: var(--fg-1); padding: 6px 12px; cursor: pointer; font-size: 12px; }
.ce-edit { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--bg-2); }
.ce-edit-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ce-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.ce-f { display: flex; flex-direction: column; gap: 3px; }
.ce-f-wide { grid-column: 1 / -1; }
.ce-check { flex-direction: row; align-items: center; gap: 6px; }
.ce-f input, .ce-f select { background: var(--bg-0); border: 1px solid var(--border); border-radius: 7px; color: var(--fg-0); padding: 7px 9px; font-size: 12.5px; }
@media (max-width: 640px) { .ce-fields { grid-template-columns: 1fr; } }
`;
