import { useCallback, useEffect, useRef, useState } from "react";

import { CanNetwork } from "../components/CanNetwork";
import { DeviceHealth } from "../components/DeviceHealth";
import { Topbar } from "../components/Topbar";
import { VehicleScan } from "../components/VehicleScan";
import { Obd, type SimScenario, type Telemetry } from "../lib/obd";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gaugePct(v: number): number {
  return Math.max(0, Math.min(100, ((v - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * 100));
}

/** A labelled divider that groups the tab into human-scannable sections. */
function GroupHeader({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="row" style={{ margin: "26px 0 2px", alignItems: "center", gap: 12 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)" }}>
        {label}
      </span>
      <span style={{ height: 1, flex: 1, background: "var(--border)" }} />
      {hint && <span className="tiny dim">{hint}</span>}
    </div>
  );
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
  const [bus, setBus] = useState(0); // 0 = HS (6/14), 1 = MS (3/11)
  const [rebooting, setRebooting] = useState(false);
  const rebootingRef = useRef(false);
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

  const polling = useRef(false); // serial round-trips are serialised; skip if one is mid-flight
  const liveOn = useRef(false);
  const livePidsRef = useRef<number[]>([]);

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    try {
      const ports = await Obd.findPorts();
      if (ports.length === 0) {
        throw new Error("No Pico found. Plug the OBD reader in over USB, close Thonny, and check Device Manager.");
      }
      let found: string | null = null;
      let banner = "";
      for (const p of ports) {
        try {
          banner = await Obd.identify(p);
          found = p;
          break;
        } catch {
          await Obd.disconnect(p).catch(() => undefined);
        }
      }
      if (!found) {
        throw new Error(
          `Found ${ports.length} Pico(s) (${ports.join(", ")}) but none is running OBD-Reader firmware. ` +
            `Flash obd_reader.ino to the reader, or unplug other RP2040 boards.`,
        );
      }
      setPort(found);
      setFirmware(banner);
      setRatio(await Obd.readRatio(found).catch(() => 5.7));
      setBusSpeed(await Obd.readBitrate(found).catch(() => 500000));
      setBusSpeedMs(await Obd.readBitrateMs(found).catch(() => 125000));
      setBus(0);
      await Obd.selectBus(found, 0).catch(() => undefined); // start on HS, UI + firmware agree
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
    setStatus("idle");
    setPort(null);
    setFirmware(null);
    setTelemetry(null);
    setSim(null);
    setLivePids([]);
    setLiveValues(new Map());
    setDtcs(null);
    setVin(null);
  }, [port]);

  // Reboot the reader (speed change / bus-off recovery) and reconnect WITHOUT a
  // second reboot, polling until the port re-enumerates. The connected view stays
  // mounted (so Live Network keeps its state) and everything pauses meanwhile.
  const rebootAndReconnect = useCallback(async (issue: () => Promise<void>) => {
    if (!port) return;
    rebootingRef.current = true;
    setRebooting(true);
    setError(null);
    try {
      await issue();
    } catch {
      /* the reboot kills the in-flight reply; expected */
    }
    await Obd.disconnect(port).catch(() => undefined);
    await sleep(1200); // let USB drop + start to re-enumerate
    const deadline = Date.now() + 9000;
    let ok = false;
    while (Date.now() < deadline) {
      try {
        const ports = await Obd.findPorts();
        const tgt = ports.includes(port) ? port : ports[0];
        if (tgt) {
          const banner = await Obd.reconnect(tgt);
          setPort(tgt);
          setFirmware(banner);
          setBusSpeed(await Obd.readBitrate(tgt).catch(() => 500000));
          setBusSpeedMs(await Obd.readBitrateMs(tgt).catch(() => 125000));
          ok = true;
          break;
        }
      } catch {
        /* not back yet — keep polling */
      }
      await sleep(600);
    }
    rebootingRef.current = false;
    setRebooting(false);
    if (!ok) {
      setError("Reader didn't come back after the reboot — unplug/replug the USB and hit Connect again.");
      setStatus("error");
    }
  }, [port]);

  async function changeBus(next: number) {
    setBus(next); // instant — no reboot
    // Point transmit + ISO-TP at the selected bus so Send/VIN/DTCs/Console/Run
    // talk to whatever is on these pins (HS 6/14 or MS 3/11).
    if (port) await Obd.selectBus(port, next);
  }

  async function changeBusSpeed(bps: number) {
    const current = bus === 1 ? busSpeedMs : busSpeed;
    if (!port || bps === current) return;
    if (bus === 1) setBusSpeedMs(bps); else setBusSpeed(bps);
    await rebootAndReconnect(() => Obd.setBusSpeed(port, bps, bus));
  }

  async function resetCanAndReconnect() {
    if (!port) return;
    await rebootAndReconnect(() => Obd.resetCan(port));
  }

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
      setSim(next === "OFF" ? null : next);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // One poll tick: battery always; live PIDs when a scan is active. Paused during
  // a reboot so a dropped session doesn't surface as a connection error.
  useEffect(() => {
    if (status !== "connected" || !port) return;
    let cancelled = false;
    const tick = async () => {
      if (polling.current || rebootingRef.current) return;
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
      } catch (err) {
        if (!cancelled && !rebootingRef.current) {
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
      const fresh = await Obd.readTelemetry(port);
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
      await Obd.canInit(port).catch(() => undefined);
      const pids = await Obd.scanSupportedPids(port);
      setLivePids(pids);
      livePidsRef.current = pids;
      liveOn.current = true;
      if (pids.length === 0) {
        setLiveError("No module answered the OBD-II request. Use Live network above to see whether raw frames arrive at all.");
      }
    } catch (err) {
      liveOn.current = false;
      setLiveError((err as Error).message);
    } finally {
      setScanning(false);
    }
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
              battery voltage, map the bus, and pull trouble codes.
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

        {/* ───────────────── THE BUS COCKPIT ───────────────── */}
        <GroupHeader label="The bus cockpit" hint="map · raw · signals · console — one place to watch & talk" />

        {!sim && <DeviceHealth port={port!} firmware={firmware} />}

        <CanNetwork
          port={port!}
          sim={!!sim}
          bus={bus}
          speed={bus === 1 ? busSpeedMs : busSpeed}
          rebooting={rebooting}
          onBus={changeBus}
          onSpeed={changeBusSpeed}
          onReset={resetCanAndReconnect}
        />

        {/* ───────────────── GUIDED DIAGNOSTICS ───────────────── */}
        <GroupHeader label="Guided diagnostics" hint="discover every module · read codes · live data" />

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
