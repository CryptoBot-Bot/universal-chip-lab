import { useState } from "react";

import { Api } from "../lib/api";

/**
 * First-time / new-network onboarding (AP-mode). When a SuperDevice can't reach a
 * known WiFi it broadcasts its own setup hotspot; the user joins it from the OS
 * WiFi menu, and this wizard configures the target network over the Pi's HTTP API
 * (reached at the AP gateway 10.42.0.1). This is the reliable, pro-standard path —
 * no Bluetooth stack required.
 */

interface WifiNet { ssid: string; signal: number; secure: boolean }
const AP_HOST_DEFAULT = "10.42.0.1:8080";

export function SetupWizard({ onClose, onDone }: { onClose: () => void; onDone: (host: string, ssid: string) => void }) {
  const [step, setStep] = useState(1);
  const [apHost, setApHost] = useState(AP_HOST_DEFAULT);
  const [nets, setNets] = useState<WifiNet[]>([]);
  const [ssid, setSsid] = useState("");
  const [pw, setPw] = useState("");
  const [devName, setDevName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function connectAp() {
    setBusy("connect"); setErr(null);
    try {
      const dev = await Api.superDevice.get<{ hostname?: string }>(apHost, "/api/device");
      setDevName(dev.hostname || "SuperDevice");
      try { setNets((await Api.superDevice.get<{ networks: WifiNet[] }>(apHost, "/api/wifi/scan")).networks); } catch { /* cache may be empty */ }
      setStep(3);
    } catch (e) {
      setErr(`Can't reach the device at ${apHost}. Make sure your laptop is joined to the device's setup WiFi first. (${(e as Error).message})`);
    } finally { setBusy(null); }
  }

  async function provision() {
    if (!ssid.trim()) { setErr("Enter your WiFi network name."); return; }
    setBusy("prov"); setErr(null);
    try {
      const r = await Api.superDevice.post<{ ok: boolean; error?: string }>(apHost, "/api/provision", { ssid: ssid.trim(), password: pw });
      if (r.ok) setStep(4);
      else setErr(r.error || "Could not join that network — double-check the password.");
    } catch {
      // the AP drops as the device switches networks, so a lost connection here
      // usually means it worked. If the password was wrong the device re-opens its AP.
      setStep(4);
    } finally { setBusy(null); }
  }

  return (
    <div className="sw-overlay" onClick={onClose}>
      <div className="sw" onClick={(e) => e.stopPropagation()}>
        <style>{styles}</style>
        <div className="sw-head">
          <div><b>Set up a device on a new WiFi</b></div>
          <button className="tiny" onClick={onClose}>✕</button>
        </div>
        <div className="sw-steps">
          {[1, 2, 3, 4].map((n) => <span key={n} className={`sw-dot ${step >= n ? "on" : ""} ${step === n ? "cur" : ""}`}>{n}</span>)}
        </div>

        {err && <div className="sw-err">{err}</div>}

        {step === 1 && (
          <div className="sw-body">
            <h4>1 · Power on the device</h4>
            <p>Plug the SuperDevice in. If it can't find a WiFi it already knows, after about a minute it creates its own setup network.</p>
            <div className="sw-tip">Give it ~60 seconds after power-on.</div>
            <button className="primary" onClick={() => setStep(2)}>Next →</button>
          </div>
        )}

        {step === 2 && (
          <div className="sw-body">
            <h4>2 · Join its setup WiFi</h4>
            <p>Open your laptop's WiFi menu and connect to the network named:</p>
            <div className="sw-ap">
              <span className="sw-ap-ssid mono">SuperDevice-Setup-••••</span>
              <span className="sw-ap-pw">password <b className="mono">superdevice</b></span>
            </div>
            <p className="tiny dim">The last 4 characters are unique to your device — it'll show in the WiFi list. Windows may warn "no internet" on this network; that's expected.</p>
            <div className="sw-row">
              <div className="sw-host">
                <label className="tiny dim">Device address (default is correct)</label>
                <input className="mono" value={apHost} onChange={(e) => setApHost(e.target.value)} />
              </div>
              <button className="primary" disabled={busy === "connect"} onClick={() => void connectAp()}>{busy === "connect" ? "Connecting…" : "I've joined it →"}</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="sw-body">
            <h4>3 · Choose the WiFi to join</h4>
            <p className="tiny dim">Connected to <b>{devName}</b>. Pick the network you want the device on (or type it in), and enter its password.</p>
            {nets.length > 0 && (
              <div className="sw-nets">
                {nets.map((n) => (
                  <button key={n.ssid} className={`sw-net ${ssid === n.ssid ? "sel" : ""}`} onClick={() => setSsid(n.ssid)}>
                    <span className="sw-net-name">{n.ssid}</span>{n.secure && <span>🔒</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="sw-field">
              <label className="tiny dim">Network name (SSID)</label>
              <input className="mono" value={ssid} onChange={(e) => setSsid(e.target.value)} placeholder="e.g. Shop-WiFi" />
            </div>
            <div className="sw-field">
              <label className="tiny dim">Password</label>
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="WiFi password" />
            </div>
            <button className="primary" disabled={busy === "prov"} onClick={() => void provision()}>{busy === "prov" ? "Joining…" : "Join network"}</button>
          </div>
        )}

        {step === 4 && (
          <div className="sw-body">
            <h4>✓ Device is joining {ssid || "your network"}</h4>
            <p>The setup hotspot is shutting down as the device switches over. Now:</p>
            <ol className="sw-ol">
              <li>Reconnect <b>your laptop</b> to <b>{ssid || "your normal WiFi"}</b>.</li>
              <li>Close this and hit <b>Scan network</b> to rediscover the device.</li>
            </ol>
            <p className="tiny dim">If the device doesn't appear, its password may have been wrong — it will re-open the setup WiFi so you can try again.</p>
            <button className="primary" onClick={() => onDone(apHost, ssid)}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = `
.sw-overlay { position: fixed; inset: 0; background: rgba(4,7,12,0.75); display: grid; place-items: center; z-index: 60; padding: 20px; }
.sw { width: 100%; max-width: 460px; max-height: 90vh; overflow-y: auto; background: var(--bg-1); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
.sw-head { display: flex; align-items: center; justify-content: space-between; }
.sw-head b { font-size: 15px; }
.sw-steps { display: flex; gap: 8px; margin: 14px 0; }
.sw-dot { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; background: var(--bg-2); border: 1px solid var(--border); color: var(--fg-2); }
.sw-dot.on { border-color: var(--accent); color: var(--accent); }
.sw-dot.cur { background: var(--accent); color: #06281c; }
.sw-err { font-size: 12px; color: var(--danger); background: rgba(239,68,68,0.08); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 11px; margin-bottom: 10px; }
.sw-body h4 { margin: 0 0 6px; }
.sw-body p { font-size: 13px; color: var(--fg-1); margin: 0 0 10px; }
.sw-tip { font-size: 12px; color: var(--warn); background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.35); border-radius: 8px; padding: 7px 10px; margin-bottom: 12px; }
.sw-ap { display: flex; flex-direction: column; gap: 4px; background: var(--bg-2); border: 1px solid var(--accent); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
.sw-ap-ssid { font-size: 16px; font-weight: 700; color: var(--accent); }
.sw-ap-pw { font-size: 12px; color: var(--fg-2); }
.sw-row { display: flex; gap: 8px; align-items: flex-end; }
.sw-host { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.sw-host input, .sw-field input { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; color: var(--fg-0); padding: 8px 10px; font-size: 13px; width: 100%; }
.sw-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.sw-nets { display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow-y: auto; margin-bottom: 10px; }
.sw-net { display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 11px; cursor: pointer; }
.sw-net.sel { border-color: var(--accent); }
.sw-net-name { font-size: 13px; color: var(--fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-ol { font-size: 13px; color: var(--fg-1); padding-left: 18px; line-height: 1.8; }
.sw button.primary { margin-top: 4px; }
`;
