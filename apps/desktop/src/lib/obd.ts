/**
 * Renderer-side helper for the OBD-II reader device.
 *
 * The OBD reader is a second RP2040 firmware (hardware/obd-reader/firmware/main.py)
 * that speaks the SAME line-based "command -> OK/ERR" protocol as PicoForge, so it
 * rides the EXISTING main-process serial session (Api.pico.findPort / .command) with
 * no new IPC. Where picoforge.ts reads/writes chip memory, this one polls live car
 * telemetry: battery voltage now, CAN frames once a can2040 firmware is flashed.
 */
import { Api } from "./api";
import {
  decodeDtcs,
  decodePidResponse,
  decodeVin,
  MODE,
  pidsFromMask,
  RANGE_PIDS,
  VIN_PID,
  type Dtc,
  type PidReading,
} from "./obd-protocol";

/** One battery sample, parsed from a `BATT` reply: `<ms>,<volts>,<state>,<vmin>,<vmax>`. */
export interface Telemetry {
  ms: number;
  volts: number;
  state: "LOW" | "OK" | "CHARGING";
  vmin: number;
  vmax: number;
}

export interface CanFrame {
  /** 11- or 29-bit arbitration id. */
  id: number;
  /** Payload bytes as lowercase hex (0–8 bytes, 16 chars max). */
  data: string;
}

/** A decoded OBD-II mode-01 parameter (RPM, speed, …) from an ECU response frame. */
export interface DecodedPid {
  pid: number;
  label: string;
  value: number;
  unit: string;
}

/** Bench-simulator scenarios understood by the firmware's SIM command. */
export type SimScenario = "OFF" | "IGNITION" | "WEAK" | "IDLE" | "DRIVE";

function throwIfErr(reply: string): void {
  if (reply.startsWith("ERR")) throw new Error(reply.replace(/^ERR\s*/, "OBD reader: "));
}

function payload(reply: string): string {
  return reply.replace(/^OK\s*/, "").trim();
}

export const Obd = {
  /** Auto-detect the Pico's COM port (RP2040 USB id 2E8A). Null if not found. */
  findPort: (): Promise<string | null> => Api.pico.findPort(),

  /**
   * Connects (reboots the firmware so we start clean) and confirms the Pico is
   * running the OBD-Reader firmware — not PicoForge on the same RP2040 USB id.
   * Returns the firmware banner (e.g. "OBD-Reader v1").
   */
  async identify(port: string): Promise<string> {
    const reply = await Api.pico.command({ port, command: "PING", reboot: true });
    throwIfErr(reply);
    const banner = payload(reply);
    if (!/OBD/i.test(banner)) {
      throw new Error(
        `That Pico is running "${banner}", not the OBD-Reader firmware. Flash ` +
          `hardware/obd-reader/firmware/main.py (see FLASH.md) and reconnect.`,
      );
    }
    return banner;
  },

  /** One live battery sample. */
  async readTelemetry(port: string): Promise<Telemetry> {
    const reply = await Api.pico.command({ port, command: "BATT" });
    throwIfErr(reply);
    return parseTelemetry(payload(reply));
  },

  /** Clears the firmware's session min/max trackers. */
  async resetMinMax(port: string): Promise<void> {
    throwIfErr(await Api.pico.command({ port, command: "RESET" }));
  },

  /** Sets the battery-divider calibration ratio; returns the value the firmware echoes. */
  async calibrate(port: string, ratio: number): Promise<number> {
    const reply = await Api.pico.command({ port, command: `CAL ${ratio.toFixed(3)}` });
    throwIfErr(reply);
    const m = payload(reply).match(/ratio=([\d.]+)/);
    return m ? Number(m[1]) : ratio;
  },

  /**
   * Brings up the CAN bus. On stock MicroPython this throws an honest error
   * (RP2040 has no hardware CAN — needs a can2040 firmware build).
   */
  async canInit(port: string, bitrate = 500000): Promise<void> {
    throwIfErr(await Api.pico.command({ port, command: `CANINIT ${bitrate}` }));
  },

  /** Recent CAN frames, newest last. Empty array when the bus is quiet. */
  async canDump(port: string): Promise<CanFrame[]> {
    const reply = await Api.pico.command({ port, command: "CANDUMP" });
    throwIfErr(reply);
    return parseCanFrames(payload(reply));
  },

  /**
   * Bench simulator: makes the firmware feed FAKE telemetry + CAN frames so the
   * app can be exercised end-to-end with no car. `OFF` returns to live readings.
   * This is a SIMULATION — the UI flags it so it's never mistaken for a real car.
   */
  async setSim(port: string, scenario: SimScenario): Promise<void> {
    throwIfErr(await Api.pico.command({ port, command: `SIM ${scenario}` }));
  },

  /**
   * One OBD-II request/response round-trip. Sends `OBD <mode> [<pid>]`; the
   * firmware (sim now, real CAN later) returns the response DATA bytes. Throws
   * on a real (non-sim) device until can2040 firmware is flashed.
   */
  async query(port: string, mode: number, pid?: number): Promise<number[]> {
    const hx = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
    const command = pid === undefined ? `OBD ${hx(mode)}` : `OBD ${hx(mode)} ${hx(pid)}`;
    const reply = await Api.pico.command({ port, command });
    throwIfErr(reply);
    return hexBytes(payload(reply));
  },

  /**
   * Discovers which Mode-01 PIDs this vehicle supports by walking the
   * 0x00/0x20/0x40/… bitmask chain. Returns the real (non-range-marker) PIDs.
   */
  async scanSupportedPids(port: string): Promise<number[]> {
    const supported: number[] = [];
    let base = 0x00;
    for (let guard = 0; guard < 7; guard++) {
      let data: number[];
      try {
        data = await Obd.query(port, MODE.CURRENT, base);
      } catch {
        break; // ECU doesn't support this range request
      }
      const mask = data.slice(1); // drop the echoed PID byte
      const pids = pidsFromMask(base, mask);
      const nextBase = base + 0x20;
      const chained = pids.includes(nextBase);
      for (const p of pids) if (!RANGE_PIDS.has(p)) supported.push(p);
      if (!chained) break;
      base = nextBase;
    }
    return supported;
  },

  /** Reads and decodes one live PID. Returns null if it didn't decode. */
  async readPid(port: string, pid: number): Promise<PidReading | null> {
    const data = await Obd.query(port, MODE.CURRENT, pid);
    return decodePidResponse(data);
  },

  /** Reads stored (Mode 03), pending (07) and permanent (0A) trouble codes. */
  async readDtcs(port: string): Promise<{ stored: Dtc[]; pending: Dtc[]; permanent: Dtc[] }> {
    const [stored, pending, permanent] = await Promise.all([
      Obd.query(port, MODE.STORED_DTC).then(decodeDtcs),
      Obd.query(port, MODE.PENDING_DTC).then(decodeDtcs),
      Obd.query(port, MODE.PERMANENT_DTC).then(decodeDtcs),
    ]);
    return { stored, pending, permanent };
  },

  /** Clears DTCs and turns off the check-engine light. This WRITES to the car. */
  async clearDtcs(port: string): Promise<void> {
    await Obd.query(port, MODE.CLEAR_DTC);
  },

  /** Reads the VIN (Mode 09 PID 02). Empty string if unavailable. */
  async readVin(port: string): Promise<string> {
    const data = await Obd.query(port, MODE.VEHICLE_INFO, VIN_PID);
    return decodeVin(data);
  },

  /** Drops the persistent serial session for this port. */
  disconnect: (port: string): Promise<{ stopped: boolean }> => Api.pico.disconnect(port),
};

/** Parses `<ms>,<volts>,<state>,<vmin>,<vmax>` into a Telemetry. Throws on garbage. */
export function parseTelemetry(csv: string): Telemetry {
  const f = csv.split(",");
  if (f.length < 5) throw new Error(`Unexpected telemetry "${csv}".`);
  const ms = Number(f[0]);
  const volts = Number(f[1]);
  const vmin = Number(f[3]);
  const vmax = Number(f[4]);
  const state = f[2] as Telemetry["state"];
  if (![ms, volts, vmin, vmax].every(Number.isFinite)) throw new Error(`Unexpected telemetry "${csv}".`);
  return { ms, volts, state, vmin, vmax };
}

/** Parses `id#hex id#hex …` (the CANDUMP payload) into frames. "(no frames)" → []. */
export function parseCanFrames(text: string): CanFrame[] {
  if (!text || text === "(no frames)") return [];
  const out: CanFrame[] = [];
  for (const tok of text.split(/\s+/)) {
    const [idHex, data] = tok.split("#");
    const id = parseInt(idHex, 16);
    if (Number.isFinite(id)) out.push({ id, data: (data ?? "").toLowerCase() });
  }
  return out;
}

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/**
 * Decodes an OBD-II mode-01 response frame (ECU id 0x7E8, payload
 * `[len, 0x41, PID, A, B, …]`) into a human value. Returns null for frames that
 * aren't a decodable PID response. Covers the common live PIDs; extend as needed.
 */
export function decodePid(f: CanFrame): DecodedPid | null {
  const b = hexBytes(f.data);
  if (f.id !== 0x7e8 || b.length < 3 || b[1] !== 0x41) return null;
  const pid = b[2];
  const A = b[3] ?? 0;
  const B = b[4] ?? 0;
  switch (pid) {
    case 0x0c: return { pid, label: "Engine RPM", value: (A * 256 + B) / 4, unit: "rpm" };
    case 0x0d: return { pid, label: "Vehicle speed", value: A, unit: "km/h" };
    case 0x05: return { pid, label: "Coolant temp", value: A - 40, unit: "°C" };
    case 0x0f: return { pid, label: "Intake air temp", value: A - 40, unit: "°C" };
    case 0x11: return { pid, label: "Throttle", value: Math.round((A * 100) / 255), unit: "%" };
    case 0x04: return { pid, label: "Engine load", value: Math.round((A * 100) / 255), unit: "%" };
    default: return null;
  }
}
