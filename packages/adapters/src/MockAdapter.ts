import type { ChipProfile, ChipSignature, Protocol } from "@ecu/chip-db";
import { manufacturerIdForName } from "@ecu/chip-db";
import {
  AdapterStatus,
  IdentifyChipRequest,
  IdentifyChipResult,
  ProgrammerAdapter,
  ReadMemoryRequest,
  ReadMemoryResult,
  VerifyMemoryRequest,
  VerifyMemoryResult,
  WriteMemoryRequest,
  WriteMemoryResult,
} from "./ProgrammerAdapter.js";

/**
 * Software-only adapter used for development, training and tests.
 *
 * Generates deterministic, plausible-looking memory contents from a seed
 * derived from the chip profile id. The same job re-reading the same chip
 * twice gets identical bytes, so the verified-backup path can be exercised
 * without any hardware.
 */
export class MockAdapter implements ProgrammerAdapter {
  readonly adapterId = "mock_adapter";
  readonly displayName = "Mock Adapter (simulator)";
  readonly type = "software" as const;
  readonly supportedProtocols: Protocol[] = ["i2c", "spi", "microwire"];
  readonly supportedVoltages = [1.8, 3.3, 5.0];
  readonly canMeasureVoltage = false;
  readonly canControlPower = false;
  readonly canRead = true;
  /** MVP-1: keep writes mock-only so the workflow can be exercised end-to-end. */
  readonly canWrite = true;
  readonly canIdentify = true;
  readonly safetyLevel = "training" as const;
  readonly description =
    "Software simulator for guided workflows. Returns deterministic dumps based on the chip profile id. Use for development, training, and verifying safety rules without real hardware.";

  private connected = false;
  private readonly memory = new Map<string, Buffer>();

  async connect(): Promise<void> {
    await delay(50);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getStatus(): Promise<AdapterStatus> {
    return {
      state: this.connected ? "connected" : "disconnected",
      message: this.connected
        ? "Mock adapter ready. All operations are simulated."
        : "Mock adapter idle. Call connect() to begin.",
      firmware: "mock-1.0.0",
    };
  }

  supportsProtocol(protocol: Protocol): boolean {
    return this.supportedProtocols.includes(protocol);
  }

  supportsVoltage(voltage: number): boolean {
    return this.supportedVoltages.includes(voltage);
  }

  async readMemory(request: ReadMemoryRequest): Promise<ReadMemoryResult> {
    this.assertConnected();
    const { chipProfile } = request;
    const offset = request.offset ?? 0;
    const length = request.length ?? chipProfile.sizeBytes;
    const total = chipProfile.sizeBytes;
    if (offset < 0 || offset >= total) {
      throw new Error(`Read offset ${offset} is outside chip size ${total}.`);
    }
    if (length <= 0 || offset + length > total) {
      throw new Error(
        `Read length ${length} (offset ${offset}) overflows chip size ${total}.`,
      );
    }

    const started = Date.now();
    const buffer = this.materialiseMemory(chipProfile).subarray(offset, offset + length);
    await this.simulateReadDuration(length, request.onProgress);

    return {
      data: Buffer.from(buffer),
      durationMs: Date.now() - started,
      meta: {
        simulated: true,
        seed: chipProfile.chipProfileId,
        tag: request.tag,
      },
    };
  }

  async writeMemory(request: WriteMemoryRequest): Promise<WriteMemoryResult> {
    this.assertConnected();
    const { chipProfile, data } = request;
    const offset = request.offset ?? 0;
    if (offset + data.length > chipProfile.sizeBytes) {
      throw new Error("Write would exceed chip size.");
    }
    const started = Date.now();
    const memory = this.materialiseMemory(chipProfile);
    data.copy(memory, offset);
    await this.simulateWriteDuration(data.length, request.onProgress);
    return {
      bytesWritten: data.length,
      durationMs: Date.now() - started,
      meta: { simulated: true, tag: request.tag },
    };
  }

  async verifyMemory(request: VerifyMemoryRequest): Promise<VerifyMemoryResult> {
    this.assertConnected();
    const { chipProfile, expected } = request;
    const offset = request.offset ?? 0;
    const started = Date.now();
    const memory = this.materialiseMemory(chipProfile).subarray(
      offset,
      offset + expected.length,
    );
    let firstDiff = -1;
    let total = 0;
    for (let i = 0; i < expected.length; i++) {
      if (memory[i] !== expected[i]) {
        if (firstDiff === -1) firstDiff = i;
        total++;
      }
    }
    return {
      ok: total === 0,
      firstDifferingOffset: firstDiff,
      totalDifferingBytes: total,
      durationMs: Date.now() - started,
    };
  }

  async identifyChip(request: IdentifyChipRequest): Promise<IdentifyChipResult> {
    this.assertConnected();
    const started = Date.now();
    await delay(120);
    const signature = synthesiseSignature(request.simulateChip);
    return {
      signature,
      durationMs: Date.now() - started,
      meta: { simulated: true, simulatedChip: request.simulateChip?.chipProfileId },
    };
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("Mock adapter is not connected. Call connect() first.");
    }
  }

  private materialiseMemory(chip: ChipProfile): Buffer {
    const key = chip.chipProfileId;
    const existing = this.memory.get(key);
    if (existing) return existing;
    const buf = generateDeterministicBytes(key, chip.sizeBytes);
    this.memory.set(key, buf);
    return buf;
  }

  private async simulateReadDuration(
    bytes: number,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    // ~64 KB/s simulated I2C/SPI rate. Clamp to 80ms .. 400ms so the UI feels live.
    const total = Math.max(80, Math.min(400, Math.round((bytes / 65536) * 1000)));
    await stepProgress(total, onProgress);
  }

  private async simulateWriteDuration(
    bytes: number,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    // Writes are ~3× slower than reads in this simulation.
    const total = Math.max(120, Math.min(800, Math.round((bytes / 65536) * 3000)));
    await stepProgress(total, onProgress);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a believable electronic signature for a simulated chip, so the scan →
 * match pipeline is demonstrable without hardware. SPI-NOR flash gets a real
 * JEDEC ID derived from its manufacturer + capacity; parts with no standard
 * ID (M95, 93Cxx, plain 24Cxx) report that honestly.
 */
function synthesiseSignature(chip?: ChipProfile): ChipSignature {
  if (!chip) {
    return {
      protocol: "spi",
      noElectronicId: true,
      notes: ["No chip simulated. On real hardware this scans the connected chip."],
    };
  }

  if (chip.family === "spi_nor_flash") {
    const manuId = (chip.manufacturer && manufacturerIdForName(chip.manufacturer)) || 0xef;
    const capacityCode = Math.round(Math.log2(chip.sizeBytes));
    const memType = 0x40; // typical for 25Q-series NOR
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
    return {
      protocol: "spi",
      jedecId: `${hex(manuId)} ${hex(memType)} ${hex(capacityCode)}`,
      sfdpPresent: true,
      notes: [`Simulated JEDEC ID for ${chip.displayName}.`],
    };
  }

  if (chip.family === "24xxx_i2c_eeprom") {
    return {
      protocol: "i2c",
      i2cAddresses: [0x50],
      notes: ["I2C EEPROM ACK at 0x50 (simulated). Capacity needs a marking/photo to confirm."],
    };
  }

  // M95 SPI EEPROM, microwire, etc. — no standard electronic ID.
  return {
    protocol: chip.protocol,
    noElectronicId: true,
    notes: [`${chip.displayName} exposes no standard electronic ID — identify by marking/photo.`],
  };
}

async function stepProgress(
  totalMs: number,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const steps = 8;
  const each = Math.max(10, Math.floor(totalMs / steps));
  for (let i = 1; i <= steps; i++) {
    await delay(each);
    onProgress?.(i / steps);
  }
}

/**
 * Deterministic PRNG-style fill. Uses a 32-bit LCG seeded from a hash of the
 * chip profile id so the same chip always produces the same bytes. Avoids
 * uniformity (entropy ≈ 0.95+) which would otherwise trigger the all-FF /
 * all-00 detection paths during development.
 */
function generateDeterministicBytes(seedKey: string, size: number): Buffer {
  let state = 0x1f1f1f1f;
  for (let i = 0; i < seedKey.length; i++) {
    state = (state ^ seedKey.charCodeAt(i)) >>> 0;
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 0x010a) + 0xb5297a4d) >>> 0;
    buf[i] = (state >>> 16) & 0xff;
  }
  // Sprinkle a recognisable signature near the start so dumps don't look like
  // pure noise to a curious operator.
  const sig = Buffer.from(`MOCK:${seedKey} `, "ascii");
  sig.copy(buf, 0, 0, Math.min(sig.length, size));
  return buf;
}
