import { useEffect, useMemo, useRef, useState } from "react";

import type {
  BusCapability,
  BusModuleKnowledge,
} from "@ecu/vehicle-db";

import { Api, type BusMapRequest } from "../lib/api";
import { Obd } from "../lib/obd";
import { negativeResponse } from "../lib/uds";

/**
 * Vehicle Intelligence — the growing, portable brain of the lab.
 *
 * Every system we talk to on a real network is memorised as a
 * {@link BusModuleKnowledge} record: how it's addressed, what it speaks, and the
 * concrete capabilities (things we can do) with exact command bytes. Seed
 * records ship with the app; the AI mapper turns a live-bus snapshot into new
 * records; confirmed ones persist to disk and can be baked back into the build.
 * So each connection makes the tool know a little more about any vehicle.
 */

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

function parseHexBytes(s: string): number[] {
  const clean = s.replace(/[^0-9a-fA-F]/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

/** A command is runnable if it's concrete hex (no range ellipsis, ≥1 byte). */
function runnable(cmd: string): boolean {
  if (/[…]|\.\.|–/.test(cmd)) return false;
  return parseHexBytes(cmd).length >= 1;
}

const TRUST_BADGE: Record<BusModuleKnowledge["provenance"]["source"], { label: string; cls: string }> = {
  seed: { label: "shipped", cls: "info" },
  bench_observed: { label: "bench-verified", cls: "ok" },
  ai_suggested: { label: "AI draft", cls: "warn" },
};

const PROTO_LABEL: Record<string, string> = {
  uds: "UDS", kwp2000: "KWP2000", obd2: "OBD-II", j1939: "J1939", gmlan: "GMLAN",
  proprietary: "proprietary", unknown: "unknown",
};

interface Props {
  port: string;
  /** Hex ids currently transmitting on the bus (uppercase, no 0x). */
  liveIds: string[];
  /** Builds the current observation (nodes + snapshot) for the AI mapper. */
  buildObservation: () => Promise<BusMapRequest>;
}

export function VehicleIntelligence({ port, liveIds, buildObservation }: Props) {
  const [known, setKnown] = useState<BusModuleKnowledge[]>([]);
  const [drafts, setDrafts] = useState<BusModuleKnowledge[]>([]);
  const [summary, setSummary] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAnalyze, setShowAnalyze] = useState(false);
  const [probeLog, setProbeLog] = useState("");
  const [baking, setBaking] = useState<string | null>(null);
  const loaded = useRef(false);

  const liveSet = useMemo(() => new Set(liveIds.map((s) => s.toUpperCase())), [liveIds]);

  async function refresh() {
    try {
      setKnown(await Api.busIntel.list());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void refresh();
  }, []);

  const isOnline = (k: BusModuleKnowledge) =>
    liveSet.has((k.fingerprint?.responseId ?? k.addressing.response).toUpperCase().replace(/[^0-9A-F]/g, ""));

  const knownIds = useMemo(() => new Set(known.map((k) => k.id)), [known]);

  async function runAnalyze() {
    setAnalyzing(true);
    setError(null);
    setDrafts([]);
    setSummary("");
    try {
      const obs = await buildObservation();
      const input: BusMapRequest = {
        ...obs,
        ...(probeLog.trim() ? { probeLog: probeLog.trim() } : {}),
      };
      const result = await Api.busIntel.analyze(input);
      setDrafts(result.modules);
      setSummary(result.summary);
      if (result.modules.length === 0) {
        setError("The mapper didn't find an identifiable system. Capture more traffic (or paste a request→response log) and try again.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function saveDraft(record: BusModuleKnowledge) {
    try {
      const merged = await Api.busIntel.save(record);
      setKnown(merged);
      setDrafts((d) => d.filter((x) => x.id !== record.id));
      setExpanded((s) => new Set(s).add(record.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    try {
      const { records } = await Api.busIntel.delete(id);
      setKnown(records);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function bake() {
    setBaking("working");
    setError(null);
    try {
      const { count } = await Api.busIntel.bake();
      setBaking(`baked ${count}`);
    } catch (e) {
      setBaking(null);
      setError((e as Error).message);
    }
    setTimeout(() => setBaking(null), 3500);
  }

  function toggle(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  const onlineCount = known.filter(isOnline).length;

  return (
    <div className="mt-8">
      <style>{viStyles}</style>

      <div className="row spread wrap" style={{ gap: 8 }}>
        <div>
          <p className="tiny dim" style={{ margin: 0 }}>
            {known.length} system{known.length === 1 ? "" : "s"} known
            {onlineCount > 0 && <> · <span style={{ color: "var(--accent)" }}>{onlineCount} on this bus now</span></>}
            . Every network you connect to teaches it more.
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="tiny" onClick={bake} disabled={baking === "working"}
            title="Fold your learned systems into the app's bundled catalog so they ship with the next release">
            {baking === "working" ? "Baking…" : baking ? `✓ ${baking}` : "Bake into app"}
          </button>
          <button className={showAnalyze ? "" : "primary"} onClick={() => setShowAnalyze((v) => !v)}>
            {showAnalyze ? "Close" : "Analyze this bus with AI"}
          </button>
        </div>
      </div>

      {showAnalyze && (
        <div className="vi-analyze mt-8">
          <p className="tiny dim" style={{ marginTop: 0 }}>
            The mapper reads the live node list and the troubleshoot snapshot. For a much deeper map, paste any
            request→response log you have (e.g. a session/read sweep) below — that's the strongest evidence.
          </p>
          <textarea
            className="mono tiny vi-log"
            placeholder={"optional — paste request → response lines, e.g.\n10 81 -> 50 81\n21 F0 -> 61 F0 31 58 4A 33 41 …"}
            value={probeLog}
            onChange={(e) => setProbeLog(e.target.value)}
          />
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="primary" onClick={runAnalyze} disabled={analyzing}>
              {analyzing ? "Mapping the bus…" : "Map the bus"}
            </button>
            <span className="tiny dim">Needs an Anthropic key (Settings). Read-only — nothing is transmitted.</span>
          </div>
        </div>
      )}

      {error && <div className="vi-banner danger mt-8">{error}</div>}
      {summary && <div className="vi-banner info mt-8">{summary}</div>}

      {/* AI drafts awaiting the operator's save */}
      {drafts.length > 0 && (
        <div className="mt-12">
          <h4 className="vi-h">Discovered — review &amp; keep</h4>
          <div className="vi-list">
            {drafts.map((k) => (
              <SystemCard
                key={k.id} k={k} port={port} online={isOnline(k)}
                expanded={expanded.has(k.id)} onToggle={() => toggle(k.id)}
                draft duplicate={knownIds.has(k.id)}
                onSave={() => saveDraft(k)}
              />
            ))}
          </div>
        </div>
      )}

      {/* the knowledge base */}
      <div className="mt-12">
        {known.length === 0 ? (
          <p className="tiny dim">No systems learned yet. Connect to a bus, go live, then Analyze.</p>
        ) : (
          <div className="vi-list">
            {known.map((k) => (
              <SystemCard
                key={k.id} k={k} port={port} online={isOnline(k)}
                expanded={expanded.has(k.id)} onToggle={() => toggle(k.id)}
                onDelete={k.provenance.source !== "seed" ? () => remove(k.id) : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface CardProps {
  k: BusModuleKnowledge;
  port: string;
  online: boolean;
  expanded: boolean;
  onToggle: () => void;
  draft?: boolean;
  duplicate?: boolean;
  onSave?: () => void;
  onDelete?: () => void;
}

function SystemCard({ k, port, online, expanded, onToggle, draft, duplicate, onSave, onDelete }: CardProps) {
  const trust = TRUST_BADGE[k.provenance.source];
  return (
    <div className={`vi-card ${online ? "online" : ""} ${draft ? "draft" : ""}`}>
      <button className="vi-card-head" onClick={onToggle}>
        <div className="vi-card-title">
          {online && <span className="vi-dot" title="Transmitting on the bus right now" />}
          <span className="vi-name">{k.label}</span>
          <span className="vi-proto">{PROTO_LABEL[k.protocol] ?? k.protocol}</span>
        </div>
        <div className="row" style={{ gap: 6, alignItems: "center" }}>
          <span className="vi-addr mono">{k.addressing.request}→{k.addressing.response}</span>
          <span className={`badge ${trust.cls}`}>{trust.label}</span>
          <span className="vi-chev">{expanded ? "▾" : "▸"}</span>
        </div>
      </button>

      {expanded && (
        <div className="vi-body">
          {k.appliesTo && <p className="tiny dim" style={{ marginTop: 0 }}>{k.appliesTo}</p>}

          {k.capabilities.length > 0 && (
            <div className="vi-sec">
              <div className="vi-sec-h">What we can do</div>
              {k.capabilities.map((c, i) => (
                <Capability key={i} cap={c} reqId={k.addressing.request} port={port} />
              ))}
            </div>
          )}

          {k.dataIdentifiers.length > 0 && (
            <div className="vi-sec">
              <div className="vi-sec-h">Readable data ({k.dataIdentifiers.length})</div>
              <div className="vi-grid">
                {k.dataIdentifiers.map((d, i) => (
                  <div key={i} className="vi-did">
                    <div className="row spread">
                      <span className="mono vi-did-req">{d.request}</span>
                      {d.session && <span className="tiny dim mono">via {d.session}</span>}
                    </div>
                    <div className="tiny">{d.name}</div>
                    {d.decoded && <div className="tiny dim">{d.decoded}</div>}
                    {d.sampleResponse && <div className="mono vi-sample">{d.sampleResponse}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {k.sessions.length > 0 && (
            <div className="vi-sec">
              <div className="vi-sec-h">Sessions</div>
              <div className="vi-chips">
                {k.sessions.map((s, i) => (
                  <span key={i} className="vi-chip" title={s.note ?? ""}>
                    <span className="mono">{s.request}</span> {s.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {k.services.length > 0 && (
            <div className="vi-sec">
              <div className="vi-sec-h">Services</div>
              <div className="vi-chips">
                {k.services.map((s, i) => (
                  <span key={i} className={`vi-chip ${s.supported ? "yes" : "no"}`} title={s.note ?? ""}>
                    <span className="mono">{s.sid}</span> {s.name}{s.supported ? "" : ` ✕${s.nrc ? " " + s.nrc : ""}`}
                  </span>
                ))}
              </div>
            </div>
          )}

          {k.notes && <p className="tiny dim vi-notes">{k.notes}</p>}

          <div className="row" style={{ gap: 8, marginTop: 4 }}>
            {draft && onSave && (
              <button className="primary tiny" onClick={onSave}>
                {duplicate ? "Update in knowledge base" : "Keep in knowledge base"}
              </button>
            )}
            {onDelete && <button className="tiny" onClick={onDelete}>Forget</button>}
            {k.provenance.model && <span className="tiny dim">drafted by {k.provenance.model}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

interface RunLine { cmd: string; resp: string; note: string; ok: boolean }

function Capability({ cap, reqId, port }: { cap: BusCapability; reqId: string; port: string }) {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<RunLine[] | null>(null);
  const canRun = cap.risk === "read" && cap.commands.some(runnable);
  const target = parseInt(reqId.replace(/[^0-9a-fA-F]/g, ""), 16);

  async function run() {
    if (!Number.isFinite(target)) return;
    setRunning(true);
    setLines([]);
    const out: RunLine[] = [];
    for (const cmd of cap.commands) {
      if (!runnable(cmd)) continue;
      const bytes = parseHexBytes(cmd);
      try {
        const resp = await Obd.isotp(port, target, bytes);
        const nrc = negativeResponse(resp);
        out.push({
          cmd,
          resp: resp.map(hex2).join(" "),
          note: nrc ? `negative: ${nrc}` : "positive",
          ok: !nrc,
        });
      } catch (e) {
        out.push({ cmd, resp: "", note: (e as Error).message, ok: false });
      }
      setLines([...out]);
    }
    setRunning(false);
  }

  async function copy() {
    try { await navigator.clipboard.writeText(cap.commands.join("\n")); } catch { /* ignore */ }
  }

  return (
    <div className="vi-cap">
      <div className="row spread">
        <div className="vi-cap-title">
          {cap.title}
          <span className={`vi-risk ${cap.risk}`}>{cap.risk}</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="tiny" onClick={copy} title="Copy the command sequence">Copy</button>
          {canRun ? (
            <button className="tiny primary" onClick={run} disabled={running} title={`Send to ${reqId}`}>
              {running ? "Running…" : "Run"}
            </button>
          ) : (
            <span className="tiny dim" title={cap.risk === "read" ? "commands are a range/placeholder" : "not a read — run it manually from the Console"}>
              {cap.risk === "read" ? "manual" : "manual only"}
            </span>
          )}
        </div>
      </div>
      <div className="tiny dim">{cap.how}</div>
      <div className="mono vi-cmds">{cap.commands.join("   ·   ")}</div>
      {cap.note && <div className="tiny dim" style={{ fontStyle: "italic" }}>{cap.note}</div>}
      {lines && lines.length > 0 && (
        <pre className="mono tiny vi-run">
          {lines.map((l, i) => (
            <span key={i}>
              {`▸ ${reqId} ← ${l.cmd}\n`}
              <span style={{ color: l.ok ? "var(--accent)" : "var(--warn)" }}>{`  ${l.resp ? l.resp + "  " : ""}(${l.note})\n`}</span>
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

const viStyles = `
.vi-banner { font-size: 12px; border-radius: 8px; padding: 8px 12px; }
.vi-banner.info { color: var(--info); background: var(--info-dim); }
.vi-banner.danger { color: var(--danger); background: var(--danger-dim); }
.vi-analyze { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.vi-log { width: 100%; min-height: 92px; resize: vertical; background: var(--bg-0); color: var(--fg-1); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; box-sizing: border-box; }
.vi-h { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg-2); margin: 0 0 8px; }
.vi-list { display: flex; flex-direction: column; gap: 8px; }
.vi-card { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-1); overflow: hidden; transition: border-color .15s ease; }
.vi-card.online { border-color: var(--accent); }
.vi-card.draft { border-style: dashed; border-color: var(--warn); }
.vi-card-head { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 12px; background: none; border: none; cursor: pointer; color: var(--fg-0); text-align: left; }
.vi-card-head:hover { background: var(--bg-2); }
.vi-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.vi-name { font-weight: 600; font-size: 13.5px; }
.vi-proto { font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em; color: var(--info); border: 1px solid var(--info-dim); border-radius: 4px; padding: 1px 5px; }
.vi-addr { font-size: 11px; color: var(--fg-2); }
.vi-chev { color: var(--fg-2); font-size: 11px; width: 12px; }
.vi-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 0 rgba(74,222,128,0.5); animation: vi-ring 1.6s ease infinite; }
.vi-body { padding: 4px 12px 12px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 12px; }
.vi-sec-h { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg-2); margin-bottom: 6px; }
.vi-cap { background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 8px 10px; margin-bottom: 6px; }
.vi-cap-title { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.vi-risk { font-family: var(--mono); font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.08em; border-radius: 4px; padding: 1px 5px; }
.vi-risk.read { color: var(--accent); background: var(--accent-dim, rgba(74,222,128,0.12)); }
.vi-risk.write, .vi-risk.caution { color: var(--warn); background: var(--warn-dim); }
.vi-cmds { font-size: 11px; color: var(--fg-1); margin-top: 5px; }
.vi-run { margin: 8px 0 0; background: var(--bg-0); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; max-height: 24vh; overflow: auto; }
.vi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.vi-did { background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; }
.vi-did-req { font-size: 12px; font-weight: 700; color: var(--accent); }
.vi-sample { font-size: 9.5px; color: var(--fg-2); margin-top: 4px; word-break: break-all; }
.vi-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.vi-chip { font-size: 10.5px; color: var(--fg-1); background: var(--bg-2); border: 1px solid var(--border); border-radius: 5px; padding: 2px 7px; }
.vi-chip.yes { border-color: var(--accent); }
.vi-chip.no { opacity: 0.55; }
.vi-notes { margin: 0; line-height: 1.5; }
@keyframes vi-ring { 0% { box-shadow: 0 0 0 0 rgba(74,222,128,0.5); } 70% { box-shadow: 0 0 0 5px rgba(74,222,128,0); } 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); } }
@media (prefers-reduced-motion: reduce) { .vi-dot { animation: none !important; } }
`;
