/**
 * Dump store — manages the verified backups saved under the workspace dumps/
 * dir. Each dump is a `<name>.bin` plus a `<name>.json` metadata sidecar
 * (written by pico:saveDump). The renderer refers to dumps by `name` only; we
 * rebuild the path server-side and validate it, so the renderer can never reach
 * outside the dumps dir.
 */
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export interface DumpEntry {
  name: string;
  sizeBytes: number;
  savedAt?: string;
  meta: Record<string, unknown>;
}

function binPathFor(dir: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid dump name "${name}".`);
  return path.join(dir, `${name}.bin`);
}

export async function listDumps(dir: string): Promise<DumpEntry[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const entries: DumpEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".bin")) continue;
    const name = file.slice(0, -4);
    const binPath = path.join(dir, file);
    let sizeBytes = 0;
    try {
      sizeBytes = (await stat(binPath)).size;
    } catch {
      /* ignore */
    }
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(await readFile(path.join(dir, `${name}.json`), "utf8"));
    } catch {
      /* sidecar may be missing */
    }
    entries.push({
      name,
      sizeBytes,
      savedAt: typeof meta.savedAt === "string" ? meta.savedAt : undefined,
      meta,
    });
  }
  entries.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
  return entries;
}

export async function readDumpSlice(
  dir: string,
  name: string,
  offset: number,
  length: number,
): Promise<{ base64: string; total: number }> {
  const buf = await readFile(binPathFor(dir, name));
  const slice = buf.subarray(offset, offset + length);
  return { base64: slice.toString("base64"), total: buf.length };
}

export async function deleteDump(dir: string, name: string): Promise<{ removed: boolean }> {
  const binPath = binPathFor(dir, name);
  await unlink(binPath).catch(() => undefined);
  await unlink(path.join(dir, `${name}.json`)).catch(() => undefined);
  await unlink(path.join(dir, `${name}.readable.json`)).catch(() => undefined);
  return { removed: true };
}

export type DumpFormat = "json" | "hex" | "strings" | "text" | "md";

/** Canonical hex dump: offset · 16 hex bytes · ASCII gutter. */
function hexDumpLines(bytes: Uint8Array, limit = bytes.length): string[] {
  const lines: string[] = [];
  const end = Math.min(bytes.length, limit);
  for (let off = 0; off < end; off += 16) {
    const slice = bytes.subarray(off, off + 16);
    const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(slice).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines;
}

/** Pulls runs of printable ASCII (like the Unix `strings` tool) with offsets. */
export function extractStrings(bytes: Uint8Array, minLen = 4): { offset: number; text: string }[] {
  const out: { offset: number; text: string }[] = [];
  let start = -1;
  let cur = "";
  for (let i = 0; i <= bytes.length; i++) {
    const b = i < bytes.length ? bytes[i] : -1;
    if (b >= 0x20 && b < 0x7f) {
      if (start < 0) start = i;
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= minLen) out.push({ offset: start, text: cur });
      start = -1;
      cur = "";
    }
  }
  return out;
}

/** Decodes printable text (keeps tab/newline), dropping binary — good for text dumps. */
function textView(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) s += String.fromCharCode(b);
  }
  return s;
}

function entropyBits(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const counts = new Array(256).fill(0);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
  let h = 0;
  for (const c of counts) {
    if (!c) continue;
    const p = c / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Contiguous runs of a single 0xFF/0x00 filler byte (the "empty" map). */
function blankRegions(bytes: Uint8Array, minRun = 32): { start: number; end: number; val: number }[] {
  const regions: { start: number; end: number; val: number }[] = [];
  let i = 0;
  while (i < bytes.length) {
    const v = bytes[i];
    if (v === 0xff || v === 0x00) {
      let j = i;
      while (j < bytes.length && bytes[j] === v) j++;
      if (j - i >= minRun) regions.push({ start: i, end: j, val: v });
      i = j;
    } else {
      i++;
    }
  }
  return regions;
}

function pct(n: number, total: number): string {
  return total ? `${((n / total) * 100).toFixed(1)}%` : "0%";
}

function markdownReport(name: string, meta: Record<string, unknown>, bytes: Uint8Array): string {
  const total = bytes.length;
  let ff = 0;
  let zero = 0;
  let printable = 0;
  for (let i = 0; i < total; i++) {
    const b = bytes[i];
    if (b === 0xff) ff++;
    else if (b === 0x00) zero++;
    if (b >= 0x20 && b < 0x7f) printable++;
  }
  const strings = extractStrings(bytes, 4);
  const top = [...strings].sort((a, b) => b.text.length - a.text.length).slice(0, 25);
  const regions = blankRegions(bytes);
  const hx = (n: number) => `0x${n.toString(16).padStart(6, "0")}`;

  const L: string[] = [];
  L.push(`# Dump report — ${meta.displayName ?? name}`, "");
  L.push("| Field | Value |", "| --- | --- |");
  L.push(`| File | \`${name}.bin\` |`);
  if (meta.displayName) L.push(`| Chip | ${meta.displayName} |`);
  if (meta.family) L.push(`| Family | ${meta.family} |`);
  if (meta.mode) L.push(`| Mode | ${meta.mode} |`);
  L.push(`| Size | ${total.toLocaleString()} bytes |`);
  if (meta.sha256) L.push(`| SHA-256 | \`${meta.sha256}\` |`);
  L.push(`| Verified | ${meta.verified === true ? "yes" : "no"} |`);
  if (meta.savedAt) L.push(`| Saved | ${meta.savedAt} |`);
  L.push("");
  L.push("## Statistics", "");
  L.push(`- **Blank \`0xFF\`:** ${ff.toLocaleString()} (${pct(ff, total)})`);
  L.push(`- **Zero \`0x00\`:** ${zero.toLocaleString()} (${pct(zero, total)})`);
  L.push(`- **Printable ASCII:** ${printable.toLocaleString()} (${pct(printable, total)})`);
  L.push(`- **Shannon entropy:** ${entropyBits(bytes).toFixed(2)} bits/byte (0 = uniform, 8 = random/encrypted)`);
  L.push("");
  if (regions.length) {
    L.push("## Blank / filler regions", "");
    for (const r of regions.slice(0, 40)) {
      L.push(`- \`${hx(r.start)}\`–\`${hx(r.end)}\` — ${(r.end - r.start).toLocaleString()} bytes of \`0x${r.val.toString(16).padStart(2, "0")}\``);
    }
    if (regions.length > 40) L.push(`- …and ${regions.length - 40} more`);
    L.push("");
  }
  L.push(`## Strings (${strings.length} runs ≥ 4 chars — longest 25)`, "");
  if (!top.length) {
    L.push("_None found._", "");
  } else {
    L.push("```");
    for (const s of top) L.push(`${hx(s.offset)}  ${s.text.slice(0, 100)}`);
    L.push("```", "");
  }
  L.push("## Hex (first 512 bytes)", "", "```");
  L.push(...hexDumpLines(bytes, 512));
  L.push("```", "");
  return L.join("\n");
}

/** Exports a dump in a human-readable format alongside the .bin. */
export async function exportDump(dir: string, name: string, format: DumpFormat): Promise<{ path: string }> {
  const buf = await readFile(binPathFor(dir, name));
  const bytes = new Uint8Array(buf);
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(await readFile(path.join(dir, `${name}.json`), "utf8"));
  } catch {
    /* ignore */
  }

  let outPath: string;
  let content: string;
  switch (format) {
    case "hex":
      outPath = path.join(dir, `${name}.hex.txt`);
      content = hexDumpLines(bytes).join("\n");
      break;
    case "strings":
      outPath = path.join(dir, `${name}.strings.txt`);
      content = extractStrings(bytes, 4)
        .map((s) => `${s.offset.toString(16).padStart(8, "0")}  ${s.text}`)
        .join("\n");
      break;
    case "text":
      outPath = path.join(dir, `${name}.txt`);
      content = textView(bytes);
      break;
    case "md":
      outPath = path.join(dir, `${name}.md`);
      content = markdownReport(name, meta, bytes);
      break;
    case "json":
    default:
      outPath = path.join(dir, `${name}.readable.json`);
      content = JSON.stringify(
        { file: `${name}.bin`, ...meta, totalBytes: bytes.length, hexDump: hexDumpLines(bytes, 64 * 1024) },
        null,
        2,
      );
      break;
  }
  await writeFile(outPath, content, "utf8");
  return { path: outPath };
}
