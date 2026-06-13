/**
 * Renderer-side helper for the PicoForge device. The actual serial I/O happens
 * in the MAIN process (System.IO.Ports via PowerShell) because Electron's
 * Web Serial can't reliably assert DTR/RTS, which MicroPython needs before it
 * will transmit. This wraps the IPC bridge into a small command + read API.
 *
 * No persistent connection: each command is one main-process serial round-trip
 * (open → send → read → close). main.py keeps running across opens, so the
 * device's MODE persists between commands.
 */
import { Api } from "./api";

export type PicoMode = 0 | 1 | 2 | 3; // SPI Flash | SPI EEPROM | I2C | Microwire

const READ_CHUNK = 16384; // bytes per READ command for SPI (32 KB of hex per round-trip)
const READ_CHUNK_SERIAL = 512; // I2C/Microwire: small reads avoid bus (ETIMEDOUT) timeouts
const WRITE_CHUNK = 1024; // bytes per WRITE command (firmware is page-aware internally)

/** SPI is fast and handles big reads; I2C/Microwire need small per-transaction reads. */
function readChunkFor(mode: PicoMode): number {
  return mode === 2 || mode === 3 ? READ_CHUNK_SERIAL : READ_CHUNK;
}

export const Pico = {
  /** Auto-detect the Pico's COM port (RP2040 USB id 2E8A). Null if not found. */
  findPort: (): Promise<string | null> => Api.pico.findPort(),

  /**
   * Send one command, return the OK/ERR reply. `reboot` soft-reboots main.py
   * first (used on connect, to recover from a stray REPL state).
   */
  command: (port: string, command: string, reboot = false, timeoutMs?: number): Promise<string> =>
    Api.pico.command({ port, command, reboot, timeoutMs }),
};

/** EEPROM modes (1/2/3) are byte-writable; flash (0) needs erase-before-write. */
export function isEeprom(mode: PicoMode): boolean {
  return mode !== 0;
}

function throwIfErr(reply: string): void {
  if (reply.startsWith("ERR")) throw new Error(reply.replace(/^ERR\s*/, "PicoForge: "));
}

/** Erases a flash chip (MODE 0) to 0xFF. Slow — give it a long timeout. */
export async function eraseFlash(port: string): Promise<void> {
  throwIfErr(await Pico.command(port, "MODE 0"));
  throwIfErr(await Pico.command(port, "ERASE", false, 135000));
}

/**
 * Clears block-protect on an SPI EEPROM (MODE 1) so its full array is writable.
 * No-op for other modes: I2C write-protect is the WP pin (hardware), Microwire
 * EWEN is issued by its driver, and flash has no such latch. Safe to call before
 * any EEPROM write — harmless on chips that aren't protected.
 */
export async function unlockChip(port: string, mode: PicoMode): Promise<void> {
  throwIfErr(await Pico.command(port, `MODE ${mode}`));
  if (mode === 1) throwIfErr(await Pico.command(port, "UNLOCK"));
}

/**
 * Erases a chip to 0xFF. Flash uses chip-erase; SPI EEPROM uses the firmware
 * FILL (one fast command); I2C/Microwire are filled by writing 0xFF (FILL is
 * SPI-only in firmware). Give EEPROM fills a generous timeout for big parts.
 */
export async function eraseChip(
  port: string,
  mode: PicoMode,
  sizeBytes: number,
  onProgress?: (done: number, total: number) => void,
  timeoutMs = 135000,
): Promise<void> {
  if (mode === 0) return eraseFlash(port);
  await unlockChip(port, mode);
  if (mode === 1) {
    throwIfErr(await Pico.command(port, `FILL 0 ${sizeBytes} ff`, false, timeoutMs));
    onProgress?.(sizeBytes, sizeBytes);
    return;
  }
  // I2C / Microwire: write a 0xFF buffer through the normal page-aware write path.
  const ff = new Uint8Array(sizeBytes).fill(0xff);
  await writeAt(port, mode, 0, ff, onProgress);
}

/**
 * Writes `bytes` at an absolute chip address (for surgical/range edits).
 * Sets the mode, then issues page-aware WRITE commands. Caller should
 * unlockChip() first for SPI EEPROM targets.
 */
export async function writeAt(
  port: string,
  mode: PicoMode,
  addr: number,
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  throwIfErr(await Pico.command(port, `MODE ${mode}`));
  for (let off = 0; off < bytes.length; off += WRITE_CHUNK) {
    const slice = bytes.subarray(off, off + WRITE_CHUNK);
    throwIfErr(await Pico.command(port, `WRITE ${addr + off} ${bytesToHex(slice)}`));
    onProgress?.(Math.min(off + slice.length, bytes.length), bytes.length);
  }
}

/** Groups a set of byte offsets into contiguous [start, endExclusive) runs. */
export function dirtyRuns(offsets: Iterable<number>): Array<[number, number]> {
  const sorted = Array.from(offsets).sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const off of sorted) {
    const last = runs[runs.length - 1];
    if (last && off === last[1]) last[1] = off + 1;
    else runs.push([off, off + 1]);
  }
  return runs;
}

/** Sets the mode, then reads the whole chip in chunks. Returns the bytes. */
export async function readChip(
  port: string,
  mode: PicoMode,
  sizeBytes: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const modeReply = await Pico.command(port, `MODE ${mode}`);
  if (modeReply.startsWith("ERR")) throw new Error(modeReply.replace(/^ERR\s*/, "PicoForge: "));

  const out = new Uint8Array(sizeBytes);
  const chunk = readChunkFor(mode);
  for (let off = 0; off < sizeBytes; off += chunk) {
    const len = Math.min(chunk, sizeBytes - off);
    const reply = await Pico.command(port, `READ ${off} ${len}`);
    if (reply.startsWith("ERR")) throw new Error(reply.replace(/^ERR\s*/, "PicoForge: "));
    const bytes = hexToBytes(reply.replace(/^OK\s*/, "").trim());
    if (bytes.length !== len) {
      throw new Error(`Short read at offset ${off}: got ${bytes.length} of ${len} bytes.`);
    }
    out.set(bytes, off);
    onProgress?.(Math.min(off + len, sizeBytes), sizeBytes);
  }
  return out;
}

/**
 * Sets the mode, then writes the bytes in chunks. When `skipBlank` is set (safe
 * only on a freshly-erased or known-blank chip, which is already all-0xFF),
 * all-FF chunks are skipped — a big speed-up for sparse dumps.
 */
export async function writeChip(
  port: string,
  mode: PicoMode,
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void,
  skipBlank = false,
): Promise<void> {
  const modeReply = await Pico.command(port, `MODE ${mode}`);
  if (modeReply.startsWith("ERR")) throw new Error(modeReply.replace(/^ERR\s*/, "PicoForge: "));
  for (let off = 0; off < bytes.length; off += WRITE_CHUNK) {
    const slice = bytes.subarray(off, off + WRITE_CHUNK);
    if (!(skipBlank && slice.every((b) => b === 0xff))) {
      const reply = await Pico.command(port, `WRITE ${off} ${bytesToHex(slice)}`);
      if (reply.startsWith("ERR")) throw new Error(reply.replace(/^ERR\s*/, "PicoForge: "));
    }
    onProgress?.(Math.min(off + slice.length, bytes.length), bytes.length);
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const n = clean.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/** A compact hex preview (offset + 16 bytes + ASCII) of the first `rows` lines. */
export function hexDump(bytes: Uint8Array, rows = 16): string {
  const lines: string[] = [];
  for (let r = 0; r < rows && r * 16 < bytes.length; r++) {
    const off = r * 16;
    const slice = bytes.subarray(off, off + 16);
    const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(slice).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${off.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}
