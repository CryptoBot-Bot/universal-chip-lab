import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ChipProfile } from "@ecu/chip-db";

export type FlashromBackend =
  | { adapter: "ch341a_spi" }
  | { adapter: "ft2232_spi"; type: "232h" | "2232h" | "4232h"; port?: number }
  | { adapter: "buspirate_spi"; dev: string; speed?: number }
  | { adapter: "serprog"; dev: string; baud?: number };

export interface FlashromReadInput {
  backend: FlashromBackend;
  chipProfile: ChipProfile;
  /** flashrom -c argument — if absent, flashrom auto-detects. */
  flashromChip?: string;
  /** Receives stderr/stdout lines as flashrom emits them. */
  onLog?: (line: string) => void;
  /** Receives 0..1 progress when flashrom prints percentages. */
  onProgress?: (fraction: number) => void;
  /** Optional override of the flashrom binary path. Defaults to "flashrom". */
  flashromBinary?: string;
}

export interface FlashromReadResult {
  data: Buffer;
  durationMs: number;
  /** Concatenated stderr+stdout from flashrom. */
  rawOutput: string;
  command: string;
}

/**
 * Spawn flashrom with the right `-p` programmer string and read the chip into
 * a temp file, then return the bytes. flashrom is the de-facto standard for
 * SPI NOR Flash and a fair chunk of SPI EEPROM on the CH341A / FT232H / Bus
 * Pirate backends, which is everything you need for Phase B reads.
 */
export async function flashromRead(input: FlashromReadInput): Promise<FlashromReadResult> {
  const binary = input.flashromBinary ?? "flashrom";
  const programmer = renderProgrammer(input.backend);
  const chipArg = input.flashromChip ?? guessFlashromChip(input.chipProfile);

  const tmp = await mkdtemp(path.join(tmpdir(), "ecl-flashrom-"));
  const outFile = path.join(tmp, "dump.bin");

  const args = ["-p", programmer, "-r", outFile, "-V"];
  if (chipArg) args.push("-c", chipArg);

  const started = Date.now();
  const command = [binary, ...args].join(" ");
  input.onLog?.(`$ ${command}`);

  let raw = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    const onChunk = (label: string) => (b: Buffer) => {
      const text = b.toString();
      raw += text;
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        input.onLog?.(`[${label}] ${line}`);
        const pct = line.match(/(\d{1,3})\s?%/);
        if (pct) {
          const pctNum = Number(pct[1]);
          if (!Number.isNaN(pctNum) && pctNum >= 0 && pctNum <= 100) {
            input.onProgress?.(pctNum / 100);
          }
        }
      }
    };
    child.stdout.on("data", onChunk("out"));
    child.stderr.on("data", onChunk("err"));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`flashrom exited with code ${code}.\n${raw}`));
    });
  }).catch(async (err) => {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  });

  const data = await readFile(outFile);
  await rm(tmp, { recursive: true, force: true });

  return {
    data,
    durationMs: Date.now() - started,
    rawOutput: raw,
    command,
  };
}

function renderProgrammer(b: FlashromBackend): string {
  switch (b.adapter) {
    case "ch341a_spi":
      return "ch341a_spi";
    case "ft2232_spi":
      return `ft2232_spi:type=${b.type}${b.port ? `,port=${b.port}` : ""}`;
    case "buspirate_spi":
      return `buspirate_spi:dev=${b.dev}${b.speed ? `,spispeed=${b.speed}k` : ""}`;
    case "serprog":
      return `serprog:dev=${b.dev}${b.baud ? `:${b.baud}` : ""}`;
  }
}

export interface FlashromWriteInput {
  backend: FlashromBackend;
  chipProfile: ChipProfile;
  data: Buffer;
  flashromChip?: string;
  onLog?: (line: string) => void;
  onProgress?: (fraction: number) => void;
  flashromBinary?: string;
}

export interface FlashromWriteResult {
  bytesWritten: number;
  durationMs: number;
  rawOutput: string;
  command: string;
}

/**
 * Spawn flashrom with `-w` to write the supplied image. flashrom internally
 * erases, writes, and verifies. This is genuinely destructive on real
 * hardware — every caller MUST have already archived the donor's original
 * contents (the Cloning Ceremony enforces this).
 *
 * Note: flashrom targets SPI NOR Flash well. SPI EEPROM (M95 family) is only
 * partially covered; if flashrom can't identify the chip it exits non-zero
 * BEFORE erasing anything — a safe failure.
 */
export async function flashromWrite(input: FlashromWriteInput): Promise<FlashromWriteResult> {
  const binary = input.flashromBinary ?? "flashrom";
  const programmer = renderProgrammer(input.backend);
  const chipArg = input.flashromChip ?? guessFlashromChip(input.chipProfile);

  const tmp = await mkdtemp(path.join(tmpdir(), "ecl-flashrom-w-"));
  const inFile = path.join(tmp, "image.bin");
  await writeFile(inFile, input.data);

  const args = ["-p", programmer, "-w", inFile, "-V"];
  if (chipArg) args.push("-c", chipArg);

  const started = Date.now();
  const command = [binary, ...args].join(" ");
  input.onLog?.(`$ ${command}`);

  let raw = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const onChunk = (label: string) => (b: Buffer) => {
      const text = b.toString();
      raw += text;
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        input.onLog?.(`[${label}] ${line}`);
        const pct = line.match(/(\d{1,3})\s?%/);
        if (pct) {
          const n = Number(pct[1]);
          if (!Number.isNaN(n) && n >= 0 && n <= 100) input.onProgress?.(n / 100);
        }
      }
    };
    child.stdout.on("data", onChunk("out"));
    child.stderr.on("data", onChunk("err"));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`flashrom write exited with code ${code}.\n${raw}`));
    });
  }).catch(async (err) => {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  });

  await rm(tmp, { recursive: true, force: true });
  return {
    bytesWritten: input.data.length,
    durationMs: Date.now() - started,
    rawOutput: raw,
    command,
  };
}

/**
 * Best-effort flashrom `-c` value from a chip profile. We return undefined by
 * default — flashrom auto-detects via JEDEC ID, which is more robust than
 * trying to match our profile's display name against flashrom's internal
 * naming convention (e.g., our "Winbond W25Q32" profile covers many variants,
 * but flashrom's DB has each variant as a separate entry: W25Q32JV, W25Q32BV,
 * W25Q32FV, etc.). If auto-detect fails with "multiple candidates", the
 * operator can be prompted to pick the exact name.
 */
export function guessFlashromChip(_profile: ChipProfile): string | undefined {
  return undefined;
}
