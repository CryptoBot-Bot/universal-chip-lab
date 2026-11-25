import { useEffect, useState } from "react";

import { labelSummary } from "@ecu/vehicle-db";
import type { CheckStatus, IdentifierLabel, VehicleModule, VehicleProfile } from "@ecu/vehicle-db";

import { Api, type VehicleExplorerEvent } from "../../lib/api";
import { fmtDate, plural } from "./vehicleFacts";

/**
 * What the swept identifiers are: names proposed by an AI from recorded bytes, each with the
 * verdict of the check. "Proven" = a value follows the car's own measured voltage or engine
 * speed in two states, readings the AI was never shown. Everything else is a proposal and is
 * shown as one. Works from what is on file: nothing is sent to a car.
 */
const VERDICT: Record<CheckStatus, { text: string; cls: string; title: string }> = {
  confirmed: { text: "proven", cls: "clean", title: "A value follows the car's own readings in two states. The AI was not shown those readings." },
  consistent: { text: "plausible", cls: "info", title: "Nothing speaks against it, but nothing proves it either." },
  unchecked: { text: "unchecked", cls: "unread", title: "There is nothing on file to check it with." },
  contradicted: { text: "wrong", cls: "fault", title: "The recorded bytes say otherwise." },
};
const num = (x: number) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100));

function Row({ l }: { l: IdentifierLabel }) {
  const v = VERDICT[l.check.status];
  const good = l.check.readings.filter((r) => r.status !== "contradicted");
  return (
    <li className="vdb-lab">
      <div className="vdb-lab-head"><span className="ual-mono">{l.id}</span><span className={`ual-chip ${v.cls}`} title={v.title}>{v.text}</span></div>
      <b>{l.name}</b>
      {good.map((r, i) => (
        <span key={i} className={r.status === "confirmed" ? "vdb-lab-val ok" : "vdb-lab-val"} title={r.note}>
          {r.status === "confirmed" ? "✓ " : ""}{r.name}: {r.at.map((a) => `${a.condition} ${[...new Set(a.values)].map(num).join(" / ")}`).join(" · ")} {r.unit}{l.check.status === "confirmed" && r.status !== "confirmed" ? " (not proven)" : ""}
        </span>
      ))}
      <span className="ual-muted">{l.why}{l.confidence === "low" ? " (the AI's confidence: low)" : ""}</span>
    </li>
  );
}

export function Labels({ profile, m, onProfile }: { profile: VehicleProfile; m: VehicleModule; onProfile?: (p: VehicleProfile) => void }) {
  const [busy, setBusy] = useState<{ done: number; of: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!busy) return;
    const off = Api.vehicleExplorer.onEvent((e: VehicleExplorerEvent) => { if (e.type === "label-module" && e.moduleId === m.id) setBusy({ done: e.done, of: e.of }); });
    return () => { off(); };
  }, [busy !== null, m.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!m.sweeps?.length) return null;
  const L = m.labels;
  const real = m.sweeps.filter((s) => !s.sim);
  const s = labelSummary(L, real.length ? real : m.sweeps);
  const of = (st: CheckStatus) => (L?.labels ?? []).filter((x) => x.kind !== "unknown" && x.check.status === st);
  const unknown = (L?.labels ?? []).filter((x) => x.kind === "unknown");
  const volts = L?.tracks?.filter((t) => t.quantity === "supply voltage") ?? [];
  const speed = L?.tracks?.filter((t) => t.quantity === "engine speed") ?? [];

  async function run() {
    setErr(null); setBusy({ done: 0, of: 0 });
    try { const r = await Api.vehicleExplorer.labelModule({ profileId: profile.id, moduleId: m.id }); onProfile?.(r.profile); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <div className="vdb-cov" aria-label="What this system's identifiers are">
      <div className="vdb-cov-head">
        <span className="vdb-caps-title">Names and proof</span>
        {L && <span className="ual-muted" style={{ marginLeft: "auto" }}>{fmtDate(L.at)}</span>}
      </div>
      {L ? (
        <>
          <div className="vdb-lab-counts">
            {(["confirmed", "consistent", "unchecked", "contradicted"] as const).filter((st) => s[st] > 0).map((st) => (
              <span key={st} className={`ual-chip strong ${VERDICT[st].cls}`} title={VERDICT[st].title}>{s[st]} {VERDICT[st].text}</span>
            ))}
            <span className="ual-chip unread" title="The AI said it cannot tell — kept as an honest answer.">{s.unknown} unknown</span>
          </div>
          <span>{s.named} of {plural(s.answered, "identifier")} named, {s.specific} of them with a value or an identity.</span>
          {of("confirmed").length > 0 && <details className="vdb-list" open><summary>Proven <span className="ual-muted">· {of("confirmed").length}</span></summary><ul className="vdb-labs">{of("confirmed").map((l) => <Row key={l.id} l={l} />)}</ul></details>}
          {of("contradicted").length > 0 && <details className="vdb-list"><summary>Wrong <span className="ual-muted">· {of("contradicted").length}</span></summary><ul className="vdb-labs">{of("contradicted").map((l) => <Row key={l.id} l={l} />)}</ul></details>}
          {of("consistent").length + of("unchecked").length > 0 && <details className="vdb-list"><summary>Proposals, not proven <span className="ual-muted">· {of("consistent").length + of("unchecked").length}</span></summary><ul className="vdb-labs">{[...of("consistent"), ...of("unchecked")].map((l) => <Row key={l.id} l={l} />)}</ul></details>}
          {unknown.length > 0 && <details className="vdb-list"><summary>Unknown <span className="ual-muted">· {unknown.length}</span></summary><p className="ual-mono vdb-cov-ids">{unknown.map((l) => l.id).join("  ")}</p></details>}
          {(volts.length > 0 || speed.length > 0) && (
            <details className="vdb-list"><summary>Found by code alone <span className="ual-muted">· {volts.length + speed.length}</span></summary>
              <p className="ual-muted" style={{ margin: "6px 0" }}>Fields whose value follows the measured {[volts.length ? `supply voltage (${volts.length}; luck alone would give about ${L.luck?.volts ?? 0})` : "", speed.length ? `engine speed (${speed.length}; luck about ${L.luck?.rpm ?? 0})` : ""].filter(Boolean).join(" and ")} in every state.</p>
              <ul className="vdb-labs">{[...volts, ...speed].slice(0, 24).map((t, i) => (
                <li key={i} className="vdb-lab"><span className="ual-mono">{t.id} · byte {t.offset}</span><span>{t.quantity}: {t.at.map((a) => `${a.condition} ${[...new Set(a.values)].map(num).join(" / ")}`).join(" · ")}</span></li>
              ))}</ul></details>
          )}
        </>
      ) : (
        <span className="ual-muted">Not named yet. An AI proposes what each identifier is from the recorded bytes; code then checks every number against the car's own readings, which the AI is not shown.</span>
      )}
      <div className="vdb-cov-actions">
        <button type="button" disabled={!!busy} onClick={() => void run()}>{busy ? (busy.of ? `Naming… ${busy.done}/${busy.of}` : "Naming…") : L ? "Name again" : "Name with AI"}</button>
        <span className="ual-muted">Offline · nothing is sent to the car · uses API tokens</span>
      </div>
      {err && <div className="ual-note err">{err}</div>}
    </div>
  );
}
