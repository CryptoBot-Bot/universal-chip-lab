import type { Protocol } from "@ecu/chip-db";

import {
  AdapterStatus,
  ProgrammerAdapter,
  ReadMemoryRequest,
  ReadMemoryResult,
  WriteMemoryRequest,
  WriteMemoryResult,
} from "./ProgrammerAdapter.js";
import { flashromRead, flashromWrite } from "./tools/flashromRunner.js";
import { detectTool } from "./tools/toolDetection.js";

/**
 * Bus Pirate v3.6a — the "Swiss army knife" serial protocol tool the operator
 * has on hand. flashrom supports it directly via `buspirate_spi`.
 *
 * Configuration: serial device must be set via the `serialDevice` field, or
 * the adapter falls back to `process.env.ECL_BUS_PIRATE_DEV`. Defaults to
 * "COM3" on Windows / "/dev/ttyUSB0" elsewhere.
 */
export class BusPirateAdapter implements ProgrammerAdapter {
  readonly adapterId = "bus_pirate";
  readonly displayName = "Dangerous Prototypes Bus Pirate v3.6 (via flashrom)";
  readonly type = "usb_serial" as const;
  readonly supportedProtocols: Protocol[] = ["spi", "i2c", "microwire", "uart"];
  readonly supportedVoltages = [3.3, 5.0];
  readonly canMeasureVoltage = true;
  readonly canControlPower = true;
  readonly canRead = true;
  readonly canWrite = true;             // capability — Ceremony gate + ECL_OPERATION_MODE control permission
  readonly safetyLevel = "training" as const;
  readonly description =
    "Serial-protocol multi-tool. SPI via flashrom (buspirate_spi). I²C / Microwire over its menu protocol (direct-serial impl in Phase B+). 3.3/5 V switchable from firmware.";

  private connected = false;
  private flashromOk: boolean | null = null;
  private serialDevice: string;

  constructor(serialDevice?: string) {
    this.serialDevice =
      serialDevice ??
      process.env.ECL_BUS_PIRATE_DEV ??
      (process.platform === "win32" ? "COM3" : "/dev/ttyUSB0");
  }

  setSerialDevice(dev: string): void {
    this.serialDevice = dev;
  }

  async connect(): Promise<void> {
    const status = await detectTool("flashrom");
    this.flashromOk = status.installed;
    if (!status.installed) {
      throw new Error(`Bus Pirate (SPI mode) needs flashrom on PATH. ${status.detail}`);
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getStatus(): Promise<AdapterStatus> {
    if (this.flashromOk === null) this.flashromOk = (await detectTool("flashrom")).installed;
    if (!this.flashromOk) {
      return { state: "disconnected", message: "flashrom not detected on PATH." };
    }
    return {
      state: this.connected ? "connected" : "disconnected",
      message: this.connected
        ? `Bus Pirate ready (serial=${this.serialDevice}). v3.6 is SPI-rate-limited — large flash reads will be slow.`
        : `Bus Pirate configured at ${this.serialDevice}. Call connect() to verify flashrom.`,
      firmware: "flashrom backend",
      port: this.serialDevice,
    };
  }

  supportsProtocol(p: Protocol): boolean {
    return this.supportedProtocols.includes(p);
  }
  supportsVoltage(v: number): boolean {
    return this.supportedVoltages.includes(v);
  }

  async readMemory(request: ReadMemoryRequest): Promise<ReadMemoryResult> {
    if (!this.connected) {
      throw new Error("Bus Pirate is not connected. Call connect() first.");
    }
    if (request.chipProfile.protocol !== "spi") {
      throw new Error(
        `Bus Pirate: direct ${request.chipProfile.protocol.toUpperCase()} mode (binary serial protocol) is scheduled for Phase B+. Use the Mock Adapter for now.`,
      );
    }
    const result = await flashromRead({
      backend: {
        adapter: "buspirate_spi",
        dev: this.serialDevice,
        speed: 1000, // 1 MHz default; v3.6 maxes out around 8 MHz
      },
      chipProfile: request.chipProfile,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
    return {
      data: result.data,
      durationMs: result.durationMs,
      meta: {
        backend: `buspirate_spi:dev=${this.serialDevice}`,
        command: result.command,
        tag: request.tag,
        raw: result.rawOutput.slice(-2000),
      },
    };
  }

  async writeMemory(request: WriteMemoryRequest): Promise<WriteMemoryResult> {
    if (!this.connected) {
      throw new Error("Bus Pirate is not connected. Call connect() first.");
    }
    if (request.chipProfile.protocol !== "spi") {
      throw new Error(
        `Bus Pirate: direct ${request.chipProfile.protocol.toUpperCase()} write is a Phase B+ item. Use the Mock Adapter for the Cloning Ceremony for now.`,
      );
    }
    if (request.chipProfile.family !== "spi_nor_flash") {
      throw new Error(
        `Bus Pirate: flashrom reliably writes SPI NOR Flash only. ${request.chipProfile.displayName} is a serial EEPROM — exercise the Cloning Ceremony with the Mock Adapter until a dedicated EEPROM writer ships.`,
      );
    }
    const res = await flashromWrite({
      backend: { adapter: "buspirate_spi", dev: this.serialDevice, speed: 1000 },
      chipProfile: request.chipProfile,
      data: request.data,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
    return {
      bytesWritten: res.bytesWritten,
      durationMs: res.durationMs,
      meta: { backend: `buspirate_spi:dev=${this.serialDevice}`, command: res.command, tag: request.tag, raw: res.rawOutput.slice(-2000) },
    };
  }
}
