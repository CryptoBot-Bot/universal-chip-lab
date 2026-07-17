import { useEffect, useMemo, useRef, useState } from "react";

import {
  ModuleSim, type ModuleSimSpec, type SimScenario, type SimSession, type RunResult, type DumpResult,
  type CloneGuide, type CloneFeasibility,
} from "../../lib/moduleSim";

const VERDICT_LABEL: Record<CloneGuide["verdict"], string> = {
  "cloneable-bench": "✓ Cloneable · bench",
  "cloneable-obd": "✓ Cloneable · OBD",
  "partial": "◐ Partial clone only",
  "not-cloneable": "✗ Not cloneable",
};
const FEAS_LABEL: Record<CloneFeasibility, string> = {
  reliable: "reliable", supplemental: "supplemental", partial: "partial", "last-resort": "last resort", no: "not possible",
};
const FEAS_TONE: Record<CloneFeasibility, string> = {
  reliable: "ok", supplemental: "info", partial: "warn", "last-resort": "warn", no: "danger",
};

/**
 * The full pure-software module cockpit for a modelled ECU (Bosch MED17). Shows
 * everything you can do with the module on a bench: the CAN it broadcasts, session
 * control, SecurityAccess, live blocks, identification, DTCs + freeze frames,
 * actuator/routine tests, coding writes, and a flash/EEPROM clone read. Every
 * write-class action returns a clearly SIMULATED result — no hardware, no ceremony.
 */

interface LogLine { kind: "ok" | "warn" | "info"; text: string }

export function EcuSimulator({ spec }: { spec: ModuleSimSpec }) {
  const sim = useMemo(() => new ModuleSim(spec), [spec]);
  const [, setTick] = useState(0);
  const [scenario, setScenario] = useState<SimScenario>("idle");
  const [log, setLog] = useState<LogLine[]>([]);
  const [openDtc, setOpenDtc] = useState<string | null>(null);
  const [seed, setSeed] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [dump, setDump] = useState<DumpResult | null>(null);
  const [codeDraft, setCodeDraft] = useState<Record<string, string | number | boolean>>(
    () => Object.fromEntries(spec.coding.map((c) => [c.id, c.value])),
  );
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setInterval(() => { sim.step(250); setTick((n) => n + 1); }, 250);
    return () => clearInterval(id);
  }, [sim]);

  function say(r: RunResult | { ok?: boolean; text: string }, kind?: LogLine["kind"]) {
    const k = kind ?? (("ok" in r && r.ok === false) ? "warn" : "ok");
    setLog((l) => [...l.slice(-60), { kind: k, text: r.text }]);
    setTick((n) => n + 1);
    setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 0);
  }

  function pickScenario(s: SimScenario) { setScenario(s); sim.setScenario(s); }

  const broadcasts = sim.broadcasts();
  const live = sim.live();
  const dtcs = sim.currentDtcs();
  const clone = spec.cloning;

  return (
    <div className="es">
      <style>{styles}</style>

      <div className="es-bar">
        <span className="badge warn">SIMULATOR</span>
        <span className="tiny dim">{spec.blurb}</span>
        <div className="es-bar-right">
          <span className={`es-ign ${sim.ignitionOn ? "on" : ""}`}>{sim.ignitionOn ? "KL15 ON" : "KL15 OFF"}</span>
          <span className={`badge ${sim.session === "default" ? "dim" : "info"}`}>{sim.session} session</span>
          <span className={`badge ${sim.secured ? "ok" : "dim"}`}>{sim.secured ? "🔓 secured" : "🔒 locked"}</span>
          <div className="seg tiny">
            {(["off", "idle", "drive", "rev"] as SimScenario[]).map((s) => (
              <button key={s} className={scenario === s ? "active" : ""} onClick={() => pickScenario(s)}>{s}</button>
            ))}
          </div>
        </div>
      </div>

      {/* CAN bus monitor */}
      <section className="es-card">
        <h4>CAN bus — broadcast frames <span className="tiny dim">{spec.reqId} diag · what the ECU puts on the wire</span></h4>
        {broadcasts.length === 0 ? (
          <div className="tiny dim">Bus is quiet — ignition (KL15) is off. Pick idle/drive/rev to wake it.</div>
        ) : (
          <table className="es-bus">
            <thead><tr><th>ID</th><th>Frame</th><th>Bytes</th><th>Decoded</th><th>cyc</th></tr></thead>
            <tbody>
              {broadcasts.map((b) => (
                <tr key={b.id}>
                  <td className="mono es-canid">{b.id}</td>
                  <td className="tiny">{b.label}</td>
                  <td className="mono tiny es-bytes">{b.hex}</td>
                  <td className="tiny">{b.signals.map((s) => `${s.name} ${s.value}`).join(" · ")}</td>
                  <td className="tiny dim">{b.cycleMs}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="es-grid">
        {/* Live data */}
        <section className="es-card">
          <h4>Live measurement blocks <span className="badge dim">{live.length}</span></h4>
          <div className="es-live">
            {live.map((r) => (
              <div key={r.id} className="es-live-cell">
                <div className="es-live-v mono">{r.value.toFixed(r.decimals)}<span className="es-live-u">{r.unit}</span></div>
                <div className="es-live-l">{r.label}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Identification */}
        <section className="es-card">
          <h4>Identification <span className="tiny dim">ReadDataByIdentifier · 0x22</span></h4>
          <table className="es-kv">
            <tbody>{spec.dids.map((d) => (
              <tr key={d.id}><td className="mono dim">{d.id}</td><td>{d.label}</td><td className="mono">{d.value}</td></tr>
            ))}</tbody>
          </table>
        </section>
      </div>

      <div className="es-grid">
        {/* DTCs */}
        <section className="es-card">
          <h4>Fault codes <span className="tiny dim">0x19 · ReadDTCInformation</span> {dtcs.length > 0 && <span className="badge danger">{dtcs.length}</span>}</h4>
          {dtcs.length === 0
            ? <div className="tiny dim">No fault codes present.</div>
            : (
              <ul className="es-dtcs">
                {dtcs.map((d) => (
                  <li key={d.code}>
                    <button className="es-dtc" onClick={() => setOpenDtc(openDtc === d.code ? null : d.code)}>
                      <b className="mono">{d.code}</b>
                      <span className={`badge ${d.status === "stored" ? "danger" : d.status === "permanent" ? "warn" : "dim"}`}>{d.status}</span>
                      <span className="mono tiny dim">stat 0x{d.statusByte}</span>
                      <span className="es-dtc-desc">{d.desc}</span>
                    </button>
                    {openDtc === d.code && d.freeze && (
                      <div className="es-freeze">
                        <div className="tiny dim">Freeze frame (0x19 04):</div>
                        {d.freeze.map((f, i) => <span key={i} className="es-fz"><b>{f.name}</b> {f.value}</span>)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          <button className="tiny" style={{ marginTop: 8 }} onClick={() => say(sim.clearDtcs())}>Clear fault memory (0x14)</button>
        </section>

        {/* Session + security */}
        <section className="es-card">
          <h4>Session &amp; security</h4>
          <div className="es-row">
            <span className="tiny dim">Session</span>
            <div className="seg tiny">
              {(["default", "extended", "programming"] as SimSession[]).map((s) => (
                <button key={s} className={sim.session === s ? "active" : ""} onClick={() => say(sim.setSession(s))}>{s}</button>
              ))}
            </div>
          </div>
          <div className="es-sec">
            <button className="tiny" onClick={() => { const r = sim.requestSeed(); setSeed(r.seed); say({ text: r.text }, "info"); }}>Request seed (27 {spec.securityLevel})</button>
            {seed && <span className="mono tiny">seed {seed}</span>}
            <input className="mono es-key" placeholder="key e.g. A1 B2 C3 D4" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
            <button className="tiny primary" onClick={() => say(sim.sendKey(keyInput))}>Send key</button>
          </div>
          <div className="tiny dim">SecurityAccess unlocks coding &amp; protected routines (simulated seed/key).</div>
        </section>
      </div>

      <div className="es-grid">
        {/* Actuator / routine tests */}
        <section className="es-card">
          <h4>Actuator &amp; routine tests <span className="tiny dim">0x2F / 0x31</span></h4>
          <div className="es-routines">
            {spec.routines.map((r) => (
              <button key={r.id} className={`es-routine ${r.risk === "read" ? "" : "risk"}`} onClick={() => say(sim.runRoutine(r))}>
                <span>{r.label}</span>
                <span className="es-routine-meta">
                  <span className="mono tiny dim">{r.request}</span>
                  {(r.needsSecurity) && <span className="badge warn tiny">sec</span>}
                  {(r.needsSession && !r.needsSecurity) && <span className="badge info tiny">ext</span>}
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* Coding / adaptation */}
        <section className="es-card">
          <h4>Coding &amp; adaptation <span className="tiny dim">0x2E · WriteDataByIdentifier</span></h4>
          <div className="es-coding">
            {spec.coding.map((c) => (
              <div key={c.id} className="es-code-row">
                <span className="es-code-l">{c.label}</span>
                {c.type === "bool" ? (
                  <input type="checkbox" disabled={!c.editable} checked={!!codeDraft[c.id]}
                    onChange={(e) => setCodeDraft((d) => ({ ...d, [c.id]: e.target.checked }))} />
                ) : (
                  <input className="mono es-code-in" disabled={!c.editable} value={String(codeDraft[c.id])}
                    onChange={(e) => setCodeDraft((d) => ({ ...d, [c.id]: c.type === "number" ? Number(e.target.value) : e.target.value }))} />
                )}
                {c.unit && <span className="tiny dim">{c.unit}</span>}
                {c.editable
                  ? <button className="tiny" onClick={() => say(sim.setCoding(c.id, codeDraft[c.id]))}>Write</button>
                  : <span className="badge dim tiny">read-only</span>}
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Clone / flash read + how to actually clone it */}
      <section className="es-card es-clone">
        <h4>Clone — memory read <span className="tiny dim">the source dump for a bench clone</span></h4>

        <div className={`es-verdict ${clone.verdict}`}>
          <span className="es-verdict-badge">{VERDICT_LABEL[clone.verdict]}</span>
          <span>{clone.headline}</span>
        </div>
        <p className="es-clone-summary">{clone.summary}</p>

        <div className="es-methods">
          {clone.methods.map((m) => (
            <div key={m.tier} className={`es-method f-${m.feasibility}`}>
              <div className="es-method-head">
                <b>{m.tier}</b>
                <span className={`badge ${FEAS_TONE[m.feasibility]}`}>{FEAS_LABEL[m.feasibility]}</span>
              </div>
              <div className="es-method-what">{m.what}</div>
              <div className="tiny"><b className="dim">How: </b>{m.how}</div>
              <div className="tiny dim"><b>Tools: </b>{m.tools}</div>
            </div>
          ))}
        </div>

        <div className="es-mem">
          <div className="es-mem-title tiny dim">What's inside — and how each part is read</div>
          <table className="es-memtab">
            <thead><tr><th>Region</th><th>Size</th><th>Holds</th><th>Read via</th></tr></thead>
            <tbody>{clone.memoryMap.map((r) => (
              <tr key={r.region}><td>{r.region}</td><td className="mono tiny">{r.size}</td><td className="tiny">{r.holds}</td><td className="tiny">{r.readVia}</td></tr>
            ))}</tbody>
          </table>
        </div>

        <div className="es-donor tiny">🔑 <b>Donor matching:</b> {clone.donorNote}</div>

        <div className="es-proceed">
          <div className="es-proceed-title">Proceed with the clone — the safe order</div>
          <ol className="es-steps">{clone.ceremonySteps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          <div className="tiny dim">The gated donor write happens in the clone-job flow (the 5-part Cloning Ceremony). This simulator produces the verified source dump.</div>
        </div>

        <div className="es-row" style={{ gap: 8, marginTop: 6 }}>
          <button className="tiny primary" onClick={() => setDump(sim.dumpMemory("flash"))}>① Read flash ({(spec.memory.flashKb / 1024).toFixed(0)} MB)</button>
          <button className="tiny" onClick={() => setDump(sim.dumpMemory("eeprom"))}>Read EEPROM ({spec.memory.eepromKb} KB)</button>
        </div>
        {spec.memory.note && <div className="tiny warn" style={{ marginTop: 6 }}>ℹ {spec.memory.note}</div>}
        {dump && (
          <div className="es-dump">
            <div className="tiny">Read <b>{dump.region.toUpperCase()}</b> · {(dump.sizeBytes / 1024).toFixed(0)} KB · CRC32 <span className="mono">{dump.crc32}</span> · ~{dump.durationS}s · <span className="ok">verified dump</span></div>
            <pre className="es-hex">{dump.previewHex}</pre>
            <div className="tiny dim">Simulated image. On real hardware this archives to Dumps as the clone source; writing the donor goes through the Cloning Ceremony (5-part gate).</div>
          </div>
        )}
      </section>

      {/* Response log */}
      <section className="es-card">
        <h4>Response log</h4>
        <div className="es-log" ref={logRef}>
          {log.length === 0 && <div className="tiny dim">Actions and simulated ECU responses appear here.</div>}
          {log.map((l, i) => <div key={i} className={`es-log-line ${l.kind}`}>{l.text}</div>)}
        </div>
      </section>
    </div>
  );
}

const styles = `
.es { display: flex; flex-direction: column; gap: 12px; }
.es-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.es-bar-right { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
.es-ign { font-size: 11px; font-weight: 700; letter-spacing: .05em; color: var(--fg-2); border: 1px solid var(--border); border-radius: 5px; padding: 2px 7px; }
.es-ign.on { color: var(--accent); border-color: var(--accent-dim); }
.es-card { background: var(--bg-1); border: 1px solid var(--border); border-radius: 12px; padding: 13px 15px; }
.es-card h4 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: var(--fg-2); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.es-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.es-bus { width: 100%; border-collapse: collapse; font-size: 12px; }
.es-bus th { text-align: left; font-weight: 500; color: var(--fg-2); font-size: 11px; padding: 0 8px 5px 0; }
.es-bus td { padding: 3px 8px 3px 0; border-top: 1px solid var(--border); vertical-align: top; }
.es-canid { color: var(--info); font-weight: 600; }
.es-bytes { color: var(--fg-1); letter-spacing: .02em; }
.es-live { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 7px; }
.es-live-cell { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; }
.es-live-v { font-size: 16px; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
.es-live-u { font-size: 10px; color: var(--fg-2); margin-left: 3px; }
.es-live-l { font-size: 10.5px; color: var(--fg-2); margin-top: 2px; }
.es-kv { width: 100%; border-collapse: collapse; font-size: 12px; }
.es-kv td { padding: 3px 8px 3px 0; border-top: 1px solid var(--border); }
.es-dtcs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.es-dtc { width: 100%; text-align: left; display: flex; align-items: center; gap: 8px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 6px 9px; cursor: pointer; font-size: 12.5px; }
.es-dtc:hover { border-color: var(--border-strong); }
.es-dtc-desc { color: var(--fg-1); }
.es-freeze { display: flex; flex-wrap: wrap; gap: 8px; padding: 7px 9px; }
.es-fz { font-size: 11.5px; background: var(--bg-0); border: 1px solid var(--border); border-radius: 6px; padding: 2px 7px; }
.es-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.es-sec { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.es-key { width: 150px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; color: var(--fg-0); padding: 5px 8px; font-size: 12px; }
.es-routines { display: grid; grid-template-columns: 1fr; gap: 5px; }
.es-routine { display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; cursor: pointer; font-size: 12.5px; }
.es-routine:hover { border-color: var(--accent); }
.es-routine.risk { border-left: 2px solid var(--warn); }
.es-routine-meta { display: flex; align-items: center; gap: 6px; }
.es-coding { display: flex; flex-direction: column; gap: 6px; }
.es-code-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.es-code-l { flex: 1; }
.es-code-in { width: 92px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; color: var(--fg-0); padding: 4px 7px; font-size: 12px; }
.es-clone { border-color: var(--border-strong); }
.es-verdict { display: flex; align-items: center; gap: 10px; font-size: 13px; padding: 9px 12px; border-radius: 9px; background: var(--bg-2); border: 1px solid var(--border); }
.es-verdict.cloneable-bench, .es-verdict.cloneable-obd { border-color: var(--accent); }
.es-verdict.partial { border-color: var(--warn); }
.es-verdict.not-cloneable { border-color: var(--danger); }
.es-verdict-badge { font-size: 11px; font-weight: 700; white-space: nowrap; padding: 3px 9px; border-radius: 6px; background: var(--bg-0); }
.es-verdict.cloneable-bench .es-verdict-badge, .es-verdict.cloneable-obd .es-verdict-badge { color: var(--accent); }
.es-verdict.partial .es-verdict-badge { color: var(--warn); }
.es-verdict.not-cloneable .es-verdict-badge { color: var(--danger); }
.es-clone-summary { font-size: 12.5px; color: var(--fg-1); line-height: 1.6; margin: 10px 0; }
.es-methods { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.es-method { background: var(--bg-2); border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px; display: flex; flex-direction: column; gap: 4px; }
.es-method.f-reliable { border-left: 3px solid var(--accent); }
.es-method.f-supplemental { border-left: 3px solid var(--info); }
.es-method.f-partial, .es-method.f-last-resort { border-left: 3px solid var(--warn); }
.es-method-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.es-method-what { font-size: 12px; color: var(--fg-1); }
.es-mem { margin-top: 10px; }
.es-mem-title { margin-bottom: 4px; }
.es-memtab { width: 100%; border-collapse: collapse; font-size: 12px; }
.es-memtab th { text-align: left; font-weight: 500; color: var(--fg-2); font-size: 11px; padding: 0 8px 5px 0; }
.es-memtab td { padding: 4px 8px 4px 0; border-top: 1px solid var(--border); vertical-align: top; }
.es-donor { margin-top: 10px; background: var(--warn-dim); border: 1px solid rgba(251,191,36,.35); border-radius: 8px; padding: 9px 11px; line-height: 1.55; color: var(--fg-1); }
.es-proceed { margin-top: 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 9px; padding: 10px 13px; }
.es-proceed-title { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--accent); margin-bottom: 6px; }
.es-steps { margin: 0 0 6px; padding-left: 18px; font-size: 12.5px; line-height: 1.7; color: var(--fg-1); }
.es-dump { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.es-hex { font-family: var(--mono); font-size: 10.5px; line-height: 1.4; color: var(--fg-1); background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow-x: auto; margin: 0; white-space: pre; max-height: 180px; }
.es-log { display: flex; flex-direction: column; gap: 3px; max-height: 200px; overflow-y: auto; font-size: 12px; }
.es-log-line { padding: 4px 8px; border-radius: 6px; line-height: 1.4; }
.es-log-line.ok { background: rgba(74,222,128,.07); }
.es-log-line.warn { background: var(--warn-dim); color: var(--warn); }
.es-log-line.info { background: rgba(96,165,250,.07); }
@media (max-width: 760px) { .es-grid { grid-template-columns: 1fr; } }
`;
