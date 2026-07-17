/**
 * Rich pure-software simulator for a specific bench module. Where the generic
 * moduleCatalog template gives a thin live/DTC view, this models a real ECU end
 * to end so the Bench Module Master simulator can demonstrate EVERYTHING you can
 * do with the module on a bench: the CAN frames it broadcasts, diagnostic session
 * control, SecurityAccess, live measurement blocks, identification DIDs, DTCs with
 * freeze frames, actuator/routine tests, coding/adaptation writes, and a flash /
 * EEPROM clone read. No hardware is touched; write-class actions return clearly
 * SIMULATED results (real writes go through the Cloning Ceremony).
 *
 * First modelled module: Bosch MED17.5 (VW/Audi 2.0 TFSI EA888) — one of the most
 * cloned/tuned engine ECUs in the world; HS-CAN @ 500k, UDS on 0x7E0/0x7E8.
 */

import { DEFAULT_IDLE, type VehicleState } from "@ecu/vehicle-db";

export type SimScenario = "off" | "idle" | "drive" | "rev";
export type SimRisk = "read" | "actuator" | "coding" | "security" | "flash" | "clear";

export interface SimSignal { name: string; value: string }
export interface SimBroadcast {
  id: string;            // CAN id, hex
  label: string;         // e.g. "Motor_1"
  cycleMs: number;       // broadcast period
  gen: (s: VehicleState, t: number) => { bytes: number[]; signals: SimSignal[] };
}
export interface SimLiveParam {
  id: string; label: string; unit: string; decimals?: number;
  gen: (s: VehicleState, t: number) => number;
}
export interface SimDid { id: string; label: string; value: string }
export interface SimDtcDef {
  code: string; desc: string; status: "stored" | "pending" | "permanent";
  active?: boolean;      // re-sets after a clear while running
  statusByte: string;    // UDS status-of-DTC byte, hex
  freeze?: SimSignal[];
}
export interface SimRoutine {
  id: string; label: string; request: string; risk: SimRisk;
  needsSession?: boolean; needsSecurity?: boolean;
  effect: string;
}
export interface SimCodingParam {
  id: string; label: string; value: number | string | boolean;
  unit?: string; type: "number" | "bool" | "text"; editable: boolean; did?: string;
}
export interface SimMemory { flashKb: number; eepromKb: number; note?: string }

// ---- how you actually clone it ----------------------------------------------

export type CloneFeasibility = "reliable" | "supplemental" | "partial" | "last-resort" | "no";
export interface CloneMethod {
  tier: string;                 // "OBD", "Bench boot", "External EEPROM", "Chip-off"
  feasibility: CloneFeasibility;
  what: string;                 // what this gets you
  how: string;                  // human steps
  tools: string;                // gear needed
}
export interface CloneMemoryRegion { region: string; size: string; holds: string; readVia: string }
export interface CloneGuide {
  verdict: "cloneable-bench" | "cloneable-obd" | "partial" | "not-cloneable";
  headline: string;             // one plain-language sentence
  summary: string;              // a short human paragraph
  methods: CloneMethod[];       // tiered, best first
  memoryMap: CloneMemoryRegion[];
  donorNote: string;            // donor matching / immobiliser reality
  ceremonySteps: string[];      // the reliable "how to proceed" checklist
}

export interface ModuleSimSpec {
  id: string;            // matches BenchModuleProfile.id
  blurb: string;
  vin: string;
  reqId: string; respId: string;
  securityLevel: string; // UDS SecurityAccess sub-function, hex "03"
  broadcasts: SimBroadcast[];
  live: SimLiveParam[];
  dids: SimDid[];
  dtcs: SimDtcDef[];
  routines: SimRoutine[];
  coding: SimCodingParam[];
  memory: SimMemory;
  cloning: CloneGuide;
}

// ---- helpers ----------------------------------------------------------------

const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const jitter = (t: number, k: number, a: number, p = 0) => Math.sin(t * k + p) * a;

// ---- Bosch MED17.5 (VW/Audi 2.0 TFSI) spec ----------------------------------

export const MED17_SIM: ModuleSimSpec = {
  id: "bosch-med17-vag-20tfsi",
  blurb: "Bosch MED17.5 — VW/Audi 2.0 TFSI (EA888). HS-CAN 500k · UDS · Tricore.",
  vin: "WVWZZZ1KZAW123456",
  reqId: "7E0", respId: "7E8",
  securityLevel: "03",
  broadcasts: [
    {
      id: "280", label: "Motor_1", cycleMs: 10,
      gen: (s) => {
        const rpmRaw = clampByte(0) === 0 ? Math.round(s.rpm * 4) : 0;
        const tq = clampByte(s.loadPct * 2.4);
        return {
          bytes: [0x49, tq, ...u16le(rpmRaw), clampByte(s.throttlePct * 2.55), 0x00, tq, 0x1a],
          signals: [{ name: "RPM", value: `${s.rpm.toFixed(0)}` }, { name: "Torque", value: `${(s.loadPct * 3.2).toFixed(0)} Nm` }],
        };
      },
    },
    {
      id: "288", label: "Motor_2", cycleMs: 10,
      gen: (s) => ({
        bytes: [0x00, clampByte(s.speedKmh * 1.28), ...u16le(Math.round(s.speedKmh * 128)), clampByte(s.loadPct * 2.55), 0x00, 0x00, 0x00],
        signals: [{ name: "Speed", value: `${s.speedKmh.toFixed(0)} km/h` }, { name: "Load", value: `${s.loadPct.toFixed(0)} %` }],
      }),
    },
    {
      id: "380", label: "Motor_3", cycleMs: 20,
      gen: (s) => ({
        bytes: [clampByte((s.coolantC + 48) * 1.33), clampByte((s.intakeC + 48) * 1.33), clampByte(s.throttlePct * 2.55), 0x00, 0x00, 0x00, 0x00, 0x00],
        signals: [{ name: "Coolant", value: `${s.coolantC.toFixed(0)} °C` }, { name: "IAT", value: `${s.intakeC.toFixed(0)} °C` }],
      }),
    },
    {
      id: "480", label: "Motor_5", cycleMs: 20,
      gen: (s, t) => {
        const boost = s.rpm > 1200 ? 900 + (s.loadPct / 100) * 1100 + jitter(t, 3, 40) : 1000; // mbar abs
        return {
          bytes: [...u16le(Math.round(boost)), clampByte(s.mafGps * 5), 0x00, 0x00, 0x00, 0x00, 0x00],
          signals: [{ name: "Boost(abs)", value: `${(boost / 1000).toFixed(2)} bar` }, { name: "MAF", value: `${s.mafGps.toFixed(1)} g/s` }],
        };
      },
    },
    {
      id: "588", label: "Motor_6", cycleMs: 100,
      gen: (s, t) => ({
        bytes: [clampByte(s.voltage * 10), clampByte(50 + jitter(t, 1.1, 6)), clampByte(s.fuelPct * 2.55), 0x00, 0x00, 0x00, 0x00, 0x00],
        signals: [{ name: "Battery", value: `${s.voltage.toFixed(1)} V` }, { name: "Fuel", value: `${s.fuelPct.toFixed(0)} %` }],
      }),
    },
  ],
  live: [
    { id: "rpm", label: "Engine speed", unit: "rpm", gen: (s) => s.rpm },
    { id: "speed", label: "Vehicle speed", unit: "km/h", gen: (s) => s.speedKmh },
    { id: "load", label: "Calculated load", unit: "%", decimals: 1, gen: (s) => s.loadPct },
    { id: "coolant", label: "Coolant temp", unit: "°C", gen: (s) => s.coolantC },
    { id: "iat", label: "Intake air temp", unit: "°C", gen: (s) => s.intakeC },
    { id: "cat", label: "Charge air temp", unit: "°C", decimals: 0, gen: (s, t) => s.intakeC + 14 + jitter(t, 0.6, 3) },
    { id: "maf", label: "MAF air mass", unit: "g/s", decimals: 1, gen: (s) => s.mafGps },
    { id: "boost", label: "Boost pressure (spec)", unit: "mbar", decimals: 0, gen: (s, t) => (s.rpm > 1200 ? 900 + (s.loadPct / 100) * 1100 + jitter(t, 3, 30) : 1000) },
    { id: "boostact", label: "Boost pressure (act)", unit: "mbar", decimals: 0, gen: (s, t) => (s.rpm > 1200 ? 900 + (s.loadPct / 100) * 1080 + jitter(t, 3.3, 45) : 1000) },
    { id: "throttle", label: "Throttle angle", unit: "%", decimals: 1, gen: (s) => s.throttlePct },
    { id: "rail", label: "Fuel rail pressure", unit: "bar", decimals: 0, gen: (s) => 40 + (s.rpm / 6500) * 160 },
    { id: "lpfp", label: "Low-pressure fuel", unit: "bar", decimals: 1, gen: () => 5.0 },
    { id: "lambda", label: "Lambda B1", unit: "λ", decimals: 3, gen: (_s, t) => 1.0 + jitter(t, 3.2, 0.02) },
    { id: "stft", label: "Short-term fuel trim", unit: "%", decimals: 1, gen: (_s, t) => jitter(t, 1.1, 3.5) },
    { id: "ltft", label: "Long-term fuel trim", unit: "%", decimals: 1, gen: () => 2.7 },
    { id: "timing", label: "Ignition angle", unit: "°", decimals: 1, gen: (s, t) => 12 + (s.rpm / 6500) * 14 + jitter(t, 1.7, 2) },
    { id: "inj", label: "Injection time", unit: "ms", decimals: 2, gen: (s) => 1.2 + (s.loadPct / 100) * 3.6 },
    { id: "knock", label: "Knock retard (avg)", unit: "°", decimals: 1, gen: (s, t) => (s.loadPct > 60 ? Math.abs(jitter(t, 4, 2.2)) : 0) },
    { id: "wg", label: "Wastegate duty", unit: "%", decimals: 0, gen: (s) => (s.rpm > 1400 ? 55 + (s.loadPct / 100) * 35 : 12) },
    { id: "batt", label: "Battery voltage", unit: "V", decimals: 1, gen: (s) => s.voltage },
  ],
  dids: [
    { id: "F190", label: "VIN", value: "WVWZZZ1KZAW123456" },
    { id: "F187", label: "VW spare part number", value: "06K906056AA" },
    { id: "F189", label: "VW application software version", value: "9970" },
    { id: "F191", label: "VW ECU hardware number", value: "06K907425" },
    { id: "F195", label: "ECU software fingerprint", value: "0040" },
    { id: "F197", label: "System name / engine code", value: "4G0907115 R4 2,0L TFSI" },
    { id: "F18C", label: "ECU serial number", value: "BOSCH-261208-77431" },
    { id: "F18A", label: "Supplier identifier", value: "Robert Bosch (0357)" },
    { id: "F1A2", label: "ASAM/ODX file version", value: "EV_ECM20TFS0104" },
    { id: "0600", label: "VW coding (long)", value: "01 0F 00 27 00 00 80" },
    { id: "F19E", label: "Workshop system name", value: "EDC/ME-Motronic" },
    { id: "0405", label: "Immobiliser / component protection", value: "adapted / matched" },
    { id: "F1DF", label: "ECU programming date", value: "2011-03-14" },
    { id: "F806", label: "Calibration verification (CVN)", value: "3F A1 07 C9" },
    { id: "F17C", label: "VW ASAM/ODX dataset", value: "EV_ECM20TFS0104_A01" },
  ],
  dtcs: [
    { code: "P0299", desc: "Turbocharger underboost (boost deviation)", status: "stored", statusByte: "2F", freeze: [{ name: "RPM", value: "3120" }, { name: "Load", value: "78 %" }, { name: "Boost dev", value: "-320 mbar" }, { name: "Coolant", value: "91 °C" }] },
    { code: "P0171", desc: "Fuel system too lean (Bank 1)", status: "stored", active: true, statusByte: "2F", freeze: [{ name: "RPM", value: "1640" }, { name: "STFT", value: "+18.7 %" }, { name: "LTFT", value: "+12.5 %" }] },
    { code: "P0300", desc: "Random / multiple cylinder misfire", status: "pending", statusByte: "27", freeze: [{ name: "RPM", value: "980" }, { name: "Load", value: "24 %" }] },
    { code: "P2187", desc: "System too lean at idle (Bank 1)", status: "pending", statusByte: "26" },
    { code: "P0087", desc: "Fuel rail/system pressure too low", status: "permanent", statusByte: "2F" },
  ],
  routines: [
    { id: "ekp", label: "Fuel pump (EKP) activation", request: "2F 09 4A 03", risk: "actuator", effect: "EKP relay energised — low-pressure fuel rises to 5.8 bar, held 5 s, released." },
    { id: "purge", label: "EVAP purge valve (N80)", request: "2F 12 34 03", risk: "actuator", effect: "N80 cycled 0→100 %; intake vacuum response nominal." },
    { id: "wgtest", label: "Wastegate / boost actuator", request: "31 01 03 5A", risk: "actuator", needsSession: true, effect: "Wastegate swept 10→90 %; position feedback tracks command ±3 %." },
    { id: "injcut", label: "Cylinder balance (injector cut)", request: "31 01 03 41", risk: "actuator", needsSession: true, effect: "Cyl 1-4 momentarily cut; RPM drop 42/45/40/44 — balanced." },
    { id: "fan1", label: "Radiator fan — stage 1", request: "2F 03 09 01", risk: "actuator", effect: "Cooling fan low speed commanded on." },
    { id: "fan2", label: "Radiator fan — stage 2", request: "2F 03 09 02", risk: "actuator", effect: "Cooling fan high speed commanded on." },
    { id: "tba", label: "Throttle body basic setting", request: "31 01 02 5A", risk: "coding", needsSession: true, needsSecurity: true, effect: "Throttle adaptation ran — closed/open stops relearned, idle actuator zeroed." },
    { id: "clearlearn", label: "Reset adaptation (fuel/knock)", request: "31 01 06 0F", risk: "coding", needsSession: true, needsSecurity: true, effect: "Learned fuel-trim & knock maps reset to defaults — relearn drive cycle required." },
    { id: "ecureset", label: "ECU reset (hard reboot)", request: "11 01", risk: "actuator", effect: "ECU reset positive response 0x51 01 — module rebooted, learned adaptations retained." },
    { id: "flashprog", label: "Flash programming (34→36→37)", request: "34 00 44 …", risk: "flash", needsSession: true, needsSecurity: true, effect: "RequestDownload 0x74 → TransferData blocks 0x76 → RequestTransferExit 0x77, checksum OK. On real hardware a full flash write IS the Cloning Ceremony's gated step — never performed ad-hoc from here." },
  ],
  coding: [
    { id: "revlimit", label: "Rev limiter", value: 6800, unit: "rpm", type: "number", editable: true, did: "2101" },
    { id: "launch", label: "Launch-control RPM", value: 4200, unit: "rpm", type: "number", editable: true, did: "2102" },
    { id: "vmax", label: "Top-speed limiter", value: 250, unit: "km/h", type: "number", editable: true, did: "2103" },
    { id: "idle", label: "Idle target", value: 780, unit: "rpm", type: "number", editable: true, did: "2104" },
    { id: "startstop", label: "Start/Stop enabled", value: true, type: "bool", editable: true, did: "2110" },
    { id: "engcode", label: "Engine code", value: "CCTA", type: "text", editable: false },
  ],
  memory: { flashKb: 4096, eepromKb: 8, note: "Tricore TC1767 internal flash — full read on a real MED17 needs bench boot mode (BDM/boot); OBD reads are partial." },
  cloning: {
    verdict: "cloneable-bench",
    headline: "Fully cloneable on the bench — read it in boot mode and write it byte-exact to a same-part-number donor.",
    summary:
      "The MED17 is a Bosch Tricore ECU. You cannot pull a complete, writable image over OBD alone (the flash is read-protected), but in BENCH BOOT MODE the whole internal flash plus the data/EEPROM (which carries the immobiliser / component-protection and adaptation data) reads out cleanly. A byte-exact clone onto a donor of the SAME hardware/part number is the standard, reliable recovery path for a burned MED17 — and because the immo data comes along, the donor runs on your car with no immo work.",
    methods: [
      {
        tier: "Bench boot mode (Tricore BSL)", feasibility: "reliable",
        what: "Complete internal flash (~4 MB: code + calibration) and the data-flash/EEPROM (immo, adaptation, VIN). This is your clone source.",
        how: "Open the ECU housing, find the boot/BDM pads or use the bench connector adapter, hold the MCU in boot-strap mode, and read the full image with a bench flasher. Save the .bin (this is what the simulator's ‘Read flash’ represents).",
        tools: "Bench flasher / boot cable for Tricore (this rig + a boot adapter), anti-static mat, steady 12V bench supply.",
      },
      {
        tier: "External serial EEPROM", feasibility: "supplemental",
        what: "The small 95xxx/25xxx SPI EEPROM on the PCB — immo/component-protection mirror, odometer and adaptation. Use it if boot mode doesn't capture the data region.",
        how: "Identify the SOIC-8 EEPROM, clip or desolder it, and read/write it directly with a memory programmer. Clone it 1:1 to the donor's EEPROM.",
        tools: "PicoForge / CH341A + SOIC-8 clip (3.3V-safe).",
      },
      {
        tier: "OBD / in-car (UDS)", feasibility: "partial",
        what: "Identification, DTCs, live data, and on some software levels a calibration-only (tune) read/write — NOT a guaranteed full byte-exact image.",
        how: "Talk to it on 7E0/7E8 as in this cockpit. Good for diagnostics and tuning, not for a reliable full clone.",
        tools: "This Super Device over the diagnostic connector.",
      },
      {
        tier: "Chip-off", feasibility: "last-resort",
        what: "Direct read of the flash/MCU die. Only if the Tricore is electrically dead and boot mode won't respond.",
        how: "Desolder the flash/MCU and read on a dedicated adapter. Rarely necessary on MED17.",
        tools: "Hot-air rework, BGA/TSOP adapter, programmer.",
      },
    ],
    memoryMap: [
      { region: "Internal program flash", size: "~4 MB", holds: "Bootloader, application code, calibration (maps / tune)", readVia: "Bench boot mode" },
      { region: "Data flash / EEPROM emulation", size: "tens of KB", holds: "Adaptations, immobiliser / component-protection, VIN", readVia: "Bench boot mode" },
      { region: "External SPI EEPROM (95320/95640)", size: "4–8 KB", holds: "Immo/CP mirror, odometer, adaptation", readVia: "SPI programmer (PicoForge/CH341)" },
    ],
    donorNote:
      "Clone to a donor with the SAME hardware/part number (ideally the same software level). A byte-exact clone carries the original immo / component-protection, so the donor runs on YOUR vehicle with no immobiliser work — the lawful burned-module recovery path. A different-variant donor will NOT match without immo adaptation, which this tool does not do (no anti-theft bypass).",
    ceremonySteps: [
      "Read the SOURCE image twice in boot mode — the two reads must match (SHA-256) to prove a clean dump.",
      "Open the DONOR side and archive its pre-write image first — that's your rollback.",
      "Confirm the donor is the same part number; type the donor label to arm the write.",
      "Write the source image to the donor (gated — the 5-part Cloning Ceremony).",
      "Read the donor back and byte-compare against the source (SHA-256 must match) before it leaves the bench.",
    ],
  },
};

const SPECS: ModuleSimSpec[] = [MED17_SIM];
export function getModuleSim(id: string): ModuleSimSpec | null {
  return SPECS.find((s) => s.id === id) ?? null;
}

// ---- runtime state ----------------------------------------------------------

const REAPPEAR_S = 5;
export type SimSession = "default" | "extended" | "programming";

export interface RunResult { ok: boolean; text: string }
export interface DumpResult { region: "flash" | "eeprom"; sizeBytes: number; crc32: string; previewHex: string; durationS: number }

export class ModuleSim {
  state: VehicleState = { ...DEFAULT_IDLE };
  scenario: SimScenario = "idle";
  session: SimSession = "default";
  secured = false;
  seed: string | null = null;
  private t = 0;
  private cleared = false;
  private clearedAt = -100;
  private coding: Record<string, number | string | boolean> = {};

  constructor(public spec: ModuleSimSpec) {
    for (const c of spec.coding) this.coding[c.id] = c.value;
  }

  get ignitionOn(): boolean { return this.scenario !== "off"; }

  setScenario(s: SimScenario) { this.scenario = s; }

  step(dtMs: number) {
    const dt = dtMs / 1000;
    this.t += dt;
    const s = this.state;
    const wob = Math.sin(this.t * 2.1) * 0.5 + Math.sin(this.t * 0.7) * 0.5;
    switch (this.scenario) {
      case "off":
        s.rpm = 0; s.speedKmh = 0; s.throttlePct = 0; s.loadPct = 0; s.mafGps = 0; s.voltage = 12.3;
        break;
      case "idle":
        s.rpm = 780 + wob * 30; s.speedKmh = 0; s.throttlePct = 13 + wob * 2; s.loadPct = 19 + wob * 3;
        s.coolantC = lerp(s.coolantC, 92, 0.02); s.intakeC = lerp(s.intakeC, 34, 0.01); s.mafGps = 3.0 + wob * 0.3; s.voltage = 14.1 + wob * 0.1;
        break;
      case "drive": {
        const tgt = 60 + Math.sin(this.t * 0.22) * 40;
        s.speedKmh = lerp(s.speedKmh, tgt, 0.05); s.rpm = 1100 + s.speedKmh * 28 + wob * 60;
        s.throttlePct = 24 + Math.max(0, tgt - s.speedKmh) * 2.5 + wob * 3; s.loadPct = 42 + (s.speedKmh / 100) * 30 + wob * 4;
        s.coolantC = lerp(s.coolantC, 95, 0.02); s.intakeC = lerp(s.intakeC, 40, 0.01); s.mafGps = 6 + (s.rpm / 1000) * 4; s.voltage = 14.0 + wob * 0.15;
        break;
      }
      case "rev":
        s.speedKmh = 0; s.rpm = 2000 + (Math.sin(this.t * 1.3) * 0.5 + 0.5) * 4600;
        s.throttlePct = 25 + (Math.sin(this.t * 1.3) * 0.5 + 0.5) * 65; s.loadPct = 35 + (Math.sin(this.t * 1.3) * 0.5 + 0.5) * 55;
        s.coolantC = lerp(s.coolantC, 98, 0.02); s.mafGps = 8 + (s.rpm / 1000) * 5; s.voltage = 14.0 + wob * 0.15;
        break;
    }
    s.fuelPct = Math.max(5, s.fuelPct - (this.scenario === "off" ? 0 : dt * 0.02));
  }

  broadcasts(): { id: string; label: string; cycleMs: number; hex: string; signals: SimSignal[] }[] {
    if (!this.ignitionOn) return [];
    return this.spec.broadcasts.map((b) => {
      const { bytes, signals } = b.gen(this.state, this.t);
      return { id: b.id, label: b.label, cycleMs: b.cycleMs, hex: bytes.map((n) => clampByte(n).toString(16).toUpperCase().padStart(2, "0")).join(" "), signals };
    });
  }

  live(): { id: string; label: string; value: number; unit: string; decimals: number }[] {
    return this.spec.live.map((p) => ({ id: p.id, label: p.label, unit: p.unit, decimals: p.decimals ?? 0, value: p.gen(this.state, this.t) }));
  }

  currentDtcs(): SimDtcDef[] {
    if (!this.cleared) return this.spec.dtcs;
    // after a clear: non-permanent gone; active faults re-set after a delay while running
    const reappear = this.ignitionOn && this.t - this.clearedAt > REAPPEAR_S;
    return this.spec.dtcs.filter((d) => d.status === "permanent" || (d.active && reappear));
  }

  clearDtcs(): RunResult {
    this.cleared = true; this.clearedAt = this.t;
    const perm = this.spec.dtcs.filter((d) => d.status === "permanent").length;
    return { ok: true, text: `✿ SIMULATED — Fault memory cleared (0x54). Non-permanent codes erased${perm ? `; ${perm} permanent code(s) remain until the fault clears` : ""}. Active faults will re-set on the next drive cycle.` };
  }

  setSession(s: SimSession): RunResult {
    this.session = s;
    if (s === "default") this.secured = false;
    return { ok: true, text: `Positive response 0x50 ${sidHex(s)} — ${s} diagnostic session active.` };
  }

  requestSeed(): { seed: string; text: string } {
    const b = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256));
    this.seed = b.map((n) => n.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    return { seed: this.seed, text: `67 ${this.spec.securityLevel} — seed ${this.seed} (level ${this.spec.securityLevel}). Compute the key and send it.` };
  }

  sendKey(_key: string): RunResult {
    if (this.session === "default") return { ok: false, text: "🔒 Enter the Extended session before requesting SecurityAccess." };
    if (!this.seed) return { ok: false, text: "🔒 Request a seed first (27 " + this.spec.securityLevel + ")." };
    this.secured = true;
    return { ok: true, text: `67 ${keyLevel(this.spec.securityLevel)} — key accepted, security level ${this.spec.securityLevel} unlocked (SIMULATED).` };
  }

  runRoutine(r: SimRoutine): RunResult {
    if (r.needsSession && this.session === "default") return { ok: false, text: `🔒 "${r.label}" needs the Extended diagnostic session — set it first.` };
    if (r.needsSecurity && !this.secured) return { ok: false, text: `🔒 "${r.label}" needs SecurityAccess — request seed & send key first.` };
    return { ok: true, text: `✿ SIMULATED — ${r.effect}` };
  }

  getCoding(id: string): number | string | boolean { return this.coding[id]; }

  setCoding(id: string, value: number | string | boolean): RunResult {
    const p = this.spec.coding.find((c) => c.id === id);
    if (!p || !p.editable) return { ok: false, text: "This value is read-only." };
    if (this.session === "default") return { ok: false, text: "🔒 Coding needs the Extended session." };
    if (!this.secured) return { ok: false, text: "🔒 Coding needs SecurityAccess (seed/key) first." };
    this.coding[id] = value;
    return { ok: true, text: `✿ SIMULATED — WriteDataByIdentifier 0x6E ${p.did ?? ""} — "${p.label}" set to ${value}${p.unit ? ` ${p.unit}` : ""}.` };
  }

  dumpMemory(region: "flash" | "eeprom"): DumpResult {
    const kb = region === "flash" ? this.spec.memory.flashKb : this.spec.memory.eepromKb;
    const sizeBytes = kb * 1024;
    // deterministic pseudo-random fill with an ASCII header, like the vehicle sim
    const bytes = new Uint8Array(Math.min(sizeBytes, 4096 * 1024));
    let seed = hashStr(`${this.spec.id}:${region}`);
    for (let i = 0; i < bytes.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; bytes[i] = seed & 0xff; }
    const header = `ECULAB-SIM ${this.spec.id} ${region.toUpperCase()} PN:${this.spec.dids.find((d) => d.id === "F187")?.value ?? ""} VIN:${this.spec.vin}\n`;
    for (let i = 0; i < header.length && i < bytes.length; i++) bytes[i] = header.charCodeAt(i) & 0xff;
    const crc = crc32(bytes);
    const rate = region === "flash" ? 48 : 1.0; // kB/s simulated
    return {
      region, sizeBytes,
      crc32: `0x${crc.toString(16).toUpperCase().padStart(8, "0")}`,
      previewHex: hexDump(Array.from(bytes.slice(0, 128))),
      durationS: +(sizeBytes / 1024 / rate).toFixed(1),
    };
  }
}

// ---- small utils ------------------------------------------------------------

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sidHex = (s: SimSession) => (s === "extended" ? "03" : s === "programming" ? "02" : "01");
const keyLevel = (lvl: string) => (parseInt(lvl, 16) + 1).toString(16).toUpperCase().padStart(2, "0");

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function hexDump(bytes: number[]): string {
  const rows: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const slice = bytes.slice(off, off + 16);
    const hexes = slice.map((n) => n.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    const ascii = slice.map((n) => (n >= 32 && n < 127 ? String.fromCharCode(n) : ".")).join("");
    rows.push(`${off.toString(16).toUpperCase().padStart(6, "0")}  ${hexes.padEnd(47)}  ${ascii}`);
  }
  return rows.join("\n");
}
