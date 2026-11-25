import { useEffect, useRef, useState } from "react";

import { Api, type PairedDevice } from "../lib/api";
import { useSuperDevice } from "../lib/superdevice-connection";
import { voltageView, voltsText } from "../lib/voltage";
import { DESK_SIM, useWorkbench } from "../lib/workbench";

/**
 * Header status: what the app is talking to (a Pi, or the desk simulator playing a
 * recorded car), which bus, and the device's write gate. Click to switch.
 */
export function ConnectionPill() {
  const sd = useSuperDevice();
  const wb = useWorkbench();
  const online = sd.link === "online";
  const [open, setOpen] = useState(false);
  const [paired, setPaired] = useState<PairedDevice[]>([]);
  const [address, setAddress] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) Api.devices.list().then((r) => setPaired(r.devices)).catch(() => setPaired([])); }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const connect = async (h: string) => {
    setErr(null);
    const r = await sd.connect(h);
    if (r.ok) setOpen(false);
    else setErr(`Could not reach ${h}: ${r.error}${h === DESK_SIM ? " — start it with START-CHIP-LAB.bat" : ""}`);
  };

  const label = !online
    ? sd.link === "connecting" ? "Connecting…" : sd.link === "error" ? "Device not reachable" : "No device — connect"
    : wb.demo ? `${wb.simCar ? `${wb.simCar} · ` : ""}desk sim`
    : `${sd.info?.hostname ?? sd.host} · ${wb.iface}`;
  const cls = !online ? (sd.link === "error" ? "err" : "off") : wb.demo ? "" : "live";

  return (
    <div className="ual-status" ref={box}>
      <button type="button" className={`ual-conn ${cls}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog"
        title={wb.demo ? "Answers come from the desk simulator on this PC, not from a car." : "The device this app talks to"}>
        <span className="ual-dot" />{label}
      </button>
      {online && <VoltageChip />}
      {wb.gate === "read-only" && (
        <span className="ual-chip protected strong" title="The device refuses every write (erase codes, coding, resets, routines) before it reaches the car. Writes can only be enabled on the Pi itself.">READ-ONLY</span>
      )}
      {wb.gate === "armed" && <span className="ual-chip fault strong" title="The device's write gate is armed for one module right now.">WRITE GATE ARMED</span>}
      {online && !wb.demo && wb.sim?.running && (
        <span className="ual-chip info strong" title="A virtual vehicle runs on the device itself; with the can1↔can0 jumper in, it answers instead of a car.">VIRTUAL CAR ON DEVICE</span>
      )}
      {open && (
        <div className="ual-pop" role="dialog" aria-label="Choose a device">
          <h4>Talk to</h4>
          {paired.map((d) => (
            <button key={d.id} type="button" className={`ual-pick ${online && sd.host === d.host ? "sel" : ""}`} onClick={() => void connect(d.host)}>
              {d.nickname || d.hostname || d.host}<small>{d.host} · Pi</small>
            </button>
          ))}
          <button type="button" className={`ual-pick ${wb.demo ? "sel" : ""}`} onClick={() => void connect(DESK_SIM)}>
            Desk simulator{wb.demo && wb.simCar ? ` — ${wb.simCar}` : ""}
            <small>this PC · plays back a car the Pi recorded · no hardware needed</small>
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <input aria-label="Device address" placeholder="address, e.g. 192.168.1.50:8080" value={address}
              onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && address.trim()) void connect(address.trim()); }} />
            <button type="button" disabled={!address.trim()} onClick={() => void connect(address.trim())}>Connect</button>
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, margin: 0, textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
            Vehicle bus
            <select value={wb.iface} onChange={(e) => wb.setIface(e.target.value)}>
              <option value="can0">can0 — HS-CAN (OBD pins 6/14)</option>
              <option value="can1">can1 — MS-CAN (OBD pins 3/11)</option>
              <option value="vcan0">vcan0 — virtual bus on the Pi</option>
            </select>
          </label>
          {err && <div className="ual-note err">{err}</div>}
          {online && <button type="button" className="ghost" style={{ alignSelf: "flex-start" }} onClick={() => { void sd.disconnect(); setOpen(false); }}>Disconnect</button>}
        </div>
      )}
    </div>
  );
}

/** The car's supply voltage, next to the device: green / amber / red by what it means. Click to read now. */
function VoltageChip() {
  const { voltage: v, demo } = useWorkbench();
  const r = v.reading;
  const view = r && r.volts !== null ? voltageView(r.volts, r.rpm) : null;
  const cls = !view || v.status ? "unread" : view.level === "ok" ? "clean" : view.level === "warn" ? "warn" : view.level === "low" ? "fault" : "info";
  const text = v.reading_now ? "reading…" : view ? `${voltsText(r!.volts!)}${view.what === "supply" ? "" : ` ${view.what}`}` : "— V";
  const tip = [
    view ? view.hint : "Supply voltage, read from the engine module (OBD 01 42).",
    r ? `Read from the engine module at ${new Date(r.at).toLocaleTimeString()}${demo ? " — from the desk simulator, not a car" : ""}.` : "",
    v.status ? `Now: ${v.status}.` : "Updates every 10 s; waits while a scan runs.",
  ].filter(Boolean).join(" ");
  return (
    <button type="button" className={`ual-chip strong ual-volts ${cls}`} title={tip} onClick={() => void v.readNow()} disabled={v.reading_now} aria-live="polite">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M7 4v3M17 4v3M6.5 13h3M14.5 13h3M16 11.5v3" /></svg>
      {text}{view && v.status && !v.reading_now ? " · old" : ""}
    </button>
  );
}
