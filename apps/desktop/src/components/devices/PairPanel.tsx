import { useEffect, useRef, useState } from "react";

import { Api, type DiscoveredDevice, type NearbyWifiNetwork, type PiDeviceInfo } from "../../lib/api";
import { ICON, Icon, errText } from "./common";

/** A Pi on its own setup hotspot always sits here. */
const SETUP_HOST = "10.42.0.1:8080";

/**
 * "Pair a Pi": what the network scan found, pairing by address, and the
 * brand-new-Pi flow (join its setup hotspot, hand it the shop Wi-Fi).
 */
export function PairPanel(props: {
  scanning: boolean;
  found: DiscoveredDevice[] | null;
  pairedHosts: Set<string>;
  error: string | null;
  /** Put the cursor in the address box (opened with "Pair a Pi", not by a scan). */
  focusAddress?: boolean;
  onScan: () => void;
  onPair: (input: { host: string; hostname?: string; model?: string }) => void;
  onClose: () => void;
}) {
  const { scanning, found, pairedHosts, error, focusAddress, onScan, onPair, onClose } = props;
  const [manualHost, setManualHost] = useState("");
  const addressRef = useRef<HTMLInputElement>(null);

  // setup-mode helper
  const [setupPi, setSetupPi] = useState<PiDeviceInfo | null>(null);
  const [setupChecking, setSetupChecking] = useState(false);
  const [setupNets, setSetupNets] = useState<NearbyWifiNetwork[] | null>(null);
  const [setupSsid, setSetupSsid] = useState<string | null>(null);
  const [setupPass, setSetupPass] = useState("");
  const [setupSent, setSetupSent] = useState(false);
  const [setupErr, setSetupErr] = useState<string | null>(null);

  useEffect(() => { if (focusAddress) addressRef.current?.focus(); }, [focusAddress]);

  const unpaired = (found ?? []).filter((f) => !pairedHosts.has(f.host));

  async function checkSetupMode() {
    setSetupChecking(true); setSetupErr(null); setSetupPi(null); setSetupNets(null); setSetupSent(false);
    try {
      const info = await Api.superDevice.get<PiDeviceInfo>(SETUP_HOST, "/api/device");
      setSetupPi(info);
      const nets = await Api.superDevice.get<{ networks: NearbyWifiNetwork[] }>(SETUP_HOST, "/api/wifi/scan");
      setSetupNets(nets.networks);
    } catch {
      setSetupErr("No Pi found at 10.42.0.1 — is this PC connected to the SuperDevice-Setup-XXXX Wi-Fi (password: superdevice)?");
    } finally { setSetupChecking(false); }
  }

  async function provisionSetupPi() {
    if (!setupSsid) return;
    setSetupErr(null);
    try {
      const r = await Api.superDevice.post<{ ok: boolean; error?: string }>(SETUP_HOST, "/api/provision", { ssid: setupSsid, password: setupPass });
      if (!r.ok) { setSetupErr(r.error || "The Pi could not join that network (it restarted its setup hotspot — try again)."); return; }
      setSetupSent(true);
      setSetupSsid(null); setSetupPass("");
    } catch (err) { setSetupErr(errText(err)); }
  }

  const pairManual = () => {
    const h = manualHost.trim();
    if (!h) return;
    onPair({ host: h });
    setManualHost("");
  };

  return (
    <section className="ual-card pad dv-pair" aria-labelledby="dv-pair-title">
      <div className="dv-pair-head">
        <h2 className="ual-h2" id="dv-pair-title">Pair a Pi</h2>
        <button type="button" className="ghost tiny" onClick={onClose} aria-label="Close pairing">
          <Icon>{ICON.close}</Icon>
        </button>
      </div>

      <div className="dv-block">
        <div className="dv-block-head">
          <h3 className="dv-h3">On this network</h3>
          <button type="button" className="tiny" onClick={onScan} disabled={scanning}>
            {scanning ? "Scanning the subnet…" : found === null ? "Scan network" : "Scan again"}
          </button>
        </div>
        {found === null ? (
          <p className="ual-sub">{scanning ? "Looking for SuperDevices on the local subnet(s)…" : "Scan to find SuperDevices on the local subnet(s)."}</p>
        ) : unpaired.length === 0 ? (
          <p className="ual-sub">No new SuperDevices found on the local subnet(s).</p>
        ) : (
          <div className="dv-list">
            {unpaired.map((f) => (
              <div key={f.host}>
                <span>
                  <b>{f.hostname}</b> <span className="ual-muted">{f.model}</span>{" "}
                  <span className="ual-mono dv-small">{f.ip}</span>
                </span>
                <button type="button" className="tiny primary" onClick={() => onPair({ host: f.host, hostname: f.hostname, model: f.model })}>Pair</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <form className="dv-block" onSubmit={(e) => { e.preventDefault(); pairManual(); }}>
        <h3 className="dv-h3"><label htmlFor="dv-pair-address">Pair by address</label></h3>
        <div className="dv-form">
          <input
            id="dv-pair-address"
            ref={addressRef}
            placeholder="hostname.local or 192.168.1.67 (port defaults to 8080)"
            value={manualHost}
            onChange={(e) => setManualHost(e.target.value)}
          />
          <button type="submit" disabled={!manualHost.trim()}>Pair by address</button>
        </div>
      </form>

      <div className="dv-block">
        <div className="dv-block-head">
          <div>
            <h3 className="dv-h3">Brand-new Pi in setup mode?</h3>
            <p className="ual-sub dv-small">
              Join this PC to its <b>SuperDevice-Setup-XXXX</b> Wi-Fi (password <code className="ual-mono">superdevice</code>), then find it here.
            </p>
          </div>
          <button type="button" className="tiny" onClick={() => void checkSetupMode()} disabled={setupChecking}>
            {setupChecking ? "Checking…" : "Find setup-mode Pi"}
          </button>
        </div>
        {setupPi && !setupSent && (
          <>
            <p className="ual-sub">
              Found <b>{setupPi.hostname}</b> ({setupPi.model}) on its hotspot. Pick the Wi-Fi it should live on:
            </p>
            {setupNets === null ? (
              <p className="ual-sub dv-small">Loading networks…</p>
            ) : setupNets.length === 0 ? (
              <p className="ual-sub dv-small">No cached networks — type the network name below.</p>
            ) : (
              <div className="dv-list">
                {setupNets.map((n) => (
                  <div key={n.ssid}>
                    <span>
                      <b>{n.ssid}</b> <span className="ual-muted">{n.signal}%</span>
                      {n.secure && <span className="dv-secure" title="Password protected"><Icon size={13}>{ICON.lock}</Icon><span className="dv-sr">secured</span></span>}
                    </span>
                    <button type="button" className="tiny" onClick={() => { setSetupSsid(n.ssid); setSetupPass(""); }}>Select</button>
                  </div>
                ))}
              </div>
            )}
            <form className="dv-form" onSubmit={(e) => { e.preventDefault(); void provisionSetupPi(); }}>
              <label className="dv-sr" htmlFor="dv-setup-ssid">Wi-Fi name (SSID)</label>
              <input id="dv-setup-ssid" placeholder="Wi-Fi name (SSID)" value={setupSsid ?? ""} onChange={(e) => setSetupSsid(e.target.value)} />
              <label className="dv-sr" htmlFor="dv-setup-pass">Wi-Fi password</label>
              <input id="dv-setup-pass" type="password" placeholder="Wi-Fi password" value={setupPass} onChange={(e) => setSetupPass(e.target.value)} />
              <button type="submit" className="primary" disabled={!setupSsid?.trim()}>Send to Pi</button>
            </form>
          </>
        )}
        {setupSent && (
          <div className="ual-note ok" role="status">
            Credentials sent — the Pi is joining your Wi-Fi now. Reconnect this PC to the same Wi-Fi,
            wait about 30 s, then press <b>Scan network</b> and pair it.
          </div>
        )}
        {setupErr && <div className="ual-note err" role="alert">{setupErr}</div>}
      </div>

      {error && <div className="ual-note err" role="alert">{error}</div>}
    </section>
  );
}
