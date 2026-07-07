import { useEffect, useMemo, useRef, useState } from "react";

import { moduleFor } from "../lib/modules";
import { SignalLab } from "./SignalLab";
import { UdsConsole } from "./UdsConsole";
import { VehicleIntelligence } from "./VehicleIntelligence";
import { Obd, decodePid, type CanFrame } from "../lib/obd";
import type { BusMapRequest } from "../lib/api";
import {
  buildReadDataById,
  buildReadDtcByStatus,
  buildSession,
  buildTesterPresent,
  DID,
  negativeResponse,
  parseUdsDtcs,
  parseUdsVin,
} from "../lib/uds";

/**
 * Live Network — the bus cockpit.
 *
 * One place to watch and work the CAN bus: a real-time map where each
 * arbitration id is a node that comes ONLINE while it transmits and fades away
 * when it goes quiet (plug a module in and its ids light up; unplug it and they
 * vanish). Diagnostic responders (0x7E8–0x7EF) are named and click-to-interact
 * (sessions, VIN, DTCs, raw ISO-TP, capture-probe); broadcast ids show their
 * bytes changing live for reverse-engineering.
 *
 * It also owns the bus hardware controls — pins (HS 6/14 vs MS 3/11), speed, and
 * a reliable reader reboot — plus a raw chronological log and a one-click
 * "copy troubleshoot snapshot" that bundles firmware INFO + CANSTAT + the node
 * table + recent frames into text you can paste back for analysis.
 *
 * Bus config + reboot live in the parent (it owns the serial connection); this
 * component drives them through the on* callbacks.
 */

const POLL_MS = 300;
const TICK_MS = 250;
const LIVE_MS = 1300;
const STALE_MS = 4000;
const LOST_MS = 9000;
const HOT_MS = 1200;
const NEW_MS = 2000;
const STALL_MS = 1800;
const HISTORY = 8;
const RAW_MAX = 800;

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
const hex3 = (n: number) => n.toString(16).toUpperCase().padStart(3, "0");
const bytesToHex = (b: number[]) => b.map(hex2).join(" ");

function parseHex(s: string): number[] {
  const clean = s.replace(/[^0-9a-fA-F]/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

interface Node {
  id: number;
  data: number[];
  changedAt: number[];
  count: number;
  firstMs: number;
  lastMs: number;
  history: number[][];
}

type Status = "live" | "stale" | "lost";
function statusOf(n: Node, now: number): Status {
  const age = now - n.lastMs;
  if (age < LIVE_MS) return "live";
  if (age < STALE_MS) return "stale";
  return "lost";
}

type Kind = "module" | "obd" | "bcast";
function classify(id: number): { name: string; kind: Kind; reqId: number } {
  if (id >= 0x7e8 && id <= 0x7ef) {
    const m = moduleFor(id);
    return { name: m.name, kind: "module", reqId: m.req };
  }
  if (id === 0x7df) return { name: "OBD functional", kind: "obd", reqId: 0x7df };
  return { name: `Broadcast ${hex3(id)}`, kind: "bcast", reqId: id };
}

function liveDecode(n: Node): string | null {
  const frame: CanFrame = { id: n.id, data: n.data.map(hex2).join("").toLowerCase() };
  const d = decodePid(frame);
  return d ? `${d.label}: ${Number.isInteger(d.value) ? d.value : d.value.toFixed(1)} ${d.unit}` : null;
}

interface FlapMeta { prev: Status; flaps: number; last: number }
interface RawFrame { t: number; id: number; data: string }
interface LogEntry { req: string; resp: string; note: string; ok: boolean }

const SPEEDS = [500000, 250000, 125000];

interface Props {
  port: string;
  sim: boolean;
  bus: number; // 0 = HS (6/14), 1 = MS (3/11)
  speed: number; // current speed of the selected bus, bps
  rebooting: boolean;
  onBus: (bus: number) => void;
  onSpeed: (bps: number) => void;
  onReset: () => void;
}

export function CanNetwork({ port, sim, bus, speed, rebooting, onBus, onSpeed, onReset }: Props) {
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<"map" | "raw" | "signals" | "console" | "intel">("map");
  const nodes = useRef<Map<number, Node>>(new Map());
  const flaps = useRef<Map<number, FlapMeta>>(new Map());
  const raw = useRef<RawFrame[]>([]);
  const lastFrameMs = useRef(0);
  const seenAny = useRef(false);
  const busy = useRef(false);
  const [, bump] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [stalled, setStalled] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // capture loop — runs on every tab except Signals (where Signal Lab does its
  // own capture), so the live map + troubleshoot snapshot stay current even while
  // you're working in the Console.
  useEffect(() => {
    if (!running || rebooting || tab === "signals") return;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const frames = await Obd.canDump(port, bus);
        const now = Date.now();
        if (frames.length) { lastFrameMs.current = now; seenAny.current = true; }
        for (const f of frames) {
          raw.current.push({ t: now, id: f.id, data: f.data });
          const bytes = parseHex(f.data);
          const row = nodes.current.get(f.id);
          if (!row) {
            nodes.current.set(f.id, {
              id: f.id, data: bytes, changedAt: bytes.map(() => now),
              count: 1, firstMs: now, lastMs: now, history: [bytes],
            });
          } else {
            for (let i = 0; i < bytes.length; i++) if (bytes[i] !== row.data[i]) row.changedAt[i] = now;
            row.data = bytes;
            row.count++;
            row.lastMs = now;
            row.history = [bytes, ...row.history].slice(0, HISTORY);
          }
        }
        if (raw.current.length > RAW_MAX) raw.current.splice(0, raw.current.length - RAW_MAX);
      } catch {
        /* best-effort */
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [running, rebooting, port, bus, tab]);

  // heartbeat: prune, detect flapping + bus-off stall, re-render
  useEffect(() => {
    if (!running) { setStalled(false); return; }
    const t = setInterval(() => {
      const now = Date.now();
      for (const [id, n] of nodes.current) {
        const st = statusOf(n, now);
        const fm = flaps.current.get(id) ?? { prev: st, flaps: 0, last: now };
        const wasOn = fm.prev === "live";
        const isOn = st === "live";
        if (wasOn !== isOn) { fm.flaps += 1; fm.last = now; }
        if (now - fm.last > 8000) fm.flaps = 0;
        fm.prev = st;
        flaps.current.set(id, fm);
        if (now - n.lastMs > LOST_MS) { nodes.current.delete(id); flaps.current.delete(id); }
      }
      setStalled(seenAny.current && lastFrameMs.current > 0 && now - lastFrameMs.current > STALL_MS);
      bump((v) => v + 1);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [running]);

  function reset() {
    nodes.current = new Map();
    flaps.current = new Map();
    raw.current = [];
    lastFrameMs.current = 0;
    seenAny.current = false;
    setSelected(null);
    setStalled(false);
    bump((v) => v + 1);
  }

  const now = Date.now();
  const list = useMemo(
    () => [...nodes.current.values()].sort((a, b) => a.id - b.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes.current.size, now],
  );
  const online = list.filter((n) => statusOf(n, now) !== "lost").length;
  const flapping = (id: number) => (flaps.current.get(id)?.flaps ?? 0) >= 3;
  const anyFlapping = list.some((n) => flapping(n.id));
  const sel = selected != null ? nodes.current.get(selected) ?? null : null;

  async function buildReport(): Promise<string> {
    const info = await Obd.info(port).catch(() => "(unavailable)");
    const canstat = await Obd.canStat(port);
    const stamp = new Date().toISOString();
    const pins = bus === 1 ? "MS-CAN (pins 3/11)" : "HS-CAN (pins 6/14)";
    const lines: string[] = [];
    lines.push("=== ECU LAB · OBD TROUBLESHOOT SNAPSHOT ===");
    lines.push(`time      : ${stamp}`);
    lines.push(`port      : ${port}`);
    lines.push(`watching  : ${pins} @ ${speed} bps`);
    lines.push(`transmit  : ${pins} — active requests go out the selected bus (CANBUS follows the pins toggle)`);
    lines.push(`info      : ${info}`);
    lines.push(`canstat   : ${canstat || "(unsupported — flash the latest firmware)"}`);
    lines.push(`nodes     : ${list.length} tracked, ${online} online${anyFlapping ? " · FLAPPING detected" : ""}`);
    lines.push("");
    lines.push("nodes (id  name  status  hz  seen  lastData):");
    for (const n of list) {
      const c = classify(n.id);
      const st = statusOf(n, now);
      const dt = (n.lastMs - n.firstMs) / 1000;
      const hz = dt > 0.6 ? Math.round(n.count / dt) : 0;
      lines.push(`  ${hex3(n.id)}  ${c.name.padEnd(16)}  ${st.padEnd(5)}  ${String(hz).padStart(4)}  ${String(n.count).padStart(6)}  ${bytesToHex(n.data)}${flapping(n.id) ? "   <FLAP>" : ""}`);
    }
    lines.push("");
    const tail = raw.current.slice(-40);
    lines.push(`recent raw (${tail.length} frames, newest last):`);
    for (const f of tail) lines.push(`  ${hex3(f.id)}#${f.data}`);
    lines.push("=== END SNAPSHOT ===");
    return lines.join("\n");
  }

  // Snapshot of the live bus for the AI mapper: each tracked node + the full
  // troubleshoot report as context. liveIds tells Intel which known systems are
  // transmitting right now.
  const liveIds = useMemo(
    () => list.filter((n) => statusOf(n, now) !== "lost").map((n) => hex3(n.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes.current.size, now],
  );
  async function buildObservation(): Promise<BusMapRequest> {
    return {
      nodes: list.map((n) => {
        const c = classify(n.id);
        const dt = (n.lastMs - n.firstMs) / 1000;
        return {
          id: hex3(n.id),
          name: c.name,
          kind: c.kind,
          hz: dt > 0.6 ? Math.round(n.count / dt) : 0,
          count: n.count,
          lastData: bytesToHex(n.data),
        };
      }),
      snapshot: await buildReport().catch(() => ""),
    };
  }

  async function copyTroubleshoot() {
    setCopied("working");
    try {
      const report = await buildReport();
      await navigator.clipboard.writeText(report);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied(null), 2500);
  }

  function downloadRaw() {
    const body = raw.current.map((f) => `${f.t} ${hex3(f.id)} ${f.data}`).join("\n");
    const blob = new Blob([body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `can-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const copyLabel = copied === "working" ? "Copying…" : copied === "copied" ? "✓ Copied — paste to Claude" : copied === "failed" ? "Copy failed" : "Copy troubleshoot data";

  return (
    <div className="card mt-16" style={{ borderColor: running ? "var(--info)" : "var(--border)" }}>
      <style>{cnStyles}</style>

      {/* header */}
      <div className="row spread">
        <h3>Live network <span className="tiny dim">— watch &amp; work the bus</span></h3>
        <div className="row" style={{ gap: 8 }}>
          <div className="seg tiny">
            <button className={tab === "map" ? "active" : ""} onClick={() => setTab("map")}>Map</button>
            <button className={tab === "raw" ? "active" : ""} onClick={() => setTab("raw")}>Raw</button>
            <button className={tab === "signals" ? "active" : ""} onClick={() => setTab("signals")}>Signals</button>
            <button className={tab === "console" ? "active" : ""} onClick={() => setTab("console")}>Console</button>
            <button className={tab === "intel" ? "active" : ""} onClick={() => setTab("intel")}>Intel</button>
          </div>
          <button className="tiny" onClick={reset}>Clear</button>
          <button className={running ? "primary" : ""} onClick={() => setRunning((r) => !r)}>
            {running ? "Stop" : "Go live"}
          </button>
        </div>
      </div>

      {/* bus cockpit — pins, speed, reboot */}
      <div className="cn-bar mt-12">
        <div className="cn-bar-group">
          <span className="tiny dim">pins</span>
          <div className="seg tiny">
            <button className={bus === 0 ? "active" : ""} disabled={rebooting} onClick={() => onBus(0)}>HS 6/14</button>
            <button className={bus === 1 ? "active" : ""} disabled={rebooting} onClick={() => onBus(1)}>MS 3/11</button>
          </div>
        </div>
        <div className="cn-bar-group">
          <span className="tiny dim">{bus === 1 ? "MS" : "HS"} speed</span>
          <div className="seg tiny">
            {SPEEDS.map((b) => (
              <button key={b} className={speed === b ? "active" : ""} disabled={rebooting} onClick={() => onSpeed(b)}>{b / 1000}k</button>
            ))}
          </div>
        </div>
        <div className="cn-bar-group" style={{ marginLeft: "auto" }}>
          <button className="tiny" disabled={rebooting} onClick={onReset} title="Reboot the reader to clear a bus-off / stuck controller">
            {rebooting ? "Rebooting…" : "Reset CAN"}
          </button>
          <button className="tiny" onClick={copyTroubleshoot} disabled={copied === "working"} title="Bundle firmware INFO + CANSTAT + the node table + recent frames as text to paste back for analysis">
            {copyLabel}
          </button>
        </div>
      </div>

      {rebooting && (
        <div className="cn-banner info mt-8">
          <span className="cn-spin" /> Rebooting the reader into {bus === 1 ? "MS" : "HS"} @ {speed / 1000}k… reconnecting automatically.
        </div>
      )}

      <div className="row wrap mt-8" style={{ gap: 14, alignItems: "center" }}>
        <span className="tiny dim"><span className="cn-dot cn-live" /> {online} online</span>
        <span className="tiny dim">{list.length} node{list.length === 1 ? "" : "s"} tracked</span>
        <span className="tiny dim">
          {sim ? "Simulator bus — fake modules." : "Plug/unplug a module and watch it appear & vanish here in real time."}
        </span>
      </div>

      {/* which transceiver transmit is pointed at — follows the pins toggle */}
      {bus === 1 && (
        <div className="cn-banner info mt-8">
          Transmit is pointed at <strong>MS 3/11</strong> — Send · VIN · DTCs · Console · Probe all go out the second
          (MS) transceiver now. Needs the 2nd MCP2515 wired; if <span className="mono">INFO</span> shows
          <span className="mono"> ms=DOWN</span>, requests can’t go out on this bus.
        </div>
      )}

      {/* bus-off / flap warnings — the TCM-going-offline-after-a-send case */}
      {stalled && running && (
        <div className="cn-banner danger mt-8">
          <strong>Bus went quiet</strong> — no frames for &gt;{(STALL_MS / 1000).toFixed(1)}s. If you just transmitted, the
          module likely <strong>bus-off’d</strong> on your request (no ACK / marginal bus).
          <button className="tiny" style={{ marginLeft: 8 }} disabled={rebooting} onClick={onReset}>Reset CAN</button>
        </div>
      )}
      {anyFlapping && !stalled && (
        <div className="cn-banner warn mt-8">
          A module is <strong>flapping</strong> (online→offline repeatedly). Classic sign it’s bus-off’ing right after each
          transmit — check termination (~60&nbsp;Ω) and a hard RS→GND. Copy the troubleshoot data and send it over.
        </div>
      )}

      {!running && list.length === 0 && (
        <p className="tiny dim mt-12">
          Press <strong>Go live</strong> to listen. Every id on the bus becomes a node — diagnostic modules (7E8–7EF) are
          named and clickable; broadcast ids show their bytes changing. Nothing is transmitted until you click a node and send.
        </p>
      )}

      {/* MAP view */}
      {tab === "map" && list.length > 0 && (
        <div className="cn-grid mt-12">
          {list.map((n) => {
            const st = statusOf(n, now);
            const c = classify(n.id);
            const isNew = now - n.firstMs < NEW_MS;
            const decoded = liveDecode(n);
            const dtSec = (n.lastMs - n.firstMs) / 1000;
            const hz = dtSec > 0.6 ? Math.round(n.count / dtSec) : null;
            const flap = flapping(n.id);
            return (
              <button
                key={n.id}
                className={`cn-node ${st} ${selected === n.id ? "sel" : ""}`}
                onClick={() => setSelected(n.id)}
                title={`${c.name} — click to inspect & interact`}
              >
                <div className="cn-node-top">
                  <span className={`cn-dot cn-${st}`} />
                  <span className="cn-id">{hex3(n.id)}</span>
                  {c.kind === "module" && <span className="cn-tag">UDS</span>}
                  {flap && <span className="cn-flap">FLAP</span>}
                  {isNew && st === "live" && !flap && <span className="cn-new">NEW</span>}
                </div>
                <div className="cn-name">{c.name}</div>
                <div className="cn-bytes">
                  {n.data.length
                    ? n.data.map((b, i) => (
                        <span key={i} className={now - n.changedAt[i] < HOT_MS ? "hot" : ""}>{hex2(b)}</span>
                      ))
                    : <span className="dim">—</span>}
                </div>
                <div className="cn-foot">
                  {st === "lost" ? <span className="cn-off">offline</span> : <span>{hz != null ? `${hz} Hz` : "…"}</span>}
                  {decoded && <span className="cn-decode">{decoded}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* RAW view */}
      {tab === "raw" && (
        <div className="mt-12">
          <div className="row spread">
            <span className="tiny dim">{raw.current.length} frame{raw.current.length === 1 ? "" : "s"} captured · newest last</span>
            <button className="tiny" onClick={downloadRaw} disabled={raw.current.length === 0}>Download log</button>
          </div>
          <pre className="mono tiny cn-rawlog">
            {raw.current.length === 0
              ? "(listening… no frames yet)"
              : raw.current.slice(-200).map((f) => `${hex3(f.id)}  ${f.data}`).join("\n")}
          </pre>
        </div>
      )}

      {tab === "map" && sel && (
        <NodeInspector key={sel.id} port={port} node={sel} flapping={flapping(sel.id)} />
      )}

      {/* SIGNALS tab — reverse-engineer broadcast frames (shares the cockpit bus + Go live) */}
      {tab === "signals" && <SignalLab port={port} embedded bus={bus} running={running} />}

      {/* CONSOLE tab — send any UDS service to any module */}
      {tab === "console" && (
        <>
          <p className="tiny dim mt-8">
            Send any service to any id. Requests transmit on <strong>{bus === 1 ? "MS 3/11" : "HS 6/14"}</strong> —
            switch the <strong>pins</strong> toggle above to move transmit between buses.
          </p>
          <UdsConsole port={port} embedded />
        </>
      )}

      {/* INTEL tab — the growing, portable knowledge base of every system we meet */}
      {tab === "intel" && (
        <>
          <div className="row spread mt-8">
            <h4 style={{ margin: 0 }}>Vehicle intelligence <span className="tiny dim">— what we know & can do</span></h4>
          </div>
          <VehicleIntelligence port={port} liveIds={liveIds} buildObservation={buildObservation} />
        </>
      )}
    </div>
  );
}

function NodeInspector({ port, node, flapping }: { port: string; node: Node; flapping: boolean }) {
  const c = classify(node.id);
  const [txid, setTxid] = useState(hex3(c.reqId));
  const [input, setInput] = useState(c.kind === "bcast" ? "22 F1 90" : "3E 00");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [probe, setProbe] = useState<CanFrame[] | null>(null);

  const now = Date.now();
  const st = statusOf(node, now);
  const dtSec = (node.lastMs - node.firstMs) / 1000;
  const hz = dtSec > 0.6 ? Math.round(node.count / dtSec) : null;
  const target = () => parseInt(txid.replace(/[^0-9a-fA-F]/g, ""), 16);

  async function send(bytes: number[], label: string) {
    const id = target();
    if (!bytes.length || !Number.isFinite(id)) return;
    setBusy(true);
    const reqStr = `${hex3(id)} ← ${bytes.map(hex2).join(" ")}`;
    try {
      const resp = await Obd.isotp(port, id, bytes);
      const nrc = negativeResponse(resp);
      let note = nrc ? `negative: ${nrc}` : "positive";
      if (!nrc) {
        if (label === "vin") { const v = parseUdsVin(resp); if (v) note = `VIN ${v}`; }
        else if (label === "dtc") { const d = parseUdsDtcs(resp); note = d.length ? `${d.length} DTC: ${d.map((x) => x.code).join(", ")}` : "no codes"; }
      }
      setLog((h) => [{ req: reqStr, resp: resp.map(hex2).join(" "), note, ok: !nrc }, ...h].slice(0, 20));
    } catch (err) {
      setLog((h) => [{ req: reqStr, resp: "", note: (err as Error).message, ok: false }, ...h].slice(0, 20));
    } finally {
      setBusy(false);
    }
  }

  async function runProbe() {
    const id = target();
    const bytes = parseHex(input);
    if (!bytes.length || !Number.isFinite(id)) return;
    setBusy(true);
    setProbe(null);
    try {
      setProbe(await Obd.reqdump(port, id, bytes));
    } catch {
      setProbe([]);
    } finally {
      setBusy(false);
    }
  }

  const canDiag = c.kind !== "bcast";

  return (
    <div className="card compact mt-12" style={{ borderColor: "var(--border-strong)" }}>
      <div className="row spread">
        <div>
          <strong>{c.name}</strong>{" "}
          <span className="tiny dim mono">
            id {hex3(node.id)} · {canDiag ? `req ${hex3(c.reqId)}` : "broadcast"} · {st === "lost" ? "offline" : `live${hz != null ? ` · ${hz} Hz` : ""}`}
          </span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {flapping && <span className="badge warn">flapping</span>}
          <span className={`badge ${st === "live" ? "ok" : st === "stale" ? "warn" : "danger"}`}>{st}</span>
        </div>
      </div>

      <div className="mono tiny mt-8">
        <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
          <span className="dim" style={{ minWidth: 52 }}>payload</span>
          <span style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {node.data.map((b, i) => (
              <span key={i} className={now - node.changedAt[i] < HOT_MS ? "cn-hotcell" : "cn-cell"}>{hex2(b)}</span>
            ))}
          </span>
        </div>
        {node.history.length > 1 && (
          <div className="row" style={{ gap: 8, alignItems: "baseline", marginTop: 6, opacity: 0.55 }}>
            <span className="dim" style={{ minWidth: 52 }}>recent</span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {node.history.slice(1, 5).map((h, i) => <span key={i}>{bytesToHex(h)}</span>)}
            </span>
          </div>
        )}
      </div>

      <div className="row wrap mt-12" style={{ gap: 6, alignItems: "center" }}>
        <span className="tiny dim">to id</span>
        <input value={txid} onChange={(e) => setTxid(e.target.value)} className="mono" style={{ width: 64 }} />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="mono"
          placeholder="hex, e.g. 22 F1 90"
          style={{ flex: 1, minWidth: 150 }}
          onKeyDown={(e) => { if (e.key === "Enter") send(parseHex(input), "raw"); }}
        />
        <button className="primary" onClick={() => send(parseHex(input), "raw")} disabled={busy}>{busy ? "…" : "Send"}</button>
        <button className="tiny" onClick={runProbe} disabled={busy} title="Send this request, capture every id that replies (finds non-standard response addresses)">
          Probe
        </button>
      </div>

      {canDiag && (
        <div className="row wrap mt-8" style={{ gap: 6 }}>
          <button className="tiny" onClick={() => send(buildTesterPresent(), "raw")} disabled={busy}>Tester present</button>
          <button className="tiny" onClick={() => send(buildSession(0x03), "raw")} disabled={busy}>Extended session</button>
          <button className="tiny" onClick={() => send(buildReadDataById(DID.VIN), "vin")} disabled={busy}>Read VIN</button>
          <button className="tiny" onClick={() => send(buildReadDtcByStatus(0xff), "dtc")} disabled={busy}>Read DTCs</button>
        </div>
      )}

      {!canDiag && (
        <p className="tiny dim mt-8">
          <strong>{hex3(node.id)} is a broadcast id</strong> — it streams data, it doesn’t answer requests, so “Read VIN”
          here would go nowhere. To read VIN/DTCs, send to a <strong>diagnostic request id</strong> (7E0 = engine, 7E1 =
          TCM) — change the “to id” box above. Watch the highlighted bytes or use the <strong>Signals</strong> tab to
          reverse this frame; <strong>Probe</strong> still works if it secretly answers on a non-standard address.
        </p>
      )}

      {log.length > 0 && (
        <pre className="mono tiny" style={{ margin: 0, marginTop: 10, maxHeight: "24vh", overflow: "auto" }}>
          {log.map((e, i) => (
            <span key={i}>
              {`▸ ${e.req}\n`}
              <span style={{ color: e.ok ? "var(--accent)" : "var(--warn)" }}>{`  ${e.resp ? e.resp + "  " : ""}(${e.note})\n`}</span>
            </span>
          ))}
        </pre>
      )}

      {probe && (
        <div className="mt-10">
          <p className="tiny dim">Captured after the request{probe.length === 0 ? " — nothing followed." : ":"}</p>
          {probe.length > 0 && (
            <pre className="mono tiny" style={{ margin: 0, marginTop: 4, maxHeight: "18vh", overflow: "auto" }}>
              {probe.map((f) => {
                const isResp = f.id >= 0x7e8 && f.id <= 0x7ef;
                const line = `${hex3(f.id)}  ${f.data}${isResp ? "   ← response" : ""}`;
                return isResp ? <span key={f.id} style={{ color: "var(--accent)" }}>{line + "\n"}</span> : line + "\n";
              })}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const cnStyles = `
.cn-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; padding: 10px 12px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; }
.cn-bar-group { display: flex; align-items: center; gap: 8px; }
.cn-banner { font-size: 12px; border-radius: 8px; padding: 8px 12px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cn-banner.info { color: var(--info); background: var(--info-dim); }
.cn-banner.warn { color: var(--warn); background: var(--warn-dim); }
.cn-banner.danger { color: var(--danger); background: var(--danger-dim); }
.cn-banner strong { color: inherit; }
.cn-spin { width: 11px; height: 11px; border-radius: 50%; border: 2px solid currentColor; border-top-color: transparent; display: inline-block; animation: cn-rot .7s linear infinite; }
.cn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(184px, 1fr)); gap: 10px; }
.cn-node { text-align: left; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 11px; cursor: pointer; color: var(--fg-0); display: flex; flex-direction: column; gap: 6px; transition: border-color .15s ease, background .15s ease, opacity .4s ease; animation: cn-in .34s ease; }
.cn-node:hover { border-color: var(--border-strong); background: var(--bg-3); }
.cn-node.sel { border-color: var(--accent); background: var(--bg-3); }
.cn-node.stale { opacity: 0.72; }
.cn-node.lost { opacity: 0.4; border-style: dashed; }
.cn-node-top { display: flex; align-items: center; gap: 7px; }
.cn-id { font-family: var(--mono); font-weight: 700; font-size: 14px; letter-spacing: 0.02em; }
.cn-tag { font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em; color: var(--info); border: 1px solid var(--info-dim); border-radius: 4px; padding: 1px 4px; }
.cn-new { margin-left: auto; font-family: var(--mono); font-size: 9px; letter-spacing: 0.12em; color: var(--bg-0); background: var(--accent); border-radius: 4px; padding: 1px 5px; animation: cn-pulse 1s ease infinite; }
.cn-flap { margin-left: auto; font-family: var(--mono); font-size: 9px; letter-spacing: 0.12em; color: var(--bg-0); background: var(--warn); border-radius: 4px; padding: 1px 5px; animation: cn-pulse .8s ease infinite; }
.cn-name { font-size: 12.5px; color: var(--fg-1); }
.cn-bytes { font-family: var(--mono); font-size: 11px; display: flex; gap: 4px; flex-wrap: wrap; color: var(--fg-2); }
.cn-bytes .hot { color: var(--bg-0); background: var(--warn); border-radius: 3px; padding: 0 2px; }
.cn-foot { display: flex; justify-content: space-between; gap: 8px; font-family: var(--mono); font-size: 10.5px; color: var(--fg-2); }
.cn-decode { color: var(--accent); text-align: right; }
.cn-off { color: var(--danger); }
.cn-cell { color: var(--fg-1); }
.cn-hotcell { color: var(--bg-0); background: var(--warn); border-radius: 3px; padding: 0 3px; }
.cn-rawlog { margin: 6px 0 0; max-height: 34vh; overflow: auto; background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.cn-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--fg-2); vertical-align: middle; }
.cn-dot.cn-live { background: var(--accent); animation: cn-ring 1.6s ease infinite; }
.cn-dot.cn-stale { background: var(--warn); }
.cn-dot.cn-lost { background: var(--danger); }
@keyframes cn-in { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes cn-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
@keyframes cn-rot { to { transform: rotate(360deg); } }
@keyframes cn-ring { 0% { box-shadow: 0 0 0 0 rgba(74,222,128,0.5); } 70% { box-shadow: 0 0 0 6px rgba(74,222,128,0); } 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); } }
@media (prefers-reduced-motion: reduce) { .cn-node, .cn-new, .cn-flap, .cn-dot.cn-live, .cn-spin { animation: none !important; } }
`;
