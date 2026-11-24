import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Api, type NearbyWifiNetwork, type PairedDevice, type SavedWifiNetwork, type SuperDeviceIface } from "../../lib/api";
import { useSuperDevice } from "../../lib/superdevice-connection";
import { DESK_SIM } from "../../lib/workbench";
import {
  BatteryBar, GATE_LABEL, ICON, Icon, availability, availabilityChip, deviceName, errText, fmtBytes,
  isNotFound, shortDuration,
  type DaemonVersion, type LiveState, type RecList, type RecStatus, type WriteGate,
} from "./common";

/**
 * Settings and status of the selected Pi, as B1 white sections:
 * Connection · Buses · Safety · Power · Software · Recordings · Name & pairing.
 *
 * Every action here is the one the old device cockpit had (connect / take over,
 * Wi-Fi, CAN up/down, reboot, rename, nickname, forget). The write gate is shown,
 * never changed: writes can only be enabled on the Pi itself.
 */

type Tone = "good" | "warn" | "fault" | "";
type Load = "loading" | "ok" | "none" | "error";

function Row({ k, children, tone = "", stack = false }: { k: ReactNode; children: ReactNode; tone?: Tone; stack?: boolean }) {
  const cls = ["ual-rowline", tone === "fault" ? "dv-fault" : tone, stack ? "dv-stack" : ""].filter(Boolean).join(" ");
  return <div className={cls}><span className="dv-k">{k}</span><span className="dv-val">{children}</span></div>;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="ual-card dv-section" aria-labelledby={`dv-sec-${id}`}>
      <h2 className="ual-section-head" id={`dv-sec-${id}`}>{title}</h2>
      <div className="ual-rows">{children}</div>
    </section>
  );
}

export function DeviceSections(props: {
  device: PairedDevice;
  live: LiveState | undefined;
  owner: string;
  onPoll: () => void;
  onRegistryChange: (list: PairedDevice[]) => void;
  onForgotten: () => void;
}) {
  const { device, live, owner, onPoll, onRegistryChange, onForgotten } = props;
  const sd = useSuperDevice();
  const info = live?.info;
  const status = live?.status;
  const avail = availability(live, owner);
  const chip = availabilityChip(avail, live);
  const online = live?.phase === "online";
  const name = deviceName(device, info);
  const isActive = sd.link === "online" && sd.host === device.host;

  const [gate, setGate] = useState<WriteGate | null>(null);
  const [gateMissing, setGateMissing] = useState(false);
  const [version, setVersion] = useState<DaemonVersion | null>(null);
  const [versionState, setVersionState] = useState<Load>("loading");
  const [recs, setRecs] = useState<RecList | null>(null);
  const [recsState, setRecsState] = useState<Load>("loading");
  const [recsErr, setRecsErr] = useState<string | null>(null);
  const [recStatus, setRecStatus] = useState<RecStatus | null>(null);

  const [wifiOpen, setWifiOpen] = useState(false);
  const [savedWifi, setSavedWifi] = useState<SavedWifiNetwork[] | null>(null);
  const [nearby, setNearby] = useState<NearbyWifiNetwork[] | null>(null);
  const [joinSsid, setJoinSsid] = useState<string | null>(null);
  const [joinPass, setJoinPass] = useState("");

  const [newName, setNewName] = useState("");
  const [nickname, setNickname] = useState(device.nickname ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "err" | "" } | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);

  const wifiOpenRef = useRef(wifiOpen);
  wifiOpenRef.current = wifiOpen;

  const say = (text: string, tone: "ok" | "err" | "" = "") => setNote({ text, tone });

  // ---- reads -------------------------------------------------------------------------
  const loadSavedWifi = useCallback(async () => {
    try {
      const r = await Api.superDevice.get<{ networks: SavedWifiNetwork[] }>(device.host, "/api/wifi/saved");
      setSavedWifi(r.networks);
    } catch { /* device dropped mid-refresh; the poller will flag it */ }
  }, [device.host]);

  /** Cheap reads, every 10 s while the Pi answers: write gate, recorder state, saved Wi-Fi (when shown). */
  const loadDetails = useCallback(async () => {
    if (!online) return;
    const h = device.host;
    await Promise.all([
      Api.superDevice.get<WriteGate>(h, "/api/write-gate")
        .then((g) => { setGate(g); setGateMissing(false); })
        .catch((e) => { if (isNotFound(e)) { setGate(null); setGateMissing(true); } }),
      Api.superDevice.get<RecStatus>(h, "/api/rec/status")
        .then(setRecStatus)
        .catch((e) => { if (isNotFound(e)) setRecStatus(null); }),
      wifiOpenRef.current ? loadSavedWifi() : Promise.resolve(),
    ]);
  }, [device.host, online, loadSavedWifi]);

  const loadVersion = useCallback(async () => {
    try {
      setVersion(await Api.superDevice.get<DaemonVersion>(device.host, "/api/version"));
      setVersionState("ok");
    } catch (e) { setVersionState(isNotFound(e) ? "none" : "error"); }
  }, [device.host]);

  /** The recording list hashes every file on the Pi — fetched on open and on request, never polled. */
  const loadRecs = useCallback(async () => {
    try {
      setRecs(await Api.superDevice.get<RecList>(device.host, "/api/rec/list"));
      setRecsState("ok"); setRecsErr(null);
    } catch (e) {
      if (isNotFound(e)) setRecsState("none");
      else { setRecsState((s) => (s === "ok" ? "ok" : "error")); setRecsErr(errText(e)); }
    }
  }, [device.host]);

  useEffect(() => {
    void loadDetails();
    const iv = setInterval(() => void loadDetails(), 10000);
    return () => clearInterval(iv);
  }, [loadDetails]);

  // once per time the Pi comes online (a reboot restarts the daemon)
  useEffect(() => {
    if (!online) return;
    void loadVersion();
    void loadRecs();
  }, [online, loadVersion, loadRecs]);

  useEffect(() => {
    if (wifiOpen && online) void loadSavedWifi();
  }, [wifiOpen, online, loadSavedWifi]);

  // ---- actions (unchanged from the device cockpit) ------------------------------------
  async function run(label: string, fn: () => Promise<unknown>, after?: () => void) {
    setBusy(label); setNote(null);
    try { await fn(); after?.(); }
    catch (err) { say(errText(err), "err"); }
    finally { setBusy(null); onPoll(); void loadDetails(); }
  }

  const connect = (force = false) => run("connect", async () => {
    const r = await sd.connect(device.host, { force });
    if (!r.ok) say(r.occupiedBy ? `Occupied by ${r.occupiedBy} — use "Take over" only if that PC is really done.` : (r.error ?? "connect failed"), "err");
    else say("Connected — the whole app now talks to this Pi, and this PC holds its claim while the app runs.", "ok");
  });

  const release = () => run("release", async () => {
    if (sd.host === device.host) {
      await sd.disconnect();
      say("Released — the Pi is available again.", "ok");
    } else {
      const r = await Api.devices.release(device.host);
      if (r.ok) say("Released — the Pi is available again.", "ok");
      else say(r.error ?? "release failed", "err");
    }
  });

  const rename = () => run("rename", async () => {
    const nm = newName.trim();
    const r = await Api.superDevice.post<{ ok: boolean; error?: string; note?: string }>(device.host, "/api/hostname", { name: nm });
    if (!r.ok) { say(r.error ?? "rename failed", "err"); return; }
    // if we reach it via <hostname>.local, follow the rename automatically
    const patch: Partial<Pick<PairedDevice, "host" | "hostname">> = { hostname: nm };
    if (/\.local:\d+$/i.test(device.host)) patch.host = `${nm}.local:${device.host.split(":")[1]}`;
    onRegistryChange(await Api.devices.update(device.id, patch));
    say(r.note ?? `Renamed to ${nm}`, "ok");
    setNewName("");
  });

  const saveNickname = () => run("nickname", async () => {
    onRegistryChange(await Api.devices.update(device.id, { nickname: nickname.trim() || undefined }));
    say("Nickname saved (only on this PC).", "ok");
  });

  const scanWifi = () => run("wifiscan", async () => {
    const r = await Api.superDevice.get<{ networks: NearbyWifiNetwork[] }>(device.host, "/api/wifi/scan");
    setNearby(r.networks);
  });

  const joinWifi = () => run("wifijoin", async () => {
    const r = await Api.superDevice.post<{ ok: boolean; error?: string }>(device.host, "/api/provision", { ssid: joinSsid, password: joinPass });
    if (r.ok) { say(`Joining ${joinSsid} — the Pi may change address; scan again if it drops off.`, "ok"); setJoinSsid(null); setJoinPass(""); }
    else say(r.error ?? "join failed", "err");
  });

  const forgetWifi = (nm: string) => run(`forget:${nm}`, async () => {
    const r = await Api.superDevice.post<{ ok: boolean; error?: string }>(device.host, "/api/wifi/forget", { name: nm });
    if (r.ok) say(`Forgot "${nm}".`, "ok");
    else say(r.error ?? "forget failed", "err");
  }, () => void loadSavedWifi());

  const reboot = () => run("reboot", async () => {
    await Api.superDevice.post(device.host, "/api/reboot", {});
    say("Rebooting — it comes back in about 40 s.", "ok");
    setConfirmReboot(false);
  });

  const forget = () => run("unpair", async () => {
    onRegistryChange(await Api.devices.unpair(device.id));
    onForgotten();
  });

  const canIfaceToggle = (iface: string, up: boolean) => run(`can:${iface}`, async () => {
    if (up) await Api.superDevice.setDown(device.host, iface);
    else await Api.superDevice.setUp(device.host, iface, iface === "can1" ? 125000 : 500000, false);
  });

  // ---- derived -----------------------------------------------------------------------
  const batt = info?.battery;
  const pw = info?.power;
  const gateMode = gate?.mode ?? (info?.write_gate as WriteGate["mode"] | undefined) ?? null;
  const claim = info?.claim;
  const appTalksTo = sd.link !== "online" ? null
    : sd.host === DESK_SIM ? "the desk simulator"
    : sd.info?.hostname ?? sd.host;

  const busRow = (i: SuperDeviceIface, hardware: boolean) => {
    const key = <><b className="ual-mono">{i.name}</b>{i.role ? ` · ${i.role === "VIRTUAL" ? "virtual" : i.role}` : ""}</>;
    if (!i.present) return <Row key={i.name} k={key}>not fitted</Row>;
    const troubled = i.up && i.canstate && !/^ERROR-ACTIVE$/i.test(i.canstate);
    const text = i.up
      ? `up · ${i.bitrate ? `${(i.bitrate / 1000).toFixed(0)}k` : "?"}${i.fd ? " FD" : ""} · rx ${i.rx ?? 0} · tx ${i.tx ?? 0}${i.rxerr ? ` · ${i.rxerr} err` : ""}${troubled ? ` · ${i.canstate}` : ""}`
      : "stopped";
    return (
      <Row key={i.name} k={key} tone={troubled ? "warn" : i.up ? "good" : ""}>
        <span>{text}</span>
        {hardware && (
          <button
            type="button"
            className="tiny"
            disabled={!online || !!busy || avail === "occupied"}
            title={avail === "occupied" ? "The Pi is in use by another PC" : undefined}
            onClick={() => void canIfaceToggle(i.name, !!i.up)}
          >
            {busy === `can:${i.name}` ? "…" : i.up ? "Stop" : `Start ${i.name === "can1" ? "125k" : "500k"}`}
          </button>
        )}
      </Row>
    );
  };

  const sessions = [...(recs?.sessions ?? [])].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || b.id.localeCompare(a.id));
  const SHOW_RECS = 8;

  return (
    <div className="dv-settings">
      <div className="dv-sel-head">
        <div className="dv-sel-title">
          <span className="ual-eyebrow">Settings</span>
          <h2 className="ual-h2">{name}</h2>
        </div>
        <span className={`ual-chip ${chip.cls}`}>{chip.label}</span>
        <div className="dv-actions">
          {avail === "available" && <button type="button" className="primary" onClick={() => void connect()} disabled={!!busy}>Connect</button>}
          {avail === "mine" && <button type="button" onClick={() => void release()} disabled={!!busy}>Disconnect</button>}
          {avail === "occupied" && (
            <button type="button" className="danger" onClick={() => void connect(true)} disabled={!!busy}
              title={`Takes the Pi from ${claim?.owner ?? "the other PC"} — only if that PC is really done`}>
              Take over
            </button>
          )}
          <a className="dv-linkbtn" href={`http://${device.host}`} target="_blank" rel="noreferrer">
            Open web UI<Icon size={14}>{ICON.external}</Icon>
          </a>
        </div>
      </div>

      {note && <div className={`ual-note ${note.tone}`} role={note.tone === "err" ? "alert" : "status"}>{note.text}</div>}
      {live?.phase === "offline" && (
        <div className="ual-note warn" role="status">
          <b>Not reachable.</b> {live.error ?? ""} · address <code className="ual-mono">{device.host}</code>
        </div>
      )}

      <div className="dv-sections">
        {/* ---------------- Connection ---------------- */}
        <section className="ual-card dv-section" aria-labelledby="dv-sec-conn">
          <h2 className="ual-section-head" id="dv-sec-conn">Connection</h2>
          <div className="ual-rows">
            <Row k="This app" tone={isActive ? "good" : ""}>
              {isActive ? "talks to this Pi" : appTalksTo ? `talks to ${appTalksTo}` : sd.link === "connecting" ? "connecting…" : "not connected"}
            </Row>
            <Row k="Address">
              <span className="ual-mono">{device.host}{info?.ip && info.ip !== device.host.split(":")[0] ? ` · ${info.ip}` : ""}</span>
            </Row>
            <Row k="Wi-Fi">{online ? (info?.ssid ? info.ssid : "not on Wi-Fi") : "—"}</Row>
            <Row k="Web UI">
              <a href={`http://${device.host}`} target="_blank" rel="noreferrer" className="ual-mono">http://{device.host}</a>
            </Row>
            <Row k="Who is using it" tone={claim && claim.owner !== owner ? "warn" : ""}>
              {claim ? (
                <span>
                  {claim.owner === owner ? `this PC (${claim.owner})` : claim.owner}
                  <span className="dv-detail">since {claim.since} · lapses {claim.expires_in} s after the last heartbeat</span>
                </span>
              ) : online ? "nobody — free" : "—"}
            </Row>
            <Row k="Network settings">
              <span>change on site only</span>
              <button type="button" className="tiny" aria-expanded={wifiOpen} aria-controls="dv-wifi" onClick={() => setWifiOpen((v) => !v)}>
                {wifiOpen ? "Hide Wi-Fi" : "Manage Wi-Fi…"}
              </button>
            </Row>
          </div>
          {wifiOpen && (
            <div className="dv-sub" id="dv-wifi">
              <div className="ual-note warn">
                The Pi&apos;s Wi-Fi is how you reach it remotely. Change it only when you are next to the Pi —
                a wrong network here can leave it unreachable until someone is on site.
              </div>
              <h3 className="dv-h3">Saved on this Pi</h3>
              {savedWifi === null ? (
                <p className="ual-sub dv-small">{online ? "Loading…" : "The Pi is not reachable."}</p>
              ) : savedWifi.length === 0 ? (
                <p className="ual-sub dv-small">None saved.</p>
              ) : (
                <div className="dv-list">
                  {savedWifi.map((n) => (
                    <div key={n.name}>
                      <span>
                        <b>{n.name}</b>
                        {n.active && <span className="ual-chip clean dv-chip-sm">connected</span>}
                        {n.autoconnect && <span className="ual-muted"> · joins automatically</span>}
                      </span>
                      <button type="button" className="tiny" disabled={!online || !!busy || n.active}
                        title={n.active ? "The connection in use cannot be forgotten" : undefined}
                        onClick={() => void forgetWifi(n.name)}>
                        Forget
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="dv-block-head">
                <h3 className="dv-h3">Nearby networks</h3>
                <button type="button" className="tiny" disabled={!online || !!busy} onClick={() => void scanWifi()}>
                  {busy === "wifiscan" ? "Scanning…" : nearby === null ? "Scan nearby" : "Scan again"}
                </button>
              </div>
              {nearby !== null && (nearby.length === 0 ? (
                <p className="ual-sub dv-small">Nothing heard — is the Pi in hotspot (setup) mode?</p>
              ) : (
                <div className="dv-list">
                  {nearby.map((n) => (
                    <div key={n.ssid}>
                      <span>
                        <b>{n.ssid}</b> <span className="ual-muted">{n.signal}%</span>
                        {n.secure && <span className="dv-secure" title="Password protected"><Icon size={13}>{ICON.lock}</Icon><span className="dv-sr">secured</span></span>}
                      </span>
                      <button type="button" className="tiny" disabled={!online || !!busy} onClick={() => { setJoinSsid(n.ssid); setJoinPass(""); }}>Join…</button>
                    </div>
                  ))}
                </div>
              ))}
              {joinSsid && (
                <form className="dv-form" onSubmit={(e) => { e.preventDefault(); void joinWifi(); }}>
                  <label htmlFor="dv-join-pass">Join <b>{joinSsid}</b></label>
                  <input id="dv-join-pass" type="password" placeholder="password (empty if open)" value={joinPass} onChange={(e) => setJoinPass(e.target.value)} />
                  <button type="submit" className="primary tiny" disabled={!!busy}>Connect Pi</button>
                  <button type="button" className="tiny ghost" onClick={() => setJoinSsid(null)}>Cancel</button>
                </form>
              )}
            </div>
          )}
        </section>

        {/* ---------------- Buses ---------------- */}
        <section className="ual-card dv-section" aria-labelledby="dv-sec-bus">
          <h2 className="ual-section-head" id="dv-sec-bus">Buses</h2>
          <div className="ual-rows">
            {!status ? (
              <Row k="CAN">{online ? "waiting for the Pi…" : "—"}</Row>
            ) : (
              <>
                {status.ifaces.map((i) => busRow(i, true))}
                {(status.virtual ?? []).map((i) => busRow(i, false))}
              </>
            )}
          </div>
          <p className="dv-foot">Starting or stopping a bus is blocked while another PC holds the Pi.</p>
        </section>

        {/* ---------------- Safety ---------------- */}
        <Section id="safety" title="Safety">
          <Row k="Write gate" tone={gateMode === "armed" ? "fault" : gateMode ? "warn" : ""}>
            {gateMode ? GATE_LABEL[gateMode] ?? gateMode : gateMissing ? "not reported by this device" : online ? "…" : "—"}
          </Row>
          {gate && (
            <Row k="Since boot">
              {gate.writes_since_boot ?? 0} {gate.writes_since_boot === 1 ? "write" : "writes"} · {gate.refused_since_boot ?? 0} refused
            </Row>
          )}
          {gate?.mode === "armed" && (
            <>
              <Row k="Armed for" tone="fault">
                {gate.scope?.iface ?? "any bus"} · module {gate.scope?.tx ?? "any"} · {Math.ceil(gate.seconds_left ?? 0)} s left
              </Row>
              <Row k="Armed by">{gate.owner || "?"}{gate.reason ? ` — ${gate.reason}` : ""}</Row>
            </>
          )}
          <Row k="Protected systems">
            <span>
              airbag · immobiliser
              <span className="dv-detail">never mapped automatically; the airbag safety session is refused even when armed</span>
            </span>
          </Row>
          <p className="dv-foot">Writes can only be enabled on the Pi itself. This page shows the gate; it cannot change it.</p>
        </Section>

        {/* ---------------- Power ---------------- */}
        <Section id="power" title="Power">
          {batt?.present && batt.external_power !== undefined && (
            <Row k="Supply" tone={batt.external_power ? "good" : "fault"}>{batt.external_power ? "12 V feed" : "ON BATTERY"}</Row>
          )}
          <Row k="UPS battery">
            {batt?.present && batt.percent != null
              ? <span className="dv-inline"><BatteryBar percent={batt.percent} /><span>{batt.voltage ?? "?"} V</span></span>
              : online ? "no fuel gauge detected — stack the X1200 and it appears here" : "—"}
          </Row>
          <Row
            k="Power guard"
            tone={pw?.state === "countdown" || pw?.state === "shutting-down" || pw?.state === "ups-degraded" ? "fault" : pw?.state === "ok" ? "good" : ""}
          >
            {!online && !pw ? "—"
              : pw == null ? "guard service not installed on this Pi"
              : pw.state === "countdown" ? `power lost — clean shutdown in ${pw.seconds_left ?? "?"} s unless the feed returns`
              : pw.state === "shutting-down" ? "shutting down…"
              : pw.state === "ok" ? `watching — clean shutdown ${pw.grace ?? 30} s after power loss; boots again when power returns`
              : pw.state === "ups-degraded" ? "ON BATTERY with no fuel gauge — cannot protect the cells; fix the 12 V feed / X1200 pogo contact or shut down"
              : "standing by (UPS not detected)"}
          </Row>
          <Row k="Restart">
            {confirmReboot ? (
              <span className="dv-inline">
                <span>Reboot the Pi now?</span>
                <button type="button" className="tiny danger" onClick={() => void reboot()} disabled={!!busy}>Yes, reboot</button>
                <button type="button" className="tiny ghost" onClick={() => setConfirmReboot(false)}>Cancel</button>
              </span>
            ) : (
              <button type="button" className="tiny" disabled={!online || !!busy} onClick={() => setConfirmReboot(true)}>Reboot…</button>
            )}
          </Row>
        </Section>

        {/* ---------------- Software ---------------- */}
        <Section id="software" title="Software">
          {versionState === "ok" && version ? (
            <>
              <Row k="Daemon build">
                <span className="ual-mono" title={version.daemon_sha256}>
                  {/^[0-9a-f]{16,}$/i.test(version.daemon_sha256 ?? "") ? version.daemon_sha256!.slice(0, 12) : (version.daemon_sha256 || "?")}
                </span>
              </Row>
              {version.uptime_s != null && (
                <Row k="Daemon running for">{shortDuration(version.uptime_s)}{version.pid ? ` · pid ${version.pid}` : ""}</Row>
              )}
              {version.features?.length ? <Row k="Features">{version.features.join(" · ")}</Row> : null}
              {version.python && <Row k="Python">{version.python}</Row>}
            </>
          ) : versionState === "none" ? (
            <Row k="Daemon build">not reported by this daemon</Row>
          ) : versionState === "error" ? (
            <Row k="Daemon build">
              <span>could not read it</span>
              <button type="button" className="tiny" disabled={!online} onClick={() => void loadVersion()}>Retry</button>
            </Row>
          ) : (
            <Row k="Daemon build">{online ? "…" : "—"}</Row>
          )}
          {status?.sys && (
            <>
              <Row k="System uptime">{status.sys.uptime ? status.sys.uptime.replace(/^up\s+/, "") : "—"}</Row>
              <Row k="CPU">{status.sys.temp != null ? `${status.sys.temp} °C` : "—"} · load {status.sys.load || "?"}</Row>
              <Row k="Kernel"><span className="ual-mono">{status.sys.kernel || "—"}</span></Row>
            </>
          )}
        </Section>

        {/* ---------------- Recordings (only when the Pi has a recorder) ---------------- */}
        {recsState !== "none" && (
          <section className="ual-card dv-section" aria-labelledby="dv-sec-rec">
            <h2 className="ual-section-head" id="dv-sec-rec">Recordings</h2>
            <div className="ual-rows">
              {recStatus && (
                <Row k="Recorder" tone={recStatus.error ? "fault" : recStatus.recording ? "good" : ""}>
                  {recStatus.error ? recStatus.error
                    : recStatus.recording && recStatus.session ? `recording · ${recStatus.session.id}`
                    : "not recording"}
                  {recStatus.free_mb != null ? ` · ${recStatus.free_mb.toLocaleString()} MB free` : ""}
                </Row>
              )}
              {recsState === "loading" && <Row k="Sessions">{online ? "loading the list…" : "—"}</Row>}
              {recsState === "error" && (
                <Row k="Sessions">
                  <span>could not list them{recsErr ? ` — ${recsErr}` : ""}</span>
                </Row>
              )}
              {recsState === "ok" && sessions.length === 0 && <Row k="Sessions">none on this Pi yet</Row>}
              {recsState === "ok" && sessions.slice(0, SHOW_RECS).map((s) => (
                <Row
                  key={s.id}
                  k={<span><span className="ual-mono dv-rec-id">{s.id}</span>{s.label || s.note ? <span className="dv-detail">{s.label || s.note}</span> : null}</span>}
                >
                  <span>
                    {s.error ? s.error : `${s.exchanges.toLocaleString()} exchanges · ${fmtBytes(s.bytes)}`}
                    <span className="dv-chips">
                      {s.active && <span className="ual-chip info dv-chip-sm">recording</span>}
                      {s.auto && <span className="ual-chip dv-chip-sm">auto</span>}
                      {s.sim && <span className="ual-chip warn dv-chip-sm" title={`Recorded while the virtual vehicle "${s.sim}" was running`}>simulator</span>}
                    </span>
                  </span>
                </Row>
              ))}
              {recsState === "ok" && sessions.length > SHOW_RECS && (
                <Row k="Older">{sessions.length - SHOW_RECS} more on the Pi</Row>
              )}
              <Row k={recs?.dir ? <span className="ual-mono dv-small">{recs.dir}</span> : "List"}>
                <button type="button" className="tiny" disabled={!online || busy === "recs"}
                  onClick={() => void run("recs", loadRecs)}>
                  <Icon size={13}>{ICON.refresh}</Icon> {busy === "recs" ? "Refreshing…" : "Refresh list"}
                </button>
              </Row>
            </div>
          </section>
        )}

        {/* ---------------- Name & pairing ---------------- */}
        <section className="ual-card dv-section" aria-labelledby="dv-sec-name">
          <h2 className="ual-section-head" id="dv-sec-name">Name &amp; pairing</h2>
          <div className="ual-rows">
            <Row k="Hostname">
              <span><b className="dv-ink">{info?.hostname ?? device.hostname ?? "—"}</b>{info?.hostname ? <span className="ual-mono"> · {info.hostname}.local</span> : null}</span>
            </Row>
            <Row k="Model">{info?.model || device.model || "—"}</Row>
            <Row k="Paired on this PC">{new Date(device.pairedAt).toLocaleString()}</Row>
            {device.lastSeenAt && live?.phase === "offline" && <Row k="Last seen">{new Date(device.lastSeenAt).toLocaleString()}</Row>}
            <div className="ual-rowline dv-stack">
              <label htmlFor="dv-rename">Rename on the Pi <span className="ual-muted">(letters, digits, hyphen)</span></label>
              <form className="dv-form" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                <input id="dv-rename" placeholder="new hostname" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <button type="submit" className="tiny" disabled={!online || !newName.trim() || !!busy}>Rename</button>
              </form>
            </div>
            <div className="ual-rowline dv-stack">
              <label htmlFor="dv-nick">Nickname <span className="ual-muted">(only on this PC)</span></label>
              <form className="dv-form" onSubmit={(e) => { e.preventDefault(); void saveNickname(); }}>
                <input id="dv-nick" placeholder="e.g. Shop Pi" value={nickname} onChange={(e) => setNickname(e.target.value)} />
                <button type="submit" className="tiny" disabled={!!busy}>Save</button>
              </form>
            </div>
            <Row k="Forget this Pi">
              {confirmForget ? (
                <span className="dv-inline">
                  <span>Remove it from this PC&apos;s list? Nothing changes on the Pi.</span>
                  <button type="button" className="tiny danger" onClick={() => void forget()} disabled={!!busy}>Yes, forget</button>
                  <button type="button" className="tiny ghost" onClick={() => setConfirmForget(false)}>Cancel</button>
                </span>
              ) : (
                <button type="button" className="tiny" onClick={() => setConfirmForget(true)}>Forget…</button>
              )}
            </Row>
          </div>
        </section>
      </div>
    </div>
  );
}
