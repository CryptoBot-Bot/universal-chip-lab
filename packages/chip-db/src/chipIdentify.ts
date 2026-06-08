import type { ChipProfile, Protocol } from "./chipProfile.schema.js";
import { classifyMemoryClass } from "./memoryClass.js";

/**
 * Electronic identity read off a real chip, independent of any photo or
 * marking. This is the *reliable* identifier — silicon answering for itself —
 * and the verification backbone the AI photo-resolver leans on later.
 */
export interface ChipSignature {
  protocol: Protocol;
  /** SPI-NOR JEDEC ID (opcode 0x9F) as space-separated hex, e.g. "EF 40 17". */
  jedecId?: string;
  /** Whether an SFDP table responded (SPI-NOR sanity check). */
  sfdpPresent?: boolean;
  /** 7-bit I2C addresses that ACKed during a bus scan. */
  i2cAddresses?: number[];
  /** True when the part exposes no standard electronic ID (M95, 93Cxx, plain 24Cxx). */
  noElectronicId?: boolean;
  /** Operator-facing notes about what the scan could and couldn't determine. */
  notes?: string[];
}

/** Common JEDEC manufacturer IDs (byte 1 of the 0x9F response). */
export const JEDEC_MANUFACTURERS: Readonly<Record<number, string>> = {
  0x01: "Spansion/Cypress",
  0x04: "Fujitsu",
  0x1c: "EON",
  0x1f: "Atmel/Adesto",
  0x20: "Micron/ST",
  0x37: "AMIC",
  0x89: "Intel",
  0x8c: "ESMT",
  0x9d: "ISSI",
  0xbf: "SST/Microchip",
  0xc2: "Macronix",
  0xc8: "GigaDevice",
  0xef: "Winbond",
};

/** Best-effort reverse lookup: a manufacturer profile string → JEDEC byte. */
export function manufacturerIdForName(name: string): number | undefined {
  const n = name.toLowerCase();
  for (const [idStr, label] of Object.entries(JEDEC_MANUFACTURERS)) {
    if (label.toLowerCase().split(/[/]/).some((part) => n.includes(part))) {
      return Number(idStr);
    }
  }
  return undefined;
}

export interface DecodedJedec {
  manufacturerId: number;
  manufacturerName: string;
  memoryType: number;
  capacityCode: number;
  /** Decoded capacity in bytes (2^capacityCode for standard NOR). */
  capacityBytes: number;
}

/** Parses a "EF 40 17"-style JEDEC string into manufacturer + capacity. */
export function decodeJedecId(jedecId: string): DecodedJedec | null {
  const bytes = jedecId
    .trim()
    .split(/[\s:]+/)
    .map((h) => parseInt(h, 16));
  if (bytes.length < 3 || bytes.some((b) => Number.isNaN(b))) return null;
  const [manufacturerId, memoryType, capacityCode] = bytes;
  // Standard SPI-NOR encodes capacity as 2^capacityCode bytes.
  const capacityBytes =
    capacityCode > 0 && capacityCode < 32 ? 2 ** capacityCode : 0;
  return {
    manufacturerId,
    manufacturerName: JEDEC_MANUFACTURERS[manufacturerId] ?? `0x${manufacturerId.toString(16)}`,
    memoryType,
    capacityCode,
    capacityBytes,
  };
}

export interface ChipMatch {
  profile: ChipProfile;
  /** 0–100 confidence the scanned chip is this profile. */
  score: number;
  reasons: string[];
}

/**
 * Ranks known profiles against a scanned signature. Returns best-first.
 * Honest by design: SPI-NOR JEDEC gives a strong match; I2C/EEPROM scans can
 * only narrow to a family + flag that capacity must be confirmed by marking.
 */
export function matchSignature(
  signature: ChipSignature,
  profiles: ChipProfile[],
): ChipMatch[] {
  const matches: ChipMatch[] = [];

  if (signature.jedecId) {
    const decoded = decodeJedecId(signature.jedecId);
    for (const p of profiles) {
      if (classifyMemoryClass(p) !== "flash") continue;
      const reasons: string[] = [];
      let score = 0;
      if (decoded && decoded.capacityBytes > 0) {
        if (p.sizeBytes === decoded.capacityBytes) {
          score += 60;
          reasons.push(`Capacity ${fmtBytes(decoded.capacityBytes)} matches JEDEC code 0x${decoded.capacityCode.toString(16)}`);
        } else {
          continue; // wrong size — not a candidate
        }
        const manuId = p.manufacturer ? manufacturerIdForName(p.manufacturer) : undefined;
        if (manuId !== undefined && manuId === decoded.manufacturerId) {
          score += 35;
          reasons.push(`Manufacturer ${p.manufacturer} matches JEDEC 0x${decoded.manufacturerId.toString(16)} (${decoded.manufacturerName})`);
        } else {
          reasons.push(`Different/unknown manufacturer (JEDEC says ${decoded.manufacturerName})`);
        }
        if (signature.sfdpPresent) {
          score += 5;
          reasons.push("SFDP table present");
        }
      }
      if (score > 0) matches.push({ profile: p, score: Math.min(100, score), reasons });
    }
  }

  if (signature.i2cAddresses && signature.i2cAddresses.length > 0) {
    for (const p of profiles) {
      if (p.family !== "24xxx_i2c_eeprom") continue;
      matches.push({
        profile: p,
        score: 25,
        reasons: [
          `I2C EEPROM ACKed at ${signature.i2cAddresses.map((a) => "0x" + a.toString(16)).join(", ")}`,
          "Capacity is NOT determinable from an I2C scan — confirm by chip marking / photo.",
        ],
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${n / (1024 * 1024)} MB`;
  if (n >= 1024) return `${n / 1024} KB`;
  return `${n} B`;
}
