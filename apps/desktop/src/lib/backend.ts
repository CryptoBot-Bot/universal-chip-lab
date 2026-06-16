/**
 * Device-agnostic backend for the Read/Write tabs (the unified adapter layer).
 *
 * A `LabBackend` exposes the operations a tab needs — read / write / writeAt /
 * erase / unlock — keyed on a ChipProfile, so the tabs never care which device
 * is behind it. Today there are two implementations:
 *
 *   - PicoBackend — wraps the proven PicoForge serial path (picoforge.ts).
 *   - SimBackend  — a software simulator backed by the @ecu/adapters MockAdapter
 *                   in the main process, so the whole pipeline works with NO
 *                   hardware ("since I don't have every chip in the world").
 *
 * The CH347 (Waveshare) and T48 backends will slot in here later as additional
 * registry-backed implementations, exactly like the simulator.
 */
import type { ChipProfile } from "@ecu/chip-db";
import { effectiveSpiClockHz, picoModeForChip } from "@ecu/chip-db";

import { Api } from "./api";
import {
  base64ToBytes,
  bytesToBase64,
  eraseChip as picoEraseChip,
  readChip as picoReadChip,
  unlockChip as picoUnlockChip,
  writeAt as picoWriteAt,
  writeChip as picoWriteChip,
  type PicoMode,
} from "./picoforge";

export type DeviceId = "picoforge" | "simulator";
export type Progress = (done: number, total: number) => void;

export interface LabBackend {
  readonly id: DeviceId;
  readonly label: string;
  /** True for real silicon (clock control, wiring hints, voltage all apply). */
  readonly isHardware: boolean;
  readChip(chip: ChipProfile, onProgress?: Progress): Promise<Uint8Array>;
  writeChip(chip: ChipProfile, bytes: Uint8Array, onProgress?: Progress, opts?: { skipBlank?: boolean }): Promise<void>;
  writeAt(chip: ChipProfile, addr: number, bytes: Uint8Array, onProgress?: Progress): Promise<void>;
  eraseChip(chip: ChipProfile, onProgress?: Progress): Promise<void>;
  unlockChip(chip: ChipProfile): Promise<void>;
}

function picoModeOrThrow(chip: ChipProfile): PicoMode {
  const m = picoModeForChip(chip);
  if (!m) {
    throw new Error(
      `PicoForge can't reach ${chip.displayName} (${chip.family}). Switch to the Simulator, or use a T48 / CH347 (coming soon).`,
    );
  }
  return m.mode;
}

/** PicoForge backend — the existing serial path, with the SPI clock applied. */
export function makePicoBackend(port: string, spiClockOverride: number | null): LabBackend {
  const clk = (chip: ChipProfile) => effectiveSpiClockHz(chip, spiClockOverride ?? undefined);
  return {
    id: "picoforge",
    label: "PicoForge",
    isHardware: true,
    readChip: (chip, onProgress) =>
      picoReadChip(port, picoModeOrThrow(chip), chip.sizeBytes, onProgress, clk(chip)),
    writeChip: (chip, bytes, onProgress, opts) => {
      const mode = picoModeOrThrow(chip);
      return picoWriteChip(port, mode, bytes, onProgress, opts?.skipBlank ?? mode === 0, clk(chip));
    },
    writeAt: (chip, addr, bytes, onProgress) =>
      picoWriteAt(port, picoModeOrThrow(chip), addr, bytes, onProgress, clk(chip)),
    eraseChip: (chip, onProgress) =>
      picoEraseChip(port, picoModeOrThrow(chip), chip.sizeBytes, onProgress, undefined, clk(chip)),
    unlockChip: (chip) => picoUnlockChip(port, picoModeOrThrow(chip), clk(chip)),
  };
}

/** Simulator backend — MockAdapter via IPC. Deterministic, persistent per session. */
const SIM_CHUNK = 256 * 1024;
const SIM_ID = "mock_adapter";

export function makeSimBackend(): LabBackend {
  return {
    id: "simulator",
    label: "Simulator",
    isHardware: false,
    async readChip(chip, onProgress) {
      const total = chip.sizeBytes;
      const out = new Uint8Array(total);
      for (let off = 0; off < total; off += SIM_CHUNK) {
        const length = Math.min(SIM_CHUNK, total - off);
        const { base64 } = await Api.adapters.read({ id: SIM_ID, chipProfile: chip, offset: off, length, tag: "read" });
        out.set(base64ToBytes(base64), off);
        onProgress?.(Math.min(off + length, total), total);
      }
      return out;
    },
    async writeChip(chip, bytes, onProgress) {
      const total = bytes.length;
      for (let off = 0; off < total; off += SIM_CHUNK) {
        const slice = bytes.subarray(off, off + SIM_CHUNK);
        await Api.adapters.write({ id: SIM_ID, chipProfile: chip, offset: off, base64: bytesToBase64(slice), tag: "write" });
        onProgress?.(Math.min(off + slice.length, total), total);
      }
    },
    async writeAt(chip, addr, bytes, onProgress) {
      await Api.adapters.write({ id: SIM_ID, chipProfile: chip, offset: addr, base64: bytesToBase64(bytes), tag: "edit" });
      onProgress?.(bytes.length, bytes.length);
    },
    async eraseChip(chip, onProgress) {
      await Api.adapters.erase({ id: SIM_ID, chipProfile: chip });
      onProgress?.(chip.sizeBytes, chip.sizeBytes);
    },
    async unlockChip() {
      /* no write-protect latch in the simulator */
    },
  };
}
