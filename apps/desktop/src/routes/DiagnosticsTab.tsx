import { useEffect, useMemo, useRef, useState } from "react";

import { bindVinIdentity, decodeVin, lastScanFor, learnVin } from "@ecu/vehicle-db";
import type { SystemScanResult, VehicleModule, VehicleProfile } from "@ecu/vehicle-db";

import { diagStyles } from "../components/diag/styles";
import { SystemPage, type FnId } from "../components/diag/SystemPage";
import { VehicleHub, type HubTab, type RowState } from "../components/diag/VehicleHub";
import { Api, type PairedDevice } from "../lib/api";
import { COMMON_MAKES, addressedSystems, manualProfile, ymmLabel } from "../lib/diag";
import { useSuperDevice } from "../lib/superdevice-connection";

/**
 * Diagnostics — the scan-tool flow.
 *
 *   Home          AutoVIN · Manual VIN · Select vehicle (make → model) · History
 *   Vehicle       Auto Scan · Control Units · Service · History
 *   System        ECU Information · Read/Erase Codes · Live Data · Active Test ·
 *                 Special Functions · Coding · Learn · Expert console
 *
 * Everything found is saved in the vehicle library as it is found: which systems
 * a model has and how to talk to each (per year/make/model), and each car's own
 * scans (per VIN). A model that has been in before opens already mapped; a car
 * that has been in before opens with its last scan.
 */

type Step =
  | { s: "home" } | { s: "vin" } | { s: "make" } | { s: "model"; make: string } | { s: "history" }
  | { s: "vehicle"; tab: HubTab } | { s: "system"; moduleId: string; fn: FnId | null };

const DESK_SIM = "127.0.0.1:8765";
const KEY = "diag.session.v1";
const IFACE_KEY = "diag.iface";

interface Saved { profileId: string | null; vin: string; step: Step }
function loadSaved(): Saved {
  try { const r = JSON.parse(localStorage.getItem(KEY) || "null") as Saved | null; if (r && r.step) return r; } catch { /* fresh */ }
  return { profileId: null, vin: "", step: { s: "home" } };
}

export function DiagnosticsTab() {
  const sd = useSuperDevice();
  const online = sd.link === "online";
  const host = sd.host;
  const saved = useRef(loadSaved()).current;

  const [profiles, setProfiles] = useState<VehicleProfile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(saved.profileId);
  const [vin, setVin] = useState(saved.vin);
  const [step, setStep] = useState<Step>(saved.step);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [note, setNote] = useState<{ kind: "" | "ok" | "warn" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [iface, setIface] = useState(() => localStorage.getItem(IFACE_KEY) || "can0");
  const [pendingVin, setPendingVin] = useState("");            // a VIN read but not yet tied to a model
  const [vinInput, setVinInput] = useState("");
  const [newYear, setNewYear] = useState(""); const [newModel, setNewModel] = useState(""); const [otherMake, setOtherMake] = useState("");
  const [pop, setPop] = useState(false);
  const [paired, setPaired] = useState<PairedDevice[]>([]);
  const [hostInput, setHostInput] = useState("");
  const [sim, setSim] = useState<{ running: boolean; vehicle?: string | null; name?: string | null } | null>(null);
  // The device's write gate: "read-only" (writes disabled on the Pi), "disarmed" or "armed".
  const [gate, setGate] = useState<string | null>(null);

  const profile = useMemo(() => profiles.find((x) => x.id === profileId) ?? null, [profiles, profileId]);
  const profilesRef = useRef(profiles); profilesRef.current = profiles;

  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ profileId, vin, step })); } catch { /* private mode */ } }, [profileId, vin, step]);
  useEffect(() => { localStorage.setItem(IFACE_KEY, iface); }, [iface]);

  // The library — re-read every few seconds, so work done elsewhere (the command line,
  // another window) shows up here as it is saved.
  useEffect(() => {
    let last = "";
    const load = async () => {
      try {
        const list = await Api.vehicleLib.list();
        const sig = list.map((x) => `${x.id}@${x.provenance?.updatedAt ?? ""}`).join("|");
        if (sig !== last) { last = sig; setProfiles(list); }
      } catch (e) { setNote({ kind: "err", text: (e as Error).message }); }
    };
    void load();
    const iv = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(iv);
  }, []);

  // Is a virtual vehicle answering instead of a car? Shown loudly in the bar.
  useEffect(() => {
    if (!online) { setSim(null); return; }
    let stop = false;
    const poll = () => {
      void Api.superDevice.get<{ running: boolean; vehicle?: string | null; name?: string | null }>(host, "/api/sim/status")
        .then((s) => { if (!stop) setSim(s); }).catch(() => { if (!stop) setSim(null); });
      void Api.superDevice.get<{ mode?: string }>(host, "/api/write-gate")
        .then((g) => { if (!stop) setGate(g?.mode ?? null); }).catch(() => { if (!stop) setGate(null); });
    };
    void poll();
    const iv = window.setInterval(() => void poll(), 8000);
    return () => { stop = true; window.clearInterval(iv); };
  }, [online, host]);

  // a step that points at something no longer there falls back to a sane place
  useEffect(() => {
    if (!profiles.length) return;
    if ((step.s === "vehicle" || step.s === "system") && !profile) setStep({ s: "home" });
    if (step.s === "system" && profile && !profile.modules.some((m) => m.id === step.moduleId)) setStep({ s: "vehicle", tab: "scan" });
  }, [profiles, profile, step]);

  async function saveProfile(next: VehicleProfile): Promise<VehicleProfile> {
    const list = await Api.vehicleLib.save(next);
    setProfiles(list);
    return list.find((x) => x.id === next.id) ?? next;
  }
  const adoptProfile = (next: VehicleProfile) => setProfiles((list) => (list.some((x) => x.id === next.id) ? list.map((x) => (x.id === next.id ? next : x)) : [...list, next]));

  function open(pf: VehicleProfile, v: string, tab: HubTab = "scan") {
    setProfileId(pf.id); setVin(v); setRows({}); setStep({ s: "vehicle", tab });
  }

  /** Tie a VIN to a library vehicle: the NHTSA decode decides; with no decode, the
   * operator's own selection stands. Returns what is now open, or null if no model is known. */
  async function bindVin(v: string, picked: VehicleProfile | null): Promise<{ profile: VehicleProfile; vin: string } | null> {
    const now = new Date().toISOString();
    let online: Awaited<ReturnType<typeof Api.vehicleExplorer.decodeOnline>> | null = null;
    try { online = await Api.vehicleExplorer.decodeOnline(v); } catch { online = null; }
    const b = bindVinIdentity(profilesRef.current, v, online, now);
    let target = b.profile;
    let how = b.kind === "vin" ? "this exact car has been here before" : b.kind === "pattern" ? "recognised by its VIN pattern" : b.kind === "ymm" ? "matched by the NHTSA decode" : b.kind === "new" ? "new model — filed from the NHTSA decode" : "";
    if (!target && picked) { target = learnVin(picked, v, now).profile; how = "NHTSA could not name it — filed under your selection"; }
    if (!target) return null;
    const stored = await saveProfile(target);
    const switched = picked && picked.id !== stored.id;
    setNote({ kind: switched ? "warn" : "ok", text: `VIN ${v} → ${ymmLabel(stored)} (${how}).${switched ? ` You had selected ${ymmLabel(picked!)} — the VIN says otherwise, so the vehicle was switched.` : ""}` });
    return { profile: stored, vin: v };
  }

  async function autoVin(picked: VehicleProfile | null): Promise<{ profile: VehicleProfile; vin: string } | null> {
    if (!online) { setNote({ kind: "warn", text: "Connect the device first (top right) — AutoVIN reads the VIN from the car." }); setPop(true); return null; }
    setBusy("Reading the VIN from the vehicle…"); setNote(null);
    try {
      const r = await Api.superDevice.readVin(host, iface);
      if (!(r.ok && r.vin)) { setNote({ kind: "err", text: `No VIN from the vehicle${r.error ? ` — ${r.error}` : ""}. Ignition on? You can still select the vehicle by hand.` }); return null; }
      const bound = await bindVin(r.vin, picked);
      if (!bound) {
        setPendingVin(r.vin);
        setNote({ kind: "warn", text: `VIN ${r.vin} was read, but the model could not be determined automatically. Select the make and model — the VIN will be filed under it.` });
        setStep({ s: "make" });
        return null;
      }
      setPendingVin("");
      return bound;
    } catch (e) { setNote({ kind: "err", text: (e as Error).message }); return null; }
    finally { setBusy(null); }
  }

  async function manualVin() {
    const d = decodeVin(vinInput);
    if (!d.valid) { setNote({ kind: "err", text: "That is not a valid 17-character VIN (no I, O or Q)." }); return; }
    setBusy("Decoding the VIN…"); setNote(null);
    try {
      const bound = await bindVin(d.vin, null);
      if (bound) open(bound.profile, bound.vin);
      else { setPendingVin(d.vin); setNote({ kind: "warn", text: `VIN ${d.vin}: the model could not be determined. Select the make and model — the VIN will be filed under it.` }); setStep({ s: "make" }); }
    } finally { setBusy(null); }
  }

  /** A model picked from the list (or typed in). A VIN waiting for a model is filed under it. */
  async function pickModel(pf: VehicleProfile) {
    if (pendingVin) {
      const stored = await saveProfile(learnVin(pf, pendingVin, new Date().toISOString()).profile);
      setNote({ kind: "ok", text: `VIN ${pendingVin} filed under ${ymmLabel(stored)}.` });
      open(stored, pendingVin); setPendingVin("");
      return;
    }
    const known = pf.knownVins ?? [];
    setNote(known.length ? { kind: "", text: `${known.length} car${known.length === 1 ? "" : "s"} of this model on file. Auto Scan reads the VIN and opens the right one.` } : null);
    open(pf, "");
  }

  async function addModel(make: string) {
    const year = newYear.trim() ? Number(newYear) : null;
    if (!newModel.trim() || (year !== null && !(year > 1980 && year < 2100))) { setNote({ kind: "err", text: "Enter the model (and a 4-digit year, or leave the year empty)." }); return; }
    const stored = await saveProfile(manualProfile(year, make, newModel.trim(), new Date().toISOString()));
    setNewModel(""); setNewYear("");
    await pickModel(stored);
  }

  const connect = async (h: string) => {
    setNote(null);
    const r = await sd.connect(h);
    if (r.ok) setPop(false);
    else setNote({ kind: "err", text: `Could not connect to ${h}: ${r.error}${h === DESK_SIM ? " — start it with START-CHIP-LAB.bat, or: python hardware\\super-device\\webui\\desk_sim.py" : ""}` });
  };
  useEffect(() => { if (pop) Api.devices.list().then((r) => setPaired(r.devices)).catch(() => setPaired([])); }, [pop]);

  // ---- derived for the pickers ----
  const makes = useMemo(() => {
    const m = new Map<string, { label: string; models: number; cars: number }>();
    for (const x of profiles) {
      const k = x.make.toLowerCase();
      const e = m.get(k) ?? { label: x.make, models: 0, cars: 0 };
      e.models += 1; e.cars += x.knownVins?.length ?? 0; m.set(k, e);
    }
    for (const c of COMMON_MAKES) if (!m.has(c.toLowerCase())) m.set(c.toLowerCase(), { label: c, models: 0, cars: 0 });
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [profiles]);
  const history = useMemo(() => profiles
    .flatMap((x) => (x.knownVins ?? []).map((v) => ({ profile: x, unit: v })))
    .sort((a, b) => (a.unit.lastReadAt < b.unit.lastReadAt ? 1 : -1)), [profiles]);

  const mod: VehicleModule | null = step.s === "system" && profile ? profile.modules.find((m) => m.id === step.moduleId) ?? null : null;
  const demo = online && host === DESK_SIM;
  const last = lastScanFor(profile, vin);

  const back = () => {
    if (step.s === "system") setStep(step.fn ? { ...step, fn: null } : { s: "vehicle", tab: "scan" });
    else if (step.s === "model") setStep({ s: "make" });
    else setStep({ s: "home" });
  };

  return (
    <div className="dg">
      <style>{diagStyles}</style>
      <div className="dg-bar">
        <button className="dg-nav" disabled={step.s === "home"} onClick={back} title="Back">◀</button>
        <button className="dg-nav" disabled={step.s === "home"} onClick={() => setStep({ s: "home" })} title="Vehicle selection">⌂</button>
        <div className="dg-path">
          <button onClick={() => setStep({ s: "home" })}>Diagnostics</button>
          {(step.s === "make" || step.s === "model") && <><span className="sep">›</span><button onClick={() => setStep({ s: "make" })}>Select vehicle</button></>}
          {step.s === "model" && <><span className="sep">›</span><b>{step.make}</b></>}
          {step.s === "vin" && <><span className="sep">›</span><b>Manual VIN</b></>}
          {step.s === "history" && <><span className="sep">›</span><b>Vehicle history</b></>}
          {(step.s === "vehicle" || step.s === "system") && profile && <><span className="sep">›</span><button onClick={() => setStep({ s: "vehicle", tab: "scan" })}>{ymmLabel(profile)}</button></>}
          {step.s === "system" && mod && <><span className="sep">›</span><b>{mod.label}</b></>}
        </div>
        <span className="dg-spacer" />
        {demo && <span className="dg-chip demo" title="Answers come from the desk simulator on this PC, not from a car.">DEMO VEHICLE{sim?.name ? ` · ${sim.name}` : ""}</span>}
        {!demo && gate === "read-only" && <span className="dg-chip" title="The device refuses every write (erase codes, coding, resets, routines) before it reaches the car. Writes can only be enabled on the Pi itself.">READ-ONLY</span>}
        {!demo && gate === "armed" && <span className="dg-chip" title="The device's write gate is armed for one module right now.">WRITE GATE ARMED</span>}
        {!demo && sim?.running && <span className="dg-chip" title="A virtual vehicle is running on the device. With the can1↔can0 jumper in, it answers instead of a car.">VIRTUAL VEHICLE RUNNING · {sim.vehicle}</span>}
        <div className={`dg-vci ${online ? "on" : sd.link === "error" ? "err" : sd.link === "connecting" ? "busy" : ""}`}>
          <span className="dot" />
          <span>{online ? `${sd.info?.hostname ?? "device"} · ${iface}` : sd.link === "connecting" ? "connecting…" : sd.link === "error" ? "device not reachable" : "no device"}</span>
          <button className="tiny" onClick={() => setPop((v) => !v)}>{online ? "Change" : "Connect"}</button>
          {pop && (
            <div className="dg-pop">
              <h4>Device</h4>
              {paired.map((d) => (
                <button key={d.id} className={`dg-dev ${host === d.host && online ? "sel" : ""}`} onClick={() => void connect(d.host)}>
                  <span style={{ flex: 1 }}>{d.nickname || d.hostname || d.host}<small>{d.host}</small></span>
                </button>
              ))}
              <button className={`dg-dev ${demo ? "sel" : ""}`} onClick={() => void connect(DESK_SIM)}>
                <span style={{ flex: 1 }}>Desk simulator — demo vehicle<small>{DESK_SIM} · no hardware, a full virtual car on this PC</small></span>
              </button>
              <div className="row" style={{ marginTop: 4 }}>
                <input className="dg-in" style={{ flex: 1 }} placeholder="address, e.g. 100.91.185.100" value={hostInput} onChange={(e) => setHostInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && hostInput.trim()) void connect(hostInput.trim()); }} />
                <button disabled={!hostInput.trim()} onClick={() => void connect(hostInput.trim())}>Connect</button>
              </div>
              <div className="row spread" style={{ marginTop: 10 }}>
                <label className="tiny dim">Vehicle bus{" "}
                  <select className="dg-in" style={{ padding: "4px 6px" }} value={iface} onChange={(e) => setIface(e.target.value)}>
                    <option value="can0">can0 — HS-CAN (OBD pins 6/14)</option><option value="can1">can1 — MS-CAN</option><option value="vcan0">vcan0 — virtual</option>
                  </select>
                </label>
                {online && <button className="tiny" onClick={() => { void sd.disconnect(); setPop(false); }}>Disconnect</button>}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="dg-body">
        {note && <div className={`dg-note ${note.kind}`}>{note.text}</div>}
        {busy && <div className="dg-note">● {busy}</div>}

        {step.s === "home" && (
          <>
            <h1 className="dg-h">Vehicle diagnostics</h1>
            <p className="dg-sub">Identify the vehicle, scan every system, work inside any of them. Whatever is found is kept — the next car of the same model opens already mapped.</p>
            <div className="dg-tiles">
              <button className="dg-tile hot" disabled={!!busy} onClick={() => void autoVin(null).then((b) => { if (b) open(b.profile, b.vin); })}>
                <span className="ico">🚗</span><span className="t">AUTO VIN</span><span className="d">Read the VIN from the connected car and identify it.</span>
                <span className="cnt">{online ? `via ${sd.info?.hostname ?? host}` : "needs the device connected"}</span>
              </button>
              <button className="dg-tile" onClick={() => { setNote(null); setStep({ s: "vin" }); }}>
                <span className="ico">⌨️</span><span className="t">MANUAL VIN</span><span className="d">Type a VIN — works without the car, for looking up what is on file.</span>
              </button>
              <button className="dg-tile" onClick={() => { setNote(null); setStep({ s: "make" }); }}>
                <span className="ico">🗂️</span><span className="t">SELECT VEHICLE</span><span className="d">Pick the make and model, then read the VIN to confirm.</span>
                <span className="cnt">{profiles.length} model{profiles.length === 1 ? "" : "s"} in the library</span>
              </button>
              <button className="dg-tile" onClick={() => { setNote(null); setStep({ s: "history" }); }}>
                <span className="ico">🕘</span><span className="t">VEHICLE HISTORY</span><span className="d">Cars that have been connected before, with their last scan.</span>
                <span className="cnt">{history.length} car{history.length === 1 ? "" : "s"}</span>
              </button>
            </div>
            {profile && (
              <>
                <div className="dg-cat">Continue</div>
                <button className="dg-item" onClick={() => setStep({ s: "vehicle", tab: "scan" })}>
                  <span className="main"><b>{ymmLabel(profile)}</b><small>{vin ? `VIN ${vin}` : "VIN not read"} · {addressedSystems(profile).length} systems{last ? ` · last scan ${new Date(last.at).toLocaleString()}` : ""}</small></span><span className="chev">›</span>
                </button>
              </>
            )}
          </>
        )}

        {step.s === "vin" && (
          <>
            <h1 className="dg-h">Manual VIN</h1>
            <p className="dg-sub">17 characters. It is decoded with the free NHTSA database and opened from the library — or filed as a new model.</p>
            <div className="dg-form">
              <input className="dg-in" style={{ width: 300, fontSize: 16, letterSpacing: ".08em" }} maxLength={17} placeholder="VIN" value={vinInput} autoFocus
                onChange={(e) => setVinInput(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter") void manualVin(); }} />
              <button className="primary" disabled={!!busy || vinInput.trim().length !== 17} onClick={() => void manualVin()}>Decode &amp; open</button>
              <span className="tiny dim">{vinInput.trim().length}/17</span>
            </div>
          </>
        )}

        {step.s === "make" && (
          <>
            <h1 className="dg-h">Select vehicle — make</h1>
            <p className="dg-sub">{pendingVin ? `VIN ${pendingVin} is waiting for a model. ` : ""}Makes with models already in your library are marked.</p>
            <div className="dg-brands">
              {makes.map((m) => (
                <button key={m.label} className={`dg-brand ${m.models ? "has" : ""}`} onClick={() => setStep({ s: "model", make: m.label })}>
                  {m.label}<small>{m.models ? `${m.models} model${m.models === 1 ? "" : "s"}${m.cars ? ` · ${m.cars} car${m.cars === 1 ? "" : "s"}` : ""}` : "none yet"}</small>
                </button>
              ))}
            </div>
            <div className="dg-form">
              <span className="tiny dim">Another make</span>
              <input className="dg-in" style={{ width: 220 }} placeholder="make" value={otherMake} onChange={(e) => setOtherMake(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && otherMake.trim()) setStep({ s: "model", make: otherMake.trim() }); }} />
              <button disabled={!otherMake.trim()} onClick={() => setStep({ s: "model", make: otherMake.trim() })}>Continue</button>
            </div>
          </>
        )}

        {step.s === "model" && (() => {
          const list = profiles.filter((x) => x.make.toLowerCase() === step.make.toLowerCase()).sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.model.localeCompare(b.model));
          return (
            <>
              <h1 className="dg-h">{step.make} — model</h1>
              <p className="dg-sub">{list.length ? "Models in your library. Each keeps its systems and what was learned about them." : `No ${step.make} in your library yet — add the model below, or just use AUTO VIN with the car connected.`}</p>
              <div className="dg-list">
                {list.map((x) => {
                  const sys = addressedSystems(x); const learned = sys.filter((m) => m.explored).length;
                  return (
                    <button key={x.id} className="dg-item" onClick={() => void pickModel(x)}>
                      <span className="main"><b>{x.year ?? "—"} {x.model}{x.trim ? <span className="dim" style={{ fontWeight: 400 }}> · {x.trim}</span> : null}</b>
                        <small>{sys.length} system{sys.length === 1 ? "" : "s"} known · {learned} learned · {x.knownVins?.length ?? 0} car{(x.knownVins?.length ?? 0) === 1 ? "" : "s"} seen{x.provenance?.source === "seed" && !(x.knownVins?.length) ? " · built-in starting map" : ""}</small></span>
                      <span className="chev">›</span>
                    </button>
                  );
                })}
              </div>
              <div className="dg-form">
                <span className="tiny dim">Add a model</span>
                <input className="dg-in" style={{ width: 90 }} placeholder="year" maxLength={4} value={newYear} onChange={(e) => setNewYear(e.target.value.replace(/\D/g, ""))} />
                <input className="dg-in" style={{ width: 240 }} placeholder="model, e.g. Camry" value={newModel} onChange={(e) => setNewModel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addModel(step.make); }} />
                <button disabled={!newModel.trim()} onClick={() => void addModel(step.make)}>Add &amp; open</button>
              </div>
            </>
          );
        })()}

        {step.s === "history" && (
          <>
            <h1 className="dg-h">Vehicle history</h1>
            <p className="dg-sub">Every car whose VIN has been read. Opening one shows its systems and last scan without the car being here.</p>
            {history.length === 0 && <div className="dg-empty">No car on file yet — AUTO VIN with a car connected files the first one.</div>}
            <div className="dg-list">
              {history.map(({ profile: x, unit }) => {
                const ls = unit.scans?.length ? unit.scans[unit.scans.length - 1] : null;
                const faults = ls ? ls.systems.filter((s: SystemScanResult) => s.status === "fault") : [];
                return (
                  <button key={x.id + unit.vin} className="dg-item" onClick={() => { setNote(null); open(x, unit.vin); }}>
                    <span className="main"><b>{ymmLabel(x)} <span className="mono dim" style={{ fontWeight: 400, fontSize: 12.5 }}>{unit.vin}</span></b>
                      <small>last connected {new Date(unit.lastReadAt).toLocaleString()} · {unit.reads} visit{unit.reads === 1 ? "" : "s"} · {ls ? (faults.length ? `last scan: ${faults.reduce((n, s) => n + s.dtcs.length, 0)} code(s) in ${faults.length} system(s)` : "last scan: no faults") : "never scanned"}</small></span>
                    {ls?.sim && <span className="dg-chip demo">VIRTUAL</span>}
                    {ls && <span className={`dg-st ${faults.length ? "fault" : "ok"}`}>{faults.length ? `Fault | ${faults.reduce((n, s) => n + s.dtcs.length, 0)}` : "No fault"}</span>}
                    <span className="chev">›</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step.s === "vehicle" && profile && (
          <VehicleHub
            host={host} iface={iface} online={online} demo={demo} simName={sim?.running ? (sim.name || sim.vehicle || "virtual vehicle") : null} profile={profile} vin={vin}
            tab={step.tab} onTab={(tab) => setStep({ s: "vehicle", tab })}
            rows={rows} setRows={setRows}
            saveProfile={saveProfile} adoptProfile={adoptProfile}
            ensureVin={async () => {
              const b = await autoVin(profile);
              if (b) { setProfileId(b.profile.id); setVin(b.vin); }
              return b;
            }}
            onEnter={(moduleId) => { setNote(null); setStep({ s: "system", moduleId, fn: null }); }}
          />
        )}

        {step.s === "system" && profile && mod && (
          <SystemPage
            host={host} iface={iface} online={online} demo={demo} profile={profile} module={mod} vin={vin}
            fn={step.fn} onFn={(fn) => setStep({ s: "system", moduleId: mod.id, fn })}
            last={(() => { const r = rows[mod.id]; return r && r !== "scanning" ? r : last?.systems.find((s) => s.moduleId === mod.id); })()}
            onModuleUpdate={(m) => void saveProfile({ ...profile, modules: profile.modules.map((y) => (y.id === m.id ? m : y)) })}
            onProfile={adoptProfile}
            onCodes={(r) => setRows((cur) => ({ ...cur, [mod.id]: r }))}
          />
        )}
      </div>
    </div>
  );
}
