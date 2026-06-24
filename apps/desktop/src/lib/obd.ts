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
import { moduleFor, PHYSICAL_REQ_ADDRS, type ModuleAddr } from "./modules";
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
import {
  buildReadDataById,
  buildReadDtcByStatus,
  buildTesterPresent,
  DID,
  negativeResponse,
  parseUdsDtcs,
  parseUdsVin,
} from "./uds";

/** Everything we learned about one module in a full vehicle scan. */
export interface ModuleReport {
  addr: ModuleAddr;
  dtcs: Dtc[];
  vin?: string;
  notes: string[];
}

const hx2 = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();

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

  /** Reads the firmware's current divider ratio (from INFO). Defaults to 5.7. */
  async readRatio(port: string): Promise<number> {
    const reply = await Api.pico.command({ port, command: "INFO" });
    throwIfErr(reply);
    const m = payload(reply).match(/ratio=([\d.]+)/);
    return m ? Number(m[1]) : 5.7;
  },

  /** Reads the HS-CAN bitrate (from INFO). Defaults to 500000. */
  async readBitrate(port: string): Promise<number> {
    const reply = await Api.pico.command({ port, command: "INFO" });
    throwIfErr(reply);
    const m = payload(reply).match(/can=up@(\d+)/);
    return m ? Number(m[1]) : 500000;
  },

  /** Reads the MS-CAN bitrate (from INFO). Defaults to 125000. */
  async readBitrateMs(port: string): Promise<number> {
    const reply = await Api.pico.command({ port, command: "INFO" });
    throwIfErr(reply);
    const m = payload(reply).match(/ms=up@(\d+)/);
    return m ? Number(m[1]) : 125000;
  },

  /**
   * Sets a bus bitrate (125000/250000/500000) — stored in flash; the reader
   * reboots into the new speed, so the caller should reconnect afterwards.
   * `bus` 0 = HS-CAN, 1 = MS-CAN.
   */
  async setBusSpeed(port: string, bitrate: number, bus = 0): Promise<void> {
    const cmd = bus === 1 ? `SPEEDMS ${bitrate}` : `SPEED ${bitrate}`;
    await Api.pico.command({ port, command: cmd, timeoutMs: 2000 }).catch(() => undefined);
  },

  /**
   * One-shot calibration to a known voltage. Reads the live value with the
   * current ratio, then back-solves: newRatio = ratioNow × (actual / shown).
   * Self-correcting even if the ratio was previously set wrong. Returns the new
   * ratio. Throws if the sense pin reads ~0 V (no source connected yet).
   */
  async calibrateToVoltage(port: string, actualVolts: number): Promise<number> {
    const ratioNow = await Obd.readRatio(port);
    const sample = await Obd.readTelemetry(port);
    if (sample.volts <= 0.1) {
      throw new Error("Sense pin reads ~0 V — feed the known voltage into the 12 V input first, then calibrate.");
    }
    const newRatio = (ratioNow * actualVolts) / sample.volts;
    return Obd.calibrate(port, newRatio);
  },

  /**
   * Brings up the CAN bus. On stock MicroPython this throws an honest error
   * (RP2040 has no hardware CAN — needs a can2040 firmware build).
   */
  async canInit(port: string, bitrate = 500000): Promise<void> {
    throwIfErr(await Api.pico.command({ port, command: `CANINIT ${bitrate}` }));
  },

  /**
   * Recovers a bus-off controller by rebooting the reader (re-inits can2040,
   * reloads calibration). The USB port drops, so the caller should reconnect.
   * Errors are swallowed — the reboot itself kills the in-flight reply.
   */
  async resetCan(port: string): Promise<void> {
    await Api.pico.command({ port, command: "CANRESET", timeoutMs: 2000 }).catch(() => undefined);
  },

  /**
   * Recent CAN frames, newest last. `bus` 0 = HS-CAN (pins 6/14), 1 = MS-CAN
   * (pins 3/11, 2nd transceiver). Empty array when the bus is quiet.
   */
  async canDump(port: string, bus = 0): Promise<CanFrame[]> {
    const reply = await Api.pico.command({ port, command: bus === 1 ? "CANDUMP2" : "CANDUMP" });
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

  /**
   * Raw ISO-TP request to any CAN address — the universal primitive behind both
   * OBD-II and UDS. Returns the full response bytes (including the service byte).
   * Throws on timeout / device error.
   */
  async isotp(port: string, txid: number, bytes: number[]): Promise<number[]> {
    const command = `ISOTP ${txid.toString(16).toUpperCase()} ${bytes.map(hx2).join("")}`;
    const reply = await Api.pico.command({ port, command });
    throwIfErr(reply);
    return hexBytes(payload(reply));
  },

  /**
   * RE tool: sends a request to `txid`, then returns every DISTINCT frame seen on
   * the bus for ~0.8 s. Reveals responses on non-standard addresses (any id that
   * appears here but isn't a normal periodic broadcast is a candidate response).
   */
  async reqdump(port: string, txid: number, bytes: number[]): Promise<CanFrame[]> {
    const command = `REQDUMP ${txid.toString(16).toUpperCase()} ${bytes.map(hx2).join("")}`;
    const reply = await Api.pico.command({ port, command, timeoutMs: 4000 });
    throwIfErr(reply);
    return parseCanFrames(payload(reply));
  },

  /** Module discovery: returns the CAN response addresses that answered. */
  async probe(port: string): Promise<number[]> {
    const reply = await Api.pico.command({ port, command: "PROBE", timeoutMs: 4000 });
    throwIfErr(reply);
    const p = payload(reply);
    if (!p || p === "(none)") return [];
    return p.split(/\s+/).map((s) => parseInt(s, 16)).filter((n) => Number.isFinite(n));
  },

  /**
   * Discovers every module on the bus: OBD-II functional discovery (PROBE) plus
   * a UDS tester-present ping to each physical address (catches UDS-only modules
   * like the TCM that don't answer generic OBD-II).
   */
  async discoverModules(port: string): Promise<ModuleAddr[]> {
    const found = new Set<number>();
    for (const r of await Obd.probe(port).catch(() => [])) found.add(r);
    for (const req of PHYSICAL_REQ_ADDRS) {
      if (found.has(req + 8)) continue;
      try {
        const resp = await Obd.isotp(port, req, buildTesterPresent());
        if (resp.length) found.add(req + 8); // any reply (positive or negative) = present
      } catch {
        /* no response → module not present */
      }
    }
    return [...found].sort((a, b) => a - b).map(moduleFor);
  },

  /**
   * Full vehicle scan: discover all modules, then read each one's DTCs (UDS
   * service 0x19) and VIN (0x22/F190). Calls onProgress per module so the UI can
   * stream results.
   */
  async scanAllModules(
    port: string,
    onProgress?: (addr: ModuleAddr, index: number, total: number) => void,
  ): Promise<ModuleReport[]> {
    const modules = await Obd.discoverModules(port);
    const reports: ModuleReport[] = [];
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i];
      onProgress?.(m, i, modules.length);
      const report: ModuleReport = { addr: m, dtcs: [], notes: [] };
      try {
        const resp = await Obd.isotp(port, m.req, buildReadDtcByStatus(0xff));
        const nrc = negativeResponse(resp);
        if (nrc) report.notes.push(`DTCs: ${nrc}`);
        else report.dtcs = parseUdsDtcs(resp);
      } catch {
        report.notes.push("DTCs: no response");
      }
      try {
        const resp = await Obd.isotp(port, m.req, buildReadDataById(DID.VIN));
        if (!negativeResponse(resp)) {
          const vin = parseUdsVin(resp);
          if (vin) report.vin = vin;
        }
      } catch {
        /* not every module stores the VIN */
      }
      reports.push(report);
    }
    return reports;
  },

  /** Clears DTCs on a specific module via UDS service 0x14. WRITES to the car. */
  async clearModuleDtcs(port: string, reqAddr: number): Promise<void> {
    await Obd.isotp(port, reqAddr, [0x14, 0xff, 0xff, 0xff]).catch(() => undefined);
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
