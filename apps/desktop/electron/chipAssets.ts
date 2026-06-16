/**
 * Per-chip asset store — operator-uploaded instruction / schematic / solder
 * images, plus the cached AI connection guide. Everything lives under the
 * workspace `chip-assets/<chipProfileId>/` dir:
 *   - <assetId>.<ext>  the image bytes
 *   - index.json       asset metadata array
 *   - guide.json       the cached AI connect/solder guide (if generated)
 *
 * The renderer refers to a chip by `chipProfileId` and an asset by `assetId`;
 * we rebuild and sanitise every path server-side so the renderer can never
 * escape the chip-assets dir.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ChipAsset, ChipAssetKind, ChipConnectGuide } from "@ecu/chip-db";

const SAFE = /[^A-Za-z0-9._-]/g;
const ID_RE = /^[A-Za-z0-9._-]+$/;

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function chipDir(baseDir: string, chipProfileId: string): string {
  return path.join(baseDir, chipProfileId.replace(SAFE, "_"));
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function listChipAssets(baseDir: string, chipProfileId: string): Promise<ChipAsset[]> {
  return readJson<ChipAsset[]>(path.join(chipDir(baseDir, chipProfileId), "index.json"), []);
}

export async function addChipAsset(
  baseDir: string,
  chipProfileId: string,
  input: { fileName: string; base64: string; mediaType: string; kind: ChipAssetKind; caption?: string },
): Promise<ChipAsset> {
  const dir = chipDir(baseDir, chipProfileId);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const ext = EXT[input.mediaType] ?? "bin";
  const bytes = Buffer.from(input.base64, "base64");
  await writeFile(path.join(dir, `${id}.${ext}`), bytes);
  const asset: ChipAsset = {
    id,
    fileName: input.fileName.replace(SAFE, "_").slice(0, 120) || `image.${ext}`,
    kind: input.kind,
    mediaType: input.mediaType,
    sizeBytes: bytes.length,
    savedAt: new Date().toISOString(),
    ...(input.caption ? { caption: input.caption.slice(0, 400) } : {}),
  };
  const index = await listChipAssets(baseDir, chipProfileId);
  index.unshift(asset);
  await writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 2), "utf8");
  return asset;
}

export async function readChipAsset(
  baseDir: string,
  chipProfileId: string,
  assetId: string,
): Promise<{ base64: string; mediaType: string; fileName: string }> {
  if (!ID_RE.test(assetId)) throw new Error(`Invalid asset id "${assetId}".`);
  const index = await listChipAssets(baseDir, chipProfileId);
  const asset = index.find((a) => a.id === assetId);
  if (!asset) throw new Error("Asset not found.");
  const ext = EXT[asset.mediaType] ?? "bin";
  const buf = await readFile(path.join(chipDir(baseDir, chipProfileId), `${assetId}.${ext}`));
  return { base64: buf.toString("base64"), mediaType: asset.mediaType, fileName: asset.fileName };
}

export async function deleteChipAsset(
  baseDir: string,
  chipProfileId: string,
  assetId: string,
): Promise<{ removed: boolean }> {
  if (!ID_RE.test(assetId)) throw new Error(`Invalid asset id "${assetId}".`);
  const index = await listChipAssets(baseDir, chipProfileId);
  const asset = index.find((a) => a.id === assetId);
  if (asset) {
    const ext = EXT[asset.mediaType] ?? "bin";
    await unlink(path.join(chipDir(baseDir, chipProfileId), `${assetId}.${ext}`)).catch(() => undefined);
    const next = index.filter((a) => a.id !== assetId);
    await writeFile(path.join(chipDir(baseDir, chipProfileId), "index.json"), JSON.stringify(next, null, 2), "utf8");
  }
  return { removed: !!asset };
}

// ---- AI connect/solder guide cache -------------------------------------------

export async function readChipGuide(baseDir: string, chipProfileId: string): Promise<ChipConnectGuide | null> {
  return readJson<ChipConnectGuide | null>(path.join(chipDir(baseDir, chipProfileId), "guide.json"), null);
}

export async function writeChipGuide(
  baseDir: string,
  chipProfileId: string,
  guide: ChipConnectGuide,
): Promise<void> {
  const dir = chipDir(baseDir, chipProfileId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "guide.json"), JSON.stringify(guide, null, 2), "utf8");
}
