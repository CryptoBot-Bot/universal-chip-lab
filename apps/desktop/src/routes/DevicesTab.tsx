import { useCallback, useEffect, useRef, useState } from "react";

import {
  Api,
  type DiscoveredDevice,
  type NearbyWifiNetwork,
  type PairedDevice,
  type PiDeviceInfo,
  type SavedWifiNetwork,
  type SuperDeviceStatus,
} from "../lib/api";
import { useSuperDevice } from "../lib/superdevice-connection";

/**
 * Pi Devices — the fleet room. Pair/unpair SuperDevice Pis, see at a glance
 * which ones are LIVE on the network, which are free and which are occupied
 * by another PC, and open any of them into a cockpit: identity (rename),
 * battery/UPS, WiFi (current + saved + join new), CAN buses, reboot.
 *
 * Occupancy model: a soft claim stored ON the Pi (so every PC agrees). The
 * claim expires after 2 minutes without a heartbeat — this tab auto-renews
 * claims held by this PC while it is open, so a crashed laptop can never
 * leave a device stuck "occupied".
 */

type Phase = "checking" | "online" | "offline";
interface LiveState {
  phase: Phase;
  info?: PiDeviceInfo;
  error?: string;
}

type Availability = "available" | "mine" | "occupied" | "offline" | "checking";

function availability(live: LiveState | undefined, owner: string): Availability {
  if (!live || live.phase === "checking") return "checking";
  if (live.phase === "offline") return "offline";
  const claim = live.info?.claim;
  if (!claim) return "available";
  return claim.owner === owner ? "mine" : "occupied";
}

const AVAIL_BADGE: Record<Availability, { label: string; cls: string }> = {
  checking:  { label: "Checking…",   cls: "" },
  offline:   { label: "Offline",     cls: "" },
  available: { label: "LIVE · Available", cls: "ok" },
  mine:      { label: "Connected · this PC", cls: "info" },
  occupied:  { label: "In use", cls: "warn" },
};

function BatteryBar({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent));
  const color = p > 50 ? "var(--accent)" : p > 20 ? "var(--warn)" : "var(--danger)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, verticalAlign: "middle" }}>
      <span style={{ width: 46, height: 12, border: "1px solid var(--border)", borderRadius: 3, padding: 1, display: "inline-block" }}>
        <span style={{ display: "block", height: "100%", width: `${Math.max(4, p)}%`, background: color, borderRadius: 2 }} />
      </span>
      <b className="tiny">{p}%</b>
    </span>
  );
}

function BatteryLine({ info }: { info?: PiDeviceInfo }) {
  const b = info?.battery;
  const pw = info?.power;
  if (pw?.state === "countdown") {
    return (
      <span className="tiny" style={{ color: "var(--danger)", fontWeight: 700 }}>
        ⚠ ON BATTERY — safe shutdown in {pw.seconds_left ?? "?"} s (restoring power cancels it)
      </span>
    );
  }
  if (pw?.state === "ups-degraded") {
    return (
      <span className="tiny" style={{ color: "var(--danger)", fontWeight: 700 }}>
        ⚠ UPS says ON BATTERY but its fuel gauge is unreachable — draining unmonitored! Check the 12 V feed and the X1200 pogo-pin contact.
      </span>
    );
  }
  if (!b?.present || b.percent == null) return null;
  return (
    <span className="tiny" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <BatteryBar percent={b.percent} />
      <span className="dim">{b.voltage ?? "?"} V</span>
      {b.external_power === undefined ? null : b.external_power
        ? <span style={{ color: "var(--accent)" }}>on 12 V feed</span>
        : <span style={{ color: "var(--warn)", fontWeight: 700 }}>ON BATTERY</span>}
    </span>
  );
}

export function DevicesTab() {
  const [owner, setOwner] = useState("");
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // discovery / manual pairing
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<DiscoveredDevice[] | null>(null);
  const [manualHost, setManualHost] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  // setup-mode helper: a Pi on its own hotspot always sits at 10.42.0.1
  const SETUP_HOST = "10.42.0.1:8080";
  const [setupPi, setSetupPi] = useState<PiDeviceInfo | null>(null);
  const [setupChecking, setSetupChecking] = useState(false);
  const [setupNets, setSetupNets] = useState<NearbyWifiNetwork[] | null>(null);
  const [setupSsid, setSetupSsid] = useState<string | null>(null);
  const [setupPass, setSetupPass] = useState("");
  const [setupSent, setSetupSent] = useState(false);

  const devicesRef = useRef<PairedDevice[]>([]);
  devicesRef.current = devices;
  const ownerRef = useRef("");
  ownerRef.current = owner;

  const refreshRegistry = useCallback(async () => {
    const r = await Api.devices.list();
    setOwner(r.owner);
    setDevices(r.devices);
    return r.devices;
  }, []);

  const pollOne = useCallback(async (d: PairedDevice) => {
    try {
      const info = await Api.superDevice.get<PiDeviceInfo>(d.host, "/api/device");
      setLive((s) => ({ ...s, [d.id]: { phase: "online", info } }));
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
      setLive((s) => ({
        ...s,
        [d.id]: { phase: "offline", error: err instanceof Error ? err.message : String(err) },
      }));
    }
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = () => { if (!stop) devicesRef.current.forEach((d) => void pollOne(d)); };
    refreshRegistry().then((list) => {
      list.forEach((d) => void pollOne(d));
      // fresh install / empty list: go looking for devices without being asked
      if (list.length === 0 && !stop) void scan();
    });
    const iv = setInterval(tick, 6000);
    return () => { stop = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRegistry, pollOne]);

  async function scan() {
    setScanning(true); setMsg(null);
    try { setFound(await Api.superDevice.discover()); }
    catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
    finally { setScanning(false); }
  }

  async function pair(input: { host: string; hostname?: string; model?: string }) {
    setMsg(null);
    try {
      const list = await Api.devices.pair(input);
      setDevices(list);
      list.forEach((d) => void pollOne(d));
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  }

  async function checkSetupMode() {
    setSetupChecking(true); setMsg(null); setSetupPi(null); setSetupNets(null); setSetupSent(false);
    try {
      const info = await Api.superDevice.get<PiDeviceInfo>(SETUP_HOST, "/api/device");
      setSetupPi(info);
      const nets = await Api.superDevice.get<{ networks: NearbyWifiNetwork[] }>(SETUP_HOST, "/api/wifi/scan");
      setSetupNets(nets.networks);
    } catch {
      setMsg("No Pi found at 10.42.0.1 — is this PC connected to the SuperDevice-Setup-XXXX wifi (password: superdevice)?");
    } finally { setSetupChecking(false); }
  }

  async function provisionSetupPi() {
    if (!setupSsid) return;
    setMsg(null);
    try {
      const r = await Api.superDevice.post<{ ok: boolean; error?: string }>(SETUP_HOST, "/api/provision", { ssid: setupSsid, password: setupPass });
      if (!r.ok) { setMsg(r.error || "The Pi could not join that network (it restarted its setup hotspot — try again)."); return; }
      setSetupSent(true);
      setSetupSsid(null); setSetupPass("");
    } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
  }

  const selected = devices.find((d) => d.id === selectedId) ?? null;

  if (selected) {
    return (
      <DeviceCockpit
        device={selected}
        live={live[selected.id]}
        owner={owner}
        onBack={() => setSelectedId(null)}
        onPoll={() => void pollOne(selected)}
        onRegistryChange={setDevices}
      />
    );
  }

  const pairedHosts = new Set(devices.map((d) => d.host));
  const unpairedFound = (found ?? []).filter((f) => !pairedHosts.has(f.host));

  return (
    <div>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0 }}>Pi Devices</h1>
          <div className="tiny dim">This PC: <b>{owner || "…"}</b> · paired devices poll every 6 s</div>
        </div>
        <button className="primary" onClick={scan} disabled={scanning}>
          {scanning ? "Scanning subnet…" : "Scan network"}
        </button>
      </div>

      {devices.length === 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-title">No paired devices yet</div>
          <p className="dim">Scan the network for SuperDevices, or add one by address below.</p>
        </div>
      )}

      <div className="grid cols-3" style={{ marginBottom: 18 }}>
        {devices.map((d) => {
          const lv = live[d.id];
          const avail = availability(lv, owner);
          const badge = AVAIL_BADGE[avail];
          return (
            <div
              key={d.id}
              className="card"
              style={{ cursor: "pointer" }}
              onClick={() => setSelectedId(d.id)}
            >
              <div className="row spread">
                <b>{d.nickname || lv?.info?.hostname || d.hostname || d.host}</b>
                <span className={`badge ${badge.cls}`}>
                  {avail === "occupied" ? `In use · ${lv?.info?.claim?.owner}` : badge.label}
                </span>
              </div>
              <div className="tiny dim" style={{ marginTop: 6 }}>
                {lv?.info?.model || d.model || "Raspberry Pi"}
              </div>
              <div className="tiny" style={{ marginTop: 4, fontFamily: "var(--mono, monospace)" }}>
                {d.host}{lv?.info?.ip && lv.info.ip !== d.host.split(":")[0] ? ` · ${lv.info.ip}` : ""}
                {lv?.info?.ssid ? ` · 📶 ${lv.info.ssid}` : ""}
              </div>
              <div style={{ marginTop: 4 }}><BatteryLine info={lv?.info} /></div>
              {avail === "offline" && d.lastSeenAt && (
                <div className="tiny dim" style={{ marginTop: 4 }}>last seen {new Date(d.lastSeenAt).toLocaleString()}</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="card-title">Add a device</div>
        {found !== null && (
          <div style={{ marginBottom: 10 }}>
            {unpairedFound.length === 0 ? (
              <div className="tiny dim">No new SuperDevices found on the local subnet(s).</div>
            ) : unpairedFound.map((f) => (
              <div key={f.host} className="row spread" style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                <span><b>{f.hostname}</b> <span className="dim tiny">{f.model}</span> <span className="tiny" style={{ fontFamily: "var(--mono, monospace)" }}>{f.ip}</span></span>
                <button className="tiny primary" onClick={() => void pair({ host: f.host, hostname: f.hostname, model: f.model })}>Pair</button>
              </div>
            ))}
          </div>
        )}
        <div className="row">
          <input
            placeholder="hostname.local or 192.168.1.67 (port defaults to 8080)"
            value={manualHost}
            onChange={(e) => setManualHost(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            disabled={!manualHost.trim()}
            onClick={() => { void pair({ host: manualHost.trim() }); setManualHost(""); }}
          >
            Pair by address
          </button>
        </div>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <div className="row spread">
            <div>
              <b className="tiny">Brand-new Pi in setup mode?</b>
              <div className="tiny dim">
                Join this PC to its <b>SuperDevice-Setup-XXXX</b> wifi (password <code>superdevice</code>), then:
              </div>
            </div>
            <button className="tiny" onClick={() => void checkSetupMode()} disabled={setupChecking}>
              {setupChecking ? "Checking…" : "Find setup-mode Pi"}
            </button>
          </div>
          {setupPi && !setupSent && (
            <div style={{ marginTop: 8 }}>
              <div className="tiny">
                Found <b>{setupPi.hostname}</b> ({setupPi.model}) on its hotspot. Pick the wifi it should live on:
              </div>
              {setupNets === null ? (
                <div className="tiny dim">loading networks…</div>
              ) : setupNets.length === 0 ? (
                <div className="tiny dim">no cached networks — type the SSID manually below</div>
              ) : setupNets.map((n) => (
                <div key={n.ssid} className="row spread" style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="tiny"><b>{n.ssid}</b> <span className="dim">{n.signal}%{n.secure ? " · 🔒" : ""}</span></span>
                  <button className="tiny" onClick={() => { setSetupSsid(n.ssid); setSetupPass(""); }}>Select</button>
                </div>
              ))}
              <div className="row" style={{ marginTop: 8 }}>
                <input placeholder="wifi name (SSID)" value={setupSsid ?? ""} onChange={(e) => setSetupSsid(e.target.value)} style={{ flex: 1 }} />
                <input type="password" placeholder="wifi password" value={setupPass} onChange={(e) => setSetupPass(e.target.value)} style={{ flex: 1 }} />
                <button className="tiny primary" disabled={!setupSsid?.trim()} onClick={() => void provisionSetupPi()}>Send to Pi</button>
              </div>
            </div>
          )}
          {setupSent && (
            <div className="tiny" style={{ marginTop: 8, color: "var(--accent)" }}>
              ✓ Credentials sent — the Pi is joining your wifi now. Reconnect this PC to the same wifi,
              wait ~30 s, then hit <b>Scan network</b> above and Pair it.
            </div>
          )}
        </div>
        {msg && <div className="tiny" style={{ color: "var(--danger)", marginTop: 8 }}>{msg}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DeviceCockpit(props: {
  device: PairedDevice;
  live: LiveState | undefined;
  owner: string;
  onBack: () => void;
  onPoll: () => void;
  onRegistryChange: (list: PairedDevice[]) => void;
}) {
  const { device, live, owner, onBack, onPoll, onRegistryChange } = props;
  const sd = useSuperDevice();
  const info = live?.info;
  const avail = availability(live, owner);
  const badge = AVAIL_BADGE[avail];
  const online = live?.phase === "online";

  const [status, setStatus] = useState<SuperDeviceStatus | null>(null);
  const [savedWifi, setSavedWifi] = useState<SavedWifiNetwork[] | null>(null);
  const [nearby, setNearby] = useState<NearbyWifiNetwork[] | null>(null);
  const [joinSsid, setJoinSsid] = useState<string | null>(null);
  const [joinPass, setJoinPass] = useState("");
  const [newName, setNewName] = useState("");
  const [nickname, setNickname] = useState(device.nickname ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);

  const say = (t: string) => { setNote(t); };

  const loadDetails = useCallback(async () => {
    if (!online) return;
    try {
      const [st, sw] = await Promise.all([
        Api.superDevice.status(device.host),
        Api.superDevice.get<{ networks: SavedWifiNetwork[] }>(device.host, "/api/wifi/saved"),
      ]);
      setStatus(st);
      setSavedWifi(sw.networks);
    } catch { /* device dropped mid-refresh; the poller will flag it */ }
  }, [device.host, online]);

  useEffect(() => {
    void loadDetails();
    const iv = setInterval(() => { void loadDetails(); onPoll(); }, 10000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDetails]);

  async function run(label: string, fn: () => Promise<unknown>, after?: () => void) {
    setBusy(label); setNote(null);
    try { await fn(); after?.(); }
    catch (err) { say(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); onPoll(); void loadDetails(); }
  }

  const connect = (force = false) => run("connect", async () => {
    const r = await sd.connect(device.host, { force });
    if (!r.ok) say(r.occupiedBy ? `Occupied by ${r.occupiedBy} — use "Take over" only if that PC is really done.` : (r.error ?? "connect failed"));
    else say("Connected — this is now the app's active SuperDevice; every tab (Cockpit, Bench…) sees it online, and the claim is held while the app runs.");
  });
  const release = () => run("release", async () => {
    if (sd.host === device.host) {
      await sd.disconnect();
      say("Released — device is available again.");
    } else {
      const r = await Api.devices.release(device.host);
      say(r.ok ? "Released — device is available again." : (r.error ?? "release failed"));
    }
  });

  const rename = () => run("rename", async () => {
    const name = newName.trim();
    const r = await Api.superDevice.post<{ ok: boolean; error?: string; note?: string }>(device.host, "/api/hostname", { name });
    if (!r.ok) { say(r.error ?? "rename failed"); return; }
    // if we reach it via <hostname>.local, follow the rename automatically
    const patch: Partial<Pick<PairedDevice, "host" | "hostname">> = { hostname: name };
    if (/\.local:\d+$/i.test(device.host)) patch.host = `${name}.local:${device.host.split(":")[1]}`;
    onRegistryChange(await Api.devices.update(device.id, patch));
    say(r.note ?? `Renamed to ${name}`);
    setNewName("");
  });

  const saveNickname = () => run("nickname", async () => {
    onRegistryChange(await Api.devices.update(device.id, { nickname: nickname.trim() || undefined }));
    say("Nickname saved (local to this PC).");
  });

  const scanWifi = () => run("wifiscan", async () => {
    const r = await Api.superDevice.get<{ networks: NearbyWifiNetwork[] }>(device.host, "/api/wifi/scan");
    setNearby(r.networks);
  });

  const joinWifi = () => run("wifijoin", async () => {
    const r = await Api.superDevice.post<{ ok: boolean; error?: string }>(device.host, "/api/provision", { ssid: joinSsid, password: joinPass });
    say(r.ok ? `Joining ${joinSsid} — the device may change IP; re-scan if it drops off.` : (r.error ?? "join failed"));
    if (r.ok) { setJoinSsid(null); setJoinPass(""); }
  });

  const forgetWifi = (name: string) => run(`forget:${name}`, async () => {
    const r = await Api.superDevice.post<{ ok: boolean; error?: string }>(device.host, "/api/wifi/forget", { name });
    say(r.ok ? `Forgot "${name}".` : (r.error ?? "forget failed"));
  });

  const reboot = () => run("reboot", async () => {
    await Api.superDevice.post(device.host, "/api/reboot", {});
    say("Rebooting — it will come back in ~40 s.");
    setConfirmReboot(false);
  });

  const unpair = () => run("unpair", async () => {
    onRegistryChange(await Api.devices.unpair(device.id));
    onBack();
  });

  const canIfaceToggle = (name: string, up: boolean) =>
    run(`can:${name}`, async () => {
      if (up) await Api.superDevice.setDown(device.host, name);
      else await Api.superDevice.setUp(device.host, name, name === "can1" ? 125000 : 500000, false);
    });

  const batt = info?.battery;

  return (
    <div>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <div className="row">
          <button className="tiny" onClick={onBack}>← All devices</button>
          <h1 style={{ margin: 0 }}>{device.nickname || info?.hostname || device.hostname || device.host}</h1>
          <span className={`badge ${badge.cls}`}>
            {avail === "occupied" ? `In use · ${info?.claim?.owner}` : badge.label}
          </span>
        </div>
        <div className="row">
          {avail === "available" && <button className="primary" onClick={() => void connect()} disabled={!!busy}>Connect</button>}
          {avail === "mine" && <button onClick={() => void release()} disabled={!!busy}>Disconnect</button>}
          {avail === "occupied" && <button className="danger" onClick={() => void connect(true)} disabled={!!busy}>Take over</button>}
        </div>
      </div>

      {note && <div className="card compact" style={{ marginBottom: 12 }}><span className="tiny">{note}</span></div>}
      {!online && (
        <div className="card" style={{ marginBottom: 12 }}>
          <b>Device unreachable</b>
          <div className="tiny dim" style={{ marginTop: 4 }}>{live?.error ?? "Waiting for first poll…"} · address <code>{device.host}</code></div>
        </div>
      )}

      <div className="grid cols-2">
        {/* Identity */}
        <div className="card">
          <div className="card-title">Identity</div>
          <table className="tiny" style={{ borderSpacing: "0 4px" }}>
            <tbody>
              <tr><td className="dim" style={{ paddingRight: 12 }}>Hostname</td><td><b>{info?.hostname ?? device.hostname ?? "—"}</b>{info?.hostname ? <span className="dim"> · {info.hostname}.local</span> : null}</td></tr>
              <tr><td className="dim">Model</td><td>{info?.model ?? device.model ?? "—"}</td></tr>
              <tr><td className="dim">Address</td><td style={{ fontFamily: "var(--mono, monospace)" }}>{device.host}{info?.ip ? ` · ${info.ip}` : ""}</td></tr>
              <tr><td className="dim">Web UI</td><td style={{ fontFamily: "var(--mono, monospace)" }}>http://{device.host}</td></tr>
              <tr><td className="dim">Paired</td><td>{new Date(device.pairedAt).toLocaleString()}</td></tr>
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 10 }}>
            <input placeholder="new hostname (letters/digits/hyphen)" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} />
            <button className="tiny" disabled={!online || !newName.trim() || !!busy} onClick={() => void rename()}>Rename device</button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input placeholder="local nickname (this PC only)" value={nickname} onChange={(e) => setNickname(e.target.value)} style={{ flex: 1 }} />
            <button className="tiny" disabled={!!busy} onClick={() => void saveNickname()}>Save nickname</button>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {confirmUnpair ? (
              <>
                <span className="tiny dim">Remove from this PC's list? (nothing changes on the Pi)</span>
                <button className="tiny danger" onClick={() => void unpair()}>Yes, unpair</button>
                <button className="tiny" onClick={() => setConfirmUnpair(false)}>Cancel</button>
              </>
            ) : (
              <button className="tiny" onClick={() => setConfirmUnpair(true)}>Unpair…</button>
            )}
          </div>
        </div>

        {/* Power & system */}
        <div className="card">
          <div className="card-title">Power & system</div>
          <table className="tiny" style={{ borderSpacing: "0 4px" }}>
            <tbody>
              <tr>
                <td className="dim" style={{ paddingRight: 12 }}>UPS battery</td>
                <td>
                  {batt?.present && batt.percent != null
                    ? <BatteryLine info={info} />
                    : <span className="dim">no fuel gauge detected — stack the X1200 and it appears here</span>}
                </td>
              </tr>
              <tr>
                <td className="dim">Power guard</td>
                <td>
                  {info?.power == null ? <span className="dim">guard service not installed on this Pi</span>
                    : info.power.state === "countdown" ? <span style={{ color: "var(--danger)", fontWeight: 700 }}>⚠ power lost — clean shutdown in {info.power.seconds_left ?? "?"} s unless the feed returns</span>
                    : info.power.state === "shutting-down" ? <span style={{ color: "var(--danger)", fontWeight: 700 }}>shutting down…</span>
                    : info.power.state === "ok" ? <span style={{ color: "var(--accent)" }}>armed — 30 s ride-through, then clean shutdown; auto-boot when power returns</span>
                    : info.power.state === "ups-degraded" ? <span style={{ color: "var(--danger)", fontWeight: 700 }}>⚠ ON BATTERY with no fuel gauge — cannot protect the cells; fix the feed / pogo contact or shut down</span>
                    : <span className="dim">standing by (UPS not detected)</span>}
                </td>
              </tr>
              <tr><td className="dim">CPU temp</td><td>{status?.sys.temp != null ? `${status.sys.temp} °C` : "—"}</td></tr>
              <tr><td className="dim">Uptime</td><td>{status?.sys.uptime ?? "—"}</td></tr>
              <tr><td className="dim">Load</td><td>{status?.sys.load ?? "—"}</td></tr>
              <tr><td className="dim">Kernel</td><td>{status?.sys.kernel ?? "—"}</td></tr>
              <tr>
                <td className="dim">Occupancy</td>
                <td>
                  {info?.claim
                    ? <>held by <b>{info.claim.owner}</b> since {info.claim.since} (renews every poll, expires in {info.claim.expires_in}s without heartbeat)</>
                    : <span className="dim">free — any PC may connect</span>}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            {confirmReboot ? (
              <>
                <span className="tiny dim">Reboot the Pi now?</span>
                <button className="tiny danger" onClick={() => void reboot()}>Yes, reboot</button>
                <button className="tiny" onClick={() => setConfirmReboot(false)}>Cancel</button>
              </>
            ) : (
              <button className="tiny" disabled={!online || !!busy} onClick={() => setConfirmReboot(true)}>Reboot…</button>
            )}
          </div>
        </div>

        {/* WiFi */}
        <div className="card">
          <div className="row spread">
            <div className="card-title" style={{ marginBottom: 0 }}>WiFi</div>
            <button className="tiny" disabled={!online || !!busy} onClick={() => void scanWifi()}>
              {busy === "wifiscan" ? "Scanning…" : "Scan nearby"}
            </button>
          </div>
          <div className="tiny" style={{ margin: "8px 0" }}>
            Connected: {info?.ssid ? <b>📶 {info.ssid}</b> : <span className="dim">not on WiFi</span>}
            {info?.ip ? <span className="dim"> · {info.ip}</span> : null}
          </div>
          <div className="tiny dim" style={{ margin: "6px 0 2px" }}>Saved networks on this Pi</div>
          {savedWifi === null ? (
            <div className="tiny dim">…</div>
          ) : savedWifi.length === 0 ? (
            <div className="tiny dim">none saved</div>
          ) : savedWifi.map((n) => (
            <div key={n.name} className="row spread" style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
              <span className="tiny">
                {n.active ? "🟢 " : ""}<b>{n.name}</b>
                {n.autoconnect ? <span className="dim"> · auto</span> : null}
              </span>
              <button className="tiny" disabled={!online || !!busy || n.active} title={n.active ? "Can't forget the active connection" : ""} onClick={() => void forgetWifi(n.name)}>Forget</button>
            </div>
          ))}
          {nearby !== null && (
            <>
              <div className="tiny dim" style={{ margin: "10px 0 2px" }}>Nearby networks</div>
              {nearby.length === 0 ? <div className="tiny dim">nothing heard — device in AP mode?</div> : nearby.map((n) => (
                <div key={n.ssid} className="row spread" style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="tiny"><b>{n.ssid}</b> <span className="dim">{n.signal}%{n.secure ? " · 🔒" : ""}</span></span>
                  <button className="tiny" disabled={!online || !!busy} onClick={() => { setJoinSsid(n.ssid); setJoinPass(""); }}>Join</button>
                </div>
              ))}
            </>
          )}
          {joinSsid && (
            <div className="row" style={{ marginTop: 10 }}>
              <span className="tiny">Join <b>{joinSsid}</b>:</span>
              <input type="password" placeholder="password (empty if open)" value={joinPass} onChange={(e) => setJoinPass(e.target.value)} style={{ flex: 1 }} />
              <button className="tiny primary" disabled={!!busy} onClick={() => void joinWifi()}>Connect Pi</button>
              <button className="tiny" onClick={() => setJoinSsid(null)}>✕</button>
            </div>
          )}
        </div>

        {/* CAN buses */}
        <div className="card">
          <div className="card-title">CAN buses</div>
          {!status ? (
            <div className="tiny dim">…</div>
          ) : status.ifaces.map((i) => (
            <div key={i.name} className="row spread" style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <span className="tiny">
                <b style={{ fontFamily: "var(--mono, monospace)" }}>{i.name}</b>
                <span className="dim"> · {i.role}</span>
                {i.up
                  ? <span> · <span className="badge ok">UP</span> {i.bitrate ? `${(i.bitrate / 1000).toFixed(0)}k` : ""}{i.fd ? " FD" : ""} · rx {i.rx} tx {i.tx}{i.rxerr ? ` · err ${i.rxerr}` : ""}</span>
                  : <span> · <span className="badge">down</span></span>}
              </span>
              <button
                className="tiny"
                disabled={!online || !!busy || avail === "occupied"}
                title={avail === "occupied" ? "Device is in use by another PC" : ""}
                onClick={() => void canIfaceToggle(i.name, !!i.up)}
              >
                {i.up ? "Down" : `Up ${i.name === "can1" ? "125k" : "500k"}`}
              </button>
            </div>
          ))}
          <div className="tiny dim" style={{ marginTop: 8 }}>
            Bus control is blocked while another PC holds the device. Full send/monitor lives in the Bench and Cockpit tabs.
          </div>
        </div>
      </div>
    </div>
  );
}
