/**
 * OBD-II (ISO 15765-4 / SAE J1979) decode layer — pure functions, no I/O.
 *
 * The firmware (or, later, real can2040 CAN) returns the raw response DATA bytes
 * for a request; everything here turns those bytes into human values: live PID
 * readouts, the list of PIDs a given car supports, diagnostic trouble codes, and
 * the VIN. Kept I/O-free so it's trivial to reason about and extend — add a row to
 * PID_TABLE and that parameter shows up everywhere.
 */

/** OBD-II services we use. (05/06/08 omitted — non-CAN or rarely needed.) */
export const MODE = {
  CURRENT: 0x01, // live data (PIDs)
  FREEZE: 0x02, // freeze-frame data
  STORED_DTC: 0x03, // stored / confirmed trouble codes
  CLEAR_DTC: 0x04, // clear DTCs + turn off the MIL  (a WRITE to the car)
  PENDING_DTC: 0x07, // pending (not yet confirmed) codes
  VEHICLE_INFO: 0x09, // VIN, calibration IDs (PID 0x02 = VIN)
  PERMANENT_DTC: 0x0a, // permanent codes (survive a clear)
} as const;

export const VIN_PID = 0x02;

export interface PidDef {
  pid: number;
  label: string;
  unit: string;
  /** Decode the value bytes (those AFTER the echoed PID byte) into a number. */
  decode: (b: number[]) => number;
  /** Round to this many decimals for display (default 0). */
  decimals?: number;
}

const u16 = (b: number[]) => (b[0] ?? 0) * 256 + (b[1] ?? 0);
const pct = (b: number[]) => ((b[0] ?? 0) * 100) / 255;

/**
 * Standard Mode-01 PIDs with their J1979 scaling. Deliberately broader than what
 * the simulator fills in — a real car that supports more will light them up with
 * no further work. The 0x00/0x20/0x40… "supported PIDs" requests are handled
 * separately (they're bitmasks, not values).
 */
export const PID_TABLE: PidDef[] = [
  { pid: 0x04, label: "Engine load", unit: "%", decode: pct },
  { pid: 0x05, label: "Coolant temp", unit: "°C", decode: (b) => (b[0] ?? 0) - 40 },
  { pid: 0x06, label: "Short fuel trim B1", unit: "%", decode: (b) => ((b[0] ?? 0) - 128) * (100 / 128), decimals: 1 },
  { pid: 0x07, label: "Long fuel trim B1", unit: "%", decode: (b) => ((b[0] ?? 0) - 128) * (100 / 128), decimals: 1 },
  { pid: 0x0a, label: "Fuel pressure", unit: "kPa", decode: (b) => (b[0] ?? 0) * 3 },
  { pid: 0x0b, label: "Intake MAP", unit: "kPa", decode: (b) => b[0] ?? 0 },
  { pid: 0x0c, label: "Engine RPM", unit: "rpm", decode: (b) => u16(b) / 4 },
  { pid: 0x0d, label: "Vehicle speed", unit: "km/h", decode: (b) => b[0] ?? 0 },
  { pid: 0x0e, label: "Timing advance", unit: "°", decode: (b) => (b[0] ?? 0) / 2 - 64, decimals: 1 },
  { pid: 0x0f, label: "Intake air temp", unit: "°C", decode: (b) => (b[0] ?? 0) - 40 },
  { pid: 0x10, label: "MAF rate", unit: "g/s", decode: (b) => u16(b) / 100, decimals: 2 },
  { pid: 0x11, label: "Throttle", unit: "%", decode: pct },
  { pid: 0x1f, label: "Run time", unit: "s", decode: u16 },
  { pid: 0x21, label: "Distance w/ MIL", unit: "km", decode: u16 },
  { pid: 0x2f, label: "Fuel level", unit: "%", decode: pct },
  { pid: 0x33, label: "Barometric pressure", unit: "kPa", decode: (b) => b[0] ?? 0 },
  { pid: 0x42, label: "Module voltage", unit: "V", decode: (b) => u16(b) / 1000, decimals: 2 },
  { pid: 0x46, label: "Ambient temp", unit: "°C", decode: (b) => (b[0] ?? 0) - 40 },
  { pid: 0x5c, label: "Engine oil temp", unit: "°C", decode: (b) => (b[0] ?? 0) - 40 },
  { pid: 0x5e, label: "Fuel rate", unit: "L/h", decode: (b) => u16(b) / 20, decimals: 1 },
];

const PID_BY_NUM = new Map(PID_TABLE.map((p) => [p.pid, p]));
export function pidDef(pid: number): PidDef | undefined {
  return PID_BY_NUM.get(pid);
}

export interface PidReading {
  pid: number;
  label: string;
  unit: string;
  value: number;
  text: string;
}

/** Decodes a Mode-01 response (`[echoedPid, ...valueBytes]`) into a reading. */
export function decodePidResponse(data: number[]): PidReading | null {
  if (data.length < 1) return null;
  const pid = data[0];
  const def = pidDef(pid);
  if (!def) return null;
  const value = def.decode(data.slice(1));
  const text = `${value.toFixed(def.decimals ?? 0)} ${def.unit}`;
  return { pid, label: def.label, unit: def.unit, value, text };
}

/**
 * The "supported PIDs" requests (0x00, 0x20, 0x40, 0x60, 0x80, 0xA0, 0xC0) each
 * return a 4-byte bitmask covering the next 32 PIDs (MSB = lowest PID). The last
 * bit of each mask flags whether the *next* range is also supported (the chain).
 * Returns the supported PID numbers in this range, INCLUDING the chain marker so
 * the scanner knows to keep going.
 */
export function pidsFromMask(base: number, mask: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    const byte = mask[i >> 3] ?? 0;
    const bit = 7 - (i % 8);
    if (byte & (1 << bit)) out.push(base + i + 1);
  }
  return out;
}

/** The PID numbers that are "supported PIDs" range markers, not real parameters. */
export const RANGE_PIDS = new Set([0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0]);

export interface Dtc {
  code: string; // e.g. "P0301"
  description: string;
}

/** A few common codes so the reader shows a human description, not just the code. */
const DTC_DESCRIPTIONS: Record<string, string> = {
  P0300: "Random/multiple cylinder misfire detected",
  P0301: "Cylinder 1 misfire detected",
  P0302: "Cylinder 2 misfire detected",
  P0303: "Cylinder 3 misfire detected",
  P0304: "Cylinder 4 misfire detected",
  P0420: "Catalyst system efficiency below threshold (Bank 1)",
  P0430: "Catalyst system efficiency below threshold (Bank 2)",
  P0171: "System too lean (Bank 1)",
  P0174: "System too lean (Bank 2)",
  P0128: "Coolant thermostat below regulating temperature",
};

const DTC_LETTER = ["P", "C", "B", "U"];

/** Decodes one 2-byte DTC into its SAE code (e.g. 0x03 0x01 → "P0301"). */
export function decodeDtc(b0: number, b1: number): string {
  const letter = DTC_LETTER[(b0 >> 6) & 0x3];
  const d1 = (b0 >> 4) & 0x3;
  const d2 = b0 & 0xf;
  const d3 = (b1 >> 4) & 0xf;
  const d4 = b1 & 0xf;
  return `${letter}${d1}${d2.toString(16)}${d3.toString(16)}${d4.toString(16)}`.toUpperCase();
}

/** Decodes a Mode 03/07/0A response (raw DTC byte pairs) into codes. Skips 0000 pads. */
export function decodeDtcs(data: number[]): Dtc[] {
  const out: Dtc[] = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    if (data[i] === 0 && data[i + 1] === 0) continue; // empty slot
    const code = decodeDtc(data[i], data[i + 1]);
    out.push({ code, description: DTC_DESCRIPTIONS[code] ?? "Manufacturer-specific / see service info" });
  }
  return out;
}

/** Decodes a Mode 09 PID 02 response (`[0x02, count, ...ascii]`) into the VIN. */
export function decodeVin(data: number[]): string {
  // Drop the PID echo (0x02) and the item-count byte, keep printable ASCII.
  const ascii = data.slice(2).filter((c) => c >= 0x20 && c < 0x7f);
  return String.fromCharCode(...ascii).trim();
}
