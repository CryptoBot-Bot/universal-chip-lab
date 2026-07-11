import { useEffect, useRef, useState } from "react";

import type { VehicleProfile } from "@ecu/vehicle-db";

import { Topbar } from "../components/Topbar";
import { Api, type VehicleScan, type VehicleMapResult } from "../lib/api";
import { buildScan, compareMap, formatRawReport, type Comparison } from "../lib/busScan";
import { perturbScan, normalizeForScoring, scoreRobustness, formatHardSection, type PerturbedScan, type RobustnessResult } from "../lib/hardMode";
import { VehicleSimulator } from "../lib/vehicleSim";

/**
 * AI Training Room — calibrate the mapper against a known truth. A simulated 2020
 * Toyota bus produces a RAW scan; the AI (real API) maps it; we score it locally
 * against the gold Corolla and emit a copy-pasteable report to review with Claude.
 */

export function TrainingRoom() {
  const [profiles, setProfiles] = useState<VehicleProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string>("2020-toyota-corolla");
  const [profile, setProfile] = useState<VehicleProfile | null>(null);
  const [scan, setScan] = useState<VehicleScan | null>(null);
  const [result, setResult] = useState<VehicleMapResult | null>(null);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [hard, setHard] = useState(false);
  const [pert, setPert] = useState<PerturbedScan | null>(null);
  const [rob, setRob] = useState<RobustnessResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const simRef = useRef<VehicleSimulator | null>(null);

  // Load the whole gold library once.
  useEffect(() => {
    Api.vehicleLib.list().then((list) => {
      setProfiles(list);
      setSelectedId((cur) => list.find((p) => p.id === cur)?.id ?? list[0]?.id ?? "");
    }).catch((e) => setError((e as Error).message));
  }, []);

  // (Re)build the simulator whenever the selected gold vehicle changes.
  useEffect(() => {
    const p = profiles.find((x) => x.id === selectedId) ?? null;
    setProfile(p);
    setScan(null); setResult(null); setCmp(null); setRob(null); setPert(null); setError(null);
    if (!p) { simRef.current = null; return; }
    const sim = new VehicleSimulator(p);
    sim.setScenario("idle");
    simRef.current = sim;
    const iv = setInterval(() => sim.step(100), 100);
    return () => clearInterval(iv);
  }, [profiles, selectedId]);

  function scanBus() {
    if (!profile || !simRef.current) return;
    const clean = buildScan(profile, simRef.current);
    if (hard) {
      const p = perturbScan(clean);
      setPert(p);
      setScan(p.scan);
    } else {
      setPert(null);
      setScan(clean);
    }
    setResult(null);
    setCmp(null);
    setRob(null);
    setError(null);
  }

  async function runAI() {
    if (!scan || !profile) return;
    setRunning(true);
    setError(null);
    try {
      const r = await Api.vehicleLib.analyze(scan);
      setResult(r);
      if (pert) {
        setCmp(compareMap(normalizeForScoring(r, pert), profile));
        setRob(scoreRobustness(r, profile, pert));
      } else {
        setCmp(compareMap(r, profile));
        setRob(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function copyRaw() {
    if (!scan || !result || !cmp) return;
    const hardSection = pert && rob ? formatHardSection(pert, rob) : undefined;
    await navigator.clipboard.writeText(formatRawReport(scan, result, cmp, hardSection));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <>
      <Topbar title="AI Training Room" crumb={profile ? `${profile.year} ${profile.make} ${profile.model}` : "loading…"} />
      <div className="content">
        <div className="tr">
          <style>{styles}</style>

          <div className="card tr-intro">
            <h3>Calibrate the mapper against a known truth</h3>
            <p className="tiny dim">
              A simulated 2020 Toyota bus produces a raw scan → the AI maps it with a real API call →
              we score it against the gold Corolla → copy the report and paste it back to Claude to tune the brain.
            </p>
            <ol className="tr-steps tiny">
              <li>Pick a gold vehicle and scan its simulated bus (real VIN + every responding ECU).</li>
              <li>Run the AI mapper — it must identify each module from raw evidence alone.</li>
              <li>Read the local score, copy the RAW report, paste it to Claude.</li>
            </ol>
            <div className="tr-vehsel">
              <label className="tiny dim">Gold vehicle</label>
              <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.year} {p.make} {p.model}{p.trim ? ` · ${p.trim}` : ""}</option>
                ))}
              </select>
              <span className="tiny dim">{profiles.length} in library</span>
            </div>
          </div>

          {error && <div className="tr-err">{error}</div>}

          <div className="tr-grid">
            {/* simulated bus */}
            <div className="card">
              <div className="row spread">
                <h4>Simulated bus {hard && <span className="tr-hardtag">HARD</span>}</h4>
                <div className="row" style={{ gap: 8 }}>
                  <label className="tr-toggle tiny" title="Adversarially perturb the scan: strip evidence, move an ECU to a non-standard address, and inject a decoy responder.">
                    <input type="checkbox" checked={hard} onChange={(e) => { setHard(e.target.checked); setScan(null); setResult(null); setCmp(null); setRob(null); setPert(null); }} />
                    Hard Mode
                  </label>
                  <button className="tiny primary" onClick={scanBus} disabled={!profile}>Scan bus →</button>
                </div>
              </div>
              {hard && <p className="tiny dim" style={{ marginTop: 4 }}>Adversarial: 2 ECUs stripped to VIN-only, skid-control moved to a non-standard id, 1 decoy responder injected. The AI is graded on humility, not just accuracy.</p>}
              {scan ? (
                <>
                  <div className="tr-vin mono">VIN {scan.vin}</div>
                  <div className="tr-ecus">
                    {scan.ecus.map((e) => (
                      <div className="tr-ecu" key={e.responseId}>
                        <span className="tr-rid mono">{e.responseId}</span>
                        <span className="tiny dim mono">{e.identifiers.find((i) => i.did === "F187")?.ascii ?? "—"}</span>
                        <span className="tiny dim">{e.dtcs.length} DTC · {e.supportedPids.length} svc</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="tiny dim mt-8">Hit “Scan bus” to interrogate the simulated Toyota.</p>
              )}
            </div>

            {/* AI result */}
            <div className="card">
              <div className="row spread">
                <h4>AI map {cmp && <span className="tr-score">{cmp.found}/{cmp.total} found · {cmp.catAcc}% cat · {cmp.readAcc}% mem · {cmp.supAcc}% sup</span>}</h4>
                <button className="tiny primary" onClick={() => void runAI()} disabled={!scan || running}>
                  {running ? "Mapping…" : "Run AI mapper"}
                </button>
              </div>
              {result ? (
                <>
                  <div className="tiny dim mt-8">{result.vehicle.year} {result.vehicle.make} {result.vehicle.model} · {result.vehicle.platform}</div>
                  <div className="tr-mods">
                    {result.modules.map((m) => (
                      <div className="tr-mod" key={m.responseId}>
                        <span className="tr-rid mono">{m.responseId}</span>
                        <span className="tr-mname">{m.name}</span>
                        <span className={`tr-conf ${m.confidence}`}>{m.confidence}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="tiny dim mt-8">{scan ? "Run the mapper to see what the AI infers." : "Scan the bus first."}</p>
              )}
            </div>
          </div>

          {/* comparison + raw report */}
          {cmp && result && scan && (
            <div className="card">
              <div className="row spread">
                <h4>Score vs gold {profile ? `${profile.make} ${profile.model}` : "vehicle"}</h4>
                <button className="tiny" onClick={() => void copyRaw()}>{copied ? "✓ Copied — paste to Claude" : "Copy RAW report"}</button>
              </div>
              <div className="tr-cmp">
                {cmp.rows.map((r) => (
                  <div className={`tr-row ${r.found ? "" : "miss"}`} key={r.responseId}>
                    <span className="mono">{r.found ? "✓" : "✗"} {r.responseId}</span>
                    <span className="tiny">{r.expLabel} <span className="dim">[{r.expCat}/{r.expRead}]</span></span>
                    <span className="tiny">→ {r.aiName} <span className={r.catOk ? "ok" : "bad"}>{r.aiCat}</span>/<span className={r.readOk ? "ok" : "bad"}>{r.aiRead}</span></span>
                  </div>
                ))}
              </div>
              {cmp.extra.length > 0 && <div className="tiny" style={{ color: "var(--warn)" }}>Extra/hallucinated ids: {cmp.extra.join(", ")}</div>}
            </div>
          )}

          {/* hard-mode robustness */}
          {rob && pert && (
            <div className="card tr-rob">
              <div className="row spread">
                <h4>Robustness under adversarial scan</h4>
                <span className={`tr-robscore ${rob.robustnessPct >= 80 ? "good" : rob.robustnessPct >= 50 ? "mid" : "bad"}`}>{rob.robustnessPct}%</span>
              </div>
              <div className="tr-robgrid">
                <div className="tr-robcell">
                  <span className="tr-robk">Resilience</span>
                  <span className="tr-robv">{rob.resilience.pct}%</span>
                  <span className="tiny dim">category survived on {rob.resilience.hit}/{rob.resilience.total} perturbed ECUs</span>
                </div>
                <div className="tr-robcell">
                  <span className="tr-robk">Honesty</span>
                  <span className="tr-robv">{rob.honesty.pct}%</span>
                  <span className="tiny dim">supplier left "unknown" on {rob.honesty.hit}/{rob.honesty.total} stripped ECUs</span>
                </div>
                <div className="tr-robcell">
                  <span className="tr-robk">Skepticism</span>
                  <span className="tr-robv">{rob.skepticism.handled ? "PASS" : "FAIL"}</span>
                  <span className="tiny dim">decoy {pert.decoyIds[0]}: {rob.skepticism.handled ? "stayed unsure" : "hallucinated a module"}</span>
                </div>
              </div>
              {rob.overconfident.length > 0 ? (
                <div className="tiny" style={{ color: "var(--danger)", marginTop: 8 }}>⚠ Over-confident &amp; wrong: {rob.overconfident.join(", ")}</div>
              ) : (
                <div className="tiny" style={{ color: "var(--accent)", marginTop: 8 }}>✓ No over-confident errors — confidence tracked correctness (correct humility).</div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const styles = `
.tr { display: flex; flex-direction: column; gap: 12px; }
.tr-intro h3 { margin: 0 0 4px; }
.tr-steps { margin: 8px 0 0; padding-left: 18px; line-height: 1.7; color: var(--fg-2); }
.tr-vehsel { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.tr-vehsel select { background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; font-size: 13px; min-width: 280px; }
.tr-err { font-size: 12px; color: var(--danger); background: var(--danger-dim); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 12px; }
.tr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
@media (max-width: 1000px) { .tr-grid { grid-template-columns: 1fr; } }
.tr-vin { font-size: 12px; color: var(--accent); margin: 8px 0; }
.tr-ecus, .tr-mods { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.tr-ecu, .tr-mod { display: flex; align-items: center; gap: 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 6px 9px; }
.tr-rid { color: var(--fg-0); font-weight: 700; min-width: 42px; }
.tr-mname { flex: 1; font-size: 12.5px; }
.tr-conf { font-size: 9px; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; }
.tr-conf.high { background: rgba(74,222,128,0.15); color: var(--accent); }
.tr-conf.medium { background: rgba(251,191,36,0.15); color: var(--warn); }
.tr-conf.low { background: rgba(239,68,68,0.15); color: var(--danger); }
.tr-score { font-size: 11px; color: var(--fg-2); font-family: var(--mono); }
.tr-cmp { display: flex; flex-direction: column; gap: 3px; margin: 8px 0; }
.tr-row { display: grid; grid-template-columns: 90px 1fr 1fr; gap: 8px; align-items: center; padding: 4px 6px; border-bottom: 1px solid var(--border); }
.tr-row.miss { background: rgba(239,68,68,0.06); }
.tr-row .ok { color: var(--accent); } .tr-row .bad { color: var(--danger); }
.tr-toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; }
.tr-toggle input { accent-color: var(--danger); }
.tr-hardtag { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; color: var(--danger); border: 1px solid var(--danger); border-radius: 4px; padding: 1px 5px; margin-left: 6px; vertical-align: middle; }
.tr-rob { border-color: var(--danger); }
.tr-robscore { font-family: var(--mono); font-size: 20px; font-weight: 700; }
.tr-robscore.good { color: var(--accent); } .tr-robscore.mid { color: var(--warn); } .tr-robscore.bad { color: var(--danger); }
.tr-robgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
@media (max-width: 700px) { .tr-robgrid { grid-template-columns: 1fr; } }
.tr-robcell { display: flex; flex-direction: column; gap: 2px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.tr-robk { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-2); }
.tr-robv { font-family: var(--mono); font-size: 18px; font-weight: 700; color: var(--fg-0); }
`;
