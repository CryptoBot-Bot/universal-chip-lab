import { useEffect, useState } from "react";

import { Api } from "../lib/api";

/**
 * SuperDevice settings — rename the Pi, join a WiFi network, reboot. Talks to the
 * Pi's HTTP API through the main process (renderer is behind CSP). Works whenever
 * the laptop is on the same network as the Pi.
 */

interface DeviceInfo { hostname: string; ip: string; ssid: string; model: string }
interface WifiNet { ssid: string; signal: number; secure: boolean }

export function DeviceSettings({ host, onClose, onHostChange }: {
  host: string; onClose: () => void; onHostChange: (h: string) => void;
}) {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [nets, setNets] = useState<WifiNet[]>([]);
  const [scanning, setScanning] = useState(false);
  const [name, setName] = useState("");
  const [selSsid, setSelSsid] = useState<string | null>(null);
  const [wifiPw, setWifiPw] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Api.superDevice.get<DeviceInfo>(host, "/api/device")
      .then((d) => { setInfo(d); setName(d.hostname); })
      .catch((e) => setErr((e as Error).message));
  }, [host]);

  async function scanWifi() {
    setScanning(true); setErr(null);
    try { setNets((await Api.superDevice.get<{ networks: WifiNet[] }>(host, "/api/wifi/scan")).networks); }
    catch (e) { setErr((e as Error).message); }
    finally { setScanning(false); }
  }

  async function rename() {
    setBusy("rename"); setErr(null); setNote(null);
    try {
      const r = await Api.superDevice.post<{ ok: boolean; error?: string; note?: string; hostname?: string }>(host, "/api/hostname", { name });
      if (r.ok) {
        setNote(r.note || "Renamed.");
        if (r.hostname) onHostChange(`${r.hostname}.local:${host.split(":")[1] || "8080"}`);
      } else setErr(r.error || "Rename failed.");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  async function connectWifi() {
    if (!selSsid) return;
    setBusy("wifi"); setErr(null); setNote(null);
    try {
      const r = await Api.superDevice.post<{ ok: boolean; error?: string }>(host, "/api/wifi/set", { ssid: selSsid, password: wifiPw });
      if (r.ok) setNote(`Joined "${selSsid}". The Pi may briefly drop off this network while it switches — reconnect if the link goes red.`);
      else setErr(r.error || "Could not join that network.");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  async function reboot() {
    setBusy("reboot"); setErr(null);
    try { await Api.superDevice.post(host, "/api/reboot", {}); setNote("Rebooting… reconnect in ~40 s."); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <div className="ds-overlay" onClick={onClose}>
      <div className="ds" onClick={(e) => e.stopPropagation()}>
        <style>{styles}</style>
        <div className="ds-head">
          <div><b>SuperDevice settings</b> <small className="dim mono">{info?.hostname ?? host}</small></div>
          <button className="tiny" onClick={onClose}>✕</button>
        </div>

        {err && <div className="ds-err">{err}</div>}
        {note && <div className="ds-note">{note}</div>}

        <div className="ds-info">
          <span><b>Board</b> {info?.model?.replace("Raspberry Pi ", "Pi ") ?? "…"}</span>
          <span><b>IP</b> <span className="mono">{info?.ip ?? "…"}</span></span>
          <span><b>WiFi</b> {info?.ssid || "—"}</span>
        </div>

        <div className="ds-sec">
          <h5>Device name</h5>
          <div className="ds-row">
            <input className="mono" value={name} onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9-]/g, ""))} maxLength={31} placeholder="superdevice" />
            <button className="primary" disabled={busy === "rename" || !name} onClick={() => void rename()}>{busy === "rename" ? "…" : "Rename"}</button>
          </div>
          <p className="tiny dim">Reachable afterwards as <span className="mono">{name || "name"}.local</span>.</p>
        </div>

        <div className="ds-sec">
          <div className="ds-sechead">
            <h5>WiFi network</h5>
            <button className="tiny" disabled={scanning} onClick={() => void scanWifi()}>{scanning ? "Scanning…" : "Scan"}</button>
          </div>
          <div className="ds-nets">
            {nets.map((n) => (
              <button key={n.ssid} className={`ds-net ${selSsid === n.ssid ? "sel" : ""}`} onClick={() => setSelSsid(n.ssid)}>
                <span className="ds-sig" data-b={Math.min(4, Math.max(1, Math.ceil(n.signal / 25)))} />
                <span className="ds-net-name">{n.ssid}</span>
                {n.secure && <span className="ds-lock">🔒</span>}
              </button>
            ))}
            {!nets.length && <p className="tiny dim">Hit <b>Scan</b> to list nearby networks.</p>}
          </div>
          {selSsid && (
            <div className="ds-row">
              <input type="password" value={wifiPw} onChange={(e) => setWifiPw(e.target.value)} placeholder={`Password for "${selSsid}"`} />
              <button className="primary" disabled={busy === "wifi"} onClick={() => void connectWifi()}>{busy === "wifi" ? "Joining…" : "Connect"}</button>
            </div>
          )}
        </div>

        <div className="ds-sec">
          <h5>Power</h5>
          <button className="tiny ds-reboot" disabled={busy === "reboot"} onClick={() => void reboot()}>⟳ Reboot device</button>
        </div>
      </div>
    </div>
  );
}

const styles = `
.ds-overlay { position: fixed; inset: 0; background: rgba(4,7,12,0.72); display: grid; place-items: center; z-index: 60; padding: 20px; }
.ds { width: 100%; max-width: 460px; max-height: 88vh; overflow-y: auto; background: var(--bg-1); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
.ds-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.ds-head b { font-size: 15px; }
.ds-err { font-size: 12px; color: var(--danger); background: rgba(239,68,68,0.08); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 11px; margin-bottom: 10px; }
.ds-note { font-size: 12px; color: var(--accent); background: rgba(74,222,128,0.07); border: 1px solid rgba(74,222,128,0.4); border-radius: 8px; padding: 8px 11px; margin-bottom: 10px; }
.ds-info { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--fg-2); background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; }
.ds-info b { color: var(--fg-1); font-weight: 600; margin-right: 4px; }
.ds-sec { margin-bottom: 16px; }
.ds-sec h5 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-2); }
.ds-sechead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.ds-sechead h5 { margin: 0; }
.ds-row { display: flex; gap: 8px; }
.ds-row input { flex: 1; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; color: var(--fg-0); padding: 8px 10px; font-size: 13px; }
.ds-nets { display: flex; flex-direction: column; gap: 4px; max-height: 190px; overflow-y: auto; margin-bottom: 8px; }
.ds-net { display: flex; align-items: center; gap: 10px; text-align: left; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 11px; cursor: pointer; }
.ds-net.sel { border-color: var(--accent); }
.ds-net-name { flex: 1; font-size: 13px; color: var(--fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-lock { font-size: 11px; opacity: 0.7; }
.ds-sig { width: 16px; height: 13px; flex: none; background:
  linear-gradient(to top, var(--fg-2) 0 100%) left 0 bottom / 3px calc(var(--h1,25%)) no-repeat,
  linear-gradient(to top, var(--fg-2) 0 100%) left 5px bottom / 3px calc(var(--h2,25%)) no-repeat,
  linear-gradient(to top, var(--fg-2) 0 100%) left 10px bottom / 3px calc(var(--h3,25%)) no-repeat,
  linear-gradient(to top, var(--fg-2) 0 100%) left 15px bottom / 3px calc(var(--h4,25%)) no-repeat; }
.ds-sig[data-b="1"] { --h1: 35%; --h2: 12%; --h3: 12%; --h4: 12%; }
.ds-sig[data-b="2"] { --h1: 45%; --h2: 70%; --h3: 12%; --h4: 12%; }
.ds-sig[data-b="3"] { --h1: 45%; --h2: 70%; --h3: 90%; --h4: 12%; }
.ds-sig[data-b="4"] { --h1: 40%; --h2: 62%; --h3: 82%; --h4: 100%; }
.ds-net.sel .ds-sig { filter: brightness(1.6) hue-rotate(90deg); }
.ds-reboot { color: var(--warn); border-color: rgba(251,191,36,0.4); }
`;
