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
 * Adafruit FT232H breakout — the safe, voltage-flexible bridge.
 *
 * - SPI: via flashrom `ft2232_spi:type=232h`
 * - I2C: requires pyftdi (Python); detection-only in MVP-B, real driver in
 *   Phase B+ (we'd shell to a small Python helper).
 *
 * Voltage advantage: FT232H I/O is 3.3 V native, with a 5 V tolerance on many
 * pins. Won't fry a 3.3 V part the way a bare CH341A can.
 */
export class FtdiAdapter implements ProgrammerAdapter {
  readonly adapterId = "ft232h";
  readonly displayName = "Adafruit FT232H (via flashrom)";
  readonly type = "usb_bridge" as const;
  readonly supportedProtocols: Protocol[] = ["spi", "i2c", "jtag"];
  readonly supportedVoltages = [3.3];
  readonly canMeasureVoltage = false;
  readonly canControlPower = false;
  readonly canRead = true;
  readonly canWrite = true;             // capability — Ceremony gate + ECL_OPERATION_MODE control permission
  readonly safetyLevel = "training" as const;
  readonly description =
    "USB-to-SPI/I²C/JTAG bridge driven by flashrom for SPI work. 3.3 V native I/O — safe for 3.3 V SPI NOR/EEPROM. I²C and JTAG require pyftdi (Phase B+).";

  private connected = false;
  private flashromOk: boolean | null = null;

  async connect(): Promise<void> {
    const status = await detectTool("flashrom");
    this.flashromOk = status.installed;
    if (!status.installed) {
      throw new Error(`FT232H needs flashrom on PATH. ${status.detail}`);
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
        ? "FT232H ready via flashrom (ft2232_spi:type=232h). 3.3 V I/O — safe for 3.3 V parts."
        : "FT232H configured. Call connect() to verify flashrom and arm.",
      firmware: "flashrom backend",
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
      throw new Error("FT232H is not connected. Call connect() first.");
    }
    if (request.chipProfile.protocol !== "spi") {
      throw new Error(
        `FT232H: ${request.chipProfile.protocol.toUpperCase()} chips need pyftdi (Phase B+). Use the Mock Adapter or a different adapter for now.`,
      );
    }
    const result = await flashromRead({
      backend: { adapter: "ft2232_spi", type: "232h" },
      chipProfile: request.chipProfile,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
    return {
      data: result.data,
      durationMs: result.durationMs,
      meta: {
        backend: "ft2232_spi:type=232h",
        command: result.command,
        tag: request.tag,
        raw: result.rawOutput.slice(-2000),
      },
    };
  }

  async writeMemory(request: WriteMemoryRequest): Promise<WriteMemoryResult> {
    if (!this.connected) {
      throw new Error("FT232H is not connected. Call connect() first.");
    }
    if (request.chipProfile.protocol !== "spi") {
      throw new Error(
        `FT232H: write is only routed through flashrom for SPI. ${request.chipProfile.displayName} (${request.chipProfile.protocol}) needs pyftdi (Phase B+).`,
      );
    }
    if (request.chipProfile.family !== "spi_nor_flash") {
      throw new Error(
        `FT232H: flashrom reliably writes SPI NOR Flash only. ${request.chipProfile.displayName} is a serial EEPROM — use the Mock Adapter to exercise the Cloning Ceremony until a dedicated EEPROM writer ships.`,
      );
    }
    const res = await flashromWrite({
      backend: { adapter: "ft2232_spi", type: "232h" },
      chipProfile: request.chipProfile,
      data: request.data,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
    return {
      bytesWritten: res.bytesWritten,
      durationMs: res.durationMs,
      meta: { backend: "ft2232_spi:type=232h", command: res.command, tag: request.tag, raw: res.rawOutput.slice(-2000) },
    };
  }
}
