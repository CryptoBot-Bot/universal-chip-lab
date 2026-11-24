import { useEffect, useState } from "react";

import { explainWrite, type PendingWrite, type WriteSeverity } from "../lib/writeActions";

/**
 * The write confirmation dialog. Every write/actuator/security/calibration action
 * passes through here with a full, detailed briefing of exactly what will happen,
 * the risks, and the preconditions — plus an explicit consent step (a checkbox, or
 * a typed phrase for critical actions). Nothing writes without this.
 */

interface Props {
  pending: PendingWrite | null;
  onCancel: () => void;
  onConfirm: () => void;
  /**
   * Where the write goes — the dialog must never call a real write "simulated".
   *   "simulated" (default)  the in-app software simulator of the 3D cockpit / inspector;
   *   "vehicle"              the bus the device is connected to: a real module;
   *   "demo"                 the desk simulator's virtual vehicle (no hardware).
   */
  target?: "simulated" | "vehicle" | "demo";
}

const SEV: Record<WriteSeverity, { label: string; color: string }> = {
  moderate: { label: "MODERATE", color: "#eab308" },
  high: { label: "HIGH RISK", color: "#f97316" },
  critical: { label: "CRITICAL", color: "#ef4444" },
};

export function WriteConfirmModal({ pending, onCancel, onConfirm, target = "simulated" }: Props) {
  const [ack, setAck] = useState(false);
  const [phrase, setPhrase] = useState("");

  // Reset only when the *action* changes — not on every parent re-render (the live
  // gauge polling re-renders ~10×/s and would otherwise keep clearing the checkbox).
  const pendingKey = pending ? `${pending.moduleLabel}::${pending.label}::${pending.request}` : "";
  useEffect(() => { setAck(false); setPhrase(""); }, [pendingKey]);

  if (!pending) return null;
  const ex = explainWrite(pending);
  const sev = SEV[ex.severity];
  const ready = ex.confirmPhrase ? phrase.trim().toUpperCase() === ex.confirmPhrase : ack;

  return (
    <div className="wc-backdrop" onClick={onCancel}>
      <style>{styles}</style>
      <div className="wc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wc-head" style={{ borderColor: sev.color }}>
          <span className="wc-sev" style={{ background: sev.color }}>{sev.label}</span>
          <div>
            <div className="wc-title">Confirm write · {pending.label}</div>
            <div className="tiny dim mono">{pending.moduleLabel} · {pending.request}</div>
          </div>
        </div>

        <p className="wc-summary">{ex.summary}</p>

        <div className="wc-cols">
          <section>
            <h5>What will happen</h5>
            <ul className="wc-what">{ex.whatHappens.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </section>
          <section>
            <h5 className="wc-risk-h">Risks &amp; consequences</h5>
            <ul className="wc-risk">{ex.risks.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </section>
          <section>
            <h5>Before you proceed</h5>
            <ul className="wc-pre">{ex.preconditions.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </section>
        </div>

        {target === "vehicle" ? (
          <div className="wc-safety" style={{ borderColor: "var(--danger)" }}>
            <strong>This is sent to the vehicle.</strong> The request goes out on the bus the device is connected to and
            the module acts on it for real. Stable battery voltage, ignition on, and nobody working on the car.
          </div>
        ) : target === "demo" ? (
          <div className="wc-safety">
            <strong>Demo vehicle.</strong> The device is the desk simulator — the request goes to a virtual car on this
            PC and nothing real is touched. On a real car this same button sends for real.
          </div>
        ) : ex.touchesMemory ? (
          <div className="wc-safety">
            <strong>Simulated in the cockpit.</strong> This is a <strong>memory write</strong> — the clone / reflash
            path. On real hardware it routes through the Cloning Ceremony (donor image archived, verified, rollback
            ready) and never runs on an unstable supply.
          </div>
        ) : (
          <div className="wc-safety">
            <strong>Simulated in the cockpit.</strong> This is a <strong>diagnostic bus command</strong>, not a memory
            clone — it doesn't read or write a .bin. On real hardware, just ensure the right preconditions and stable power.
          </div>
        )}

        <div className="wc-consent">
          {ex.confirmPhrase ? (
            <label className="wc-phrase">
              Type <span className="mono wc-phrase-word">{ex.confirmPhrase}</span> to confirm:
              <input className="mono" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoFocus />
            </label>
          ) : (
            <label className="wc-check">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I understand what this does and the consequences above.
            </label>
          )}
        </div>

        <div className="wc-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="wc-go" style={{ background: ready ? sev.color : undefined }} disabled={!ready} onClick={onConfirm}>
            {target === "vehicle" ? "Send to the vehicle" : target === "demo" ? "Send (demo vehicle)" : "Proceed (simulated)"}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = `
.wc-backdrop { position: fixed; inset: 0; background: rgba(3,6,12,0.72); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 24px; }
.wc-modal { width: min(680px, 100%); max-height: 88vh; overflow-y: auto; background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 14px; padding: 20px; box-shadow: 0 24px 80px rgba(0,0,0,0.6); }
.wc-head { display: flex; align-items: center; gap: 12px; padding-bottom: 12px; border-bottom: 2px solid; margin-bottom: 12px; }
.wc-sev { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: #0a0a0a; padding: 3px 9px; border-radius: 5px; }
.wc-title { font-size: 15px; font-weight: 600; }
.wc-summary { font-size: 13.5px; color: var(--fg-0); margin: 0 0 14px; }
.wc-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
.wc-cols h5 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-2); }
.wc-cols h5.wc-risk-h { color: var(--danger); }
.wc-cols ul { margin: 0; padding-left: 16px; }
.wc-cols li { font-size: 12px; line-height: 1.55; margin-bottom: 4px; }
.wc-risk li { color: #fca5a5; }
.wc-safety { margin-top: 14px; font-size: 12px; line-height: 1.55; color: var(--fg-1); background: var(--bg-2); border: 1px solid var(--accent); border-radius: 9px; padding: 10px 12px; }
.wc-safety strong { color: var(--accent); }
.wc-consent { margin-top: 14px; }
.wc-check, .wc-phrase { display: flex; align-items: center; gap: 9px; font-size: 13px; color: var(--fg-0); flex-wrap: wrap; }
.wc-phrase input { padding: 6px 9px; background: var(--bg-2); border: 1px solid var(--border-strong); border-radius: 7px; color: var(--fg-0); letter-spacing: 0.12em; }
.wc-phrase-word { color: var(--danger); font-weight: 700; }
.wc-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.wc-actions button { padding: 9px 18px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--bg-2); color: var(--fg-0); font-size: 13px; cursor: pointer; }
.wc-go { border: none; color: #0a0a0a; font-weight: 700; }
.wc-go:disabled { background: var(--bg-2); color: var(--fg-2); cursor: not-allowed; }
`;
