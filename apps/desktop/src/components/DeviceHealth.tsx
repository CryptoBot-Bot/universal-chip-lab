import { useEffect, useRef, useState } from "react";

import { Obd, type BusHealth, type DeviceHealth as DeviceHealthT } from "../lib/obd";

/**
 * Device & wiring health — a self-test cockpit for the OBD reader hardware.
 *
 * Answers "are my modules wired right?" at a glance: each MCP2515 controller is a
 * card that reads DETECTED / NOT DETECTED / IDLE / BUS-OFF, with live counters and
 * a plain-language verdict. One button re-runs the test; another copies a full
 * diagnostic bundle (INFO + both CANSTAT samples + verdicts) to paste back for help.
 */

interface Props {
  port: string;
  firmware?: string | null;
}

const VERDICT: Record<BusHealth["verdict"], { label: string; tone: string }> = {
  healthy: { label: "DETECTED · RECEIVING", tone: "ok" },
  idle:    { label: "DETECTED · IDLE", tone: "warn" },
  busoff:  { label: "BUS-OFF", tone: "danger" },
  down:    { label: "NOT DETECTED", tone: "danger" },
};

const hx = (n: number | null) => (n == null ? "—" : `0x${n.toString(16).toUpperCase().padStart(2, "0")}`);
const val = (n: number | null) => (n == null ? "—" : String(n));

export function DeviceHealth({ port, firmware }: Props) {
  const [health, setHealth] = useState<DeviceHealthT | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ran = useRef(false);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const h = await Obd.selfTest(port);
      setHealth({ ...h, firmware: firmware ?? h.firmware });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function report(): string {
    if (!health) return "";
    const L: string[] = [];
    L.push("=== ECU LAB · DEVICE & WIRING SELF-TEST ===");
    L.push(`firmware : ${health.firmware || "(unknown)"}`);
    L.push(`crystal  : ${health.xtalMHz ?? "?"} MHz   transmit bus: ${health.txbus ?? "?"}   divider ratio: ${health.ratio ?? "?"}`);
    for (const b of [health.hs, health.ms]) {
      L.push("");
      L.push(`${b.label}: ${VERDICT[b.verdict].label} @ ${b.bitrate} bps`);
      L.push(`  rx=${val(b.rx)} (Δ${b.rxDelta}/0.9s) tx=${val(b.tx)} txFail=${val(b.txFail)} tec=${val(b.tec)} rec=${val(b.rec)} eflg=${hx(b.eflg)}`);
      L.push(`  → ${b.note}`);
    }
    L.push("");
    L.push(`raw INFO    : ${health.raw.info}`);
    L.push(`raw CANSTAT1: ${health.raw.canstat1}`);
    L.push(`raw CANSTAT2: ${health.raw.canstat2}`);
    L.push("=== END SELF-TEST ===");
    return L.join("\n");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(report());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="card mt-16">
      <style>{dhStyles}</style>
      <div className="row spread">
        <h3>Device &amp; wiring health <span className="tiny dim">— are both modules connected right?</span></h3>
        <div className="row" style={{ gap: 6 }}>
          <button className="tiny" onClick={copy} disabled={!health}>
            {copied ? "✓ Copied — paste to Claude" : "Copy diagnostics"}
          </button>
          <button className="tiny primary" onClick={run} disabled={running}>
            {running ? "Testing…" : "Re-run self-test"}
          </button>
        </div>
      </div>

      {error && <div className="dh-banner danger mt-8">{error}</div>}

      {health && (
        <>
          <div className="dh-meta mt-12">
            <span className="dh-chip"><span className="dim">firmware</span> {health.firmware || "—"}</span>
            <span className="dh-chip"><span className="dim">crystal</span> {health.xtalMHz ?? "?"} MHz</span>
            <span className="dh-chip"><span className="dim">transmit</span> {health.txbus ?? "?"}</span>
          </div>

          <div className="dh-grid mt-12">
            <ModuleCard bus={health.hs} />
            <ModuleCard bus={health.ms} />
          </div>

          {health.ms.verdict === "down" && (
            <div className="dh-fix mt-12">
              <strong>MS module not detected — quick checklist</strong>
              <ol>
                <li><span className="mono">CS → GP15</span> soldered and continuous to the 2nd module's CS pin.</li>
                <li>2nd module <span className="mono">VCC</span> present, and its supply shares a <strong>common ground</strong> with the Pico/USB.</li>
                <li>Its <span className="mono">SO/MISO</span> reaches <span className="mono">GP16</span> (through the level shifter) — HS proves this net works, so confirm the 2nd module's SO is actually tied onto it.</li>
                <li>Still down with all that good? The module itself may be faulty — swap in a spare and re-test.</li>
              </ol>
            </div>
          )}
        </>
      )}

      {!health && !error && <p className="tiny dim mt-8">Running self-test…</p>}
    </div>
  );
}

function ModuleCard({ bus }: { bus: BusHealth }) {
  const v = VERDICT[bus.verdict];
  return (
    <div className={`dh-card ${bus.verdict}`}>
      <div className="dh-card-head">
        <span className={`dh-dot ${v.tone}`} />
        <span className="dh-card-title">{bus.label}</span>
        <span className={`badge ${v.tone}`} style={{ marginLeft: "auto" }}>{v.label}</span>
      </div>
      <div className="dh-speed">{(bus.bitrate / 1000)}k bps</div>
      <div className="dh-stats">
        <Stat k="rx" v={val(bus.rx)} sub={`Δ${bus.rxDelta}`} hot={bus.rxDelta > 0} />
        <Stat k="tx" v={val(bus.tx)} />
        <Stat k="txFail" v={val(bus.txFail)} warn={!!bus.txFail} />
        <Stat k="tec" v={val(bus.tec)} warn={bus.tec != null && bus.tec > 96} />
        <Stat k="rec" v={val(bus.rec)} />
        <Stat k="eflg" v={hx(bus.eflg)} warn={!!bus.eflg} />
      </div>
      <div className={`dh-note ${v.tone}`}>{bus.note}</div>
    </div>
  );
}

function Stat({ k, v, sub, hot, warn }: { k: string; v: string; sub?: string; hot?: boolean; warn?: boolean }) {
  return (
    <div className="dh-stat">
      <div className="dh-stat-k">{k}</div>
      <div className={`dh-stat-v ${hot ? "hot" : ""} ${warn ? "warn" : ""}`}>
        {v}{sub && <span className="dh-stat-sub"> {sub}</span>}
      </div>
    </div>
  );
}

const dhStyles = `
.dh-banner { font-size: 12px; border-radius: 8px; padding: 8px 12px; }
.dh-banner.danger { color: var(--danger); background: var(--danger-dim); }
.dh-meta { display: flex; flex-wrap: wrap; gap: 8px; }
.dh-chip { font-family: var(--mono); font-size: 11px; color: var(--fg-1); background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 3px 9px; }
.dh-chip .dim { color: var(--fg-2); margin-right: 5px; letter-spacing: 0.04em; }
.dh-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.dh-card { border: 1px solid var(--border); border-radius: 10px; padding: 14px; background: var(--bg-1); }
.dh-card.healthy { border-color: var(--accent); }
.dh-card.down, .dh-card.busoff { border-color: var(--danger); }
.dh-card.idle { border-color: var(--warn); }
.dh-card-head { display: flex; align-items: center; gap: 9px; }
.dh-card-title { font-weight: 600; font-size: 13.5px; }
.dh-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.dh-dot.ok { background: var(--accent); box-shadow: 0 0 0 0 rgba(74,222,128,0.5); animation: dh-ring 1.6s ease infinite; }
.dh-dot.warn { background: var(--warn); }
.dh-dot.danger { background: var(--danger); }
.dh-speed { font-family: var(--mono); font-size: 12px; color: var(--fg-2); margin-top: 10px; }
.dh-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
.dh-stat { background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 7px 9px; }
.dh-stat-k { font-family: var(--mono); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg-2); }
.dh-stat-v { font-family: var(--mono); font-size: 15px; font-weight: 700; color: var(--fg-0); font-variant-numeric: tabular-nums; margin-top: 2px; }
.dh-stat-v.hot { color: var(--accent); }
.dh-stat-v.warn { color: var(--warn); }
.dh-stat-sub { font-size: 10px; font-weight: 400; color: var(--fg-2); }
.dh-note { font-size: 11.5px; line-height: 1.5; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
.dh-note.ok { color: var(--fg-1); }
.dh-note.warn { color: var(--warn); }
.dh-note.danger { color: var(--danger); }
.dh-fix { background: var(--danger-dim); border: 1px solid var(--danger); border-radius: 8px; padding: 12px 14px; font-size: 12px; color: var(--fg-0); }
.dh-fix strong { color: var(--danger); }
.dh-fix ol { margin: 8px 0 0; padding-left: 18px; line-height: 1.7; }
.dh-fix .mono { color: var(--fg-0); }
@keyframes dh-ring { 0% { box-shadow: 0 0 0 0 rgba(74,222,128,0.5); } 70% { box-shadow: 0 0 0 6px rgba(74,222,128,0); } 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); } }
@media (prefers-reduced-motion: reduce) { .dh-dot.ok { animation: none !important; } }
`;
