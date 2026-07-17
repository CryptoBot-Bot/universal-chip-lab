import { useEffect, useRef, useState } from "react";

import type { BenchModuleProfile } from "@ecu/vehicle-db";

import { Api, type ExplorerEvent, type ExplorerResult, type ExplorerRun, type PriorKnowledge } from "../../lib/api";

/**
 * Live popup for the AI Module Explorer. Runs the autonomous read-only agent on
 * the real module and streams its thoughts, actions and observations while it maps
 * the module; a growing "Understanding" panel fills from its findings, and the
 * verified result can be saved back into the module (growing the library).
 *
 * Every run is recorded (transcript + result + token cost + what was NEW) and the
 * next run is seeded with everything verified so far — a self-improving loop. The
 * raw log is copyable so it can be pasted for analysis.
 */

type Item =
  | { k: "thought"; text: string }
  | { k: "action"; tool: string; input: unknown }
  | { k: "obs"; tool: string; summary: string; detail?: string }
  | { k: "finding"; kind: string; title: string; detail: string }
  | { k: "status"; text: string }
  | { k: "error"; text: string };

const TOOL_LABEL: Record<string, string> = { scan_bus: "Scan bus", probe: "Probe", record: "Record", conclude: "Conclude" };

function kfmt(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

export function ModuleExplorer({ module, host, iface, tx, rx, onClose, onApply }: {
  module: BenchModuleProfile;
  host: string; iface: string; tx: string; rx: string;
  onClose: () => void;
  onApply?: (updated: BenchModuleProfile) => Promise<void>;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [findings, setFindings] = useState<{ kind: string; title: string; detail: string }[]>([]);
  const [result, setResult] = useState<ExplorerResult | null>(null);
  const [running, setRunning] = useState(false);
  const [applied, setApplied] = useState(false);
  const [benchVerified, setBenchVerified] = useState(false);
  const [enrich, setEnrich] = useState<{ info: number; codes: number; live: number; bus: number; caps: number } | null>(null);
  const [usage, setUsage] = useState<{ in: number; out: number; steps: number } | null>(null);
  const [prior, setPrior] = useState<PriorKnowledge | null>(null);
  const [runs, setRuns] = useState<ExplorerRun[]>([]);
  const [copied, setCopied] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const logRef = useRef<string[]>([]);
  const startedAtRef = useRef<string>("");
  const priorRef = useRef<PriorKnowledge | null>(null);

  useEffect(() => () => { unsubRef.current?.(); }, []);
  useEffect(() => { streamRef.current?.scrollTo(0, streamRef.current.scrollHeight); }, [items]);
  useEffect(() => { void refreshRuns(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const bus = module.buses[0];
  const knownIdentity = module.partNumbers[0] || module.displayName;

  async function refreshRuns() {
    try { setRuns(await Api.moduleExplorer.listRuns(module.id)); } catch { /* fresh */ }
  }

  function logLine(e: ExplorerEvent) {
    if (e.type === "thought") logRef.current.push(`💭 ${e.text}`);
    else if (e.type === "action") logRef.current.push(`→ ${TOOL_LABEL[e.tool] ?? e.tool}  ${summarizeInput(e.tool, e.input)}`);
    else if (e.type === "observation") logRef.current.push(`← ${e.summary}${e.detail ? "\n    " + e.detail.replace(/\n/g, "\n    ") : ""}`);
    else if (e.type === "finding") logRef.current.push(`✓ ${e.kind}: ${e.title} — ${e.detail}`);
    else if (e.type === "status") logRef.current.push(`• ${e.text}`);
    else if (e.type === "error") logRef.current.push(`✕ ${e.text}`);
  }

  async function run() {
    setItems([]); setFindings([]); setResult(null); setApplied(false); setRunning(true); setUsage(null); setPrior(null);
    logRef.current = []; startedAtRef.current = new Date().toISOString(); priorRef.current = null;
    unsubRef.current?.();
    unsubRef.current = Api.moduleExplorer.onEvent((e: ExplorerEvent) => {
      logLine(e);
      if (e.type === "thought") setItems((l) => [...l, { k: "thought", text: e.text }]);
      else if (e.type === "action") setItems((l) => [...l, { k: "action", tool: e.tool, input: e.input }]);
      else if (e.type === "observation") setItems((l) => [...l, { k: "obs", tool: e.tool, summary: e.summary, detail: e.detail }]);
      else if (e.type === "finding") { setItems((l) => [...l, { k: "finding", kind: e.kind, title: e.title, detail: e.detail }]); setFindings((f) => [...f, { kind: e.kind, title: e.title, detail: e.detail }]); }
      else if (e.type === "status") setItems((l) => [...l, { k: "status", text: e.text }]);
      else if (e.type === "error") setItems((l) => [...l, { k: "error", text: e.text }]);
      else if (e.type === "usage") setUsage({ in: e.inputTokens, out: e.outputTokens, steps: e.steps });
      else if (e.type === "prior") { setPrior(e.knowledge); priorRef.current = e.knowledge; }
      else if (e.type === "done") setResult(e.result);
    });
    try {
      const d = module.diagnostics;
      const r = await Api.moduleExplorer.start({
        host, iface, tx: tx.replace(/\s/g, ""), rx: rx.replace(/\s/g, ""),
        module: {
          moduleId: module.id, displayName: module.displayName, brand: module.brand, category: module.category,
          protocol: bus?.protocol ?? "unknown", capabilities: d.capabilities,
          identity: knownIdentity, knownDtcs: d.knownDtcs,
          // The full current record — the agent verifies each field and fills the gaps.
          skeleton: {
            partNumbers: module.partNumbers,
            applications: module.applications ?? [],
            bitrate: bus?.bitrate, fd: bus?.fd,
            sessions: d.sessions ?? [],
            services: d.sampleServices ?? [],
            identification: (d.identification ?? []).map((x) => ({ id: x.id, label: x.label, value: x.value, session: x.session })),
            liveData: (d.liveData ?? []).map((x) => ({ id: x.id, label: x.label, session: x.session })),
            broadcastFrames: (d.broadcastFrames ?? []).map((x) => ({ canId: x.canId, hz: x.hz, decode: x.decode })),
            operations: (d.operations ?? []).map((x) => ({ op: x.op, status: x.status, request: x.request, session: x.session })),
            dtcs: d.knownDtcs,
            cloneVerdict: module.cloneGuide?.verdict,
          },
        },
      });
      setResult(r);
      await persistRun(r);
    } catch (e) {
      setItems((l) => [...l, { k: "error", text: (e as Error).message }]);
    } finally {
      setRunning(false); unsubRef.current?.(); unsubRef.current = null;
    }
  }

  async function stop() { try { await Api.moduleExplorer.stop(); } catch { /* ignore */ } }

  async function persistRun(r: ExplorerResult) {
    const run: ExplorerRun = {
      id: `run-${Date.now()}`, moduleId: module.id, displayName: module.displayName,
      iface, tx, rx,
      startedAt: startedAtRef.current || new Date().toISOString(), endedAt: new Date().toISOString(),
      outcome: r.outcome, result: r, newFindings: r.newFindings, priorRunCount: priorRef.current?.runCount ?? 0,
      tokensIn: r.tokensIn, tokensOut: r.tokensOut, steps: r.steps,
      transcript: buildTranscript(r),
    };
    try { setRuns(await Api.moduleExplorer.saveRun(run)); } catch { /* non-fatal */ }
  }

  function buildTranscript(r: ExplorerResult | null): string {
    const L: string[] = [];
    L.push("=== AI Module Explorer run ===");
    L.push(`Module:  ${module.displayName} (${module.brand}) · ${tx}→${rx} · ${iface}`);
    L.push(`When:    ${startedAtRef.current || "(unsaved)"}`);
    if (r) L.push(`Outcome: ${r.outcome} · confidence ${r.confidence} · ${r.steps} steps · tokens IN ${r.tokensIn} / OUT ${r.tokensOut}`);
    L.push(`Seeded from ${priorRef.current?.runCount ?? 0} prior run(s).`);
    L.push("");
    L.push("--- stream ---");
    L.push(...logRef.current);
    if (r) {
      L.push("");
      L.push("--- result ---");
      L.push(`Summary:  ${r.summary}`);
      L.push(`Identity: ${r.identity}`);
      L.push(`Services:${r.services.length ? "\n  - " + r.services.join("\n  - ") : " (none)"}`);
      L.push(`Capabilities:${r.capabilities.length ? "\n  - " + r.capabilities.join("\n  - ") : " (none)"}`);
      L.push(`DTCs:${r.dtcs.length ? "\n  - " + r.dtcs.map((d) => `${d.code} — ${d.desc}`).join("\n  - ") : " (none)"}`);
      L.push(`Verification: ${r.verification}`);
      L.push("");
      L.push(`--- NEW this run (${r.newFindings.length}) ---`);
      L.push(r.newFindings.length ? "  - " + r.newFindings.join("\n  - ") : "  (nothing new vs prior runs)");
    }
    return L.join("\n");
  }

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(buildTranscript(result));
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  async function copyRun(r: ExplorerRun) {
    try { await navigator.clipboard.writeText(r.transcript); } catch { /* ignore */ }
  }

  async function delRun(r: ExplorerRun) {
    try { const res = await Api.moduleExplorer.deleteRun(module.id, r.id); setRuns(res.runs); } catch { /* ignore */ }
  }

  async function apply() {
    if (!result || !onApply) return;
    const d = module.diagnostics;
    // Per-tab enrichment tally — exactly what this run added/sharpened in each cockpit
    // function, so "enrich" is visible and calibratable.
    const enr = { info: 0, codes: 0, live: 0, bus: 0, caps: 0 };
    // capabilities (free-text "what you can do")
    const caps = new Set(d.capabilities);
    result.capabilities.forEach((c) => { if (!caps.has(c)) { caps.add(c); enr.caps++; } });
    // DTCs (by code) → Trouble Codes tab
    const dtcByCode = new Map(d.knownDtcs.map((x) => [x.code, x]));
    result.dtcs.forEach((x) => { if (!dtcByCode.has(x.code)) { dtcByCode.set(x.code, x); enr.codes++; } });
    // services
    const svc = new Set(d.sampleServices);
    result.services.forEach((s) => { const m = /\b([0-9A-Fa-f]{2})\b/.exec(s); if (m) svc.add(m[1].toUpperCase()); });
    // sessions (by id) → ECU Information / session model
    const sess = new Map(d.sessions.map((s) => [norm(s.id), s]));
    (result.sessions ?? []).forEach((s) => { const k = norm(s.id); if (!sess.has(k)) { sess.set(k, { id: s.id, label: s.label }); enr.info++; } });
    // identification (by id) → ECU Information. A fresh read with a real value updates
    // the stored one; we also decode a readable ASCII value so the tab shows a string.
    const idn = new Map((d.identification ?? []).map((r) => [norm(r.id), r]));
    (result.identification ?? []).forEach((r) => {
      const k = norm(r.id); const cur = idn.get(k);
      if (!cur) { idn.set(k, r); enr.info++; }
      else if (r.value && r.value !== cur.value) { idn.set(k, { ...cur, ...r }); enr.info++; }
    });
    // Lift verified part number / serial reads into partNumbers — the unit fingerprint.
    const partNumbers = [...module.partNumbers];
    for (const r of idn.values()) {
      const lbl = (r.label || "").toLowerCase();
      const v = (r.value || "").trim();
      if (v.length >= 4 && /part|spare|hardware|serial|catalog/.test(lbl) && !partNumbers.includes(v)) partNumbers.push(v);
    }
    // live-data blocks (by id) → Live Data tab. Refresh the note/session when the new
    // read carries more (a decoded snapshot), not only when the block is brand new.
    const live = new Map((d.liveData ?? []).map((b) => [norm(b.id), b]));
    (result.liveData ?? []).forEach((b) => {
      const k = norm(b.id); const cur = live.get(k);
      if (!cur) { live.set(k, b); enr.live++; }
      else if ((b.note && b.note !== cur.note) || (b.session && !cur.session)) { live.set(k, { ...cur, ...b }); enr.live++; }
    });
    // broadcast frames (by canId) → Bus Monitor tab. Update rate/decode as they sharpen.
    const bc = new Map((d.broadcastFrames ?? []).map((f) => [norm(f.canId), f]));
    (result.broadcastFrames ?? []).forEach((f) => {
      const k = norm(f.canId); const cur = bc.get(k);
      const rec = { canId: f.canId, hz: f.hz, decode: f.decode };
      if (!cur) { bc.set(k, rec); enr.bus++; }
      else if ((f.decode && f.decode !== cur.decode) || (f.hz && f.hz !== cur.hz)) { bc.set(k, { ...cur, ...rec }); enr.bus++; }
    });
    // canonical operations (by op) → Capabilities tab. A fresh definitive status wins
    // over "unknown"; count any op that newly gained a definitive stance.
    type Op = NonNullable<BenchModuleProfile["diagnostics"]["operations"]>[number];
    const ops = new Map<string, Op>((d.operations ?? []).map((o) => [o.op, o]));
    (result.operations ?? []).forEach((o) => {
      const cur = ops.get(o.op);
      const definitive = o.status !== "unknown";
      if (!cur || definitive) {
        if (definitive && (!cur || cur.status !== o.status)) enr.caps++;
        ops.set(o.op, { op: o.op, status: o.status as Op["status"], request: o.request, session: o.session, nrc: o.nrc, detail: o.detail });
      }
    });

    // Did this run genuinely talk to the real module? The explorer only ever runs
    // against the live Pi bus, so any positive diagnostic evidence — an answered
    // session, an ID value, a broadcast frame, a DTC, a service — means this exact
    // unit was confirmed on the bench. That promotes it to bench-verified.
    const communicated =
      (result.sessions?.length ?? 0) > 0 ||
      (result.services?.length ?? 0) > 0 ||
      (result.identification ?? []).some((r) => (r.value || "").trim().length > 0) ||
      (result.broadcastFrames?.length ?? 0) > 0 ||
      (result.dtcs?.length ?? 0) > 0;
    const verify = communicated && module.provenance.confidence !== "bench_verified";

    const updated: BenchModuleProfile = {
      ...module,
      partNumbers,
      diagnostics: {
        ...d,
        capabilities: [...caps],
        knownDtcs: [...dtcByCode.values()],
        sampleServices: [...svc],
        sessions: [...sess.values()],
        identification: [...idn.values()],
        liveData: [...live.values()],
        broadcastFrames: [...bc.values()],
        operations: [...ops.values()],
      },
      provenance: verify
        ? {
            ...module.provenance,
            source: module.provenance.source === "seed" ? "seed" : "operator",
            confidence: "bench_verified",
            evidence: { ...module.provenance.evidence, observedOn: "bench (AI explorer confirmed real comms)" },
            notes: `${module.provenance.notes ? module.provenance.notes + " " : ""}[AI explorer] ${result.summary}`.slice(0, 1400),
          }
        : { ...module.provenance, notes: `${module.provenance.notes ? module.provenance.notes + " " : ""}[AI explorer] ${result.summary}`.slice(0, 1400) },
    };
    await onApply(updated);
    setApplied(true);
    setBenchVerified(verify);
    setEnrich(enr);
  }

  function norm(s: string): string { return (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  const canCopy = items.length > 0 || !!result;

  return (
    <div className="ax-overlay" onClick={onClose}>
      <div className="ax" onClick={(e) => e.stopPropagation()}>
        <style>{styles}</style>
        <div className="ax-head">
          <div>
            <div className="ax-title"><span className={`ax-orb ${running ? "on" : ""}`} /> AI Module Explorer</div>
            <div className="tiny dim">
              {module.displayName} · {tx}→{rx} · read-only
              {usage && <> · <span className="mono">IN {kfmt(usage.in)} · OUT {kfmt(usage.out)}</span> · {usage.steps} steps</>}
              {!usage && runs.length > 0 && <> · {runs.length} run(s) on record</>}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {canCopy && <button className="tiny" onClick={() => void copyLog()}>{copied ? "✓ Copied" : "📋 Copy raw log"}</button>}
            {running
              ? <button className="tiny" onClick={() => void stop()}>■ Stop</button>
              : <button className="tiny primary" onClick={() => void run()}>{items.length ? "Run again" : "▶ Start exploring"}</button>}
            <button className="tiny" onClick={onClose}>✕</button>
          </div>
        </div>

        {prior && prior.runCount > 0 && !result && (
          <div className="ax-prior tiny">
            🧠 Building on <b>{prior.runCount}</b> prior run(s): {prior.services.length} services, {prior.capabilities.length} capabilities, {prior.dtcs.length} DTCs known. The agent will confirm these fast, then hunt for what's new.
          </div>
        )}

        <div className="ax-body">
          <div className="ax-stream" ref={streamRef}>
            {items.length === 0 && !running && <div className="tiny dim" style={{ padding: 12 }}>Press <b>Start exploring</b> — the agent will monitor the bus and probe the module read-only, narrating as it goes. Each run is saved and the next one builds on it.</div>}
            {items.map((it, i) => <StreamItem key={i} it={it} />)}
            {running && <div className="ax-typing"><span /><span /><span /></div>}
          </div>

          <div className="ax-map">
            <div className="ax-map-h">Understanding</div>
            {result ? (
              <div className="ax-result">
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <span className={`badge ${result.confidence === "high" ? "ok" : result.confidence === "medium" ? "warn" : "dim"}`}>{result.confidence} confidence</span>
                  {result.outcome === "partial" && <span className="badge warn">partial</span>}
                  <span className="badge dim mono">IN {kfmt(result.tokensIn)} · OUT {kfmt(result.tokensOut)}</span>
                </div>
                <p className="ax-summary">{result.summary}</p>
                {result.newFindings.length > 0 && (
                  <div className="ax-new">
                    <div className="ax-new-h">🆕 New this run ({result.newFindings.length})</div>
                    <ul className="ax-g-l">{result.newFindings.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  </div>
                )}
                <Group title="Identity">{result.identity}</Group>
                <ListGroup title="Services" items={result.services} />
                <ListGroup title="Capabilities" items={result.capabilities} />
                {result.dtcs.length > 0 && <ListGroup title="DTCs" items={result.dtcs.map((d) => `${d.code} — ${d.desc}`)} />}
                <Group title="Verification">{result.verification}</Group>
                {onApply && (applied
                  ? <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <span className="badge ok">✓ Saved to module</span>
                        {benchVerified && <span className="badge ok">✓ Bench-verified — confirmed on the real bus</span>}
                      </div>
                      {enrich && <EnrichReport e={enrich} />}
                    </div>
                  : <button className="tiny primary" style={{ marginTop: 8 }} onClick={() => void apply()}>💾 Save findings{module.provenance.confidence !== "bench_verified" ? " & bench-verify" : ""}</button>)}
              </div>
            ) : (
              <div className="ax-findings">
                {findings.length === 0 ? <div className="tiny dim">Findings appear here as the agent confirms them.</div>
                  : findings.map((f, i) => (
                    <div key={i} className="ax-find">
                      <span className={`ax-find-kind k-${f.kind}`}>{f.kind}</span>
                      <div><b>{f.title}</b><div className="tiny dim">{f.detail}</div></div>
                    </div>
                  ))}
              </div>
            )}

            {runs.length > 0 && (
              <div className="ax-runs">
                <div className="ax-map-h" style={{ marginTop: 14 }}>Run history ({runs.length})</div>
                {runs.map((r) => (
                  <div key={r.id} className="ax-run">
                    <div className="ax-run-top">
                      <span className={`ax-run-dot ${r.outcome}`} />
                      <span className="tiny">{fmtWhen(r.startedAt)}</span>
                      {r.newFindings.length > 0 && <span className="ax-run-new">🆕 {r.newFindings.length}</span>}
                      <span className="tiny dim mono" style={{ marginLeft: "auto" }}>{kfmt(r.tokensIn)}/{kfmt(r.tokensOut)} · {r.steps}s</span>
                    </div>
                    {r.newFindings.length > 0 && <div className="tiny dim ax-run-list">{r.newFindings.slice(0, 4).join(" · ")}{r.newFindings.length > 4 ? " …" : ""}</div>}
                    <div className="row" style={{ gap: 6, marginTop: 3 }}>
                      <button className="tiny" onClick={() => void copyRun(r)}>📋 Copy</button>
                      <button className="tiny" onClick={() => void delRun(r)}>🗑</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtWhen(iso: string): string {
  try { const d = new Date(iso); return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

function StreamItem({ it }: { it: Item }) {
  if (it.k === "thought") return <div className="ax-it ax-thought"><span className="ax-ic">💭</span><div>{it.text}</div></div>;
  if (it.k === "action") return <div className="ax-it ax-action"><span className="ax-ic">→</span><div><b>{TOOL_LABEL[it.tool] ?? it.tool}</b> <span className="mono tiny dim">{summarizeInput(it.tool, it.input)}</span></div></div>;
  if (it.k === "obs") return <div className="ax-it ax-obs"><span className="ax-ic">←</span><div><span className="tiny dim">{it.summary}</span>{it.detail && <pre className="ax-detail">{it.detail}</pre>}</div></div>;
  if (it.k === "finding") return <div className="ax-it ax-finding"><span className="ax-ic">✓</span><div><b>{it.title}</b> <span className="tiny dim">{it.detail}</span></div></div>;
  if (it.k === "error") return <div className="ax-it ax-err"><span className="ax-ic">✕</span><div>{it.text}</div></div>;
  return <div className="ax-it ax-status"><span className="ax-ic">•</span><div className="tiny dim">{it.text}</div></div>;
}

function summarizeInput(tool: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  if (tool === "probe") return `${Array.isArray(o.requests) ? (o.requests as string[]).join(" ") : ""} — ${o.purpose ?? ""}`;
  if (tool === "scan_bus") return `${o.ms ?? 700}ms`;
  if (tool === "record") return `${o.kind}: ${o.title}`;
  return "";
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="ax-g"><div className="ax-g-t">{title}</div><div className="ax-g-b">{children}</div></div>;
}
function ListGroup({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div className="ax-g"><div className="ax-g-t">{title}</div><ul className="ax-g-l">{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>;
}

/** What this run added/sharpened in each cockpit function tab. */
function EnrichReport({ e }: { e: { info: number; codes: number; live: number; bus: number; caps: number } }) {
  const rows = [
    { icon: "🪪", label: "ECU Information", n: e.info },
    { icon: "⚠️", label: "Trouble Codes", n: e.codes },
    { icon: "📈", label: "Live Data", n: e.live },
    { icon: "📡", label: "Bus Monitor", n: e.bus },
    { icon: "🧩", label: "Capabilities", n: e.caps },
  ];
  const total = rows.reduce((s, r) => s + r.n, 0);
  return (
    <div className="ax-enrich">
      <div className="ax-enrich-h">{total > 0 ? `Enriched ${total} field(s) across the cockpit` : "No new fields — the record already matched the module"}</div>
      <div className="ax-enrich-grid">
        {rows.map((r) => (
          <div key={r.label} className={`ax-enrich-cell ${r.n > 0 ? "hit" : ""}`}>
            <span>{r.icon} {r.label}</span>
            <b>{r.n > 0 ? `+${r.n}` : "—"}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = `
.ax-enrich { border: 1px solid var(--border); border-radius: 9px; padding: 9px 10px; background: var(--bg-2); }
.ax-enrich-h { font-size: 12px; font-weight: 600; margin-bottom: 7px; }
.ax-enrich-grid { display: flex; flex-direction: column; gap: 3px; }
.ax-enrich-cell { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--fg-2); padding: 2px 0; }
.ax-enrich-cell.hit { color: var(--fg-0); }
.ax-enrich-cell.hit b { color: var(--ok, #34d399); }
.ax-enrich-cell b { color: var(--fg-2); font-variant-numeric: tabular-nums; }
.ax-overlay { position: fixed; inset: 0; background: rgba(4,7,12,0.8); display: grid; place-items: center; z-index: 80; padding: 20px; }
.ax { width: 100%; max-width: 1000px; height: 84vh; background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 16px; display: flex; flex-direction: column; overflow: hidden; }
.ax-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.ax-title { display: flex; align-items: center; gap: 9px; font-size: 15px; font-weight: 700; }
.ax-orb { width: 12px; height: 12px; border-radius: 50%; background: var(--fg-2); }
.ax-orb.on { background: var(--accent); box-shadow: 0 0 10px var(--accent); animation: axpulse 1.1s ease-in-out infinite; }
@keyframes axpulse { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
.ax-prior { padding: 8px 18px; border-bottom: 1px solid var(--border); color: var(--fg-1); background: var(--bg-2); }
.ax-body { flex: 1; display: grid; grid-template-columns: 1.5fr 1fr; overflow: hidden; }
.ax-stream { overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 9px; border-right: 1px solid var(--border); }
.ax-it { display: flex; gap: 9px; font-size: 12.5px; line-height: 1.5; }
.ax-ic { flex-shrink: 0; width: 18px; text-align: center; color: var(--fg-2); }
.ax-thought { color: var(--fg-1); }
.ax-thought div { background: var(--bg-2); border-radius: 8px; padding: 7px 11px; border: 1px solid var(--border); }
.ax-action b { color: var(--info); }
.ax-obs { color: var(--fg-2); }
.ax-finding { color: var(--fg-0); }
.ax-finding .ax-ic { color: var(--accent); }
.ax-err { color: var(--danger); }
.ax-status { color: var(--fg-2); }
.ax-detail { font-family: var(--mono); font-size: 10.5px; line-height: 1.4; color: var(--fg-2); background: var(--bg-0); border: 1px solid var(--border); border-radius: 6px; padding: 7px; margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; max-height: 130px; overflow-y: auto; }
.ax-typing { display: flex; gap: 4px; padding: 4px 0 4px 27px; }
.ax-typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); opacity: .5; animation: axdot 1s infinite; }
.ax-typing span:nth-child(2) { animation-delay: .2s; } .ax-typing span:nth-child(3) { animation-delay: .4s; }
@keyframes axdot { 0%,100% { opacity: .3; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-3px); } }
.ax-map { overflow-y: auto; padding: 14px 16px; }
.ax-map-h { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--fg-2); margin-bottom: 10px; }
.ax-summary { font-size: 12.5px; line-height: 1.6; color: var(--fg-1); margin: 8px 0; }
.ax-new { background: var(--bg-2); border: 1px solid var(--accent); border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
.ax-new-h { font-size: 11px; font-weight: 700; color: var(--accent); margin-bottom: 4px; }
.ax-g { margin-bottom: 10px; }
.ax-g-t { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-2); margin-bottom: 3px; }
.ax-g-b { font-size: 12.5px; color: var(--fg-1); }
.ax-g-l { margin: 0; padding-left: 16px; font-size: 12px; line-height: 1.6; color: var(--fg-1); }
.ax-findings { display: flex; flex-direction: column; gap: 7px; }
.ax-find { display: flex; gap: 8px; font-size: 12.5px; }
.ax-find-kind { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; padding: 1px 6px; border-radius: 4px; height: fit-content; background: var(--bg-3); color: var(--fg-2); }
.ax-find-kind.k-identity { color: var(--info); } .ax-find-kind.k-capability { color: var(--accent); } .ax-find-kind.k-dtc { color: var(--danger); } .ax-find-kind.k-service { color: var(--warn); }
.ax-runs { border-top: 1px solid var(--border); margin-top: 8px; }
.ax-run { border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; margin-bottom: 7px; background: var(--bg-2); }
.ax-run-top { display: flex; align-items: center; gap: 7px; }
.ax-run-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-2); flex-shrink: 0; }
.ax-run-dot.concluded { background: var(--ok, #38b000); } .ax-run-dot.partial { background: var(--warn); } .ax-run-dot.error { background: var(--danger); }
.ax-run-new { font-size: 10px; color: var(--accent); font-weight: 700; }
.ax-run-list { margin-top: 3px; word-break: break-word; }
@media (max-width: 760px) { .ax-body { grid-template-columns: 1fr; } .ax-map { border-top: 1px solid var(--border); } }
`;
