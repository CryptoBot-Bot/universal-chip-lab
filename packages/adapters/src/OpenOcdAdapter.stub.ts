import type { Protocol } from "@ecu/chip-db";
import {
  AdapterStatus,
  NotImplementedError,
  ProgrammerAdapter,
  ReadMemoryRequest,
  ReadMemoryResult,
} from "./ProgrammerAdapter.js";

/**
 * Wrapper around OpenOCD for JTAG/SWD debug-port access. Real implementation
 * will spawn `openocd` with a per-target board/interface config and talk to
 * its telnet/tcl port. Scheduled for Milestone 4.
 */
export class OpenOcdAdapter implements ProgrammerAdapter {
  readonly adapterId = "openocd";
  readonly displayName = "OpenOCD (external tool)";
  readonly type = "external_tool" as const;
  readonly supportedProtocols: Protocol[] = ["jtag", "swd"];
  readonly supportedVoltages = [1.8, 3.3];
  readonly canMeasureVoltage = false;
  readonly canControlPower = false;
  readonly canRead = false;
  readonly canWrite = false;
  readonly safetyLevel = "field" as const;
  readonly description =
    "Wraps the external OpenOCD binary for JTAG / SWD on-chip debugging and programming. Scheduled for Milestone 4 (automotive MCU profiles will arrive at the same time).";

  async connect(): Promise<void> {
    throw new NotImplementedError(this.adapterId, "connect");
  }
  async disconnect(): Promise<void> {
    /* no-op */
  }
  async getStatus(): Promise<AdapterStatus> {
    return {
      state: "disconnected",
      message: "OpenOCD wrapper not yet implemented (Milestone 4).",
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
