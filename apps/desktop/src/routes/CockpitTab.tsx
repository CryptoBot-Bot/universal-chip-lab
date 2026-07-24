import { useEffect, useMemo, useRef, useState } from "react";

import {
  decodeVin, findProfileForVin, findProfileByYmm, recordVinRead, profileId, PIDS, moduleTemplateFor,
  type VehicleProfile, type VehicleCapability, type BodyType,
} from "@ecu/vehicle-db";

import { CarScene, type SceneModule } from "../components/CarScene";
import { DeviceSettings } from "../components/DeviceSettings";
import { SetupWizard } from "../components/SetupWizard";
import { VehicleDeepMap } from "../components/VehicleDeepMap";
import { VirtualVehiclePanel } from "../components/VirtualVehiclePanel";
import { ModuleInspector } from "../components/ModuleInspector";
import { Topbar } from "../components/Topbar";
import { WriteConfirmModal } from "../components/WriteConfirmModal";
import type { PendingWrite } from "../lib/writeActions";
import { Api, type SuperDeviceStatus, type SuperDeviceIface, type DiscoveredDevice } from "../lib/api";
import { useSuperDevice } from "../lib/superdevice-connection";
import { VehicleSimulator, type SimScenario, type SimReading } from "../lib/vehicleSim";

/**
 * Vehicle Cockpit — the single cockpit for BOTH a simulated car and the real
 * SuperDevice (Raspberry Pi 5 + isolated dual CAN-FD). Pick a data source at the
 * top: SIMULATOR (type a VIN, no hardware) or REAL (connect to the Pi, then read
 * the vehicle's VIN off the bus). Either way you land in the same 3D cockpit,
 * driven by the self-growing vehicle library.
 */

const DEFAULT_VIN = "JTDEPRAE0LJ012345"; // 2020 Toyota (JTD, pos-10 L) — matches the seed
const DEFAULT_HOST = "superdevice.local:8080";
const BODY_TYPES: BodyType[] = ["sedan", "suv", "truck", "van", "minivan", "hatchback", "coupe", "wagon"];
const SCENARIOS: { id: SimScenario; label: string }[] = [
  { id: "off", label: "Ignition off" },
  { id: "idle", label: "Idle" },
  { id: "drive", label: "Driving" },
  { id: "rev", label: "Rev" },
];

type Mode = "simulator" | "real";
type LinkState = "idle" | "connecting" | "online" | "error";

const BITRATES: { v: number; label: string }[] = [
  { v: 125000, label: "125k" }, { v: 250000, label: "250k" },
  { v: 500000, label: "500k" }, { v: 1000000, label: "1M" },
];

interface BusPref { bitrate: number; fd: boolean }
interface CockpitPrefs { mode: Mode; host: string; bus: Record<string, BusPref> }
const PREFS_KEY = "cockpit.prefs.v2";
const DEFAULT_PREFS: CockpitPrefs = {
  mode: "simulator", host: DEFAULT_HOST,
  bus: { can0: { bitrate: 500000, fd: false }, can1: { bitrate: 125000, fd: false } }, // MS-CAN (3/11) = 125k
};
function loadPrefs(): CockpitPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return { ...DEFAULT_PREFS, ...raw, bus: { ...DEFAULT_PREFS.bus, ...(raw.bus || {}) } };
  } catch { return DEFAULT_PREFS; }
}
function persistPrefs(patch: Partial<CockpitPrefs>) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch })); } catch { /* ignore */ }
}

export function CockpitTab() {
  const [mode, setMode] = useState<Mode>("simulator");
  const [vin, setVin] = useState(DEFAULT_VIN);
  const [profiles, setProfiles] = useState<VehicleProfile[]>([]);
  const [selected, setSelected] = useState<VehicleProfile | null>(null);
  const [identified, setIdentified] = useState(false);
  const [inLibrary, setInLibrary] = useState<boolean | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [scenario, setScenario] = useState<SimScenario>("off");
  const [gauges, setGauges] = useState<SimReading[]>([]);
  const [capResult, setCapResult] = useState<string | null>(null);
  const [pendingCap, setPendingCap] = useState<VehicleCapability | null>(null);
  const [stubBody, setStubBody] = useState<BodyType>("sedan");
  const [stubModel, setStubModel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  // --- REAL: SuperDevice link (backed by the app-wide shared connection) ---
  const sd = useSuperDevice();
  const [piHost, setPiHost] = useState(DEFAULT_HOST);
  const [link, setLink] = useState<LinkState>("idle");
  const [pi, setPi] = useState<SuperDeviceStatus | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [vinReading, setVinReading] = useState(false);
  const [vinPending, setVinPending] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [vinInsight, setVinInsight] = useState<{
    inGarage: boolean; garageYmm?: string; shopName?: string;
    profileKnown: boolean; ymmLabel?: string; exploredModules: number;
    vinSeenBefore: boolean; lastReadAt?: string;
  } | null>(null);
  const [showDevice, setShowDevice] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredDevice[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busPref, setBusPref] = useState<Record<string, BusPref>>(DEFAULT_PREFS.bus);
  const [rxRate, setRxRate] = useState<Record<string, number>>({});
  const [rxHist, setRxHist] = useState<Record<string, number[]>>({});
  const prevRxRef = useRef<Record<string, { rx: number; t: number }>>({});

  const simRef = useRef<VehicleSimulator | null>(null);
  const running = scenario !== "off";

  useEffect(() => { void refreshLibrary(); }, []);

  async function refreshLibrary() {
    try { setProfiles(await Api.vehicleLib.list()); } catch (e) { setMsg((e as Error).message); }
  }

  function identifyWith(v: string) {
    const d = decodeVin(v);
    const prof = findProfileForVin(profiles, d.vin, d.wmi, d.make, d.year);
    setIdentified(true);
    setSelectedModuleId(null);
    setCapResult(null);
    setScenario("off");
    if (prof) { setSelected(prof); setInLibrary(true); }
    else { setSelected(null); setInLibrary(false); setStubModel(""); }
  }


  // load saved prefs + auto-connect if we were on REAL and nothing is connected yet
  useEffect(() => {
    const p = loadPrefs();
    setMode(p.mode);
    setPiHost(p.host);
    setBusPref(p.bus);
    if ((p.mode === "real" || p.mode === "simulator") && p.host && sd.link !== "online" && sd.link !== "connecting") void connectPi(p.host);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // adopt the app-wide connection: if the app is already linked to a Pi
  // (connected from Pi Devices / Bench / a previous session), show it ONLINE
  // here instantly instead of starting from offline.
  useEffect(() => {
    if (sd.link === "online" && link !== "online") {
      setPiHost(sd.host);
      setPi(sd.status);
      setLink("online");
      setMode((m) => (m === "simulator" ? "simulator" : "real"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sd.link, sd.host]);

  function chooseMode(m: Mode) { setMode(m); persistPrefs({ mode: m }); }

  // ---- SuperDevice connection (routes through the shared app-wide link) ----
  async function connectPi(host = piHost) {
    setLink("connecting");
    setLinkErr(null);
    setPi(null);
    prevRxRef.current = {};
    const r = await sd.connect(host);
    if (r.ok) {
      setLink("online");
      persistPrefs({ host });
      // the 1.5 s health poll below fills `pi` immediately after link flips
    } else {
      setLinkErr(r.error ?? "connect failed");
      setLink("error");
    }
  }

  async function toggleBus(iface: string, up: boolean) {
    const pref = busPref[iface] ?? { bitrate: 500000, fd: false };
    try {
      if (up) await Api.superDevice.setUp(piHost, iface, pref.bitrate, pref.fd);
      else await Api.superDevice.setDown(piHost, iface);
      setPi(await Api.superDevice.status(piHost));
    } catch (e) { setMsg((e as Error).message); }
  }

  function updateBusPref(iface: string, patch: Partial<BusPref>) {
    setBusPref((prev) => {
      const next = { ...prev, [iface]: { ...(prev[iface] ?? { bitrate: 500000, fd: false }), ...patch } };
      persistPrefs({ bus: next });
      if (pi?.ifaces.find((i) => i.name === iface)?.up) {
        // re-apply live if the bus is currently up
        void Api.superDevice.setUp(piHost, iface, next[iface].bitrate, next[iface].fd)
          .then(() => Api.superDevice.status(piHost)).then(setPi).catch(() => undefined);
      }
      return next;
    });
  }

  function disconnectPi() {
    setLink("idle");
    setPi(null);
    setLinkErr(null);
    void sd.disconnect(); // releases the claim app-wide, not just in this tab
  }

  async function scanNetwork() {
    setScanning(true); setDiscovered(null); setLinkErr(null);
    try { setDiscovered(await Api.superDevice.discover()); }
    catch (e) { setLinkErr((e as Error).message); }
    finally { setScanning(false); }
  }

  // keep device health live + compute per-bus RX rate (frames/s) while online
  useEffect(() => {
    if ((mode !== "real" && mode !== "simulator") || link !== "online") return;
    const poll = async () => {
      try {
        const st = await Api.superDevice.status(piHost);
        setPi(st);
        const now = Date.now();
        const rates: Record<string, number> = {};
        for (const i of st.ifaces) {
          const prev = prevRxRef.current[i.name];
          const rx = i.rx ?? 0;
          if (prev && i.up) {
            const dt = (now - prev.t) / 1000;
            rates[i.name] = dt > 0 ? Math.max(0, Math.round((rx - prev.rx) / dt)) : 0;
          } else {
            rates[i.name] = 0;
          }
          prevRxRef.current[i.name] = { rx, t: now };
        }
        setRxRate(rates);
        setRxHist((h) => {
          const nh = { ...h };
          for (const i of st.ifaces) nh[i.name] = (nh[i.name] ?? []).concat(rates[i.name] ?? 0).slice(-24);
          return nh;
        });
      } catch { setLink("error"); setLinkErr("Lost connection to the SuperDevice."); }
    };
    void poll();
    const iv = setInterval(poll, 1500);
    return () => clearInterval(iv);
  }, [mode, link, piHost]);

  // Step ①: read the VIN off the live bus. Doesn't decode/save yet — that's the
  // explicit "Decode & add to Garage" step so the operator confirms it.
  async function readRealVin() {
    setVinReading(true);
    setMsg(null);
    setVinPending(false);
    setVinInsight(null);
    try {
      const r = await Api.superDevice.readVin(piHost);
      if (!(r.ok && r.vin)) {
        setMsg(`No VIN from the vehicle${r.error ? ` — ${r.error}` : ""}. Check the ignition is on and the ECM is responding.`);
        return;
      }
      setVin(r.vin);
      identifyWith(r.vin);
      setVinPending(true);
      setMsg(`VIN read from the vehicle: ${r.vin}`);
      // Immediately tell the operator what we already know about this VIN/YMM:
      // is it in the shop garage, and have we mapped this Year/Make/Model before?
      void buildVinInsight(r.vin).then(setVinInsight).catch(() => setVinInsight(null));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setVinReading(false);
    }
  }

  /** Look up what we already hold for a just-read VIN — shop garage presence and
   * local Chip Lab knowledge (mapped modules + whether we've read this exact VIN). */
  async function buildVinInsight(vinStr: string) {
    const up = vinStr.toUpperCase();
    const d = decodeVin(vinStr);
    const profile = findProfileForVin(profiles, vinStr, d.wmi, d.make, d.year);
    const seen = profile?.knownVins?.find((v) => v.vin === up);
    const exploredModules = profile ? profile.modules.filter((m) => m.explored).length : 0;

    let inGarage = false; let garageYmm: string | undefined; let shopName: string | undefined;
    try {
      const jc = await Api.jobcount.status();
      if (jc.linked) {
        shopName = jc.shopName ?? undefined;
        const g = await Api.jobcount.listGarage(vinStr);
        const hit = g.vehicles.find((v) => (v.vin || "").toUpperCase() === up);
        if (hit) { inGarage = true; garageYmm = [hit.year, hit.make, hit.model].filter(Boolean).join(" "); }
      }
    } catch { /* shop offline — skip garage check */ }

    return {
      inGarage, garageYmm, shopName,
      profileKnown: !!profile,
      ymmLabel: profile ? `${profile.year ?? ""} ${profile.make} ${profile.model}`.trim() : undefined,
      exploredModules,
      vinSeenBefore: !!seen,
      lastReadAt: seen?.lastReadAt,
    };
  }

  // Step ②: decode the VIN, add the vehicle to the linked shop garage, and file
  // it into the self-growing library. Returns a success line the UI shows.
  async function decodeAndAddToGarage() {
    if (!vin) return;
    setDecoding(true);
    setMsg(null);
    const parts: string[] = [];
    try {
      let resolved: { year: number | null; make: string; model: string } | null = null;
      const jc = await Api.jobcount.status();
      if (jc.linked) {
        const d = decodeVin(vin);
        const push = await Api.jobcount.pushVehicle({ vin, year: d.year, make: d.make ?? undefined });
        if (push.vehicle.make) resolved = { year: push.vehicle.year, make: push.vehicle.make, model: push.vehicle.model };
        const ymm = [push.vehicle.year, push.vehicle.make, push.vehicle.model].filter(Boolean).join(" ");
        parts.push(push.created ? `✓ Added to ${jc.shopName} garage — ${ymm}` : `✓ Already in ${jc.shopName} garage — ${ymm}`);
      } else {
        parts.push("Not linked to a shop — saved locally only (link one in Settings to sync the garage).");
      }

      const grew = await growLibraryWithVin(vin, resolved);
      if (grew) parts.push(grew);

      setVinPending(false);
      setMsg(parts.join(" · "));
    } catch (e) {
      setMsg(`Decode/add failed — ${(e as Error).message}`);
    } finally {
      setDecoding(false);
    }
  }

  /**
   * Record a real VIN read into the self-growing library. Finds the matching
   * Year/Make/Model profile (by VIN/WMI, or by YMM once JobCount resolves the
   * model) and appends the VIN to its knownVins — the profile is "the decoded
   * car", the VINs are the individual units. Creates the YMM profile on first
   * sight when we have a model to name it. Returns a human status, or null when
   * there's nothing to grow yet (no model known and no existing match).
   */
  async function growLibraryWithVin(
    vinStr: string,
    resolved: { year: number | null; make: string; model: string } | null,
  ): Promise<string | null> {
    const d = decodeVin(vinStr);
    const now = new Date().toISOString();
    let match = findProfileForVin(profiles, vinStr, d.wmi, d.make, d.year);
    if (!match && resolved?.model) match = findProfileByYmm(profiles, resolved.year, resolved.make, resolved.model);

    if (match) {
      const { profile, vinIsNew } = recordVinRead(match, vinStr, now);
      const list = await Api.vehicleLib.save(profile);
      setProfiles(list);
      const n = profile.knownVins?.length ?? 0;
      const name = `${profile.year ?? ""} ${profile.make} ${profile.model}`.trim();
      return vinIsNew
        ? `filed under "${name}" (${n} VIN${n === 1 ? "" : "s"} on file)`
        : `already on file under "${name}"`;
    }

    // No match — only auto-create when we have a real model to name it by
    // (JobCount's decode). Otherwise leave the manual "Add to library" path.
    if (resolved?.model) {
      const year = resolved.year ?? d.year;
      const make = resolved.make || d.make || "Unknown";
      const model = resolved.model;
      const stub: VehicleProfile = {
        id: profileId(year, make, model),
        year, make, model, bodyType: (d.bodyTypeHint as BodyType) || "sedan",
        wmi: d.wmi ? [d.wmi] : [],
        buses: [{ id: "hs-can", label: "HS-CAN", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
        modules: [
          { id: "ecm", label: "Engine Control Module", category: "powertrain", bus: "hs-can", location: "engine", addressing: { request: "7E0", response: "7E8" } },
        ],
        supportedPids: PIDS.map((p) => p.pid),
        capabilities: [
          { id: "live-data", label: "Live engine data", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["01 0C", "01 0D", "01 05"] },
          { id: "read-dtcs", label: "Read stored DTCs", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["03"] },
          { id: "read-vin", label: "Read VIN", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["09 02"] },
        ],
        notes: "Auto-created from an OBD VIN read — enrich by mapping this bus in the AI Training Room.",
        provenance: { source: "vin_decoded", confidence: 0.4, createdAt: now, observedOn: vinStr },
      };
      const { profile } = recordVinRead(stub, vinStr, now);
      const list = await Api.vehicleLib.save(profile);
      setProfiles(list);
      setSelected(profile);
      setInLibrary(true);
      return `new vehicle "${`${year ?? ""} ${make} ${model}`.trim()}" added to your library (1 VIN on file)`;
    }
    return null;
  }

  // (Re)build the simulator whenever the loaded profile changes.
  useEffect(() => {
    if (!selected) { simRef.current = null; setGauges([]); return; }
    const sim = new VehicleSimulator(selected);
    simRef.current = sim;
    setGauges(sim.readings());
    const iv = setInterval(() => { sim.step(100); setGauges(sim.readings()); }, 100);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => { simRef.current?.setScenario(scenario); }, [scenario]);

  const sceneModules: SceneModule[] = useMemo(
    () => (selected?.modules ?? []).map((m) => ({
      id: m.id, label: m.label, category: m.category, location: m.location, online: running,
    })),
    [selected, running],
  );

  function reading(pid: number): SimReading | undefined {
    return gauges.find((g) => g.pid === pid);
  }

  function runCap(cap: VehicleCapability) {
    const sim = simRef.current;
    if (!sim) return;
    if (cap.risk !== "read") { setPendingCap(cap); return; }
    const tokens = (cap.sequence[0] ?? "").split(/\s+/).filter(Boolean).map((t) => parseInt(t, 16));
    if (!tokens.length) return;
    const res = sim.query(tokens[0], tokens[1]);
    setCapResult(`${cap.label} → ${res.text}`);
  }

  function confirmCap() {
    if (!pendingCap) return;
    setCapResult(`✿ SIMULATED — ${pendingCap.label}: positive response. (Real hardware routes through the Cloning Ceremony.)`);
    setPendingCap(null);
  }

  const capPending: PendingWrite | null = pendingCap
    ? {
        moduleLabel: `${selected?.make ?? ""} ${selected?.model ?? ""}`.trim() || "Vehicle",
        label: pendingCap.label,
        request: pendingCap.sequence[0] ?? "",
        kind: /clear/i.test(pendingCap.id) ? "clear" : "write",
        risk: pendingCap.risk,
        note: pendingCap.note,
      }
    : null;

  async function saveStub() {
    const d = decodeVin(vin);
    const model = stubModel.trim() || "Unknown";
    const stub: VehicleProfile = {
      id: profileId(d.year, d.make ?? "Unknown", model),
      year: d.year, make: d.make ?? "Unknown", model, bodyType: stubBody,
      wmi: d.wmi ? [d.wmi] : [],
      buses: [{ id: "hs-can", label: "HS-CAN", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
      modules: [
        { id: "ecm", label: "Engine Control Module", category: "powertrain", bus: "hs-can", location: "engine", addressing: { request: "7E0", response: "7E8" } },
      ],
      supportedPids: PIDS.map((p) => p.pid),
      capabilities: [
        { id: "live-data", label: "Live engine data", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["01 0C", "01 0D", "01 05"] },
        { id: "read-dtcs", label: "Read stored DTCs", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["03"] },
        { id: "read-vin", label: "Read VIN", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["09 02"] },
      ],
      notes: "Created from VIN decode — enrich by mapping this bus with AI in the AI Training Room.",
      provenance: { source: "vin_decoded", confidence: 0.4, createdAt: new Date().toISOString() },
    };
    try {
      const list = await Api.vehicleLib.save(stub);
      setProfiles(list);
      setSelected(stub);
      setInLibrary(true);
      setMsg(`Saved "${d.year ?? ""} ${d.make ?? ""} ${model}" to your library — it now grows the DB.`);
    } catch (e) { setMsg((e as Error).message); }
  }

  const rpm = reading(0x0c);
  const speed = reading(0x0d);
  const otherGauges = gauges.filter((g) => g.pid !== 0x0c && g.pid !== 0x0d);
  const canUp = pi?.ifaces.filter((i) => i.up).length ?? 0;
  const upIface = pi?.ifaces.find((i) => i.up)?.name ?? "can0";

  return (
    <>
      <Topbar title="Vehicle Cockpit" crumb={selected ? `${selected.year} ${selected.make} ${selected.model}` : mode === "real" ? "connect the SuperDevice" : "identify a vehicle"} />
      <div className="content">
        <div className="cp">
      <style>{styles}</style>

      <header className="cp-head">
        <div>
          <h2>Vehicle Cockpit <span className="tiny dim">— {profiles.length} vehicle{profiles.length === 1 ? "" : "s"} in your self-growing library</span></h2>
          <p className="tiny dim">One cockpit for the bench simulator and the real car. Pick a source, identify the vehicle, and its whole map loads instantly.</p>
        </div>
      </header>

      {/* DATA SOURCE CHOOSER */}
      <div className="cp-mode">
        <button className={`cp-mode-btn ${mode === "real" ? "active real" : ""}`} onClick={() => chooseMode("real")}>
          <span className="cp-mode-ic">🛰️</span>
          <span className="cp-mode-txt"><b>REAL VEHICLE</b><small>connect to the SuperDevice & read the live bus</small></span>
          {mode === "real" && <span className={`cp-mode-live ${link === "online" ? "on" : ""}`}>{link === "online" ? "ONLINE" : "SELECTED"}</span>}
        </button>
        <button className={`cp-mode-btn ${mode === "simulator" ? "active sim" : ""}`} onClick={() => chooseMode("simulator")}>
          <span className="cp-mode-ic">🧪</span>
          <span className="cp-mode-txt"><b>SIMULATOR</b><small>full simulated car on CAN1 → read it on CAN0</small></span>
          {mode === "simulator" && <span className={`cp-mode-live sim ${link === "online" ? "on" : ""}`}>{link === "online" ? "ONLINE" : "SELECTED"}</span>}
        </button>
      </div>

      {/* SOURCE PANEL — simulator drives a virtual car on CAN1, then reads it
          on CAN0 through the SAME pipeline as a real vehicle. */}
      {mode === "simulator" && <VirtualVehiclePanel host={piHost} />}
      {(
        <div className={`cp-link card ${link}`}>
          {link !== "online" && (
            <div className="cp-link-head">
              <div className="cp-link-orb" data-state={link}>
                <span className="cp-orb-core" />
                <span className="cp-orb-ring" />
                <span className="cp-orb-ring r2" />
              </div>
              <div className="cp-link-title">
                <b>SuperDevice</b>
                <small className="dim">
                  {link === "idle" && "Raspberry Pi 5 · dual isolated CAN-FD"}
                  {link === "connecting" && "Locating device · handshaking · reading health…"}
                  {link === "error" && "Connection failed"}
                </small>
              </div>
            </div>
          )}

          {(link === "idle" || link === "error") && (
            <div className="cp-link-connect">
              <div className="cp-host">
                <label className="tiny dim">Host</label>
                <input className="mono" value={piHost} onChange={(e) => setPiHost(e.target.value)} placeholder="superdevice.local:8080" />
              </div>
              <button className="primary cp-connect-btn" onClick={() => void connectPi()}>Connect</button>
              {link === "error" && linkErr && <div className="cp-link-err">{linkErr}</div>}

              <div className="cp-link-actions">
                <button className="tiny" disabled={scanning} onClick={() => void scanNetwork()}>{scanning ? "Scanning network…" : "🔍 Scan network"}</button>
                <button className="tiny" onClick={() => setShowSetup(true)}>📶 Set up new device / WiFi</button>
              </div>

              {discovered && (
                <div className="cp-found">
                  {discovered.length === 0 && <p className="tiny dim">No SuperDevices found on this network. If it's brand new or in a shop, use <b>Set up new device</b>.</p>}
                  {discovered.map((d) => (
                    <button key={d.host} className="cp-found-item" onClick={() => { setPiHost(d.host); persistPrefs({ host: d.host }); void connectPi(d.host); }}>
                      <span className="cp-found-name">{d.hostname}</span>
                      <span className="tiny dim mono">{d.ip}</span>
                      <span className="tiny dim">{d.model.replace("Raspberry Pi ", "Pi ")}</span>
                      <span className="cp-found-go">Connect →</span>
                    </button>
                  ))}
                </div>
              )}

              {link === "idle" && !discovered && <p className="tiny dim">Powered from the OBD-II cable. Make sure the Pi is on and on your network — or <b>Scan</b> to find it.</p>}
            </div>
          )}

          {link === "connecting" && (
            <div className="cp-link-scan">
              <div className="cp-scanline" />
              <ul className="cp-steps tiny mono">
                <li className="done">▸ resolving {piHost.split(":")[0]}</li>
                <li className="done">▸ opening control channel</li>
                <li className="active">▸ reading device health…</li>
              </ul>
            </div>
          )}

          {link === "online" && pi && (
            <div className="cp-online">
              <div className="cp-online-head">
                <div className="cp-online-id">
                  <span className="cp-online-dot" />
                  <div>
                    <b>SuperDevice ONLINE</b>
                    <small className="dim mono"> {piHost}</small>
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="tiny" onClick={() => setShowDevice(true)}>⚙ Device</button>
                  <button className="tiny" onClick={disconnectPi}>Disconnect</button>
                </div>
              </div>

              <div className="cp-health">
                <Health k="Board" v={(pi.sys.model || "Pi").replace("Raspberry Pi ", "Pi ")} />
                <Health k="Kernel" v={pi.sys.kernel} />
                <Health k="Temp" v={pi.sys.temp != null ? `${pi.sys.temp}°C` : "—"} tone={pi.sys.temp && pi.sys.temp > 70 ? "warn" : "ok"} />
                <Health k="Load" v={pi.sys.load} />
                <Health k="Uptime" v={(pi.sys.uptime || "").replace("up ", "")} />
                <Health k="Buses up" v={`${canUp}/${pi.ifaces.length}`} tone={canUp > 0 ? "ok" : "warn"} />
              </div>

              <div className="cp-buses">
                {pi.ifaces.map((i) => (
                  <BusCard
                    key={i.name}
                    iface={i}
                    pref={busPref[i.name] ?? { bitrate: i.bitrate || 500000, fd: !!i.fd }}
                    rate={rxRate[i.name] ?? 0}
                    hist={rxHist[i.name] ?? []}
                    onToggle={(up) => void toggleBus(i.name, up)}
                    onBitrate={(v) => updateBusPref(i.name, { bitrate: v })}
                    onFd={(fd) => updateBusPref(i.name, { fd })}
                  />
                ))}
                <div className="cp-bus-add">+ K-Line, MS-CAN &amp; more<br /><span className="tiny dim">pods land here</span></div>
              </div>

              <div className="cp-vinrow">
                <button className="primary cp-vin-btn" onClick={() => void readRealVin()} disabled={vinReading || canUp === 0}>
                  {vinReading ? "Reading VIN…" : "① Read VIN from vehicle"}
                </button>
                {canUp === 0 && <span className="tiny warn">Bring a bus UP first (in the SuperDevice panel / web UI).</span>}
                {vin && identified && <span className="cp-vin-got mono">VIN {vin}</span>}
              </div>
              <p className="tiny dim">Reads OBD-II mode 09 from the ECM over the live bus, then identifies the vehicle in your library — or offers to map it.</p>
              {vinInsight && (
                <div className="cp-insight-card">
                  <div className="cp-insight-row">
                    {vinInsight.inGarage
                      ? <span className="badge ok">✓ VIN already in {vinInsight.shopName || "the shop"} garage{vinInsight.garageYmm ? ` — ${vinInsight.garageYmm}` : ""}</span>
                      : vinInsight.shopName
                        ? <span className="badge">new to the {vinInsight.shopName} garage</span>
                        : <span className="badge dim">shop not linked</span>}
                  </div>
                  <div className="cp-insight-row tiny">
                    {vinInsight.profileKnown ? (
                      <>
                        <span>🧠 We already know this YMM: <b>{vinInsight.ymmLabel}</b>{" "}
                          {vinInsight.exploredModules > 0
                            ? <span className="cp-known">— {vinInsight.exploredModules} module{vinInsight.exploredModules === 1 ? "" : "s"} mapped, we know how to talk to it.</span>
                            : <span className="dim">— in your library but not deep-mapped yet.</span>}
                        </span>
                      </>
                    ) : (
                      <span className="dim">New Year/Make/Model — not in your Chip Lab library yet.</span>
                    )}
                  </div>
                  {vinInsight.vinSeenBefore && vinInsight.lastReadAt && (
                    <div className="cp-insight-row tiny dim">You last read this exact VIN on {new Date(vinInsight.lastReadAt).toLocaleString()}.</div>
                  )}
                </div>
              )}

              {vinPending && (
                <div className="cp-decode-card">
                  <span className="tiny">
                    {vinInsight?.inGarage
                      ? <>Already in the garage — re-file it locally and refresh?</>
                      : <>VIN <b className="mono">{vin}</b> read. Decode it, add it to your shop garage, and save it to the library?</>}
                  </span>
                  <button className="primary" onClick={() => void decodeAndAddToGarage()} disabled={decoding}>
                    {decoding ? "Decoding & adding…" : vinInsight?.inGarage ? "② Re-decode & refresh" : "② Decode VIN & add to Garage"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {msg && <div className="cp-msg">{msg}</div>}

      {identified && inLibrary === false && (
        <div className="card cp-miss">
          <strong>Not in your library yet.</strong>
          <p className="tiny dim">This is a new vehicle — save it so the library grows. You can enrich the map later with AI in the AI Training Room.</p>
          <div className="cp-miss-row">
            <input className="cp-model" placeholder="Model (e.g. Camry)" value={stubModel} onChange={(e) => setStubModel(e.target.value)} />
            <select className="cp-select" value={stubBody} onChange={(e) => setStubBody(e.target.value as BodyType)}>
              {BODY_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <button className="primary" onClick={() => void saveStub()}>Save to library</button>
          </div>
        </div>
      )}

      {selected && (
        <>
          {(mode === "real" || mode === "simulator") && (
            <div className="cp-realnote tiny">
              {mode === "simulator"
                ? <>🧪 <b>Simulated vehicle.</b> Reading the virtual car on CAN0 — the map, discovery and AI deep-map run exactly as on a real vehicle.</>
                : <>🛰️ <b>Live vehicle.</b> Structure &amp; modules are loaded from the library for <b>{selected.year} {selected.make} {selected.model}</b>. Gauges below are a simulated preview — live telemetry streaming from the Pi is the next build step.</>}
            </div>
          )}

          {(mode === "real" || mode === "simulator") && link === "online" && (
            <VehicleDeepMap
              host={piHost}
              iface={mode === "simulator" ? "can0" : upIface}
              profile={selected}
              onProfileUpdate={(p) => { setSelected(p); setProfiles((list) => list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]); }}
            />
          )}
        <div className="cp-grid">
          <div className="card cp-stage">
            <div className="cp-stage-head">
              <div>
                <span className="cp-badge ok">{mode === "real" ? "LIVE · MAP LOADED" : "IN LIBRARY · MAP LOADED"}</span>
                <h3>{selected.year} {selected.make} {selected.model} <span className="tiny dim">· {selected.bodyType}</span></h3>
              </div>
              <div className="seg tiny">
                {SCENARIOS.map((s) => (
                  <button key={s.id} className={scenario === s.id ? "active" : ""} onClick={() => setScenario(s.id)}>{s.label}</button>
                ))}
              </div>
            </div>
            <div className="cp-canvas">
              <CarScene bodyType={selected.bodyType} modules={sceneModules} selectedId={selectedModuleId} running={running} onSelect={setSelectedModuleId} />
              <div className="cp-sim-tag">{mode === "real" ? (running ? "◉ PREVIEW (sim telemetry)" : "○ pick a scenario to preview") : (running ? "◉ SIMULATOR LIVE" : "○ simulator idle — pick a scenario")}</div>
            </div>
          </div>

          <div className="cp-side">
            <div className="card cp-cluster">
              <div className="cp-big">
                <Big label="RPM" value={rpm ? Math.round(rpm.value) : 0} max={7000} unit="" />
                <Big label="Speed" value={speed ? Math.round(speed.value) : 0} max={180} unit="km/h" />
              </div>
              <div className="cp-gauges">
                {otherGauges.map((g) => (
                  <div className="cp-g" key={g.pid}>
                    <div className="cp-g-k">{g.name}</div>
                    <div className="cp-g-v mono">{g.value.toFixed(g.unit === "V" ? 1 : 0)}<span className="cp-g-u"> {g.unit}</span></div>
                  </div>
                ))}
                {!gauges.length && <div className="tiny dim">Pick a scenario to bring the bus alive.</div>}
              </div>
            </div>

            <div className="card">
              <h4>Modules <span className="tiny dim">— {selected.modules.length} known · click to highlight</span></h4>
              <div className="cp-mods">
                {selected.modules.map((m) => (
                  <button key={m.id} className={`cp-mod ${selectedModuleId === m.id ? "sel" : ""}`} onClick={() => setSelectedModuleId(m.id)}>
                    <span className={`cp-dot ${running ? "on" : ""}`} data-cat={m.category} />
                    <span className="cp-mod-label">{m.label}</span>
                    <span className="tiny dim mono">{m.addressing?.request ?? "—"}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="card">
              <h4>What we can do here</h4>
              <div className="cp-caps">
                {selected.capabilities.map((c) => (
                  <div className="cp-cap" key={c.id}>
                    <div className="cp-cap-main">
                      <span className="cp-cap-label">{c.label}</span>
                      <span className={`cp-risk ${c.risk}`}>{c.risk}</span>
                    </div>
                    <button className="tiny" disabled={!running && c.risk === "read"} onClick={() => runCap(c)}>
                      {c.risk === "read" ? "Run" : "⚠ Run…"}
                    </button>
                  </div>
                ))}
              </div>
              {capResult && <div className="cp-cap-result mono">{capResult}</div>}
            </div>
          </div>
        </div>
        </>
      )}

      {selected && selectedModuleId && (() => {
        const mod = selected.modules.find((m) => m.id === selectedModuleId);
        if (!mod) return null;
        return (
          <ModuleInspector
            module={mod}
            template={moduleTemplateFor(mod.id, mod.category)}
            sim={simRef.current}
            running={running}
            onClose={() => setSelectedModuleId(null)}
          />
        );
      })()}

      {!selected && !identified && mode === "simulator" && (
        <div className="card cp-empty">
          <p className="dim">Enter a VIN and hit <strong>Identify vehicle</strong>. Try the seeded flagship — the default VIN is a 2020 Toyota Corolla.</p>
        </div>
      )}

      {showDevice && link === "online" && (
        <DeviceSettings
          host={piHost}
          onClose={() => setShowDevice(false)}
          onHostChange={(h) => { setPiHost(h); persistPrefs({ host: h }); void connectPi(h); }}
        />
      )}

      {showSetup && (
        <SetupWizard onClose={() => setShowSetup(false)} onDone={() => { setShowSetup(false); void scanNetwork(); }} />
      )}

      <WriteConfirmModal pending={capPending} onCancel={() => setPendingCap(null)} onConfirm={confirmCap} />
        </div>
      </div>
    </>
  );
}

function Health({ k, v, tone }: { k: string; v: string | number; tone?: "ok" | "warn" }) {
  return (
    <div className="cp-hcell">
      <div className="cp-hk">{k}</div>
      <div className={`cp-hv mono ${tone ?? ""}`}>{v}</div>
    </div>
  );
}

function BusCard({ iface, pref, rate, hist, onToggle, onBitrate, onFd }: {
  iface: SuperDeviceIface; pref: BusPref; rate: number; hist: number[];
  onToggle: (up: boolean) => void; onBitrate: (v: number) => void; onFd: (fd: boolean) => void;
}) {
  const up = !!iface.up;
  const live = up && rate > 0;
  const maxR = Math.max(20, ...hist);
  return (
    <div className={`cp-bus2 ${up ? "up" : "down"} ${live ? "live" : ""}`}>
      <div className="cp-bus2-top">
        <div className="cp-bus2-id">
          <span className="cp-bus2-name mono">{iface.name}</span>
          <span className="cp-bus2-role">{iface.role ?? ""}</span>
        </div>
        <button className={`cp-switch ${up ? "on" : ""}`} onClick={() => onToggle(!up)} title={up ? "Bring bus down" : "Bring bus up"}>
          <span className="cp-switch-knob" />
          <span className="cp-switch-txt">{up ? "UP" : "DOWN"}</span>
        </button>
      </div>

      <div className="cp-bus2-activity">
        <div className="cp-spark">
          {Array.from({ length: 24 }).map((_, i) => {
            const v = hist[hist.length - 24 + i] ?? 0;
            return <span key={i} style={{ height: `${up ? Math.max(4, (v / maxR) * 100) : 2}%` }} />;
          })}
        </div>
        <div className={`cp-rate ${live ? "on" : ""}`}>
          {up ? (
            <><span className="cp-rate-dot" /><span className="cp-rate-n mono">{rate}</span><span className="cp-rate-u">fr/s</span></>
          ) : <span className="tiny dim">down</span>}
        </div>
      </div>

      <div className="cp-bus2-ctl">
        <select className="cp-br mono" value={pref.bitrate} onChange={(e) => onBitrate(Number(e.target.value))} title="Bus speed">
          {BITRATES.map((b) => <option key={b.v} value={b.v}>{b.label}</option>)}
        </select>
        <label className="cp-fd tiny" title="CAN-FD"><input type="checkbox" checked={pref.fd} onChange={(e) => onFd(e.target.checked)} /> FD</label>
        <span className="tiny dim mono">rx {(iface.rx ?? 0).toLocaleString()}</span>
      </div>
    </div>
  );
}

function Big({ label, value, max, unit }: { label: string; value: number; max: number; unit: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="cp-bigtile">
      <div className="cp-big-k">{label}</div>
      <div className="cp-big-v mono">{value}<span className="cp-big-u"> {unit}</span></div>
      <div className="cp-big-bar"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

const styles = `
.cp { display: flex; flex-direction: column; gap: 12px; }
.cp-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.cp-head h2 { margin: 0; }

/* mode chooser */
.cp-mode { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 700px) { .cp-mode { grid-template-columns: 1fr; } }
.cp-mode-btn { display: flex; align-items: center; gap: 12px; text-align: left; padding: 14px 16px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 12px; cursor: pointer; position: relative; transition: border-color .15s, background .15s; }
.cp-mode-btn:hover { border-color: var(--fg-2); }
.cp-mode-btn.active.real { border-color: var(--accent); background: linear-gradient(180deg, rgba(74,222,128,0.06), transparent); }
.cp-mode-btn.active.sim { border-color: #60a5fa; background: linear-gradient(180deg, rgba(96,165,250,0.06), transparent); }
.cp-mode-ic { font-size: 24px; }
.cp-mode-txt { display: flex; flex-direction: column; }
.cp-mode-txt b { font-size: 14px; letter-spacing: 0.03em; }
.cp-mode-txt small { color: var(--fg-2); font-size: 11.5px; }
.cp-mode-live { position: absolute; top: 10px; right: 12px; font-size: 9px; font-weight: 700; letter-spacing: 0.08em; padding: 2px 7px; border-radius: 20px; background: rgba(74,222,128,0.14); color: var(--accent); }
.cp-mode-live.sim { background: rgba(96,165,250,0.14); color: #60a5fa; }
.cp-mode-live.on { box-shadow: 0 0 10px rgba(74,222,128,0.5); }

/* VIN (simulator) */
.cp-vin { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cp-vin-input { flex: 1; min-width: 220px; font-size: 15px; letter-spacing: 0.12em; padding: 8px 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; color: var(--fg-0); }
.cp-decode { display: flex; gap: 6px; flex-wrap: wrap; }
.cp-chip { font-size: 11px; font-family: var(--mono); background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 4px 9px; }
.cp-chip .dim { margin-right: 5px; }
.cp-chip.ok { border-color: var(--accent); color: var(--accent); }
.cp-chip.warn { border-color: var(--warn); color: var(--warn); }

/* SuperDevice link */
.cp-link { position: relative; overflow: hidden; }
.cp-link.error { border-color: var(--danger); }
.cp-link.online { border-color: var(--accent); }
.cp-link-head { display: flex; align-items: center; gap: 14px; }
.cp-link-orb { position: relative; width: 40px; height: 40px; flex: none; display: grid; place-items: center; }
.cp-orb-core { width: 12px; height: 12px; border-radius: 50%; background: var(--fg-2); }
.cp-link-orb[data-state="idle"] .cp-orb-core { background: var(--fg-2); }
.cp-link-orb[data-state="connecting"] .cp-orb-core { background: var(--warn); }
.cp-link-orb[data-state="error"] .cp-orb-core { background: var(--danger); }
.cp-orb-ring, .cp-orb-ring.r2 { position: absolute; inset: 0; border-radius: 50%; border: 1px solid var(--border); opacity: 0; }
.cp-link-orb[data-state="connecting"] .cp-orb-ring { border-color: var(--warn); animation: orb 1.4s ease-out infinite; }
.cp-link-orb[data-state="connecting"] .cp-orb-ring.r2 { animation-delay: 0.7s; }
@keyframes orb { 0% { transform: scale(0.4); opacity: 0.7; } 100% { transform: scale(1.3); opacity: 0; } }
.cp-link-title { display: flex; flex-direction: column; }
.cp-link-title b { font-size: 14px; }
.cp-link-connect { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
.cp-host { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 220px; }
.cp-host input { padding: 8px 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; color: var(--fg-0); font-size: 13px; }
.cp-connect-btn { white-space: nowrap; }
.cp-link-err { flex-basis: 100%; font-size: 12px; color: var(--danger); background: var(--danger-dim, rgba(239,68,68,0.08)); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 10px; }
.cp-link-actions { display: flex; gap: 8px; flex-basis: 100%; margin-top: 2px; }
.cp-found { flex-basis: 100%; display: flex; flex-direction: column; gap: 5px; margin-top: 4px; }
.cp-found-item { display: flex; align-items: center; gap: 10px; text-align: left; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 11px; cursor: pointer; }
.cp-found-item:hover { border-color: var(--accent); }
.cp-found-name { font-weight: 700; color: var(--fg-0); font-size: 13px; }
.cp-found-go { margin-left: auto; color: var(--accent); font-size: 12px; }
.cp-link-scan { position: relative; margin-top: 14px; padding: 12px; background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px; }
.cp-scanline { position: absolute; left: 0; top: 0; height: 2px; width: 40%; background: linear-gradient(90deg, transparent, var(--warn), transparent); animation: scan 1.2s linear infinite; }
@keyframes scan { 0% { transform: translateX(-40%); } 100% { transform: translateX(300%); } }
.cp-steps { list-style: none; margin: 0; padding: 0; line-height: 1.9; }
.cp-steps li { color: var(--fg-2); }
.cp-steps li.done { color: var(--accent); }
.cp-steps li.active { color: var(--warn); }

/* online device card */
.cp-online-head { display: flex; align-items: center; justify-content: space-between; }
.cp-online-id { display: flex; align-items: center; gap: 11px; }
.cp-online-dot { width: 11px; height: 11px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px var(--accent); animation: pulse 1.8s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.cp-online-id b { font-size: 14px; }
.cp-health { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin: 12px 0; }
@media (max-width: 820px) { .cp-health { grid-template-columns: repeat(3, 1fr); } }
.cp-hcell { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; }
.cp-hk { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-2); }
.cp-hv { font-size: 13px; font-weight: 700; color: var(--fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-hv.ok { color: var(--accent); } .cp-hv.warn { color: var(--warn); }
.cp-buses { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; margin-bottom: 12px; }
.cp-bus2 { background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; padding: 11px 12px; display: flex; flex-direction: column; gap: 9px; transition: border-color .2s, box-shadow .2s; }
.cp-bus2.up { border-color: rgba(74,222,128,0.32); }
.cp-bus2.live { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(74,222,128,0.25), 0 0 20px rgba(74,222,128,0.13); }
.cp-bus2-top { display: flex; align-items: center; justify-content: space-between; }
.cp-bus2-id { display: flex; align-items: baseline; gap: 8px; }
.cp-bus2-name { font-size: 15px; font-weight: 700; color: var(--fg-0); }
.cp-bus2-role { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-2); }
.cp-switch { display: inline-flex; align-items: center; gap: 6px; background: var(--bg-1); border: 1px solid var(--border); border-radius: 20px; padding: 3px 10px 3px 5px; cursor: pointer; }
.cp-switch-knob { width: 13px; height: 13px; border-radius: 50%; background: var(--fg-2); transition: background .2s, transform .2s, box-shadow .2s; }
.cp-switch.on { border-color: var(--accent); }
.cp-switch.on .cp-switch-knob { background: var(--accent); transform: translateX(2px); box-shadow: 0 0 8px var(--accent); }
.cp-switch-txt { font-size: 10px; font-weight: 700; letter-spacing: 0.05em; color: var(--fg-2); }
.cp-switch.on .cp-switch-txt { color: var(--accent); }
.cp-bus2-activity { display: flex; align-items: flex-end; gap: 10px; height: 34px; }
.cp-spark { flex: 1; display: flex; align-items: flex-end; gap: 1.5px; height: 100%; }
.cp-spark span { flex: 1; background: var(--border); border-radius: 1px; min-height: 2px; transition: height .35s ease; }
.cp-bus2.live .cp-spark span { background: linear-gradient(180deg, var(--accent), rgba(74,222,128,0.25)); }
.cp-rate { display: flex; align-items: baseline; gap: 3px; min-width: 54px; justify-content: flex-end; }
.cp-rate-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-2); align-self: center; }
.cp-rate.on .cp-rate-dot { background: var(--accent); box-shadow: 0 0 8px var(--accent); animation: pulse 1s infinite; }
.cp-rate-n { font-size: 18px; font-weight: 700; color: var(--fg-1); font-variant-numeric: tabular-nums; }
.cp-rate.on .cp-rate-n { color: var(--accent); }
.cp-rate-u { font-size: 9px; color: var(--fg-2); }
.cp-bus2-ctl { display: flex; align-items: center; gap: 10px; }
.cp-br { background: var(--bg-1); border: 1px solid var(--border); border-radius: 6px; color: var(--fg-0); font-size: 12px; padding: 4px 7px; }
.cp-fd { display: flex; align-items: center; gap: 4px; color: var(--fg-2); cursor: pointer; }
.cp-bus-add { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; border: 1px dashed var(--border); border-radius: 10px; color: var(--fg-2); font-size: 12px; padding: 11px; }
.cp-vinrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.cp-decode-card { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 10px; padding: 10px 12px; background: var(--bg-2); border: 1px solid var(--accent); border-radius: 10px; }
.cp-insight-card { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; padding: 10px 12px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; }
.cp-insight-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cp-known { color: var(--accent); }
.cp-vin-btn { font-size: 14px; padding: 10px 18px; }
.cp-vin-got { color: var(--accent); font-size: 13px; }
.warn { color: var(--warn); }

.cp-msg { font-size: 12px; background: var(--bg-2); border: 1px solid var(--accent); color: var(--fg-1); border-radius: 8px; padding: 8px 12px; }
.cp-realnote { background: linear-gradient(180deg, rgba(74,222,128,0.06), transparent); border: 1px solid rgba(74,222,128,0.35); border-radius: 8px; padding: 8px 12px; color: var(--fg-1); }
.cp-miss { border-color: var(--warn); }
.cp-miss strong { color: var(--warn); }
.cp-miss-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.cp-model, .cp-select { padding: 7px 9px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; color: var(--fg-0); }
.cp-grid { display: grid; grid-template-columns: 1.5fr 1fr; gap: 12px; align-items: start; }
@media (max-width: 1100px) { .cp-grid { grid-template-columns: 1fr; } }
.cp-stage { padding: 12px; }
.cp-stage-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.cp-stage-head h3 { margin: 4px 0 0; }
.cp-badge { font-size: 9.5px; letter-spacing: 0.08em; padding: 2px 7px; border-radius: 5px; }
.cp-badge.ok { background: rgba(74,222,128,0.12); color: var(--accent); border: 1px solid var(--accent); }
.cp-canvas { position: relative; height: 440px; border-radius: 10px; overflow: hidden; border: 1px solid var(--border); }
.cp-sim-tag { position: absolute; left: 12px; bottom: 12px; font-size: 11px; font-family: var(--mono); color: var(--accent); background: rgba(6,10,18,0.6); padding: 4px 9px; border-radius: 6px; }
.cp-side { display: flex; flex-direction: column; gap: 12px; }
.cp-big { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.cp-bigtile { background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.cp-big-k { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg-2); }
.cp-big-v { font-size: 30px; font-weight: 700; color: var(--fg-0); font-variant-numeric: tabular-nums; line-height: 1.1; }
.cp-big-u { font-size: 12px; font-weight: 400; color: var(--fg-2); }
.cp-big-bar { height: 4px; background: var(--bg-1); border-radius: 3px; margin-top: 6px; overflow: hidden; }
.cp-big-bar span { display: block; height: 100%; background: var(--accent); transition: width 0.1s linear; }
.cp-gauges { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
.cp-g { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; }
.cp-g-k { font-size: 9.5px; color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cp-g-v { font-size: 16px; font-weight: 700; color: var(--fg-0); font-variant-numeric: tabular-nums; }
.cp-g-u { font-size: 10px; font-weight: 400; color: var(--fg-2); }
.cp-mods { display: flex; flex-direction: column; gap: 4px; }
.cp-mod { display: flex; align-items: center; gap: 9px; padding: 7px 9px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; text-align: left; }
.cp-mod.sel { border-color: var(--accent); }
.cp-mod-label { flex: 1; font-size: 12.5px; color: var(--fg-0); }
.cp-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--border); flex: none; }
.cp-dot.on { box-shadow: 0 0 6px currentColor; }
.cp-dot[data-cat="powertrain"] { color: #f97316; } .cp-dot[data-cat="transmission"] { color: #eab308; }
.cp-dot[data-cat="chassis"] { color: #38bdf8; } .cp-dot[data-cat="body"] { color: #a78bfa; }
.cp-dot[data-cat="safety"] { color: #ef4444; } .cp-dot[data-cat="infotainment"] { color: #22d3ee; }
.cp-dot[data-cat="hvac"] { color: #34d399; } .cp-dot[data-cat="network"], .cp-dot[data-cat="other"] { color: #94a3b8; }
.cp-dot.on { background: currentColor; }
.cp-caps { display: flex; flex-direction: column; gap: 5px; }
.cp-cap { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 9px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; }
.cp-cap-main { display: flex; align-items: center; gap: 8px; }
.cp-cap-label { font-size: 12.5px; }
.cp-risk { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; padding: 1px 6px; border-radius: 4px; }
.cp-risk.read { background: rgba(74,222,128,0.12); color: var(--accent); }
.cp-risk.write, .cp-risk.caution { background: rgba(251,191,36,0.14); color: var(--warn); }
.cp-cap-result { margin-top: 8px; font-size: 12px; color: var(--fg-1); background: var(--bg-1); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.cp-empty { text-align: center; padding: 32px; }
`;
