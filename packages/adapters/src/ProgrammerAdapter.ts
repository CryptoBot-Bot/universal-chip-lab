import type { ChipProfile, ChipSignature, Protocol } from "@ecu/chip-db";

export type AdapterSafetyLevel = "training" | "field";

export type AdapterConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface AdapterStatus {
  state: AdapterConnectionState;
  message: string;
  port?: string | undefined;
  firmware?: string | undefined;
  measuredVoltage?: number | undefined;
}

export interface ReadMemoryRequest {
  chipProfile: ChipProfile;
  /** Optional start offset (byte). Defaults to 0. */
  offset?: number;
  /** Optional length (bytes). Defaults to full chip. */
  length?: number;
  /** Operator-friendly tag for logs ("read_1", "read_2", "post_write_verify", …). */
  tag: string;
  /** Receives progress in [0, 1] for long reads. */
  onProgress?: (fraction: number) => void;
}

export interface ReadMemoryResult {
  /** The bytes that were read. Always exactly `length` long. */
  data: Buffer;
  /** Elapsed time in milliseconds, as measured by the adapter. */
  durationMs: number;
  /** Adapter-specific metadata (raw command log, register snapshots, …). */
  meta: Record<string, unknown>;
}

export interface WriteMemoryRequest {
  chipProfile: ChipProfile;
  offset?: number;
  data: Buffer;
  tag: string;
  onProgress?: (fraction: number) => void;
}

export interface WriteMemoryResult {
  bytesWritten: number;
  durationMs: number;
  meta: Record<string, unknown>;
}

export interface VerifyMemoryRequest {
  chipProfile: ChipProfile;
  offset?: number;
  expected: Buffer;
  tag: string;
}

export interface VerifyMemoryResult {
  ok: boolean;
  firstDifferingOffset: number;
  totalDifferingBytes: number;
  durationMs: number;
}

export interface IdentifyChipRequest {
  /** Restrict probing to one protocol; otherwise the adapter tries what it supports. */
  protocol?: Protocol;
  /**
   * MOCK/SIMULATION ONLY: pretend this chip is physically on the bench so the
   * scan pipeline can be exercised without hardware. Real adapters ignore it
   * and read the actual silicon.
   */
  simulateChip?: ChipProfile;
}

export interface IdentifyChipResult {
  signature: ChipSignature;
  durationMs: number;
  meta: Record<string, unknown>;
}

export interface ProgrammerAdapterDescriptor {
  adapterId: string;
  displayName: string;
  type: "software" | "usb_serial" | "usb_bridge" | "external_tool" | "debug_probe";
  supportedProtocols: Protocol[];
  supportedVoltages: number[];
  canMeasureVoltage: boolean;
  canControlPower: boolean;
  canRead: boolean;
  canWrite: boolean;
  /** Whether the adapter can read a chip's electronic signature (JEDEC / I2C scan). */
  canIdentify?: boolean;
  safetyLevel: AdapterSafetyLevel;
  /** Free-form summary shown on the Adapter Manager card. */
  description: string;
}

export interface ProgrammerAdapter extends ProgrammerAdapterDescriptor {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): Promise<AdapterStatus>;

  supportsProtocol(protocol: Protocol): boolean;
  supportsVoltage(voltage: number): boolean;

  setVoltage?(voltage: number): Promise<void>;
  powerOn?(): Promise<void>;
  powerOff?(): Promise<void>;
  measureVoltage?(pin?: string): Promise<number>;

  readMemory(request: ReadMemoryRequest): Promise<ReadMemoryResult>;
  writeMemory?(request: WriteMemoryRequest): Promise<WriteMemoryResult>;
  verifyMemory?(request: VerifyMemoryRequest): Promise<VerifyMemoryResult>;
  identifyChip?(request: IdentifyChipRequest): Promise<IdentifyChipResult>;
}

export class NotImplementedError extends Error {
  constructor(adapterId: string, operation: string) {
    super(
      `Adapter "${adapterId}" does not yet implement "${operation}". This is a stub for a future milestone — see TODO.md.`,
    );
    this.name = "NotImplementedError";
  }
}
