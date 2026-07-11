/**
 * Standard OBD-II / SAE J1979 PID table — public, universal, unencumbered.
 *
 * Two jobs:
 *  1) DECODE — turn a raw response (Mode 41 <pid> <bytes…>) into a real value+unit
 *     for the cockpit gauges.
 *  2) SIMULATE — given a small VehicleState, ENCODE realistic raw bytes so the
 *     Simulator device can answer a scan-tool request with no hardware attached.
 *
 * Browser+node safe, dependency-free.
 */

export interface PidDef {
  pid: number;                 // Mode 01 PID
  name: string;
  unit: string;
  bytes: number;               // data byte count
  decode: (d: number[]) => number;                 // raw data bytes → value
  sample: (s: VehicleState) => number[];           // VehicleState → raw data bytes
  min?: number;
  max?: number;
}

/** Minimal live state the simulator drives; extend as needed. */
export interface VehicleState {
  rpm: number;         // engine rpm
  speedKmh: number;    // road speed
  coolantC: number;    // coolant temp °C
  intakeC: number;     // intake air temp °C
  ambientC: number;    // ambient °C
  throttlePct: number; // 0..100
  loadPct: number;     // 0..100
  mafGps: number;      // g/s
  fuelPct: number;     // 0..100
  voltage: number;     // control module voltage
  runtimeS: number;    // seconds since start
}

export const DEFAULT_IDLE: VehicleState = {
  rpm: 720, speedKmh: 0, coolantC: 89, intakeC: 32, ambientC: 24,
  throttlePct: 14, loadPct: 21, mafGps: 3.1, fuelPct: 68, voltage: 14.1, runtimeS: 0,
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];

/** Canonical PID definitions. decode/sample are inverses of the SAE formula. */
export const PIDS: PidDef[] = [
  { pid: 0x04, name: "Calculated engine load", unit: "%", bytes: 1,
    decode: d => (d[0] * 100) / 255, sample: s => [Math.round((clamp(s.loadPct, 0, 100) / 100) * 255)], min: 0, max: 100 },
  { pid: 0x05, name: "Coolant temperature", unit: "°C", bytes: 1,
    decode: d => d[0] - 40, sample: s => [Math.round(clamp(s.coolantC, -40, 215)) + 40], min: -40, max: 215 },
  { pid: 0x0a, name: "Fuel pressure", unit: "kPa", bytes: 1,
    decode: d => d[0] * 3, sample: () => [Math.round(300 / 3)], min: 0, max: 765 },
  { pid: 0x0b, name: "Intake manifold pressure", unit: "kPa", bytes: 1,
    decode: d => d[0], sample: s => [Math.round(clamp(30 + s.loadPct, 20, 255))], min: 0, max: 255 },
  { pid: 0x0c, name: "Engine RPM", unit: "rpm", bytes: 2,
    decode: d => (d[0] * 256 + d[1]) / 4, sample: s => u16(Math.round(clamp(s.rpm, 0, 16383) * 4)), min: 0, max: 16383 },
  { pid: 0x0d, name: "Vehicle speed", unit: "km/h", bytes: 1,
    decode: d => d[0], sample: s => [Math.round(clamp(s.speedKmh, 0, 255))], min: 0, max: 255 },
  { pid: 0x0e, name: "Timing advance", unit: "°", bytes: 1,
    decode: d => d[0] / 2 - 64, sample: () => [Math.round((10 + 64) * 2)], min: -64, max: 63 },
  { pid: 0x0f, name: "Intake air temperature", unit: "°C", bytes: 1,
    decode: d => d[0] - 40, sample: s => [Math.round(clamp(s.intakeC, -40, 215)) + 40], min: -40, max: 215 },
  { pid: 0x10, name: "MAF air flow", unit: "g/s", bytes: 2,
    decode: d => (d[0] * 256 + d[1]) / 100, sample: s => u16(Math.round(clamp(s.mafGps, 0, 655) * 100)), min: 0, max: 655 },
  { pid: 0x11, name: "Throttle position", unit: "%", bytes: 1,
    decode: d => (d[0] * 100) / 255, sample: s => [Math.round((clamp(s.throttlePct, 0, 100) / 100) * 255)], min: 0, max: 100 },
  { pid: 0x1f, name: "Run time since start", unit: "s", bytes: 2,
    decode: d => d[0] * 256 + d[1], sample: s => u16(clamp(Math.round(s.runtimeS), 0, 65535)), min: 0, max: 65535 },
  { pid: 0x2f, name: "Fuel level", unit: "%", bytes: 1,
    decode: d => (d[0] * 100) / 255, sample: s => [Math.round((clamp(s.fuelPct, 0, 100) / 100) * 255)], min: 0, max: 100 },
  { pid: 0x33, name: "Barometric pressure", unit: "kPa", bytes: 1,
    decode: d => d[0], sample: () => [101], min: 0, max: 255 },
  { pid: 0x42, name: "Control module voltage", unit: "V", bytes: 2,
    decode: d => (d[0] * 256 + d[1]) / 1000, sample: s => u16(Math.round(clamp(s.voltage, 0, 65) * 1000)), min: 0, max: 65 },
  { pid: 0x46, name: "Ambient air temperature", unit: "°C", bytes: 1,
    decode: d => d[0] - 40, sample: s => [Math.round(clamp(s.ambientC, -40, 215)) + 40], min: -40, max: 215 },
  { pid: 0x5c, name: "Engine oil temperature", unit: "°C", bytes: 1,
    decode: d => d[0] - 40, sample: s => [Math.round(clamp(s.coolantC + 8, -40, 215)) + 40], min: -40, max: 215 },
];

export const PID_BY_ID: Record<number, PidDef> = Object.fromEntries(PIDS.map(p => [p.pid, p]));

/** Mode 01 PID 0x00/0x20/… "supported PIDs" bitmask (4 bytes) for a base of 0x00/0x20. */
export function supportedMask(base: number, supported: number[]): number[] {
  const bits = new Array(32).fill(0);
  for (const p of supported) {
    const rel = p - base - 1; // bit 0 = base+1 … MSB first
    if (rel >= 0 && rel < 32) bits[rel] = 1;
  }
  const bytes = [0, 0, 0, 0];
  for (let i = 0; i < 32; i++) if (bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
  return bytes;
}

/** Encode a full positive Mode 41 response for one PID: [0x41, pid, ...data]. */
export function encodePidResponse(pid: number, state: VehicleState): number[] | null {
  if (pid === 0x00) return [0x41, 0x00, ...supportedMask(0x00, PIDS.map(p => p.pid).filter(p => p <= 0x20))];
  if (pid === 0x20) return [0x41, 0x20, ...supportedMask(0x20, PIDS.map(p => p.pid).filter(p => p > 0x20 && p <= 0x40))];
  if (pid === 0x40) return [0x41, 0x40, ...supportedMask(0x40, PIDS.map(p => p.pid).filter(p => p > 0x40 && p <= 0x60))];
  const def = PID_BY_ID[pid];
  if (!def) return null;
  return [0x41, pid, ...def.sample(state)];
}

/** Decode a Mode 41 response [0x41, pid, ...data] → { name, value, unit }. */
export function decodePidResponse(bytes: number[]): { pid: number; name: string; value: number; unit: string } | null {
  if (bytes.length < 2 || bytes[0] !== 0x41) return null;
  const pid = bytes[1];
  const def = PID_BY_ID[pid];
  if (!def) return null;
  const data = bytes.slice(2, 2 + def.bytes);
  return { pid, name: def.name, value: def.decode(data), unit: def.unit };
}
