import type { Protocol } from "@ecu/chip-db";
import {
  AdapterStatus,
  NotImplementedError,
  ProgrammerAdapter,
  ReadMemoryRequest,
  ReadMemoryResult,
} from "./ProgrammerAdapter.js";

export class PicoAdapter implements ProgrammerAdapter {
  readonly adapterId = "pico";
  readonly displayName = "Raspberry Pi Pico (custom firmware)";
  readonly type = "usb_serial" as const;
  readonly supportedProtocols: Protocol[] = ["spi", "i2c", "microwire", "swd"];
  readonly supportedVoltages = [1.8, 3.3];
  readonly canMeasureVoltage = false;
  readonly canControlPower = true;
  readonly canRead = false;
  readonly canWrite = false;
  readonly safetyLevel = "training" as const;
  readonly description =
    "Future custom programmer firmware running on a Pi Pico — level-shifted, voltage-controlled. Driver scheduled for Milestone 5.";

  async connect(): Promise<void> {
    throw new NotImplementedError(this.adapterId, "connect");
  }
  async disconnect(): Promise<void> {
    /* no-op */
  }
  async getStatus(): Promise<AdapterStatus> {
    return {
      state: "disconnected",
      message: "Pico programmer firmware not yet authored (Milestone 5).",
    };
  }
  supportsProtocol(protocol: Protocol): boolean {
    return this.supportedProtocols.includes(protocol);
  }
  supportsVoltage(voltage: number): boolean {
    return this.supportedVoltages.includes(voltage);
  }
  async readMemory(_request: ReadMemoryRequest): Promise<ReadMemoryResult> {
    throw new NotImplementedError(this.adapterId, "readMemory");
  }
}
