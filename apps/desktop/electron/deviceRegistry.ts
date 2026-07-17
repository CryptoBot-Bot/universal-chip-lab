import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Registry of PAIRED SuperDevice Pis. Pairing is a local bookmark — the Pi
 * itself doesn't know it's paired; live state (online/occupied/battery) is
 * always fetched fresh from the device. Lives at <workspace>/devices/paired.json.
 */
export interface PairedDevice {
  id: string;
  /** "ip:port" or "hostname.local:port" — the address we reach it on. */
  host: string;
  /** Last hostname the Pi reported (refreshed on every successful poll). */
  hostname: string;
  model: string;
  /** Local label chosen on this PC, independent of the Pi's hostname. */
  nickname?: string;
  pairedAt: string;
  lastSeenAt?: string;
}

const FILE = "paired.json";

export async function loadPairedDevices(dir: string): Promise<PairedDevice[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, FILE), "utf8"));
    return Array.isArray(parsed) ? (parsed as PairedDevice[]) : [];
  } catch {
    return [];
  }
}

export async function savePairedDevices(dir: string, devices: PairedDevice[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, FILE), `${JSON.stringify(devices, null, 2)}\n`, "utf8");
}
