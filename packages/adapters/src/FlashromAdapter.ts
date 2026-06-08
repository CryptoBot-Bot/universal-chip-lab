import type { Protocol } from "@ecu/chip-db";

import {
  AdapterStatus,
  ProgrammerAdapter,
  ReadMemoryRequest,
  ReadMemoryResult,
} from "./ProgrammerAdapter.js";
import {
  flashromRead,
  type FlashromBackend,
} from "./tools/flashromRunner.js";
import { detectTool } from "./tools/toolDetection.js";

/**
 * Direct flashrom adapter — the operator picks the underlying programmer
 * string explicitly. Useful when none of the wrapped adapters (CH341A,
 * FT232H, Bus Pirate) cover the hardware on hand.
 */
export class FlashromAdapter implements ProgrammerAdapter {
  readonly adapterId = "flashrom";
  readonly displayName = "flashrom (manual programmer string)";
  readonly type = "external_tool" as const;
  readonly supportedProtocols: Protocol[] = ["spi"];
  readonly supportedVoltages = [1.8, 3.3, 5.0];
  readonly canMeasureVoltage = false;
  readonly canControlPower = false;
  readonly canRead = true;
  readonly canWrite = false;
  readonly safetyLevel = "field" as const;
  readonly description =
    "Pass-through to the flashrom binary. Operator supplies the programmer string (e.g. `dediprog`, `serprog:dev=/dev/ttyUSB0:115200`). For ad-hoc support of programmers we don't model directly.";

  private connected = false;
  private backend: FlashromBackend = { adapter: "ch341a_spi" };

  setBackend(b: FlashromBackend): void {
    this.backend = b;
  }

  async connect(): Promise<void> {
    const status = await detectTool("flashrom");
    if (!status.installed) {
      throw new Error(`flashrom needs to be on PATH. ${status.detail}`);
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getStatus(): Promise<AdapterStatus> {
    const status = await detectTool("flashrom");
    if (!status.installed) {
      return { state: "disconnected", message: "flashrom not detected on PATH." };
    }
    return {
      state: this.connected ? "connected" : "disconnected",
      message: this.connected
        ? `flashrom ready; backend = ${describe(this.backend)}.`
        : "flashrom ready; call connect() to arm.",
      firmware: status.version ?? "flashrom",
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
      throw new Error("flashrom adapter is not connected. Call connect() first.");
    }
    const result = await flashromRead({
      backend: this.backend,
      chipProfile: request.chipProfile,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
    return {
      data: result.data,
      durationMs: result.durationMs,
      meta: {
        backend: describe(this.backend),
        command: result.command,
        tag: request.tag,
        raw: result.rawOutput.slice(-2000),
      },
    };
  }
}

function describe(b: FlashromBackend): string {
  switch (b.adapter) {
    case "ch341a_spi":   return "ch341a_spi";
    case "ft2232_spi":   return `ft2232_spi:type=${b.type}`;
    case "buspirate_spi": return `buspirate_spi:dev=${b.dev}`;
    case "serprog":      return `serprog:dev=${b.dev}`;
  }
}
