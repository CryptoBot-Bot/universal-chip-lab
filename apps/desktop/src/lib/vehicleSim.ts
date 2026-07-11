/**
 * Renderer-side vehicle OBD simulator.
 *
 * Emulates a specific VehicleProfile answering OBD-II requests so the whole
 * cockpit is testable with zero hardware. It deliberately routes every reading
 * through the REAL J1979 encode→decode path (encodePidResponse/decodePidResponse)
 * so the simulator also validates our PID table round-trips correctly.
 */

import {
  DEFAULT_IDLE,
  encodePidResponse,
  decodePidResponse,
  moduleTemplateFor,
  buildSampleVin,
  MODULE_CONFIG,
  MODULE_MEMORY,
  ACTIVE_DTCS,
  type VehicleState,
  type VehicleProfile,
  type ModuleTemplate,
  type ModuleActionDef,
  type ModuleDtc,
  type ConfigParam,
  type ModuleIdentity,
} from "@ecu/vehicle-db";

export interface ModuleInfoRow { id: string; label: string; value: string; }
export interface ModuleLiveRow { id: string; label: string; value: number; unit: string; decimals: number; }
export interface ActionResult { ok: boolean; text: string; }
export interface LiveDtc extends ModuleDtc { present: boolean; active: boolean; clearedAt?: number; }
export interface DumpResult { region: "flash" | "eeprom"; sizeBytes: number; bytes: Uint8Array; crc32: string; previewHex: string; durationS: number; }

/** One ECU's raw answer as collected by an address-space sweep (structurally an EcuObservation). */
export interface ScannedEcu {
  responseId: string;
  requestId: string;
  supportedPids: string[];
  identifiers: { did: string; ascii: string }[];
  dtcs: string[];
  liveSample: { name: string; value: string }[];
}

const REAPPEAR_S = 4; // active faults re-set this long after a clear (while running)

export type SimScenario = "off" | "idle" | "drive" | "rev";

export interface SimReading {
  pid: number;
  name: string;
  value: number;
  unit: string;
}

export interface SimQuery {
  ok: boolean;
  mode: number;
  pid?: number;
  raw: number[];
  text: string;
}

/** PIDs shown on the live gauge cluster. */
const GAUGE_PIDS = [0x0c, 0x0d, 0x05, 0x11, 0x04, 0x10, 0x0f, 0x2f, 0x42, 0x5c];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class VehicleSimulator {
  state: VehicleState = { ...DEFAULT_IDLE };
  scenario: SimScenario = "off";
  vin: string;
  dtcs: string[];
  private t = 0; // accumulated seconds (drives sinusoids; no Date needed)
  private dtcState: Record<string, LiveDtc[]> = {};
  private configState: Record<string, ConfigParam[]> = {};
  /** The emulated CAN bus: which physical request id answers, and as what. Built
   * ONCE from the profile — a scanner never sees this map, it discovers it by probing. */
  private bus = new Map<string, { responseId: string; requestId: string; tpl: ModuleTemplate | null; identity?: ModuleIdentity }>();

  constructor(public profile: VehicleProfile) {
    // A real, decodable VIN for the profile's first WMI + year (user-owned demo unit):
    // legal charset + valid check digit, so decodeVin() resolves it like a real scan.
    this.vin = buildSampleVin(profile.wmi?.[0] ?? "1HG", profile.year ?? 2020, "012345");
    this.dtcs = ["P0300", "P0420"]; // random misfire + cat efficiency — classic demo pair
    for (const m of profile.modules) {
      const req = m.addressing?.request?.toUpperCase();
      const resp = m.addressing?.response?.toUpperCase();
      if (!req || !resp) continue; // modules without a known address stay silent (unmapped)
      this.bus.set(req, { responseId: resp, requestId: req, tpl: moduleTemplateFor(m.id, m.category) ?? null, identity: m.identity });
    }
  }

  // ---- emulated bus (address-space probing) ---------------------------------

  /**
   * Probe ONE physical request id, exactly as a scan tool would: send session
   * control / ReadDataByIdentifier / ReadDTCInformation and collect whatever the
   * ECU at that address answers. Returns null if the address is silent.
   */
  probe(requestId: string): ScannedEcu | null {
    const entry = this.bus.get(requestId.toUpperCase());
    if (!entry) return null;
    const { responseId, requestId: rid, tpl, identity } = entry;
    if (!tpl) return { responseId, requestId: rid, supportedPids: [], identifiers: [], dtcs: [], liveSample: [] };
    const info = this.moduleInfo(tpl, identity);
    const identifiers = tpl.ecuInfo
      .map((d) => { const row = info.find((r) => r.id === d.id); return row ? { did: d.id, ascii: row.value } : null; })
      .filter((x): x is { did: string; ascii: string } => !!x);
    return {
      responseId,
      requestId: rid,
      supportedPids: tpl.services.map((s) => s.id),
      identifiers,
      dtcs: this.moduleDtcs(tpl).map((x) => x.code),
      liveSample: this.moduleLive(tpl).slice(0, 8).map((p) => ({
        name: p.label, value: `${p.value.toFixed(p.decimals)}${p.unit ? ` ${p.unit}` : ""}`,
      })),
    };
  }

  /** Sweep a list of candidate physical request ids; return the raw observation
   * for every ECU that answered (deduped by response id, address-sorted). */
  scanBus(candidateRequestIds: string[]): ScannedEcu[] {
    const seen = new Set<string>();
    const out: ScannedEcu[] = [];
    for (const req of candidateRequestIds) {
      const e = this.probe(req);
      if (e && !seen.has(e.responseId)) { seen.add(e.responseId); out.push(e); }
    }
    return out.sort((a, b) => a.responseId.localeCompare(b.responseId));
  }

  setScenario(s: SimScenario) {
    this.scenario = s;
    if (s === "off") this.state.runtimeS = 0;
  }

  /** Advance the simulated engine by dtMs. */
  step(dtMs: number) {
    const dt = dtMs / 1000;
    this.t += dt;
    const s = this.state;
    const wobble = Math.sin(this.t * 2.1) * 0.5 + Math.sin(this.t * 0.7) * 0.5;

    switch (this.scenario) {
      case "off":
        s.rpm = lerp(s.rpm, 0, 0.2);
        s.speedKmh = lerp(s.speedKmh, 0, 0.3);
        s.throttlePct = lerp(s.throttlePct, 0, 0.2);
        s.loadPct = lerp(s.loadPct, 0, 0.2);
        s.coolantC = lerp(s.coolantC, s.ambientC, 0.002);
        break;
      case "idle":
        s.rpm = 720 + wobble * 35;
        s.speedKmh = 0;
        s.throttlePct = 14 + wobble * 2;
        s.loadPct = 21 + wobble * 3;
        s.coolantC = lerp(s.coolantC, 89, 0.02);
        s.mafGps = 3.1 + wobble * 0.3;
        s.runtimeS += dt;
        break;
      case "drive": {
        const target = 55 + Math.sin(this.t * 0.25) * 35; // 20–90 km/h cruise
        s.speedKmh = lerp(s.speedKmh, target, 0.05);
        s.rpm = 900 + s.speedKmh * 32 + wobble * 60;
        s.throttlePct = 22 + Math.max(0, target - s.speedKmh) * 3 + wobble * 3;
        s.loadPct = 35 + (s.speedKmh / 90) * 25 + wobble * 4;
        s.coolantC = lerp(s.coolantC, 93, 0.02);
        s.mafGps = 4 + (s.rpm / 1000) * 3;
        s.runtimeS += dt;
        break;
      }
      case "rev":
        s.speedKmh = 0;
        s.rpm = 1600 + (Math.sin(this.t * 1.4) * 0.5 + 0.5) * 3800;
        s.throttlePct = 20 + (Math.sin(this.t * 1.4) * 0.5 + 0.5) * 60;
        s.loadPct = 30 + (Math.sin(this.t * 1.4) * 0.5 + 0.5) * 45;
        s.coolantC = lerp(s.coolantC, 96, 0.02);
        s.mafGps = 5 + (s.rpm / 1000) * 4;
        s.runtimeS += dt;
        break;
    }
    s.voltage = this.scenario === "off" ? 12.4 : 14.0 + wobble * 0.15;
    s.fuelPct = Math.max(4, s.fuelPct - (this.scenario === "off" ? 0 : dt * 0.02));

    // Active faults re-set a few seconds after a clear — but only while running
    // (the fault is re-detected during operation). Cleared historic codes stay gone.
    if (this.scenario !== "off") {
      for (const list of Object.values(this.dtcState)) {
        for (const d of list) {
          if (!d.present && d.active && d.clearedAt != null && this.t - d.clearedAt > REAPPEAR_S) {
            d.present = true;
            d.status = "pending";
            d.clearedAt = undefined;
          }
        }
      }
    }
  }

  /** Live readings for the gauge cluster (round-tripped through the PID codec). */
  readings(): SimReading[] {
    const out: SimReading[] = [];
    for (const pid of GAUGE_PIDS) {
      const raw = encodePidResponse(pid, this.state);
      if (!raw) continue;
      const dec = decodePidResponse(raw);
      if (dec) out.push(dec);
    }
    return out;
  }

  /** Answer a raw OBD request as the firmware would (mode 01/03/09). */
  query(mode: number, pid?: number): SimQuery {
    if (this.scenario === "off" && mode !== 0x09) {
      return { ok: false, mode, pid, raw: [], text: "NO DATA (ignition off)" };
    }
    if (mode === 0x01 && pid != null) {
      const raw = encodePidResponse(pid, this.state);
      if (!raw) return { ok: false, mode, pid, raw: [], text: "NO DATA (unsupported PID)" };
      const dec = decodePidResponse(raw);
      return { ok: true, mode, pid, raw, text: dec ? `${dec.name}: ${dec.value.toFixed(1)} ${dec.unit}` : hex(raw) };
    }
    if (mode === 0x03) {
      return { ok: true, mode, raw: [], text: this.dtcs.length ? this.dtcs.join(", ") : "No stored DTCs" };
    }
    if (mode === 0x09 && pid === 0x02) {
      return { ok: true, mode, pid, raw: [...this.vin].map((c) => c.charCodeAt(0)), text: this.vin };
    }
    return { ok: false, mode, pid, raw: [], text: "NO DATA" };
  }

  // ---- per-module inspection ------------------------------------------------

  /** ECU identity DIDs (VIN injected live; brand identity overlaid when supplied). */
  moduleInfo(tpl: ModuleTemplate, identity?: ModuleIdentity): ModuleInfoRow[] {
    const overlay: Record<string, string | undefined> = identity
      ? { F187: identity.partNo, F18A: identity.supplier, F195: identity.sw, F191: identity.hw, F18C: identity.serial }
      : {};
    return tpl.ecuInfo.map((d) => ({
      id: d.id,
      label: d.label,
      value: overlay[d.id] ?? (d.sample === "@VIN" ? this.vin : d.sample),
    }));
  }

  /** Live measurement block evaluated against the current simulated state. */
  moduleLive(tpl: ModuleTemplate): ModuleLiveRow[] {
    return tpl.liveParams.map((p) => ({
      id: p.id,
      label: p.label,
      value: p.gen(this.state, this.t),
      unit: p.unit,
      decimals: p.decimals ?? 0,
    }));
  }

  private ensureDtc(tpl: ModuleTemplate): LiveDtc[] {
    if (!this.dtcState[tpl.key]) {
      const active = new Set(ACTIVE_DTCS[tpl.key] ?? []);
      this.dtcState[tpl.key] = tpl.dtcs.map((d) => ({ ...d, present: true, active: active.has(d.code) }));
    }
    return this.dtcState[tpl.key];
  }

  /** Currently-present DTCs for this module (reflects clears + reappearances). */
  moduleDtcs(tpl: ModuleTemplate): ModuleDtc[] {
    return this.ensureDtc(tpl).filter((d) => d.present).map(({ code, desc, status }) => ({ code, desc, status }));
  }

  /** Clear DTCs: non-permanent codes vanish; active faults will re-set (see step). */
  clearDtcs(tpl: ModuleTemplate): { cleared: number; willReturn: number } {
    const list = this.ensureDtc(tpl);
    let cleared = 0, willReturn = 0;
    for (const d of list) {
      if (d.status === "permanent") continue;
      if (d.present) { d.present = false; d.clearedAt = this.t; cleared++; if (d.active) willReturn++; }
    }
    return { cleared, willReturn };
  }

  private ensureConfig(tpl: ModuleTemplate): ConfigParam[] {
    if (!this.configState[tpl.key]) {
      const src = MODULE_CONFIG[tpl.key] ?? [];
      this.configState[tpl.key] = src.map((p) => ({ ...p, value: p.value === "@VIN" ? this.vin : p.value }));
    }
    return this.configState[tpl.key];
  }

  moduleConfig(tpl: ModuleTemplate): ConfigParam[] {
    return this.ensureConfig(tpl);
  }

  setConfig(tpl: ModuleTemplate, id: string, value: string | number | boolean) {
    const p = this.ensureConfig(tpl).find((x) => x.id === id);
    if (p && p.editable) p.value = value;
  }

  /**
   * Simulate an over-OBD memory read (the Raspberry-Pi clone-source dump) and
   * return a REAL byte image — deterministic pseudo-random fill with a readable
   * ASCII header — so it can be archived as an actual .bin in the Dumps tab.
   */
  dumpMemory(tpl: ModuleTemplate, region: "flash" | "eeprom"): DumpResult {
    const mem = MODULE_MEMORY[tpl.key] ?? { flashKb: 512, eepromKb: 2 };
    const sizeBytes = (region === "flash" ? mem.flashKb : mem.eepromKb) * 1024;
    const bytes = new Uint8Array(sizeBytes);
    let seed = hashStr(`${tpl.key}:${region}`);
    for (let i = 0; i < sizeBytes; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; bytes[i] = seed & 0xff; }
    const partNo = tpl.ecuInfo.find((d) => d.id === "F187")?.sample ?? "";
    const header = `ECULAB-SIM ${tpl.key.toUpperCase()} ${region.toUpperCase()} PN:${partNo} SUP:${tpl.supplier} VIN:${this.vin}\n`;
    for (let i = 0; i < header.length && i < sizeBytes; i++) bytes[i] = header.charCodeAt(i) & 0xff;
    const crc = crc32(bytes);
    const rateKbs = region === "flash" ? 62 : 1.2; // simulated UDS transfer rate
    return {
      region, sizeBytes, bytes,
      crc32: `0x${crc.toString(16).toUpperCase().padStart(8, "0")}`,
      previewHex: hexDump(Array.from(bytes.slice(0, 128))),
      durationS: +(sizeBytes / 1024 / rateKbs).toFixed(1),
    };
  }

  /**
   * Simulate any module action. Read actions run freely; write/actuator/security
   * actions run ONLY when `confirmed` (the UI's WriteConfirmModal supplies that),
   * and always return a clearly-labelled SIMULATED result — no real ECU is touched.
   */
  runModuleAction(tpl: ModuleTemplate, a: ModuleActionDef, confirmed = false): ActionResult {
    if (a.risk !== "read") {
      if (!confirmed) {
        return { ok: false, text: `🔒 "${a.label}" (${a.request}) is a ${a.risk.toUpperCase()} action — confirm the write dialog to run it (simulated).` };
      }
      if (a.kind === "clear") {
        const r = this.clearDtcs(tpl);
        const tail = r.willReturn > 0 ? ` ${r.willReturn} active fault(s) will re-set shortly while running.` : "";
        return { ok: true, text: `✿ SIMULATED — Fault memory cleared (0x54). ${r.cleared} code(s) erased.${tail}` };
      }
      return { ok: true, text: `✿ SIMULATED — ${this.writeEffect(a)}` };
    }
    switch (a.kind) {
      case "dtc-read": {
        if (!tpl.dtcs.length) return { ok: true, text: "No stored DTCs — module reports clean." };
        return { ok: true, text: tpl.dtcs.map((d) => `${d.code} (${d.status}) — ${d.desc}`).join("\n") };
      }
      case "info": {
        const info = this.moduleInfo(tpl);
        const get = (id: string) => info.find((r) => r.id === id)?.value ?? "—";
        return { ok: true, text: `Part ${get("F187")} · SW ${get("F195")} · HW ${get("F191")} · SN ${get("F18C")} · ${get("F18A")} · VIN ${this.vin}` };
      }
      case "live":
        return { ok: true, text: `Streaming ${tpl.liveParams.length} live parameters — see the Live Data panel.` };
      case "freeze":
        return { ok: true, text: `Freeze frame @ ${tpl.dtcs[0]?.code ?? "—"}: RPM 3120, Load 62%, Coolant 91°C, Speed 64 km/h, STFT +6.2%` };
      case "readiness":
        return { ok: true, text: "Monitors — Misfire ✓  Fuel ✓  Components ✓  Catalyst ✓  O2 ✓  EVAP ✗ (incomplete)" };
      case "session":
        return { ok: true, text: `Positive response 0x50 — ${a.request.includes("03") ? "extended" : "programming"} diagnostic session active.` };
      case "adaptation":
        return { ok: true, text: "Adaptation block read — values learned and within nominal range." };
      default:
        return { ok: true, text: `Positive response for ${a.request}.` };
    }
  }

  /** Plausible simulated effect text for a confirmed write action. */
  private writeEffect(a: ModuleActionDef): string {
    if (/squib|deploy/i.test(`${a.label} ${a.note ?? ""}`))
      return "Deployment command was NOT executed. This is never performed on a real vehicle from this tool.";
    switch (a.kind) {
      case "clear": return "Fault memory cleared (0x54). Stored & pending DTCs erased; readiness monitors reset — a drive cycle is required.";
      case "adaptation": return "Adaptation values reset to defaults (0x71 01). Relearn drive cycle required.";
      case "actuator": return `Actuator commanded and cycled (0x71 01) — "${a.label}" completed, component returned to rest.`;
      case "security": return "SecurityAccess: seed 0x1A2B3C received, key accepted — level unlocked (0x67 02).";
      case "calibration": return `Calibration routine ran (0x71 01) — new reference stored for "${a.label}". Verify alignment.`;
      default: return "WriteDataByIdentifier accepted (0x6E). On real hardware this requires the Cloning Ceremony.";
    }
  }
}

function hex(b: number[]): string {
  return b.map((n) => n.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Classic offset | hex | ascii dump of the preview bytes. */
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
