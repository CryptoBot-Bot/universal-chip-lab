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
 * WCH CH341A USB programmer — the cheap, plentiful Amazon programmer.
 *
 * Capabilities:
 * - SPI NOR Flash (W25Q, MX25L, M25P, etc.) — via flashrom -p ch341a_spi
 * - SPI EEPROM (M95 family) — via flashrom where supported; otherwise
 *   recommend ch341prog or the FT232H / Bus Pirate backends.
 * - I2C EEPROM (24Cxx) — NOT via flashrom (CH341A I2C mode isn't supported
 *   there). For 24Cxx the operator should switch to the FT232H or Bus Pirate
 *   adapter, or install ch341eepromtool.
 *
 * Voltage: ⚠ stock board ships at 5 V on VCC. Using it on 3.3 V parts in-
 * circuit will damage them. The 1.8 V adapter in the AiTrip kit fixes this
 * for SOIC clip work — when present the operator should clip onto the 1.8 V
 * carrier, not the bare board.
 */
export class Ch341aAdapter implements ProgrammerAdapter {
  readonly adapterId = "ch341a";
  readonly displayName = "WCH CH341A (via flashrom)";
  readonly type = "usb_bridge" as const;
  readonly supportedProtocols: Protocol[] = ["spi", "i2c"];
  readonly supportedVoltages = [3.3, 5.0];
  readonly canMeasureVoltage = false;
  readonly canControlPower = false;
  readonly canRead = true;
  readonly canWrite = true;             // capability — the Ceremony gate + ECL_OPERATION_MODE control permission
  readonly safetyLevel = "training" as const;
  readonly description =
    "USB SPI programmer driven by flashrom. Use the 1.8 V adapter board for 3.3 V SPI NOR/EEPROM in-circuit; bare-board CH341A is 5 V and will damage 3.3 V parts. I2C EEPROM workflow requires the FT232H or Bus Pirate adapter instead.";

  private connected = false;
  private flashromOk: boolean | null = null;

  async connect(): Promise<void> {
    const status = await detectTool("flashrom");
    this.flashromOk = status.installed;
    if (!status.installed) {
      throw new Error(
        `CH341A needs flashrom on PATH. ${status.detail}`,
      );
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
        ? "CH341A ready via flashrom. Confirm the chip is on a 1.8/3.3 V carrier before clipping a 3.3 V part."
        : "CH341A configured. Call connect() to verify flashrom and arm.",
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
      throw new Error("CH341A is not connected. Call connect() first (this also verifies flashrom).");
    }
    if (request.chipProfile.protocol !== "spi") {
      throw new Error(
        `CH341A: ${request.chipProfile.protocol.toUpperCase()} chips are not supported through flashrom. Use the FT232H or Bus Pirate adapter for ${request.chipProfile.displayName}, or install ch341eepromtool for I2C work.`,
      );
    }
    const result = await flashromRead({
      backend: { adapter: "ch341a_spi" },
      chipProfile: request.chipProfile,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
    return {
      data: result.data,
      durationMs: result.durationMs,
      meta: {
        backend: "ch341a_spi",
        command: result.command,
        tag: request.tag,
        raw: result.rawOutput.slice(-2000),
      },
    };
  }

  async writeMemory(request: WriteMemoryRequest): Promise<WriteMemoryResult> {
    if (!this.connected) {
      throw new Error("CH341A is not connected. Call connect() first.");
    }
    if (request.chipProfile.protocol !== "spi") {
      throw new Error(
        `CH341A: write is only routed through flashrom for SPI. ${request.chipProfile.displayName} (${request.chipProfile.protocol}) is not supported here.`,
      );
    }
    if (request.chipProfile.family !== "spi_nor_flash") {
      throw new Error(
        `CH341A: flashrom reliably writes SPI NOR Flash only. ${request.chipProfile.displayName} is a serial EEPROM — flashrom may refuse to identify it (a safe no-op) but a dedicated EEPROM writer is required (future milestone). Use the Mock Adapter to exercise the Cloning Ceremony for now.`,
      );
    }
    const res = await flashromWrite({
      backend: { adapter: "ch341a_spi" },
      chipProfile: request.chipProfile,
      data: request.data,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
    return {
      bytesWritten: res.bytesWritten,
      durationMs: res.durationMs,
      meta: { backend: "ch341a_spi", command: res.command, tag: request.tag, raw: res.rawOutput.slice(-2000) },
    };
  }
}
