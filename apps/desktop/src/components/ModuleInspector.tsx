import { useEffect, useRef, useState } from "react";

import { MODULE_MEMORY, type ModuleTemplate, type ModuleActionDef, type VehicleModule, type ConfigParam } from "@ecu/vehicle-db";

import { Api } from "../lib/api";
import { bytesToBase64, sha256Hex } from "../lib/picoforge";
import type { VehicleSimulator, DumpResult } from "../lib/vehicleSim";
import type { PendingWrite } from "../lib/writeActions";
import { WriteConfirmModal } from "./WriteConfirmModal";

/**
 * ECU Inspector — everything a module exposes and everything you can do to it.
 * Reads (identity, live data, DTCs, memory dump) run freely; every write
 * (clear DTCs, coding edits, actuators, security) goes through WriteConfirmModal.
 * DTC state is live: clear them and watch active faults re-set while running.
 */

interface Props {
  module: VehicleModule;
  template: ModuleTemplate | null;
  sim: VehicleSimulator | null;
  running: boolean;
  onClose: () => void;
}

interface Op { pending: PendingWrite; commit: () => void; }

const STATUS_TONE: Record<string, string> = { stored: "danger", pending: "warn", permanent: "danger" };

const fmtSize = (b: number) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(b % 1048576 ? 1 : 0)} MB` : `${Math.round(b / 1024)} KB`;

const coerce = (v: string, t: ConfigParam["type"]): string | number | boolean =>
  t === "number" ? Number(v) : t === "bool" ? v === "true" : v;

const READ_LABEL: Record<string, string> = {
  obd: "OBD-readable", obd_partial: "OBD partial", bench: "Bench / boot-mode required",
};

export function ModuleInspector({ module, template, sim, running, onClose }: Props) {
  const [result, setResult] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dumping, setDumping] = useState<{ region: "flash" | "eeprom"; pct: number } | null>(null);
  const [dump, setDump] = useState<DumpResult | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dumpIv = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (dumpIv.current) clearInterval(dumpIv.current); }, []);

  if (!template) {
    return (
      <div className="mi card">
        <div className="mi-head"><h3>{module.label}</h3><button className="tiny" onClick={onClose}>Close</button></div>
        <p className="tiny dim">No detailed catalog for this module yet — map it with AI in the OBD Intel tab to enrich it.</p>
      </div>
    );
  }

  const tpl = template;
  const info = sim ? sim.moduleInfo(tpl) : [];
  const live = sim ? sim.moduleLive(tpl) : [];
  const dtcs = sim ? sim.moduleDtcs(tpl) : tpl.dtcs;
  const config = sim ? sim.moduleConfig(tpl) : [];
  const mem = MODULE_MEMORY[tpl.key];

  const toPending = (a: ModuleActionDef): PendingWrite =>
    ({ moduleLabel: module.label, label: a.label, request: a.request, kind: a.kind, risk: a.risk, note: a.note });

  function runAction(a: ModuleActionDef) {
    if (!sim) return;
    if (a.risk === "read") { const r = sim.runModuleAction(tpl, a); setLastAction(a.label); setResult(r.text); return; }
    setOp({ pending: toPending(a), commit: () => { const r = sim.runModuleAction(tpl, a, true); setLastAction(a.label); setResult(r.text); } });
  }

  function clearDtcs() {
    const clearAction = tpl.actions.find((a) => a.kind === "clear")
      ?? { id: "clear", label: "Clear DTCs", request: "14 FF FF FF", kind: "clear", risk: "write" } as ModuleActionDef;
    runAction(clearAction);
  }

  function applyConfig(p: ConfigParam) {
    if (!sim) return;
    const value = coerce(drafts[p.id], p.type);
    setOp({
      pending: { moduleLabel: module.label, label: `Set ${p.label} = ${value}`, request: `2E ${p.did ?? "----"}`, kind: "coding", risk: "write", note: p.note },
      commit: () => {
        sim.setConfig(tpl, p.id, value);
        setDrafts((d) => { const n = { ...d }; delete n[p.id]; return n; });
        setLastAction(`Coding: ${p.label}`);
        setResult(`✿ SIMULATED — coding written (0x6E): ${p.label} = ${value}`);
      },
    });
  }

  async function archiveDump() {
    if (!dump) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const sha = await sha256Hex(dump.bytes);
      const res = await Api.pico.saveDump({
        name: `${module.label} ${dump.region}`,
        base64: bytesToBase64(dump.bytes),
        meta: {
          source: "cockpit-obd-dump", simulated: true,
          module: module.id, moduleLabel: module.label, region: dump.region,
          addressing: module.addressing?.request, sizeBytes: dump.sizeBytes,
          crc32: dump.crc32, sha256: sha,
        },
      });
      setSaveMsg(`✓ Archived ${res.bytes.toLocaleString()} bytes → Dumps tab`);
    } catch (e) {
      setSaveMsg(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  function startDump(region: "flash" | "eeprom") {
    if (!sim) return;
    setDump(null);
    setSaveMsg(null);
    setDumping({ region, pct: 0 });
    if (dumpIv.current) clearInterval(dumpIv.current);
    let pct = 0;
    dumpIv.current = setInterval(() => {
      pct += Math.random() * 16 + 7;
      if (pct >= 100) {
        if (dumpIv.current) clearInterval(dumpIv.current);
        setDumping(null);
        setDump(sim.dumpMemory(tpl, region));
      } else setDumping({ region, pct: Math.round(pct) });
    }, 130);
  }

  return (
    <div className="mi card">
      <style>{styles}</style>

      <div className="mi-head">
        <div>
          <div className="mi-title"><h3>{module.label}</h3><span className="mi-cat" data-cat={module.category}>{module.category}</span></div>
          <div className="mi-meta tiny mono dim">
            <span>req {module.addressing?.request ?? "—"}</span>
            <span>resp {module.addressing?.response ?? "—"}</span>
            <span>supplier {tpl.supplier}</span>
            {mem && <span>flash {mem.flashKb}KB · eeprom {mem.eepromKb}KB</span>}
          </div>
        </div>
        <button className="tiny" onClick={onClose}>Close ✕</button>
      </div>

      <div className="mi-grid">
        {/* ECU information */}
        <section className="mi-panel">
          <h4>ECU identification</h4>
          <table className="mi-table"><tbody>
            {info.map((r) => (
              <tr key={r.id}><td className="mi-k mono">{r.id}</td><td className="mi-lbl">{r.label}</td><td className="mi-v mono">{r.value}</td></tr>
            ))}
          </tbody></table>
        </section>

        {/* Live data */}
        <section className="mi-panel">
          <h4>Live data {running ? <span className="mi-live">◉ streaming</span> : <span className="tiny dim">— pick a scenario</span>}</h4>
          <div className="mi-live-grid">
            {live.map((p) => (
              <div className="mi-live-row" key={p.id}>
                <span className="mi-live-k">{p.label}</span>
                <span className="mi-live-v mono">{p.value.toFixed(p.decimals)}<span className="mi-live-u"> {p.unit}</span></span>
              </div>
            ))}
          </div>
        </section>

        {/* Configuration / coding */}
        <section className="mi-panel">
          <h4>Configuration <span className="tiny dim">— static &amp; coding</span></h4>
          <div className="mi-cfg">
            {config.map((p) => {
              const cur = String(p.value);
              const draft = drafts[p.id];
              const val = draft ?? cur;
              const changed = draft !== undefined && draft !== cur;
              return (
                <div className="mi-cfg-row" key={p.id}>
                  <span className="mi-cfg-k">{p.label}{p.unit ? <span className="dim"> ({p.unit})</span> : null}</span>
                  {!p.editable ? (
                    <span className="mi-cfg-ro mono" title={p.note ?? "read-only"}>{cur} <span className="mi-lock">🔒</span></span>
                  ) : (
                    <span className="mi-cfg-edit">
                      {p.type === "enum" || p.type === "bool" ? (
                        <select className="mono" value={val} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}>
                          {(p.type === "bool" ? ["true", "false"] : p.options ?? []).map((o) => (
                            <option key={o} value={o}>{p.type === "bool" ? (o === "true" ? "On" : "Off") : o}</option>
                          ))}
                        </select>
                      ) : (
                        <input className="mono" type={p.type === "number" ? "number" : "text"} value={val}
                          onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))} />
                      )}
                      {changed && <button className="tiny locked mi-apply" onClick={() => applyConfig(p)}>⚠ Apply</button>}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* DTCs */}
        <section className="mi-panel">
          <h4>
            Fault codes <span className="tiny dim">— {dtcs.length}</span>
            <button className="tiny locked mi-clear" disabled={!dtcs.length} onClick={clearDtcs}>⚠ Clear DTCs</button>
          </h4>
          {dtcs.length === 0 ? (
            <p className="tiny dim">No stored codes. {running ? "Active faults will re-appear if the condition persists." : ""}</p>
          ) : (
            <div className="mi-dtcs">
              {dtcs.map((d) => (
                <div className="mi-dtc" key={d.code}>
                  <span className="mi-dtc-code mono">{d.code}</span>
                  <span className="mi-dtc-desc">{d.desc}</span>
                  <span className={`badge ${STATUS_TONE[d.status]}`}>{d.status}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Memory dump over OBD */}
        <section className="mi-panel mi-mem">
          <h4>Memory dump <span className="tiny dim">— via OBD (Raspberry Pi)</span></h4>
          {mem && (
            <>
              <div className="mi-read-row">
                <span className="mi-read" data-r={mem.read}>{READ_LABEL[mem.read] ?? mem.read}</span>
              </div>
              {mem.note && <div className="tiny dim mi-read-note">{mem.note}</div>}
              {mem.read === "bench" ? (
                <div className="mi-bench">
                  <strong>Not OBD-readable.</strong> This ECU blocks firmware read over the bus — the full image needs
                  <strong> bench / boot-mode</strong> (T48 · PicoForge · JTAG). Pull the module and use the Read → Dumps flow.
                </div>
              ) : (
                <>
                  <div className="mi-mem-btns">
                    <button className="tiny" disabled={!!dumping} onClick={() => startDump("flash")}>Dump FLASH ({fmtSize(mem.flashKb * 1024)})</button>
                    <button className="tiny" disabled={!!dumping} onClick={() => startDump("eeprom")}>Dump EEPROM ({fmtSize(mem.eepromKb * 1024)})</button>
                  </div>
                  {mem.read === "obd_partial" && (
                    <div className="tiny dim">OBD exposes identifiers &amp; calibration; the full firmware region still needs bench.</div>
                  )}
                </>
              )}
            </>
          )}
          {dumping && (
            <div className="mi-prog">
              <div className="mi-prog-bar"><span style={{ width: `${dumping.pct}%` }} /></div>
              <div className="tiny mono dim">Reading {dumping.region.toUpperCase()} over OBD… {dumping.pct}%</div>
            </div>
          )}
          {dump && (
            <div className="mi-dump">
              <div className="mi-dump-meta mono tiny">
                {dump.region.toUpperCase()} · {fmtSize(dump.sizeBytes)} · CRC32 {dump.crc32} · ~{dump.durationS}s
              </div>
              <pre className="mi-hex mono">{dump.previewHex}</pre>
              <div className="mi-dump-actions">
                <button className="tiny primary" disabled={saving} onClick={() => void archiveDump()}>
                  {saving ? "Archiving…" : "💾 Save .bin to Dumps"}
                </button>
                {saveMsg && <span className="tiny mono" style={{ color: "var(--accent)" }}>{saveMsg}</span>}
              </div>
              <div className="tiny dim">Preview (first 128 bytes). Saving writes a real .bin + metadata sidecar to the Dumps tab — the archive step of the Cloning Ceremony.</div>
            </div>
          )}
        </section>

        {/* Actions */}
        <section className="mi-panel">
          <h4>Actions &amp; routines</h4>
          <div className="mi-actions">
            {tpl.actions.map((a) => (
              <div className="mi-action" key={a.id}>
                <div className="mi-action-main">
                  <span className="mi-action-label">{a.label}</span>
                  <span className="mi-action-req mono tiny dim">{a.request}</span>
                </div>
                <button className={`tiny ${a.risk === "read" ? "" : "locked"}`} onClick={() => runAction(a)} title={a.note ?? (a.risk === "read" ? "" : "Requires confirmation")}>
                  {a.risk === "read" ? "Run" : "⚠ Run…"}
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {result && (
        <div className="mi-result">
          <div className="tiny dim">↳ {lastAction}</div>
          <pre className="mi-result-body mono">{result}</pre>
        </div>
      )}

      <WriteConfirmModal pending={op?.pending ?? null} onCancel={() => setOp(null)} onConfirm={() => { op?.commit(); setOp(null); }} />
    </div>
  );
}

const styles = `
.mi { margin-top: 12px; }
.mi-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.mi-title { display: flex; align-items: center; gap: 10px; }
.mi-title h3 { margin: 0; }
.mi-cat { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 5px; background: var(--bg-2); border: 1px solid var(--border); }
.mi-cat[data-cat="powertrain"] { color: #f97316; border-color: #f97316; } .mi-cat[data-cat="transmission"] { color: #eab308; border-color: #eab308; }
.mi-cat[data-cat="chassis"] { color: #38bdf8; border-color: #38bdf8; } .mi-cat[data-cat="body"] { color: #a78bfa; border-color: #a78bfa; }
.mi-cat[data-cat="safety"] { color: #ef4444; border-color: #ef4444; } .mi-cat[data-cat="infotainment"] { color: #22d3ee; border-color: #22d3ee; }
.mi-cat[data-cat="hvac"] { color: #34d399; border-color: #34d399; }
.mi-meta { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 6px; }
.mi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
.mi-panel { background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.mi-panel h4 { margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
.mi-live { font-size: 10px; color: var(--accent); }
.mi-table { width: 100%; border-collapse: collapse; }
.mi-table td { padding: 4px 6px; border-bottom: 1px solid var(--border); font-size: 12px; vertical-align: top; }
.mi-k { color: var(--fg-2); width: 46px; } .mi-lbl { color: var(--fg-1); } .mi-v { color: var(--fg-0); text-align: right; }
.mi-live-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.mi-live-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 6px 9px; }
.mi-live-k { font-size: 11px; color: var(--fg-2); } .mi-live-v { font-size: 14px; font-weight: 700; color: var(--fg-0); font-variant-numeric: tabular-nums; white-space: nowrap; } .mi-live-u { font-size: 10px; font-weight: 400; color: var(--fg-2); }
.mi-cfg { display: flex; flex-direction: column; gap: 5px; }
.mi-cfg-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 5px 9px; }
.mi-cfg-k { font-size: 12px; color: var(--fg-1); }
.mi-cfg-ro { font-size: 12px; color: var(--fg-0); } .mi-lock { opacity: 0.5; }
.mi-cfg-edit { display: flex; align-items: center; gap: 6px; }
.mi-cfg-edit input, .mi-cfg-edit select { width: 92px; padding: 3px 6px; background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 6px; color: var(--fg-0); font-size: 12px; }
.mi-apply { white-space: nowrap; }
.mi-clear, .mi-mem-btns button { margin-left: auto; }
.mi-dtcs { display: flex; flex-direction: column; gap: 5px; }
.mi-dtc { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 6px 9px; }
.mi-dtc-code { font-weight: 700; color: var(--danger); } .mi-dtc-desc { font-size: 11.5px; color: var(--fg-1); }
.mi-read-row { margin-bottom: 6px; }
.mi-read { font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; padding: 3px 9px; border-radius: 5px; border: 1px solid; }
.mi-read[data-r="obd"] { color: var(--accent); border-color: var(--accent); background: rgba(74,222,128,0.1); }
.mi-read[data-r="obd_partial"] { color: var(--warn); border-color: var(--warn); background: rgba(251,191,36,0.1); }
.mi-read[data-r="bench"] { color: var(--danger); border-color: var(--danger); background: rgba(239,68,68,0.1); }
.mi-read-note { margin-bottom: 8px; }
.mi-bench { font-size: 12px; line-height: 1.55; color: var(--fg-1); background: rgba(239,68,68,0.08); border: 1px solid var(--danger); border-radius: 8px; padding: 10px 12px; }
.mi-bench strong { color: var(--danger); }
.mi-mem-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.mi-prog { margin-top: 10px; } .mi-prog-bar { height: 6px; background: var(--bg-2); border-radius: 4px; overflow: hidden; margin-bottom: 4px; } .mi-prog-bar span { display: block; height: 100%; background: var(--accent); transition: width 0.13s linear; }
.mi-dump { margin-top: 10px; } .mi-dump-meta { color: var(--accent); margin-bottom: 6px; }
.mi-dump-actions { display: flex; align-items: center; gap: 10px; margin: 6px 0; flex-wrap: wrap; }
.mi-hex { margin: 0 0 6px; background: #05101a; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 10.5px; line-height: 1.5; color: #7dd3fc; overflow-x: auto; white-space: pre; }
.mi-actions { display: flex; flex-direction: column; gap: 5px; }
.mi-action { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 6px 9px; }
.mi-action-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; } .mi-action-label { font-size: 12.5px; color: var(--fg-0); }
.tiny.locked { color: var(--warn); border-color: var(--warn); }
.mi-result { margin-top: 12px; } .mi-result-body { margin: 4px 0 0; background: #06111c; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 12px; color: #7dd3fc; white-space: pre-wrap; line-height: 1.5; }
`;
