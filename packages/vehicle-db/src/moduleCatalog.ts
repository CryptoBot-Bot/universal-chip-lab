/**
 * Per-module knowledge catalog — what each ECU exposes and everything you can do
 * with it. Keyed by a canonical module type so it is reusable across vehicles; a
 * VehicleModule links in by id/category. This is code (not persisted JSON) so the
 * live-parameter generators can be real functions of the simulated vehicle state.
 *
 * Everything here is READ-oriented diagnostic knowledge. Write/actuator/security
 * actions are declared so the UI can show them, but they are risk-flagged and the
 * cockpit never executes them (gated by the Cloning Ceremony).
 */

import type { RiskLevel } from "./busKnowledge.schema.js";
import type { VehicleState } from "./obdPids.js";

export interface EcuDid {
  id: string;        // UDS DID, e.g. "F190"
  label: string;     // "VIN"
  sample: string;    // static value, or "@VIN" to inject the live VIN
}

export interface LiveParam {
  id: string;
  label: string;
  unit: string;
  gen: (s: VehicleState, t: number) => number;
  decimals?: number;
}

export interface ModuleDtc {
  code: string;
  desc: string;
  status: "stored" | "pending" | "permanent";
}

export type ActionKind =
  | "dtc-read" | "info" | "live" | "freeze" | "readiness" | "session"
  | "clear" | "actuator" | "security" | "adaptation" | "calibration";

export interface ModuleActionDef {
  id: string;
  label: string;
  request: string;   // e.g. "19 02 FF" / "22 F190" / "10 03"
  kind: ActionKind;
  risk: RiskLevel;
  note?: string;
}

export interface ModuleTemplate {
  key: string;
  match: string[];                 // module ids or categories this applies to
  supplier: string;
  sessions: { id: string; label: string }[];
  services: { id: string; label: string }[];
  ecuInfo: EcuDid[];
  liveParams: LiveParam[];
  dtcs: ModuleDtc[];
  actions: ModuleActionDef[];
}

// jitter helper (deterministic, no Math.random needed)
const j = (t: number, k: number, a: number, p = 0) => Math.sin(t * k + p) * a;

const SESSIONS = [
  { id: "01", label: "Default session" },
  { id: "03", label: "Extended diagnostic session" },
  { id: "02", label: "Programming session" },
];

const COMMON_INFO = (partNo: string, sw: string, hw: string, serial: string, supplier: string): EcuDid[] => [
  { id: "F190", label: "VIN", sample: "@VIN" },
  { id: "F187", label: "Spare part number", sample: partNo },
  { id: "F195", label: "ECU software version", sample: sw },
  { id: "F191", label: "ECU hardware number", sample: hw },
  { id: "F18C", label: "ECU serial number", sample: serial },
  { id: "F18A", label: "Supplier identifier", sample: supplier },
];

const READ_INFO: ModuleActionDef = { id: "read-info", label: "Read ECU identification", request: "22 F1 8x", kind: "info", risk: "read" };
const READ_DTC: ModuleActionDef = { id: "read-dtc", label: "Read stored DTCs", request: "19 02 FF", kind: "dtc-read", risk: "read" };
const READ_LIVE: ModuleActionDef = { id: "read-live", label: "Read live data stream", request: "22 <did> / 21", kind: "live", risk: "read" };
const CLEAR_DTC: ModuleActionDef = { id: "clear-dtc", label: "Clear DTCs", request: "14 FF FF FF", kind: "clear", risk: "write", note: "Erases fault memory." };

export const MODULE_TEMPLATES: ModuleTemplate[] = [
  {
    key: "ecm", match: ["ecm", "powertrain"], supplier: "DENSO",
    sessions: SESSIONS,
    services: [
      { id: "01/09", label: "OBD-II live + info" }, { id: "03/07/0A", label: "Emissions DTCs" },
      { id: "10", label: "Session control" }, { id: "22", label: "ReadDataByIdentifier" },
      { id: "19", label: "ReadDTCInformation" }, { id: "27", label: "SecurityAccess" },
      { id: "2E", label: "WriteDataByIdentifier" }, { id: "31", label: "RoutineControl" },
    ],
    ecuInfo: COMMON_INFO("89661-02X40", "352A100", "89663-02010", "DN20A7431", "DENSO"),
    liveParams: [
      { id: "rpm", label: "Engine speed", unit: "rpm", gen: (s) => s.rpm },
      { id: "load", label: "Calculated load", unit: "%", gen: (s) => s.loadPct, decimals: 1 },
      { id: "coolant", label: "Coolant temp", unit: "°C", gen: (s) => s.coolantC, decimals: 0 },
      { id: "iat", label: "Intake air temp", unit: "°C", gen: (s) => s.intakeC, decimals: 0 },
      { id: "maf", label: "MAF air flow", unit: "g/s", gen: (s) => s.mafGps, decimals: 1 },
      { id: "throttle", label: "Throttle position", unit: "%", gen: (s) => s.throttlePct, decimals: 1 },
      { id: "timing", label: "Ignition timing", unit: "°", gen: (_s, t) => 10 + j(t, 1.7, 4), decimals: 1 },
      { id: "stft", label: "Short-term fuel trim", unit: "%", gen: (_s, t) => j(t, 1.1, 4), decimals: 1 },
      { id: "ltft", label: "Long-term fuel trim", unit: "%", gen: () => 2.3, decimals: 1 },
      { id: "o2", label: "O2 sensor B1S1", unit: "V", gen: (_s, t) => 0.45 + j(t, 3.2, 0.4), decimals: 2 },
      { id: "rail", label: "Fuel rail pressure", unit: "MPa", gen: (s) => 3.5 + (s.rpm / 6000) * 8, decimals: 1 },
      { id: "batt", label: "Battery voltage", unit: "V", gen: (s) => s.voltage, decimals: 1 },
    ],
    dtcs: [
      { code: "P0300", desc: "Random/multiple cylinder misfire", status: "stored" },
      { code: "P0420", desc: "Catalyst efficiency below threshold (Bank 1)", status: "stored" },
      { code: "P0171", desc: "System too lean (Bank 1)", status: "pending" },
    ],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE,
      { id: "freeze", label: "Read freeze-frame data", request: "19 04 / 02 02", kind: "freeze", risk: "read" },
      { id: "readiness", label: "Read readiness monitors", request: "01 01", kind: "readiness", risk: "read" },
      { id: "montest", label: "On-board monitor results (mode 06)", request: "06", kind: "info", risk: "read" },
      { id: "pending", label: "Read pending DTCs (mode 07)", request: "07", kind: "dtc-read", risk: "read" },
      { id: "permanent", label: "Read permanent DTCs (mode 0A)", request: "0A", kind: "dtc-read", risk: "read" },
      { id: "calid", label: "Read CAL ID / CVN (mode 09)", request: "09 04", kind: "info", risk: "read" },
      { id: "sess-ext", label: "Enter extended session", request: "10 03", kind: "session", risk: "read" },
      CLEAR_DTC,
      { id: "sec", label: "Security access (seed/key)", request: "27 01", kind: "security", risk: "caution", note: "Unlocks protected services." },
      { id: "inj", label: "Injector balance test", request: "31 01 xx", kind: "actuator", risk: "write", note: "Cuts injectors — engine must run." },
      { id: "reset-adapt", label: "Reset fuel/idle adaptations", request: "31 01 FF00", kind: "adaptation", risk: "write" },
    ],
  },
  {
    key: "tcm", match: ["tcm", "transmission"], supplier: "AISIN",
    sessions: SESSIONS,
    services: [
      { id: "10", label: "Session control" }, { id: "22/21", label: "Read data" },
      { id: "19", label: "ReadDTCInformation" }, { id: "27", label: "SecurityAccess" }, { id: "31", label: "RoutineControl" },
    ],
    ecuInfo: COMMON_INFO("89530-02A70", "K120CVT-14", "89535-02020", "AS19C8820", "AISIN"),
    liveParams: [
      { id: "ratio", label: "CVT pulley ratio", unit: ":1", gen: (s) => 2.4 - (s.speedKmh / 90) * 1.9, decimals: 2 },
      { id: "atf", label: "ATF temperature", unit: "°C", gen: (s) => s.coolantC - 8 + j(0, 0, 0), decimals: 0 },
      { id: "line", label: "Line pressure", unit: "kPa", gen: (s) => 800 + s.loadPct * 30, decimals: 0 },
      { id: "inshaft", label: "Input shaft speed", unit: "rpm", gen: (s) => s.rpm, decimals: 0 },
      { id: "outshaft", label: "Output shaft speed", unit: "rpm", gen: (s) => s.speedKmh * 30, decimals: 0 },
      { id: "slip", label: "Torque-converter slip", unit: "rpm", gen: (_s, t) => 20 + Math.abs(j(t, 1.3, 30)), decimals: 0 },
      { id: "sol", label: "Pressure solenoid duty", unit: "%", gen: (s) => 40 + (s.loadPct / 2), decimals: 0 },
    ],
    dtcs: [
      { code: "P0740", desc: "Torque converter clutch circuit malfunction", status: "stored" },
      { code: "P0776", desc: "Pressure control solenoid B stuck off", status: "pending" },
    ],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE,
      { id: "adapt", label: "Read adaptation values", request: "22 21 F0", kind: "adaptation", risk: "read" },
      { id: "sess-ext", label: "Enter extended session", request: "10 03", kind: "session", risk: "read" },
      CLEAR_DTC,
      { id: "reset-adapt", label: "Reset transmission adaptation", request: "31 01 xx", kind: "adaptation", risk: "write" },
      { id: "sol-test", label: "Shift-solenoid actuator test", request: "31 01 yy", kind: "actuator", risk: "write" },
    ],
  },
  {
    key: "abs", match: ["abs", "chassis"], supplier: "ADVICS",
    sessions: SESSIONS,
    services: [{ id: "10", label: "Session control" }, { id: "22/21", label: "Read data" }, { id: "19", label: "DTC info" }, { id: "31", label: "RoutineControl" }],
    ecuInfo: COMMON_INFO("89540-02L20", "ADV-8940", "44050-02460", "AV21D9910", "ADVICS"),
    liveParams: [
      { id: "wfl", label: "Wheel speed FL", unit: "km/h", gen: (s, t) => Math.max(0, s.speedKmh + j(t, 5, 0.6, 0)), decimals: 1 },
      { id: "wfr", label: "Wheel speed FR", unit: "km/h", gen: (s, t) => Math.max(0, s.speedKmh + j(t, 5, 0.6, 1)), decimals: 1 },
      { id: "wrl", label: "Wheel speed RL", unit: "km/h", gen: (s, t) => Math.max(0, s.speedKmh + j(t, 5, 0.6, 2)), decimals: 1 },
      { id: "wrr", label: "Wheel speed RR", unit: "km/h", gen: (s, t) => Math.max(0, s.speedKmh + j(t, 5, 0.6, 3)), decimals: 1 },
      { id: "yaw", label: "Yaw rate", unit: "°/s", gen: (s, t) => (s.speedKmh > 3 ? j(t, 0.6, 3.5) : 0), decimals: 1 },
      { id: "latg", label: "Lateral acceleration", unit: "g", gen: (s, t) => (s.speedKmh > 3 ? j(t, 0.5, 0.15) : 0), decimals: 2 },
      { id: "steer", label: "Steering angle", unit: "°", gen: (_s, t) => j(t, 0.4, 25), decimals: 0 },
      { id: "brake", label: "Brake fluid pressure", unit: "MPa", gen: (_s, t) => Math.max(0, j(t, 0.8, 2)), decimals: 1 },
    ],
    dtcs: [
      { code: "C1201", desc: "Engine control system malfunction", status: "stored" },
      { code: "C1241", desc: "Low battery positive voltage", status: "pending" },
    ],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE,
      { id: "vsc", label: "Read VSC/TRAC status", request: "22 21 05", kind: "live", risk: "read" },
      CLEAR_DTC,
      { id: "zero", label: "Yaw/G sensor zero-point calibration", request: "31 01 zz", kind: "calibration", risk: "write" },
      { id: "bleed", label: "ABS brake-bleed actuator test", request: "31 01 bb", kind: "actuator", risk: "write" },
    ],
  },
  {
    key: "srs", match: ["srs", "safety"], supplier: "TOYODA GOSEI",
    sessions: SESSIONS,
    services: [{ id: "10", label: "Session control" }, { id: "22", label: "Read data" }, { id: "19", label: "DTC info" }, { id: "27", label: "SecurityAccess" }],
    ecuInfo: COMMON_INFO("89170-02R30", "SRS-7734", "89170-02040", "TG21E1120", "TOYODA GOSEI"),
    liveParams: [
      { id: "crash", label: "Crash record count", unit: "", gen: () => 0, decimals: 0 },
      { id: "igncnt", label: "Ignition cycle count", unit: "", gen: () => 41822, decimals: 0 },
      { id: "occ", label: "Passenger occupant class", unit: "(0=empty)", gen: () => 2, decimals: 0 },
      { id: "beltd", label: "Driver seatbelt", unit: "(1=buckled)", gen: () => 1, decimals: 0 },
      { id: "beltp", label: "Passenger seatbelt", unit: "(1=buckled)", gen: () => 0, decimals: 0 },
      { id: "squibd", label: "Driver squib resistance", unit: "Ω", gen: (_s, t) => 2.1 + j(t, 0.3, 0.05), decimals: 2 },
    ],
    dtcs: [
      { code: "B1650", desc: "Passenger occupant classification malfunction", status: "stored" },
      { code: "B0100", desc: "Driver squib circuit (deployment loop)", status: "pending" },
    ],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE,
      { id: "crash-read", label: "Read crash / deployment data", request: "22 21 08", kind: "info", risk: "read" },
      { id: "clear-crash", label: "Clear crash data", request: "14 xx", kind: "clear", risk: "caution", note: "Airbag memory — legal/safety sensitive." },
      { id: "squib-test", label: "Squib firing / deployment", request: "31 01 !!", kind: "actuator", risk: "write", note: "NEVER in the cockpit. Deploys pyrotechnics." },
    ],
  },
  {
    key: "bcm", match: ["bcm", "body"], supplier: "DENSO",
    sessions: SESSIONS,
    services: [{ id: "10", label: "Session control" }, { id: "22/21", label: "Read data" }, { id: "19", label: "DTC info" }, { id: "2E", label: "WriteDataByIdentifier" }, { id: "31", label: "RoutineControl" }],
    ecuInfo: COMMON_INFO("89221-02V10", "BODY-1150", "89221-02040", "DN21B4410", "DENSO"),
    liveParams: [
      { id: "ign", label: "Ignition switch", unit: "(0/1/2)", gen: (s) => (s.rpm > 100 ? 2 : 1), decimals: 0 },
      { id: "doors", label: "Doors open (bitmask)", unit: "", gen: () => 0, decimals: 0 },
      { id: "lock", label: "Central lock", unit: "(1=locked)", gen: () => 1, decimals: 0 },
      { id: "keyin", label: "Key in ignition", unit: "", gen: () => 1, decimals: 0 },
      { id: "lights", label: "Headlight status", unit: "(0=off)", gen: () => 1, decimals: 0 },
      { id: "batt", label: "Body battery voltage", unit: "V", gen: (s) => s.voltage, decimals: 1 },
    ],
    dtcs: [
      { code: "B1242", desc: "Door lock motor circuit", status: "pending" },
      { code: "U0155", desc: "Lost communication with combination meter", status: "stored" },
    ],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE,
      { id: "custom", label: "Read customization settings", request: "22 21 A0", kind: "info", risk: "read" },
      CLEAR_DTC,
      { id: "lock-act", label: "Door lock/unlock actuator test", request: "31 01 dd", kind: "actuator", risk: "write" },
      { id: "light-act", label: "Exterior light test", request: "31 01 ll", kind: "actuator", risk: "write" },
    ],
  },
  {
    key: "meter", match: ["meter", "infotainment"], supplier: "DENSO",
    sessions: SESSIONS,
    services: [{ id: "10", label: "Session control" }, { id: "22", label: "Read data" }, { id: "19", label: "DTC info" }],
    ecuInfo: COMMON_INFO("83800-02Y40", "METER-9021", "83800-02040", "DN21M7710", "DENSO"),
    liveParams: [
      { id: "odo", label: "Odometer", unit: "km", gen: () => 48213, decimals: 0 },
      { id: "tripa", label: "Trip A", unit: "km", gen: () => 312.4, decimals: 1 },
      { id: "fuel", label: "Fuel level", unit: "%", gen: (s) => s.fuelPct, decimals: 0 },
      { id: "spd", label: "Displayed speed", unit: "km/h", gen: (s) => s.speedKmh, decimals: 0 },
      { id: "rpm", label: "Displayed RPM", unit: "rpm", gen: (s) => s.rpm, decimals: 0 },
      { id: "otemp", label: "Outside temperature", unit: "°C", gen: (s) => s.ambientC, decimals: 0 },
    ],
    dtcs: [{ code: "U0100", desc: "Lost communication with ECM/PCM", status: "stored" }],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE,
      { id: "lamps", label: "Read warning-lamp status", request: "22 21 20", kind: "info", risk: "read" },
      { id: "sweep", label: "Gauge sweep / display self-test", request: "31 01 ss", kind: "actuator", risk: "write" },
    ],
  },
  {
    key: "hvac", match: ["hvac"], supplier: "DENSO",
    sessions: SESSIONS,
    services: [{ id: "10", label: "Session control" }, { id: "22/21", label: "Read data" }, { id: "19", label: "DTC info" }, { id: "31", label: "RoutineControl" }],
    ecuInfo: COMMON_INFO("88650-02T60", "AC-4420", "88650-02040", "DN21A2210", "DENSO"),
    liveParams: [
      { id: "cabin", label: "Cabin temperature", unit: "°C", gen: (_s, t) => 22 + j(t, 0.2, 1), decimals: 1 },
      { id: "set", label: "Set temperature", unit: "°C", gen: () => 21.5, decimals: 1 },
      { id: "evap", label: "Evaporator temp", unit: "°C", gen: (_s, t) => 4 + j(t, 0.3, 1.5), decimals: 1 },
      { id: "ambient", label: "Ambient sensor", unit: "°C", gen: (s) => s.ambientC, decimals: 0 },
      { id: "blower", label: "Blower voltage", unit: "V", gen: () => 7.8, decimals: 1 },
      { id: "refrig", label: "Refrigerant pressure", unit: "MPa", gen: (_s, t) => 1.4 + j(t, 0.4, 0.2), decimals: 2 },
      { id: "comp", label: "Compressor status", unit: "(1=on)", gen: (s) => (s.rpm > 100 ? 1 : 0), decimals: 0 },
    ],
    dtcs: [{ code: "B1421", desc: "Evaporator temperature sensor circuit", status: "pending" }],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE,
      { id: "door-act", label: "Air-mix / mode door actuator test", request: "31 01 aa", kind: "actuator", risk: "write" },
      { id: "comp-act", label: "Compressor relay test", request: "31 01 cc", kind: "actuator", risk: "write" },
    ],
  },
  {
    key: "fcm", match: ["fcm", "radar"], supplier: "DENSO",
    sessions: SESSIONS,
    services: [{ id: "10", label: "Session control" }, { id: "22/21", label: "Read data" }, { id: "19", label: "DTC info" }, { id: "31", label: "RoutineControl (aiming)" }],
    ecuInfo: COMMON_INFO("88150-02090", "TSS2-1180", "88150-02040", "DN21F5510", "DENSO"),
    liveParams: [
      { id: "dist", label: "Lead vehicle distance", unit: "m", gen: (s, t) => (s.speedKmh > 5 ? 40 + j(t, 0.3, 15) : 0), decimals: 1 },
      { id: "relspd", label: "Relative speed", unit: "km/h", gen: (s, t) => (s.speedKmh > 5 ? j(t, 0.5, 6) : 0), decimals: 1 },
      { id: "target", label: "Target detected", unit: "(1=yes)", gen: (s) => (s.speedKmh > 5 ? 1 : 0), decimals: 0 },
      { id: "align", label: "Radar alignment", unit: "°", gen: () => 0.2, decimals: 2 },
      { id: "cam", label: "Camera status", unit: "(1=ok)", gen: () => 1, decimals: 0 },
      { id: "pcs", label: "PCS state", unit: "(1=ready)", gen: () => 1, decimals: 0 },
    ],
    dtcs: [
      { code: "C1AA0", desc: "Radar sensor blocked/dirty", status: "pending" },
      { code: "U0401", desc: "Invalid data received from ECM/PCM", status: "stored" },
    ],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE,
      { id: "pcs-status", label: "Read PCS / lane-keep status", request: "22 21 30", kind: "live", risk: "read" },
      { id: "aim", label: "Radar/camera aiming calibration", request: "31 01 mm", kind: "calibration", risk: "write", note: "Requires targets + level floor." },
    ],
  },
  {
    key: "eps", match: ["eps", "steering"], supplier: "JTEKT",
    sessions: SESSIONS,
    services: [{ id: "10", label: "Session control" }, { id: "22/21", label: "Read data" }, { id: "19", label: "DTC info" }, { id: "31", label: "RoutineControl" }],
    ecuInfo: COMMON_INFO("89650-02R40", "EPS-2210", "89650-02040", "JT21E7710", "JTEKT"),
    liveParams: [
      { id: "angle", label: "Steering angle", unit: "°", gen: (_s, t) => j(t, 0.4, 25), decimals: 0 },
      { id: "torque", label: "Steering torque", unit: "Nm", gen: (_s, t) => j(t, 0.8, 2.5), decimals: 1 },
      { id: "motor", label: "Assist motor current", unit: "A", gen: (_s, t) => 5 + Math.abs(j(t, 0.8, 12)), decimals: 1 },
      { id: "assist", label: "Assist level", unit: "%", gen: (s) => Math.max(5, 40 - s.speedKmh / 5), decimals: 0 },
    ],
    dtcs: [{ code: "C1511", desc: "Torque sensor circuit malfunction", status: "pending" }],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE, CLEAR_DTC,
      { id: "tq-cal", label: "Torque sensor zero calibration", request: "31 01 tq", kind: "calibration", risk: "write" },
    ],
  },
  {
    key: "tcm-at", match: ["tcm-at", "at", "dct", "dsg"], supplier: "AISIN",
    sessions: SESSIONS,
    services: [
      { id: "10", label: "Session control" }, { id: "22/21", label: "Read data" },
      { id: "19", label: "DTC info" }, { id: "27", label: "SecurityAccess" }, { id: "31", label: "RoutineControl" },
    ],
    ecuInfo: COMMON_INFO("AT-8HP-0000", "AT-CTRL-100", "AT-HW-010", "AT00000000", "AISIN"),
    liveParams: [
      { id: "gear", label: "Selected gear", unit: "", gen: (s) => Math.min(8, Math.max(1, Math.floor(s.speedKmh / 18) + 1)), decimals: 0 },
      { id: "atf", label: "ATF temperature", unit: "°C", gen: (s) => 70 + s.loadPct * 0.2, decimals: 0 },
      { id: "line", label: "Line pressure", unit: "kPa", gen: (s) => 900 + s.loadPct * 9, decimals: 0 },
      { id: "tin", label: "Input shaft speed", unit: "rpm", gen: (s) => s.rpm, decimals: 0 },
      { id: "tout", label: "Output shaft speed", unit: "rpm", gen: (s) => s.speedKmh * 12, decimals: 0 },
      { id: "slip", label: "Torque-converter slip", unit: "rpm", gen: (s, t) => (s.speedKmh > 15 ? Math.abs(j(t, 1.0, 18)) : s.rpm * 0.05), decimals: 0 },
      { id: "tcc", label: "TCC lockup duty", unit: "%", gen: (s) => (s.speedKmh > 30 ? 92 : 0), decimals: 0 },
      { id: "range", label: "Selected range", unit: "(P/R/N/D)", gen: (s) => (s.speedKmh > 1 ? 4 : 1), decimals: 0 },
    ],
    dtcs: [
      { code: "P0730", desc: "Incorrect gear ratio", status: "pending" },
      { code: "P0715", desc: "Input/turbine speed sensor circuit", status: "stored" },
    ],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE, CLEAR_DTC,
      { id: "adapt-reset", label: "Reset shift adaptation", request: "31 01 ad", kind: "adaptation", risk: "write" },
    ],
  },
  {
    key: "gateway", match: ["gateway", "cgw", "network"], supplier: "DENSO",
    sessions: SESSIONS,
    services: [{ id: "10", label: "Session control" }, { id: "22", label: "Read data" }, { id: "19", label: "DTC info" }, { id: "27", label: "SecurityAccess" }],
    ecuInfo: COMMON_INFO("89100-02A10", "CGW-1140", "89100-02040", "DN21G3310", "DENSO"),
    liveParams: [
      { id: "hsload", label: "HS-CAN bus load", unit: "%", gen: (_s, t) => 28 + j(t, 1.1, 8), decimals: 0 },
      { id: "bodyload", label: "Body-CAN bus load", unit: "%", gen: (_s, t) => 15 + j(t, 0.7, 6), decimals: 0 },
      { id: "woken", label: "Modules awake", unit: "", gen: (s) => (s.rpm > 100 ? 21 : 6), decimals: 0 },
      { id: "ign", label: "Ignition state", unit: "(0/1/2)", gen: (s) => (s.rpm > 100 ? 2 : 1), decimals: 0 },
    ],
    dtcs: [{ code: "U0073", desc: "Control module communication bus A off", status: "pending" }],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE,
      { id: "topo", label: "Read network topology", request: "22 21 00", kind: "info", risk: "read" },
      { id: "sec", label: "Security access (routing)", request: "27 01", kind: "security", risk: "caution" },
    ],
  },
  {
    key: "cert", match: ["cert", "smartkey", "immo"], supplier: "DENSO",
    sessions: SESSIONS,
    services: [{ id: "10", label: "Session control" }, { id: "22", label: "Read data" }, { id: "19", label: "DTC info" }, { id: "27", label: "SecurityAccess" }],
    ecuInfo: COMMON_INFO("89990-02T30", "SMK-3320", "89990-02040", "DN21S8810", "DENSO"),
    liveParams: [
      { id: "keys", label: "Registered keys", unit: "", gen: () => 2, decimals: 0 },
      { id: "immo", label: "Immobiliser armed", unit: "(1=armed)", gen: (s) => (s.rpm > 100 ? 0 : 1), decimals: 0 },
      { id: "lock", label: "Steering lock", unit: "(1=locked)", gen: (s) => (s.rpm > 100 ? 0 : 1), decimals: 0 },
    ],
    dtcs: [{ code: "B2799", desc: "Engine immobiliser system malfunction", status: "stored" }],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE,
      { id: "keystat", label: "Read key registration status", request: "22 21 40", kind: "info", risk: "read" },
      { id: "regkey", label: "Register a key (your own vehicle)", request: "27 + 31 01 kk", kind: "security", risk: "caution", note: "Lawful key add for YOUR car only — never an immobiliser bypass." },
    ],
  },
  {
    key: "park", match: ["park", "parking", "sonar"], supplier: "AISIN",
    sessions: SESSIONS,
    services: [{ id: "10", label: "Session control" }, { id: "22/21", label: "Read data" }, { id: "19", label: "DTC info" }, { id: "31", label: "RoutineControl" }],
    ecuInfo: COMMON_INFO("89340-02460", "SONAR-780", "89340-02040", "AS21P6610", "AISIN"),
    liveParams: [
      { id: "fl", label: "Front-left sonar", unit: "cm", gen: (_s, t) => 120 + j(t, 0.6, 60), decimals: 0 },
      { id: "fc", label: "Front-center sonar", unit: "cm", gen: (_s, t) => 90 + j(t, 0.5, 40), decimals: 0 },
      { id: "rc", label: "Rear-center sonar", unit: "cm", gen: (_s, t) => 70 + j(t, 0.4, 35), decimals: 0 },
      { id: "buzz", label: "Buzzer active", unit: "(1=on)", gen: (_s, t) => (j(t, 0.4, 35) < 10 ? 1 : 0), decimals: 0 },
    ],
    dtcs: [{ code: "C1AC0", desc: "Rear-center sonar sensor fault", status: "pending" }],
    actions: [
      READ_DTC, READ_INFO, READ_LIVE, CLEAR_DTC,
      { id: "sonar-test", label: "Sonar sensor actuator test", request: "31 01 sn", kind: "actuator", risk: "write" },
    ],
  },
];

export function moduleTemplateFor(moduleId: string, category: string): ModuleTemplate | null {
  const id = moduleId.toLowerCase();
  const cat = category.toLowerCase();
  return (
    MODULE_TEMPLATES.find((t) => t.match.includes(id)) ??
    MODULE_TEMPLATES.find((t) => t.match.includes(cat)) ??
    null
  );
}

// ---- static / coding parameters ------------------------------------------

export interface ConfigParam {
  id: string;
  label: string;
  value: string | number | boolean;
  type: "text" | "number" | "bool" | "enum";
  unit?: string;
  editable: boolean;
  options?: string[];   // for enum
  did?: string;         // DID it maps to (WriteDataByIdentifier)
  note?: string;
}

/** Configuration/coding blocks per module key. Editable ones write via 2E (coding). */
export const MODULE_CONFIG: Record<string, ConfigParam[]> = {
  ecm: [
    { id: "rev_limit", label: "Rev limiter", value: 6400, type: "number", unit: "rpm", editable: true, did: "0121" },
    { id: "spd_limit", label: "Speed limiter", value: 180, type: "number", unit: "km/h", editable: true, did: "0122" },
    { id: "idle_tgt", label: "Idle target", value: 700, type: "number", unit: "rpm", editable: true, did: "0123" },
    { id: "fuel", label: "Fuel type", value: "Gasoline", type: "enum", options: ["Gasoline", "E85", "Diesel"], editable: false },
    { id: "cal_id", label: "Calibration ID", value: "352A100", type: "text", editable: false },
    { id: "vin_w", label: "VIN (stored)", value: "@VIN", type: "text", editable: true, did: "F190", note: "Writing VIN is legally sensitive." },
  ],
  tcm: [
    { id: "shift_mode", label: "Default shift map", value: "Normal", type: "enum", options: ["Eco", "Normal", "Sport"], editable: true, did: "0130" },
    { id: "cvt_adapt", label: "Adaptive shifting", value: true, type: "bool", editable: true, did: "0131" },
    { id: "stall", label: "Stall speed", value: 2300, type: "number", unit: "rpm", editable: false },
  ],
  abs: [
    { id: "trac_default", label: "TRAC on at startup", value: true, type: "bool", editable: true, did: "0140" },
    { id: "tire_size", label: "Tire rolling radius", value: 317, type: "number", unit: "mm", editable: true, did: "0141" },
    { id: "variant", label: "Brake system variant", value: "ADVICS-4CH", type: "text", editable: false },
  ],
  srs: [
    { id: "occ_cal", label: "Occupant sensor", value: "Calibrated", type: "enum", options: ["Calibrated", "Needs cal"], editable: false },
    { id: "deploy_cnt", label: "Deployment count", value: 0, type: "number", editable: false },
    { id: "belt_reminder", label: "Passenger belt reminder", value: true, type: "bool", editable: true, did: "0150" },
  ],
  bcm: [
    { id: "auto_lock", label: "Auto-lock speed", value: 20, type: "number", unit: "km/h", editable: true, did: "0160" },
    { id: "unlock_mode", label: "Unlock mode", value: "Driver door", type: "enum", options: ["Driver door", "All doors"], editable: true, did: "0161" },
    { id: "lock_chirp", label: "Horn chirp on lock", value: false, type: "bool", editable: true, did: "0162" },
    { id: "drl", label: "Daytime running lights", value: true, type: "bool", editable: true, did: "0163" },
    { id: "hl_delay", label: "Headlight-off delay", value: 30, type: "number", unit: "s", editable: true, did: "0164" },
  ],
  meter: [
    { id: "units", label: "Display units", value: "km", type: "enum", options: ["km", "mi"], editable: true, did: "0170" },
    { id: "lang", label: "Language", value: "EN", type: "enum", options: ["EN", "FR", "ES", "JP"], editable: true, did: "0171" },
    { id: "svc_interval", label: "Service interval", value: 16000, type: "number", unit: "km", editable: true, did: "0172" },
    { id: "odo", label: "Odometer", value: 48213, type: "number", unit: "km", editable: false, note: "Odometer is tamper-protected — never writable." },
  ],
  hvac: [
    { id: "def_temp", label: "Default set temp", value: 21.5, type: "number", unit: "°C", editable: true, did: "0180" },
    { id: "auto_fan", label: "Auto fan on start", value: true, type: "bool", editable: true, did: "0181" },
    { id: "defog_timer", label: "Rear defog timer", value: 15, type: "number", unit: "min", editable: true, did: "0182" },
  ],
  fcm: [
    { id: "pcs_sens", label: "PCS sensitivity", value: "Mid", type: "enum", options: ["Near", "Mid", "Far"], editable: true, did: "0190" },
    { id: "lda", label: "Lane-departure alert", value: true, type: "bool", editable: true, did: "0191" },
    { id: "follow", label: "Following distance", value: "2", type: "enum", options: ["1", "2", "3"], editable: true, did: "0192" },
  ],
  eps: [
    { id: "assist_mode", label: "Assist tuning", value: "Normal", type: "enum", options: ["Comfort", "Normal", "Sport"], editable: true, did: "01A0" },
    { id: "lka_gain", label: "Lane-keep steer gain", value: 50, type: "number", unit: "%", editable: true, did: "01A1" },
  ],
  gateway: [
    { id: "sgw", label: "Security gateway", value: true, type: "bool", editable: false, note: "Cannot be disabled." },
    { id: "diag_routing", label: "Diagnostic routing", value: "Standard", type: "enum", options: ["Standard", "Extended"], editable: false },
  ],
  cert: [
    { id: "reg_keys", label: "Registered keys", value: 2, type: "number", editable: false },
    { id: "auto_relock", label: "Auto re-lock timer", value: 30, type: "number", unit: "s", editable: true, did: "01B0" },
  ],
  park: [
    { id: "sens", label: "Sonar sensitivity", value: "Normal", type: "enum", options: ["Low", "Normal", "High"], editable: true, did: "01C0" },
    { id: "vol", label: "Buzzer volume", value: 3, type: "number", editable: true, did: "01C1" },
  ],
};

/**
 * How a module's full memory image is actually obtainable:
 *  - "obd"         : fully readable over the OBD bus (simpler/body modules).
 *  - "obd_partial" : OBD exposes identifiers/calibration; full firmware needs bench.
 *  - "bench"       : read-protected — full image requires bench / boot-mode (T48/JTAG).
 * This is the honest reality that separates diagnostics from true cloning.
 */
export type ReadMethod = "obd" | "obd_partial" | "bench";

export interface ModuleMemory { flashKb: number; eepromKb: number; read: ReadMethod; note?: string; }

/** Simulated on-chip memory sizes + real-world read method per module. */
export const MODULE_MEMORY: Record<string, ModuleMemory> = {
  ecm:     { flashKb: 2048, eepromKb: 4,  read: "bench", note: "Denso flash is read-protected — full image needs bench/boot-mode." },
  tcm:     { flashKb: 1024, eepromKb: 2,  read: "bench" },
  "tcm-at":{ flashKb: 1024, eepromKb: 2,  read: "bench", note: "Transmission mechatronics flash is read-protected — bench only." },
  abs:     { flashKb: 512,  eepromKb: 2,  read: "obd_partial" },
  srs:     { flashKb: 256,  eepromKb: 2,  read: "obd_partial", note: "Crash/config EEPROM partly OBD-readable; code flash needs bench." },
  bcm:     { flashKb: 512,  eepromKb: 8,  read: "obd", note: "Body ECU config is OBD-readable." },
  meter:   { flashKb: 512,  eepromKb: 16, read: "bench", note: "Odometer EEPROM is tamper-protected — bench only." },
  hvac:    { flashKb: 128,  eepromKb: 1,  read: "obd" },
  fcm:     { flashKb: 1024, eepromKb: 2,  read: "obd_partial" },
  eps:     { flashKb: 512,  eepromKb: 2,  read: "obd_partial" },
  gateway: { flashKb: 1024, eepromKb: 4,  read: "bench", note: "Security gateway — locked routing hub." },
  cert:    { flashKb: 512,  eepromKb: 4,  read: "bench", note: "Smart key / immobiliser — security-locked." },
  park:    { flashKb: 256,  eepromKb: 1,  read: "obd" },
};

export function readMethodFor(key: string): ReadMethod {
  return MODULE_MEMORY[key]?.read ?? "obd_partial";
}

/** Codes that re-set after clearing (active faults). Anything NOT listed clears for good. */
export const ACTIVE_DTCS: Record<string, string[]> = {
  ecm: ["P0300", "P0420"], tcm: ["P0740"], "tcm-at": ["P0730"], abs: ["C1201"], srs: ["B1650"],
  bcm: ["U0155"], meter: ["U0100"], hvac: [], fcm: ["C1AA0"],
  eps: ["C1511"], gateway: ["U0073"], cert: ["B2799"], park: [],
};
