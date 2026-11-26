import { useEffect, useRef, useState } from "react";

import type { VehicleProfile } from "@ecu/vehicle-db";

import { Api, type MechanicEvent } from "../../lib/api";
import { voltageView, voltsText } from "../../lib/voltage";
import { useWorkbench } from "../../lib/workbench";

/**
 * Ask the mechanic — stage 1: it can look at the car, not act on it. It finds values in this
 * vehicle's catalog, reads them live, and explains the fault codes on file. Every value shows
 * how far it is trusted.
 */
type Turn = { role: "user" | "assistant"; text: string; notes: string[]; values: Extract<MechanicEvent, { type: "values" }>["values"] };
const TRUST: Record<string, { text: string; cls: string }> = {
  proven: { text: "proven", cls: "clean" }, standard: { text: "standard", cls: "clean" }, fits: { text: "fits", cls: "info" }, ai: { text: "AI guess", cls: "warn" },
};
const QUICK = ["What do the fault codes mean, and what would you check first?", "How is the battery and charging?", "Show me the engine's live data.", "Is the engine warm?"];
const num = (v: number | string | null) => (v === null ? "—" : typeof v === "number" ? String(Math.round(v * 100) / 100) : v);

export function MechanicChat({ profile, vin, host, iface, online, demo, deviceName }: {
  profile: VehicleProfile; vin: string; host: string; iface: string; online: boolean; demo: boolean; deviceName: string;
}) {
  const wb = useWorkbench();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ tokensIn: number; tokensOut: number; costUsd: number; model: string } | null>(null);
  const session = useRef(`m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  const end = useRef<HTMLDivElement>(null);

  // a new vehicle starts a new conversation
  useEffect(() => { setTurns([]); setUsage(null); session.current = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }, [profile.id, vin]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [turns]);

  const update = (f: (t: Turn) => Turn) => setTurns((list) => list.map((t, i) => (i === list.length - 1 ? f(t) : t)));

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setInput(""); setErr(null); setBusy(true);
    setTurns((t) => [...t, { role: "user", text: question, notes: [], values: [] }, { role: "assistant", text: "", notes: [], values: [] }]);
    const off = Api.mechanic.onEvent((e) => {
      if (e.sessionId !== session.current) return;
      const ev = e.event;
      if (ev.type === "text") update((t) => ({ ...t, text: t.text + ev.delta }));
      else if (ev.type === "found") update((t) => ({ ...t, notes: [...t.notes, `looked for "${ev.query}": ${ev.items.length} found`] }));
      else if (ev.type === "values") update((t) => ({ ...t, values: [...t.values, ...ev.values] }));
      else if (ev.type === "done") setUsage((u) => ({ tokensIn: (u?.tokensIn ?? 0) + ev.tokensIn, tokensOut: (u?.tokensOut ?? 0) + ev.tokensOut, costUsd: (u?.costUsd ?? 0) + (ev.costUsd ?? 0), model: ev.model }));
    });
    const r = wb.voltage.reading;
    const volt = online && r?.volts != null ? `${voltsText(r.volts)} (${voltageView(r.volts, r.rpm).what}${wb.voltage.status ? `, ${wb.voltage.status}` : ""})` : undefined;
    const device = !online ? "no device connected — nothing can be read live" : demo ? "the desk simulator, replaying a recording of this van — values are replayed, not live" : `${deviceName} on ${iface}, read-only`;
    try { await Api.mechanic.ask({ sessionId: session.current, profileId: profile.id, vin, host: online ? host : undefined, iface, question, voltage: volt, device }); }
    catch (e) { setErr((e as Error).message); }
    finally { off(); setBusy(false); }
  }

  return (
    <div className="mc">
      <div className="ual-card pad mc-head">
        <div>
          <h2 className="ual-h2">Ask the mechanic</h2>
          <span className="ual-muted">It can look at the car — read values, explain codes — but not act on it. Every value says how far it is trusted.</span>
        </div>
        {turns.length > 0 && <button type="button" className="ghost tiny" disabled={busy} onClick={() => { setTurns([]); setUsage(null); void Api.mechanic.reset({ sessionId: session.current }); }}>New conversation</button>}
      </div>

      <div className="ual-card pad mc-log" aria-live="polite">
        {turns.length === 0 && (
          <div className="mc-quick">
            {QUICK.map((q) => <button key={q} type="button" className="ghost" onClick={() => void ask(q)}>{q}</button>)}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`mc-turn ${t.role}`}>
            {t.notes.length > 0 && <div className="ual-muted mc-notes">{t.notes.join(" · ")}</div>}
            {t.values.length > 0 && (
              <table className="mc-values"><tbody>{t.values.map((v, k) => (
                <tr key={k}><td>{v.name}<span className="ual-muted"> · {v.module}</span></td><td className="ual-mono">{v.value === null ? <span className="ual-muted" title={v.error}>no value</span> : `${num(v.value)} ${v.unit}`}</td><td><span className={`ual-chip ${TRUST[v.trust]?.cls ?? "unread"}`} title={v.source}>{TRUST[v.trust]?.text ?? v.trust}</span></td></tr>
              ))}</tbody></table>
            )}
            {(t.text || (busy && i === turns.length - 1 && t.role === "assistant")) && <div className="mc-text">{t.text || "…"}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>

      <form className="mc-input" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
        <input aria-label="Your question" placeholder={online ? "Ask about this vehicle…" : "Ask about this vehicle (no device connected — it works from what is on file)"} value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
        {busy ? <button type="button" onClick={() => void Api.mechanic.stop()}>Stop</button> : <button type="submit" className="primary" disabled={!input.trim()}>Ask</button>}
      </form>
      <span className="ual-muted mc-foot">
        Read-only · {usage ? `${usage.model} · ${usage.tokensIn.toLocaleString()} in / ${usage.tokensOut.toLocaleString()} out · about $${usage.costUsd.toFixed(2)} so far` : "uses API tokens per question"}
      </span>
      {err && <div className="ual-note err">{err}</div>}
    </div>
  );
}
