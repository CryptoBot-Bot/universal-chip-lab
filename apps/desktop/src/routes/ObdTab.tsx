import { useCallback, useEffect, useRef, useState } from "react";

import { SignalLab } from "../components/SignalLab";
import { Topbar } from "../components/Topbar";
import { UdsConsole } from "../components/UdsConsole";
import { VehicleScan } from "../components/VehicleScan";
import { Obd, type CanFrame, type SimScenario, type Telemetry } from "../lib/obd";
import type { Dtc, PidReading } from "../lib/obd-protocol";

type Status = "idle" | "connecting" | "connected" | "error";
interface Dtcs { stored: Dtc[]; pending: Dtc[]; permanent: Dtc[] }

const POLL_MS = 1200; // live refresh; the firmware answers each request on demand
const GAUGE_MIN = 10.5;
const GAUGE_MAX = 15.0;

const STATE_BADGE: Record<Telemetry["state"], string> = { LOW: "danger", OK: "ok", CHARGING: "info" };
const STATE_NOTE: Record<Telemetry["state"], string> = {
  LOW: "Weak / discharged — below 11.8 V",
  OK: "Healthy at rest — engine off, ignition on",
  CHARGING: "Alternator running — 13.2 V+",
};

const SCENARIOS: { key: SimScenario; label: string }[] = [
  { key: "IGNITION", label: "Ignition (12.5 V)" },
  { key: "WEAK", label: "Weak battery" },
  { key: "IDLE", label: "Engine idle" },
  { key: "DRIVE", label: "Engine start → drive" },
];

function gaugePct(v: number): number {
  return Math.max(0, Math.min(100, ((v - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * 100));
}

export function ObdTab() {
  const [status, setStatus] = useState<Status>("idle");
  const [port, setPort] = useState<string | null>(null);
  const [firmware, setFirmware] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [ratio, setRatio] = useState(5.7);
  const [busSpeed, setBusSpeed] = useState(500000);
  const [busSpeedMs, setBusSpeedMs] = useState(125000);
  const [monitorBus, setMonitorBusState] = useState(0); // 0 = HS (6/14), 1 = MS (3/11)
  const monitorBusRef = useRef(0);
  const [calTarget, setCalTarget] = useState("12.0");
  const [calMsg, setCalMsg] = useState<string | null>(null);
  const [sim, setSim] = useState<SimScenario | null>(null);

  // live data (active OBD-II PID polling)
  const [livePids, setLivePids] = useState<number[]>([]);
  const [liveValues, setLiveValues] = useState<Map<number, PidReading>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  // diagnostics (codes + VIN)
  const [dtcs, setDtcs] = useState<Dtcs | null>(null);
  const [vin, setVin] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // raw bus monitor (passive sniff — independent of any OBD request/response)
  const [canFrames, setCanFrames] = useState<CanFrame[]>([]);
  const [monitoring, setMonitoring] = useState(false);
  const [monitorSeen, setMonitorSeen] = useState(0); // total frames seen since monitor start
  const [probeFrames, setProbeFrames] = useState<CanFrame[] | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);

  const polling = useRef(false); // serial round-trips are serialised; skip if one is mid-flight
  const liveOn = useRef(false);
  const livePidsRef = useRef<number[]>([]);
  const monitorOn = useRef(false);
  const logRef = useRef<string[]>([]); // captured bus frames (timestamped) while monitoring
  const [logLines, setLogLines] = useState(0);
  const emptyPolls = useRef(0); // consecutive empty monitor polls after frames had flowed
  const seenAny = useRef(false);
  const [canStalled, setCanStalled] = useState(false);

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    try {
      const found = await Obd.findPort();
      if (!found) {
        throw new Error("No Pico found. Plug the OBD reader in over USB, close Thonny, and check Device Manager.");
      }
      const banner = await Obd.identify(found); // reboots firmware + verifies it's the OBD build
      setPort(found);
      setFirmware(banner);
      setRatio(await Obd.readRatio(found).catch(() => 5.7)); // show the device's actual ratio
      setBusSpeed(await Obd.readBitrate(found).catch(() => 500000));
      setBusSpeedMs(await Obd.readBitrateMs(found).catch(() => 125000));
      setStatus("connected");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }, []);

  const disconnect = useCallback(() => {
    if (port) Obd.disconnect(port).catch(() => undefined);
    liveOn.current = false;
    livePidsRef.current = [];
    monitorOn.current = false;
    setStatus("idle");
    setPort(null);
    setFirmware(null);
    setTelemetry(null);
    setSim(null);
    setLivePids([]);
    setLiveValues(new Map());
    setDtcs(null);
    setVin(null);
    setCanFrames([]);
    setMonitoring(false);
    setMonitorSeen(0);
    seenAny.current = false;
    emptyPolls.current = 0;
    setCanStalled(false);
  }, [port]);

  // Bench simulator scenario (or OFF). Changing it resets diagnostics so stale
  // sim codes/values don't linger across scenarios.
  async function chooseScenario(next: SimScenario) {
    if (!port) return;
    setError(null);
    try {
      await Obd.setSim(port, next);
      liveOn.current = false;
      livePidsRef.current = [];
      setLivePids([]);
      setLiveValues(new Map());
      setDtcs(null);
      setVin(null);
      setCanFrames([]);
      setSim(next === "OFF" ? null : next);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // One poll tick: battery always; live PIDs when a scan is active; raw frames
  // alongside. All sequential because the device handles one command at a time.
  useEffect(() => {
    if (status !== "connected" || !port) return;
    let cancelled = false;
    const tick = async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const t = await Obd.readTelemetry(port);
        if (!cancelled) setTelemetry(t);

        if (liveOn.current && livePidsRef.current.length) {
          const next = new Map<number, PidReading>();
          for (const pid of livePidsRef.current) {
            try {
              const r = await Obd.readPid(port, pid);
              if (r) next.set(pid, r);
            } catch {
              /* skip a PID that errored this round */
            }
          }
          if (!cancelled) setLiveValues(next);
        }

        // Passive bus monitor: just listen for whatever frames arrive, whether or
        // not anything answered our requests. This is the key diagnostic.
        if (monitorOn.current || (liveOn.current && livePidsRef.current.length)) {
          try {
            const frames = await Obd.canDump(port, monitorBusRef.current);
            if (!cancelled) {
              setCanFrames(frames);
              if (frames.length) setMonitorSeen((n) => n + frames.length);
              if (monitorOn.current && frames.length) {
                const ts = Date.now();
                for (const f of frames) {
                  logRef.current.push(`${ts} ${f.id.toString(16).toUpperCase().padStart(3, "0")} ${f.data}`);
                }
                if (logRef.current.length > 10000) logRef.current.splice(0, logRef.current.length - 10000);
                setLogLines(logRef.current.length);
              }
              // Stall detection: frames were flowing, then stopped → likely bus-off.
              if (monitorOn.current) {
                if (frames.length) {
                  seenAny.current = true;
                  emptyPolls.current = 0;
                  if (canStalled) setCanStalled(false);
                } else if (seenAny.current) {
                  emptyPolls.current++;
                  if (emptyPolls.current >= 5 && !canStalled) setCanStalled(true);
                }
              }
            }
          } catch {
            /* best-effort */
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setStatus("error");
        }
      } finally {
        polling.current = false;
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status, port]);

  async function calibrateToKnownVoltage() {
    if (!port) return;
    setCalMsg(null);
    const actual = Number(calTarget);
    if (!actual || actual <= 0) {
      setError("Enter the true voltage your meter reads.");
      return;
    }
    if (sim) {
      setError("Turn the simulator Off (live) before calibrating — sim voltage is fake.");
      return;
    }
    setError(null);
    try {
      const newRatio = await Obd.calibrateToVoltage(port, actual);
      setRatio(newRatio);
      const fresh = await Obd.readTelemetry(port); // refresh the gauge immediately, don't wait for the poll
      setTelemetry(fresh);
      setCalMsg(`Calibrated: ratio = ${newRatio.toFixed(3)} — now reading ${fresh.volts.toFixed(2)} V (target ${actual.toFixed(2)}).`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetMinMax() {
    if (!port) return;
    try {
      await Obd.resetMinMax(port);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function scanVehicle() {
    if (!port) return;
    setScanning(true);
    setLiveError(null);
    try {
      await Obd.canInit(port).catch(() => undefined); // harmless if already up / sim
      const pids = await Obd.scanSupportedPids(port);
      setLivePids(pids);
      livePidsRef.current = pids;
      liveOn.current = true;
      if (pids.length === 0) {
        setLiveError("No module answered the OBD-II request. Try Monitor bus below to see whether any raw frames arrive at all.");
      }
    } catch (err) {
      liveOn.current = false;
      setLiveError((err as Error).message);
    } finally {
      setScanning(false);
    }
  }

  function toggleMonitor() {
    if (!port) return;
    const next = !monitorOn.current;
    monitorOn.current = next;
    setMonitoring(next);
    if (next) {
      setCanFrames([]);
      setMonitorSeen(0);
      logRef.current = [];
      setLogLines(0);
      seenAny.current = false;
      emptyPolls.current = 0;
      setCanStalled(false);
      Obd.canInit(port).catch(() => undefined); // ensure CAN is up (no-op on this firmware)
    }
  }

  // Switch which bus the passive monitor listens on (HS pins 6/14 vs MS pins 3/11).
  function changeMonitorBus(bus: number) {
    monitorBusRef.current = bus;
    setMonitorBusState(bus);
    setCanFrames([]);
    setMonitorSeen(0);
    seenAny.current = false;
    emptyPolls.current = 0;
    setCanStalled(false);
  }

  // Change a bus's speed: the reader stores it and reboots, so reconnect after.
  async function changeBusSpeed(b: number, bus: number) {
    const current = bus === 1 ? busSpeedMs : busSpeed;
    if (!port || b === current) return;
    if (bus === 1) setBusSpeedMs(b); else setBusSpeed(b);
    await Obd.setBusSpeed(port, b, bus);
    disconnect();
    setTimeout(() => { void connect(); }, 3500); // reader reboots into the new speed
  }

  // Recover from a bus-off stall: reboot the reader, then auto-reconnect.
  async function resetCanAndReconnect() {
    if (!port) return;
    setCanStalled(false);
    seenAny.current = false;
    emptyPolls.current = 0;
    await Obd.resetCan(port);
    disconnect();
    setTimeout(() => { void connect(); }, 3500); // reader reboots + re-enumerates
  }

  async function probeAndCapture() {
    if (!port) return;
    setProbeBusy(true);
    setProbeFrames(null);
    setError(null);
    try {
      // Send a functional OBD-II supported-PIDs request, capture everything that follows.
      const frames = await Obd.reqdump(port, 0x7df, [0x01, 0x00]);
      setProbeFrames(frames);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProbeBusy(false);
    }
  }

  function downloadLog() {
    const blob = new Blob([logRef.current.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `can-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function readCodes() {
    if (!port) return;
    setDiagBusy(true);
    setDiagError(null);
    setConfirmClear(false);
    try {
      await Obd.canInit(port).catch(() => undefined);
      const [codes, v] = await Promise.all([Obd.readDtcs(port), Obd.readVin(port).catch(() => "")]);
      setDtcs(codes);
      setVin(v);
    } catch (err) {
      setDiagError((err as Error).message);
    } finally {
      setDiagBusy(false);
    }
  }

  async function clearCodes() {
    if (!port) return;
    setDiagBusy(true);
    setDiagError(null);
    try {
      await Obd.clearDtcs(port);
      setConfirmClear(false);
      const codes = await Obd.readDtcs(port);
      setDtcs(codes);
    } catch (err) {
      setDiagError((err as Error).message);
    } finally {
      setDiagBusy(false);
    }
  }

  if (status !== "connected") {
    return (
      <>
        <Topbar title="OBD Reader" crumb={status === "error" ? "connection failed" : "not connected"} />
        <div className="content">
          <div className="card">
            <h3>Connect the OBD-II reader</h3>
            <p className="tiny dim mt-8">
              Flash <span className="mono">hardware/obd-reader/firmware/main.py</span> to the Pico (see{" "}
              <span className="mono">FLASH.md</span>), plug it in over USB, and close Thonny. Then connect to read live
              battery voltage, scan all live data, and pull trouble codes.
            </p>
            <div className="row mt-12">
              <button className="primary" onClick={connect} disabled={status === "connecting"}>
                {status === "connecting" ? "Connecting…" : "Connect"}
              </button>
            </div>
            {status === "error" && error && <p className="tiny mt-12" style={{ color: "var(--danger)" }}>{error}</p>}
          </div>

          <div className="card mt-16">
            <h3>🛑 Bench checklist — before the car</h3>
            <ol className="tiny dim mt-8" style={{ lineHeight: 1.7, paddingLeft: 18 }}>
              <li>Feed the protected 12 V input from a <strong>bench supply</strong>, not the car yet.</li>
              <li>Meter <strong>LM2596 OUT+</strong> → confirm <strong>5.1 V</strong> before it ever reaches the Pico.</li>
              <li>Only then connect OUT+ → Pico VSYS, plug USB, and Connect above.</li>
              <li>Sweep the supply 12 → 14.4 V and watch the reading track it. Calibrate the ratio if it's off.</li>
              <li>At the car: fuse in, <strong>laptop on battery</strong>, ignition on → start → watch 12 → ~14 V. 🔋</li>
            </ol>
          </div>
        </div>
      </>
    );
  }

  const t = telemetry;
  const badge = t ? STATE_BADGE[t.state] : "info";
  const readings = livePids.map((p) => liveValues.get(p)).filter((r): r is PidReading => !!r);

  return (
    <>
      <Topbar
        title="OBD Reader"
        crumb={`${firmware ?? "OBD-Reader"} · ${port}`}
        actions={
          <>
            {sim && <span className="badge warn" style={{ marginRight: 8 }}>⚠ SIMULATION</span>}
            <button className="tiny" onClick={disconnect}>Disconnect</button>
          </>
        }
      />
      <div className="content">
        {error && (
          <div className="card" style={{ borderColor: "var(--danger)", marginBottom: 16 }}>
            <p className="tiny" style={{ color: "var(--danger)", margin: 0 }}>
              {error} <button className="tiny" style={{ marginLeft: 8 }} onClick={() => setError(null)}>dismiss</button>
            </p>
          </div>
        )}
        {/* Bench simulator */}
        <div className="card" style={{ borderColor: sim ? "var(--warn)" : "var(--border)" }}>
          <div className="row spread">
            <h3>Bench simulator <span className="tiny dim">— exercise the app with no car</span></h3>
            {sim ? <span className="badge warn">SIMULATION · {sim}</span> : <span className="badge dim">live hardware</span>}
          </div>
          <div className="row wrap mt-12" style={{ gap: 8 }}>
            {SCENARIOS.map((s) => (
              <button key={s.key} className={sim === s.key ? "primary" : ""} onClick={() => chooseScenario(s.key)}>
                {s.label}
              </button>
            ))}
            <button className={!sim ? "primary" : ""} onClick={() => chooseScenario("OFF")} style={{ marginLeft: "auto" }}>
              Off (live)
            </button>
          </div>
          <p className="tiny dim mt-8">
            {sim
              ? "All readings below are FAKE, generated on the Pico — for app testing only. Switch Off before reading a real car."
              : "Pick a scenario to inject a realistic battery curve + a simulated ECU you can scan for live data and codes."}
          </p>
        </div>

        {/* Battery */}
        <div className="card mt-16" style={{ borderColor: t ? `var(--${badge === "ok" ? "accent" : badge})` : "var(--border)" }}>
          <div className="row spread">
            <h3>Battery voltage</h3>
            {t && <span className={`badge ${badge}`}>{t.state}</span>}
          </div>
          <div className="row spread mt-12" style={{ alignItems: "baseline" }}>
            <span className="mono" style={{ fontSize: 44, fontWeight: 700, lineHeight: 1 }}>
              {t ? t.volts.toFixed(2) : "––.––"}<span className="dim" style={{ fontSize: 20 }}> V</span>
            </span>
            <span className="tiny dim">{t ? STATE_NOTE[t.state] : "waiting for first sample…"}</span>
          </div>
          <div style={{ marginTop: 14, height: 12, borderRadius: 6, background: "var(--bg-3)", position: "relative", overflow: "hidden" }}>
            <div style={{ width: `${t ? gaugePct(t.volts) : 0}%`, height: "100%", background: `var(--${badge === "ok" ? "accent" : badge})`, transition: "width 0.4s ease" }} />
          </div>
          <div className="row spread tiny dim mt-8">
            <span>{GAUGE_MIN.toFixed(1)} V</span>
            <span>session min {t ? t.vmin.toFixed(2) : "—"} · max {t ? t.vmax.toFixed(2) : "—"}</span>
            <span>{GAUGE_MAX.toFixed(1)} V</span>
          </div>
          <div className="row wrap mt-12" style={{ gap: 8 }}>
            <button className="tiny" onClick={resetMinMax}>Reset min/max</button>
            <span className="tiny dim" style={{ marginLeft: "auto" }}>my meter reads</span>
            <input type="number" step="0.1" value={calTarget} onChange={(e) => setCalTarget(e.target.value)} style={{ width: 76 }} />
            <span className="tiny dim">V</span>
            <button className="tiny primary" onClick={calibrateToKnownVoltage} disabled={!telemetry || !!sim}>Calibrate</button>
          </div>
          <p className="tiny dim mt-8">
            Feed a known voltage (your WSP3010H + multimeter), type that exact voltage above, hit Calibrate — the device
            back-solves the divider ratio so the reading matches. Current ratio <span className="mono">{ratio.toFixed(3)}</span>.
          </p>
          {calMsg && <p className="tiny mt-8" style={{ color: "var(--accent)" }}>{calMsg}</p>}
        </div>

        {/* Full vehicle scan — discover every module + read its codes/VIN */}
        <VehicleScan port={port!} sim={!!sim} />

        {/* Live data — active OBD-II query scan */}
        <div className="card mt-16">
          <div className="row spread">
            <h3>Live data <span className="tiny dim">— Mode 01 parameters this vehicle reports</span></h3>
            <button className="primary" onClick={scanVehicle} disabled={scanning}>
              {scanning ? "Scanning…" : livePids.length ? "Re-scan" : "Scan vehicle"}
            </button>
          </div>
          {liveError && <p className="tiny mt-8" style={{ color: "var(--warn)" }}>{liveError}</p>}
          {!livePids.length && !liveError && (
            <p className="tiny dim mt-8">
              Scan asks the ECU which PIDs it supports, then polls each live. On a real car this needs can2040 firmware;
              in the bench simulator it works now — pick a scenario above and scan.
            </p>
          )}
          {readings.length > 0 && (
            <div className="grid cols-2 mt-12" style={{ gap: 8 }}>
              {readings.map((r) => (
                <div key={r.pid} className="card compact" style={{ padding: "8px 12px" }}>
                  <div className="tiny dim">{r.label} <span className="mono">· {r.pid.toString(16).toUpperCase().padStart(2, "0")}</span></div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700 }}>{r.text}</div>
                </div>
              ))}
            </div>
          )}
          {!!livePids.length && (
            <p className="tiny dim mt-8">{livePids.length} supported PID{livePids.length === 1 ? "" : "s"} · polling every {(POLL_MS / 1000).toFixed(1)} s</p>
          )}
        </div>

        {/* Diagnostics — trouble codes + VIN */}
        <div className="card mt-16">
          <div className="row spread">
            <h3>Diagnostics <span className="tiny dim">— trouble codes & VIN</span></h3>
            <button className="primary" onClick={readCodes} disabled={diagBusy}>
              {diagBusy ? "Reading…" : dtcs ? "Re-read codes" : "Read codes"}
            </button>
          </div>
          {diagError && <p className="tiny mt-8" style={{ color: "var(--warn)" }}>{diagError}</p>}
          {!dtcs && !diagError && (
            <p className="tiny dim mt-8">Reads stored (Mode 03), pending (07) and permanent (0A) codes, plus the VIN.</p>
          )}
          {vin && <p className="tiny mt-8">VIN <span className="mono">{vin}</span></p>}
          {dtcs && (
            <>
              <DtcList title="Stored" tone="danger" codes={dtcs.stored} />
              <DtcList title="Pending" tone="warn" codes={dtcs.pending} />
              <DtcList title="Permanent" tone="info" codes={dtcs.permanent} />
              {dtcs.stored.length + dtcs.pending.length === 0 && (
                <p className="badge ok mt-12">✓ No stored or pending codes</p>
              )}
              <div className="row wrap mt-12" style={{ gap: 8 }}>
                {!confirmClear ? (
                  <button className="tiny" onClick={() => setConfirmClear(true)} disabled={diagBusy || dtcs.stored.length === 0}>
                    Clear codes…
                  </button>
                ) : (
                  <>
                    <span className="tiny" style={{ color: "var(--danger)" }}>
                      ⚠ This WRITES to the car and turns off the check-engine light. Codes return if the fault persists.
                    </span>
                    <button className="tiny" onClick={() => setConfirmClear(false)}>Cancel</button>
                    <button className="tiny primary" style={{ background: "var(--danger)" }} onClick={clearCodes} disabled={diagBusy}>
                      Yes, clear codes
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Passive bus monitor — listens for raw frames regardless of requests */}
        <div className="card mt-16" style={{ borderColor: monitoring ? "var(--info)" : "var(--border)" }}>
          <div className="row spread">
            <h3>Bus monitor <span className="tiny dim">— passive · {monitorBus === 1 ? "MS-CAN (pins 3/11)" : "HS-CAN (pins 6/14)"}</span></h3>
            <div className="row" style={{ gap: 8 }}>
              <div className="seg tiny">
                <button className={monitorBus === 0 ? "active" : ""} onClick={() => changeMonitorBus(0)}>HS 6/14</button>
                <button className={monitorBus === 1 ? "active" : ""} onClick={() => changeMonitorBus(1)}>MS 3/11</button>
              </div>
              {logLines > 0 && (
                <button className="tiny" onClick={downloadLog} title="Download captured frames as a .txt log">
                  Download log ({logLines})
                </button>
              )}
              <button className="tiny" onClick={resetCanAndReconnect} title="Reboot the reader to clear a bus-off and reconnect">
                Reset CAN
              </button>
              <button className={monitoring ? "primary" : ""} onClick={toggleMonitor}>
                {monitoring ? "Stop monitoring" : "Monitor bus"}
              </button>
            </div>
          </div>
          <div className="row mt-8" style={{ gap: 8, alignItems: "center" }}>
            <span className="tiny dim">{monitorBus === 1 ? "MS" : "HS"} speed</span>
            <div className="seg tiny">
              {[500000, 250000, 125000].map((b) => {
                const active = (monitorBus === 1 ? busSpeedMs : busSpeed) === b;
                return (
                  <button key={b} className={active ? "active" : ""} onClick={() => changeBusSpeed(b, monitorBus)}>
                    {b / 1000}k
                  </button>
                );
              })}
            </div>
            <span className="tiny dim">
              {monitorBus === 1
                ? "MS-CAN (pins 3/11) is usually 125k. Changing reboots the reader."
                : "HS-CAN (pins 6/14) is 500k on almost all 2008+ cars. Changing reboots the reader."}
            </span>
          </div>
          {canStalled && (
            <div className="card compact mt-8" style={{ borderColor: "var(--warn)" }}>
              <p className="tiny" style={{ color: "var(--warn)", margin: 0 }}>
                ⚠ Frames stopped — the controller likely went <strong>bus-off</strong> (a transmit wasn't ACK'd). This
                won't happen on a real multi-module car.{" "}
                <button className="tiny primary" style={{ marginLeft: 6 }} onClick={resetCanAndReconnect}>Reset CAN now</button>
              </p>
            </div>
          )}
          {monitoring && (
            <p className="tiny dim mt-8">
              Listening on CAN-H/CAN-L… <strong>{monitorSeen}</strong> frame{monitorSeen === 1 ? "" : "s"} seen.
              {monitorSeen === 0 && " If this stays 0, nothing is reaching the reader — see the checklist below."}
            </p>
          )}
          {canFrames.length > 0 && (
            <pre className="mono tiny" style={{ margin: 0, marginTop: 10, maxHeight: "24vh", overflow: "auto" }}>
              {canFrames.map((f) => `${f.id.toString(16).toUpperCase().padStart(3, "0")}  ${f.data}`).join("\n")}
            </pre>
          )}
          {monitoring && monitorSeen === 0 && (
            <ul className="tiny dim mt-8" style={{ lineHeight: 1.7, paddingLeft: 18 }}>
              <li><strong>Swap CAN-H / CAN-L</strong> — they're easy to get backwards.</li>
              <li><strong>Common ground</strong> tied: reader GND ↔ TCM ground ↔ supply minus.</li>
              <li>Terminator across the CAN pair (your 100 Ω).</li>
              <li>If a powered, known-good module still shows 0 frames, the issue is likely our reader's CAN — a known-broadcasting partner (2nd Pico) would prove it.</li>
            </ul>
          )}

          {/* Active probe — find responses on ANY address (incl. non-standard) */}
          <div className="row spread mt-12" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <span className="tiny dim">Active probe — send a request, capture every id that follows</span>
            <button className="tiny" onClick={probeAndCapture} disabled={probeBusy}>
              {probeBusy ? "Probing…" : "Probe & capture"}
            </button>
          </div>
          {probeFrames && (
            <div className="mt-8">
              {probeFrames.length === 0 ? (
                <p className="tiny dim">Nothing on the bus after the request.</p>
              ) : (
                <>
                  <p className="tiny dim">Distinct ids seen after the request (a diagnostic response shows in <span style={{ color: "var(--accent)" }}>green</span>):</p>
                  <pre className="mono tiny" style={{ margin: 0, marginTop: 6, maxHeight: "20vh", overflow: "auto" }}>
                    {probeFrames.map((f) => {
                      const isResp = f.id >= 0x7e8 && f.id <= 0x7ef;
                      const line = `${f.id.toString(16).toUpperCase().padStart(3, "0")}  ${f.data}${isResp ? "   ← response" : ""}`;
                      return isResp ? <span key={f.id} style={{ color: "var(--accent)" }}>{line + "\n"}</span> : line + "\n";
                    })}
                  </pre>
                  <p className="tiny dim mt-8">
                    If you only see your known broadcast ids (174/176/177/421/560) and no response, this module isn't
                    answering tester requests standalone — normal for a bench TCM without the rest of the car's network.
                    On a real car the engine ECM does answer. Tell me any new id and I'll target it.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Signal Lab — reverse-engineer raw broadcast frames into named signals */}
        <SignalLab port={port!} />

        {/* UDS console — send any service to any module (diagnostic control) */}
        <UdsConsole port={port!} />
      </div>
    </>
  );
}

function DtcList({ title, tone, codes }: { title: string; tone: string; codes: Dtc[] }) {
  if (codes.length === 0) return null;
  return (
    <div className="mt-12">
      <div className="row" style={{ gap: 8 }}>
        <span className={`badge ${tone}`}>{title} · {codes.length}</span>
      </div>
      {codes.map((d) => (
        <div key={d.code} className="row" style={{ gap: 10, marginTop: 6, alignItems: "baseline" }}>
          <span className="mono" style={{ fontWeight: 700, minWidth: 56 }}>{d.code}</span>
          <span className="tiny dim">{d.description}</span>
        </div>
      ))}
    </div>
  );
}
