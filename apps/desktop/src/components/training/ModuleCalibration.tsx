import { useEffect, useMemo, useState } from "react";

import type { BenchModuleProfile } from "@ecu/vehicle-db";

import { Api, type ModuleMapResult } from "../../lib/api";
import { buildModuleInput, scoreModuleMap, formatModuleReport, FIDELITY_LABEL, type Fidelity, type ModuleScore } from "../../lib/moduleScore";

/**
 * Module-mapper calibration track for the Training Room. Pick a golden bench
 * module (e.g. the Bosch MED17.5), choose how much the operator "knows", run the
 * real AI module mapper on that description, and score whether it recovers the
 * right category/bus/hookup/capabilities — plus a humility check at low fidelity.
 */
export function ModuleCalibration() {
  const [modules, setModules] = useState<BenchModuleProfile[]>([]);
  const [goldenId, setGoldenId] = useState("bosch-med17-vag-20tfsi");
  const [fidelity, setFidelity] = useState<Fidelity>("full");
  const [result, setResult] = useState<ModuleMapResult | null>(null);
  const [score, setScore] = useState<ModuleScore | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Api.benchModules.list().then((list) => {
      setModules(list);
      setGoldenId((cur) => list.find((m) => m.id === cur)?.id ?? list[0]?.id ?? "");
    }).catch((e) => setError((e as Error).message));
  }, []);

  const golden = useMemo(() => modules.find((m) => m.id === goldenId) ?? null, [modules, goldenId]);
  const input = useMemo(() => (golden ? buildModuleInput(golden, fidelity) : ""), [golden, fidelity]);

  function reset() { setResult(null); setScore(null); setError(null); }

  async function run() {
    if (!golden) return;
    setRunning(true); setError(null);
    try {
      const r = await Api.benchModules.analyze({ images: [], description: input });
      setResult(r);
      setScore(scoreModuleMap(r, golden, fidelity));
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  }

  async function copyReport() {
    if (!golden || !result || !score) return;
    await navigator.clipboard.writeText(formatModuleReport(golden, fidelity, input, result, score));
    setCopied(true); setTimeout(() => setCopied(false), 2500);
  }

  return (
    <div className="mcal">
      <style>{styles}</style>

      <div className="card">
        <h3>Calibrate the bench module mapper</h3>
        <p className="tiny dim">Give the AI only what an operator would type, then check it reconstructs the module's real hookup and capabilities against the golden truth. Lower the fidelity to test whether it stays honest without a part number.</p>
        <div className="mcal-controls">
          <label className="tiny dim">Golden module
            <select value={goldenId} onChange={(e) => { setGoldenId(e.target.value); reset(); }}>
              {modules.map((m) => <option key={m.id} value={m.id}>{m.brand} {m.displayName}</option>)}
            </select>
          </label>
          <label className="tiny dim">Operator knows
            <select value={fidelity} onChange={(e) => { setFidelity(e.target.value as Fidelity); reset(); }}>
              {(["full", "sparse", "vague"] as Fidelity[]).map((f) => <option key={f} value={f}>{FIDELITY_LABEL[f]}</option>)}
            </select>
          </label>
          <button className="tiny primary" disabled={!golden || running} onClick={() => void run()}>{running ? "Mapping…" : "Run module mapper"}</button>
        </div>
        {golden && <div className="mcal-input"><span className="tiny dim">Input sent to the mapper:</span> <span className="mono tiny">"{input}"</span></div>}
      </div>

      {error && <div className="tr-err">{error}</div>}

      {score && result && golden && (
        <div className="card">
          <div className="row spread">
            <h4>Score vs golden {golden.displayName}</h4>
            <div className="row" style={{ gap: 8 }}>
              <span className={`mcal-overall ${score.overall >= 80 ? "good" : score.overall >= 55 ? "mid" : "bad"}`}>{score.overall}%</span>
              <button className="tiny" onClick={() => void copyReport()}>{copied ? "✓ Copied — paste to Claude" : "Copy report"}</button>
            </div>
          </div>

          <div className="mcal-rows">
            {score.rows.map((r) => (
              <div key={r.key} className={`mcal-row ${r.ok ? "" : "miss"}`}>
                <span className="mcal-rk">{r.ok ? "✓" : "✗"} {r.label}</span>
                <span className="tiny">got <b className={r.ok ? "ok" : "bad"}>{r.got}</b></span>
                <span className="tiny dim">want {r.want}</span>
              </div>
            ))}
          </div>

          <div className="mcal-detail">
            <div className="mcal-chip">
              <span className="tiny dim">Hookup signals</span>
              <span>{score.hookup.covered.join(", ") || "none"}{score.hookup.missing.length > 0 && <span className="bad"> · missed {score.hookup.missing.join(", ")}</span>}</span>
            </div>
            <div className="mcal-chip">
              <span className="tiny dim">Capabilities</span>
              <span>{score.capabilities.hit}/{score.capabilities.total} matched</span>
            </div>
            <div className="mcal-chip">
              <span className="tiny dim">Known DTCs</span>
              <span>{score.dtcs.hit}/{score.dtcs.total} matched</span>
            </div>
          </div>

          <div className={`mcal-honesty ${score.honesty.ok ? "ok" : "bad"}`}>
            Confidence <b>{score.honesty.confidence}</b> — {score.honesty.note}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = `
.mcal { display: flex; flex-direction: column; gap: 12px; }
.mcal-controls { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-top: 10px; }
.mcal-controls select { display: block; margin-top: 3px; background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; font-size: 13px; }
.mcal-input { margin-top: 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 11px; }
.mcal-overall { font-family: var(--mono); font-size: 20px; font-weight: 700; }
.mcal-overall.good { color: var(--accent); } .mcal-overall.mid { color: var(--warn); } .mcal-overall.bad { color: var(--danger); }
.mcal-rows { display: flex; flex-direction: column; gap: 3px; margin: 10px 0; }
.mcal-row { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 8px; align-items: center; padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.mcal-row.miss { background: rgba(239,68,68,0.06); }
.mcal-rk { font-weight: 500; }
.mcal-row .ok { color: var(--accent); } .mcal-row .bad { color: var(--danger); }
.mcal-detail { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 0; }
@media (max-width: 700px) { .mcal-detail { grid-template-columns: 1fr; } }
.mcal-chip { display: flex; flex-direction: column; gap: 2px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; }
.mcal-chip .bad { color: var(--danger); }
.mcal-honesty { font-size: 12.5px; border-radius: 8px; padding: 8px 11px; background: rgba(74,222,128,0.07); }
.mcal-honesty.bad { background: var(--danger-dim); color: var(--danger); }
`;
