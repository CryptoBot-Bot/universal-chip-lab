import { useCallback, useEffect, useRef, useState } from "react";

import { Api, type DiscoveredDevice, type PairedDevice } from "../lib/api";
import { useSuperDevice } from "../lib/superdevice-connection";
import { DESK_SIM, useWorkbench, type SimStatus } from "../lib/workbench";
import { DeviceSections } from "../components/devices/DeviceSections";
import { ObdConnector } from "../components/devices/ObdConnector";
import { PairPanel } from "../components/devices/PairPanel";
import {
  BatteryBar, ICON, Icon, availability, availabilityChip, deviceName, errText, shortUptime,
  type DeviceInfo, type DeviceStatus, type LiveState,
} from "../components/devices/common";
import "./devicesTab.css";

/**
 * Pi Devices — the fleet room, in the B1 look.
 *
 * Top to bottom: "Your devices" (scan / pair), a card per paired Pi plus the desk
 * simulator on this PC, the OBD-II connector (which pins reach the Pi), then the
 * selected Pi's settings — Connection, Buses, Safety, Power, Software, Recordings,
 * Name & pairing.
 *
 * Occupancy model: a soft claim stored ON the Pi (so every PC agrees). The claim
 * expires after 2 minutes without a heartbeat — this tab renews claims held by
 * this PC while it is open, so a crashed laptop can never leave a device stuck
 * "occupied".
 */

const GATE_SHORT: Record<string, string> = { "read-only": "Read-only", disarmed: "Writes on", armed: "Armed" };

export function DevicesTab() {
  const sd = useSuperDevice();
  const [owner, setOwner] = useState("");
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // discovery / pairing
  const [pairOpen, setPairOpen] = useState(false);
  const [pairFocus, setPairFocus] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<DiscoveredDevice[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const devicesRef = useRef<PairedDevice[]>([]);
  devicesRef.current = devices;
  const ownerRef = useRef("");
  ownerRef.current = owner;
  const sdRef = useRef(sd);
  sdRef.current = sd;

  const refreshRegistry = useCallback(async () => {
    const r = await Api.devices.list();
    setOwner(r.owner);
    setDevices(r.devices);
    return r.devices;
  }, []);

  const pollOne = useCallback(async (d: PairedDevice) => {
    try {
      const info = await Api.superDevice.get<DeviceInfo>(d.host, "/api/device");
      // bus + system figures for the card (uptime, CPU); a slow answer here never marks the Pi offline.
      // The Pi the app talks to is already polled by the connection provider — reuse that.
      const act = sdRef.current;
      let status: DeviceStatus | undefined;
      if (act.link === "online" && act.host === d.host && act.status) status = act.status as DeviceStatus;
      else {
        try { status = (await Api.superDevice.status(d.host)) as DeviceStatus; } catch { status = undefined; }
      }
      setLive((s) => ({ ...s, [d.id]: { phase: "online", info, status: status ?? s[d.id]?.status } }));
      // keep the bookmark fresh (hostname can be renamed on the Pi itself)
      if (info.hostname !== d.hostname || info.model !== d.model) {
        await Api.devices.update(d.id, {
          hostname: info.hostname, model: info.model, lastSeenAt: new Date().toISOString(),
        }).then(setDevices).catch(() => {});
      }
      // heartbeat: renew a claim this PC holds before it goes stale
      if (info.claim && info.claim.owner === ownerRef.current && info.claim.expires_in < 90) {
        Api.devices.claim(d.host).catch(() => {});
      }
    } catch (err) {
      setLive((s) => ({ ...s, [d.id]: { phase: "offline", error: errText(err) } }));
    }
  }, []);

  const scan = useCallback(async () => {
    setScanning(true); setMsg(null); setPairOpen(true); setPairFocus(false);
    try { setFound(await Api.superDevice.discover()); }
    catch (err) { setMsg(errText(err)); }
    finally { setScanning(false); }
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = () => { if (!stop) devicesRef.current.forEach((d) => void pollOne(d)); };
    refreshRegistry().then((list) => {
      list.forEach((d) => void pollOne(d));
      // fresh install / empty list: go looking for devices without being asked
      if (list.length === 0 && !stop) void scan();
    }).catch((err) => setMsg(errText(err)));
    const iv = setInterval(tick, 6000);
    return () => { stop = true; clearInterval(iv); };
  }, [refreshRegistry, pollOne, scan]);

  async function pair(input: { host: string; hostname?: string; model?: string }) {
    setMsg(null);
    try {
      const list = await Api.devices.pair(input);
      setDevices(list);
      list.forEach((d) => void pollOne(d));
      const added = list.find((d) => d.host === input.host || d.host === `${input.host}:8080`);
      if (added) setSelectedId(added.id);
    } catch (err) { setMsg(errText(err)); }
  }

  // the selected Pi: what the user clicked, else the one the app talks to, else the first
  // one that answers (a stale home-LAN entry must not hide the Pi reachable over the VPN)
  const selected = devices.find((d) => d.id === selectedId)
    ?? devices.find((d) => d.host === sd.host)
    ?? devices.find((d) => live[d.id]?.phase === "online")
    ?? devices.find((d) => live[d.id]?.phase !== "offline")
    ?? devices[0]
    ?? null;
  const selectedName = selected ? deviceName(selected, live[selected.id]?.info) : null;
  const n = devices.length;

  return (
    <div className="ual-page dv-page">
      <div className="dv-head">
        <h1 className="ual-h1">Your devices</h1>
        <span className="ual-muted">
          {n === 1 ? "1 Pi" : `${n} Pis`} · 1 desk simulator · this PC is <b className="dv-ink">{owner || "…"}</b>
        </span>
        <div className="dv-actions">
          <button type="button" onClick={() => void scan()} disabled={scanning}>
            <Icon>{ICON.scan}</Icon>{scanning ? "Scanning…" : "Scan network"}
          </button>
          <button type="button" className="primary" aria-expanded={pairOpen} aria-controls="dv-pair"
            onClick={() => { setPairFocus(true); setPairOpen((v) => !v); }}>
            <Icon>{ICON.plus}</Icon>Pair a Pi
          </button>
        </div>
      </div>

      {pairOpen && (
        <div id="dv-pair">
          <PairPanel
            scanning={scanning}
            found={found}
            pairedHosts={new Set(devices.map((d) => d.host))}
            error={msg}
            focusAddress={pairFocus}
            onScan={() => void scan()}
            onPair={(input) => void pair(input)}
            onClose={() => setPairOpen(false)}
          />
        </div>
      )}
      {!pairOpen && msg && <div className="ual-note err" role="alert">{msg}</div>}

      <div className="dv-cards">
        {n === 0 && (
          <div className="ual-card pad dv-empty">
            <h2 className="ual-h2">No Pi paired yet</h2>
            <p className="ual-sub">Scan the network for SuperDevices, or pair one by its address.</p>
          </div>
        )}
        {devices.map((d) => (
          <DeviceCard
            key={d.id}
            device={d}
            live={live[d.id]}
            owner={owner}
            selected={selected?.id === d.id}
            onSelect={() => setSelectedId(d.id)}
          />
        ))}
        <DeskSimCard />
      </div>

      <ObdConnector deviceName={selectedName} />

      {selected && (
        <DeviceSections
          key={selected.id}
          device={selected}
          live={live[selected.id]}
          owner={owner}
          onPoll={() => void pollOne(selected)}
          onRegistryChange={setDevices}
          onForgotten={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DeviceCard(props: {
  device: PairedDevice;
  live: LiveState | undefined;
  owner: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { device, live, owner, selected, onSelect } = props;
  const info = live?.info;
  const status = live?.status;
  const avail = availability(live, owner);
  const chip = availabilityChip(avail, live);
  const online = live?.phase === "online";
  const gate = info?.write_gate;
  const b = info?.battery;
  const pw = info?.power;

  return (
    <button type="button" className={`dv-card ${selected ? "sel" : ""}`} aria-pressed={selected} onClick={onSelect}>
      <span className="dv-card-top">
        <span className="dv-name">{deviceName(device, info)}</span>
        <span className={`ual-chip ${chip.cls}`}>{chip.label}</span>
      </span>
      <span className="dv-card-lines">
        <span className="ual-muted">{info?.model || device.model || "Raspberry Pi"}</span>
        <span className="ual-mono dv-small">
          {device.host}
          {info?.ip && info.ip !== device.host.split(":")[0] ? ` · ${info.ip}` : ""}
          {info?.ssid ? ` · Wi-Fi ${info.ssid}` : ""}
        </span>
      </span>

      {online ? (
        <span className="dv-stats">
          <span className="ual-stat"><b>{shortUptime(status?.sys.uptime) ?? "—"}</b><span>up</span></span>
          <span className="ual-stat"><b>{status?.sys.temp != null ? `${status.sys.temp} °C` : "—"}</b><span>CPU</span></span>
          <span className={`ual-stat ${gate === "armed" ? "fault" : gate ? "protected" : ""}`}>
            <b>{gate ? GATE_SHORT[gate] ?? gate : "—"}</b><span>write gate</span>
          </span>
        </span>
      ) : (
        <span className="ual-soft dv-soft-line">
          {avail === "checking" ? "Checking…"
            : device.lastSeenAt ? `Not reachable · last seen ${new Date(device.lastSeenAt).toLocaleString()}`
            : "Not reachable"}
        </span>
      )}

      {pw?.state === "countdown" ? (
        <span className="ual-note err dv-card-note">
          On battery — safe shutdown in {pw.seconds_left ?? "?"} s (restoring power cancels it)
        </span>
      ) : pw?.state === "ups-degraded" ? (
        <span className="ual-note err dv-card-note">
          UPS says on battery but its fuel gauge is unreachable — draining unmonitored. Check the 12 V feed and the X1200 pogo-pin contact.
        </span>
      ) : b?.present && b.percent != null ? (
        <span className="dv-inline dv-small">
          <BatteryBar percent={b.percent} />
          <span className="ual-muted">{b.voltage ?? "?"} V</span>
          {b.external_power === undefined ? null : b.external_power
            ? <span className="dv-good">on 12 V feed</span>
            : <span className="dv-bad">ON BATTERY</span>}
        </span>
      ) : null}
    </button>
  );
}

function DeskSimCard() {
  const sd = useSuperDevice();
  const wb = useWorkbench();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sim = wb.sim as (SimStatus & { ecus?: number; iface?: string | null }) | null;

  const talk = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await sd.connect(DESK_SIM);
      if (!r.ok) setErr(`Could not reach ${DESK_SIM}: ${r.error ?? "no answer"} — start it with START-CHIP-LAB.bat`);
    } finally { setBusy(false); }
  };

  const playing: string[] = [];
  if (wb.demo && sim?.running) {
    const rec = sim.replay?.length ?? 0;
    if (rec) playing.push(`plays back ${rec} recording${rec === 1 ? "" : "s"}`);
    if (sim.ecus) playing.push(`${sim.ecus} systems`);
  }

  return (
    <div className="ual-card dv-card dv-sim">
      <span className="dv-card-top">
        <span className="dv-name">Desk simulator</span>
        <span className={`ual-chip ${wb.demo ? "info" : "unread"}`}>
          {wb.demo ? (sim?.running ? "Running" : "Connected") : "Not connected"}
        </span>
      </span>
      <span className="ual-muted">This PC · no hardware needed</span>
      {wb.demo ? (
        <span className="ual-stat">
          <b>{wb.simCar ?? (sim?.running ? "Virtual car" : "No car loaded")}</b>
          <span>{playing.length ? playing.join(" · ") : "answers instead of a car"}</span>
        </span>
      ) : (
        <span className="ual-stat">
          <b>Plays back a car the Pi recorded</b>
          <span>connect to it to see which car it is playing</span>
        </span>
      )}
      <span className="dv-card-actions">
        {wb.demo ? (
          <button type="button" className="tiny" onClick={() => void sd.disconnect()}>Disconnect</button>
        ) : (
          <button type="button" className="tiny" disabled={busy || sd.link === "connecting"} onClick={() => void talk()}>
            {busy ? "Connecting…" : "Talk to the desk simulator"}
          </button>
        )}
      </span>
      {err && <span className="ual-note err" role="alert">{err}</span>}
    </div>
  );
}
