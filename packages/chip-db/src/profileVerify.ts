import { decodeJedecId, manufacturerIdForName, type ChipSignature } from "./chipIdentify.js";
import {
  effectiveProvenance,
  type ChipConfidence,
  type ChipProfile,
} from "./chipProfile.schema.js";

/**
 * Verify-before-trust (Phase 6). An AI-suggested profile is only promoted to
 * `bench_verified` when the chip's own electronic signature and a clean full
 * read agree with the profile. A contradicting signature blocks promotion
 * outright — an AI guess must never become trusted on its own say-so.
 */

/** Compact summary of a verification read (computed from the raw bytes). */
export interface ReadSummary {
  byteLength: number;
  expectedBytes: number;
  /** True when the dump is uniform (all 0x00 or all 0xFF). */
  allSame: boolean;
  uniqueBytes: number;
  /** Shannon entropy, normalised 0..1. */
  entropy: number;
}

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface VerificationCheck {
  id: "signature" | "read";
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ProfileVerification {
  chipProfileId: string;
  checks: VerificationCheck[];
  /** Highest confidence the gathered evidence supports. */
  recommendedConfidence: ChipConfidence;
  canPromote: boolean;
  summary: string;
}

const CONFIDENCE_ORDER: ChipConfidence[] = [
  "unverified",
  "ai_suggested",
  "bench_verified",
  "clone_proven",
];

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${n / (1024 * 1024)} MB`;
  if (n >= 1024) return `${n / 1024} KB`;
  return `${n} B`;
}

/** Pure assessment: profile + scanned signature + read summary → verdict. */
export function assessProfileVerification(
  profile: ChipProfile,
  signature: ChipSignature,
  read: ReadSummary,
): ProfileVerification {
  const checks: VerificationCheck[] = [];

  // ---- Electronic signature check
  let signatureBlocks = false;
  if (signature.jedecId) {
    const d = decodeJedecId(signature.jedecId);
    if (d && d.capacityBytes > 0) {
      if (d.capacityBytes !== profile.sizeBytes) {
        signatureBlocks = true;
        checks.push({
          id: "signature",
          label: "Electronic signature",
          status: "fail",
          detail: `JEDEC ${signature.jedecId} decodes to ${fmtBytes(d.capacityBytes)}, but the profile is ${fmtBytes(profile.sizeBytes)}. Mismatch — do not trust this profile.`,
        });
      } else {
        const manuId = profile.manufacturer ? manufacturerIdForName(profile.manufacturer) : undefined;
        const manuMatches = manuId !== undefined && manuId === d.manufacturerId;
        checks.push({
          id: "signature",
          label: "Electronic signature",
          status: manuMatches ? "pass" : "warn",
          detail: manuMatches
            ? `JEDEC ${signature.jedecId} → ${d.manufacturerName}, ${fmtBytes(d.capacityBytes)} — matches the profile.`
            : `Capacity matches (${fmtBytes(d.capacityBytes)}), but the chip reports manufacturer ${d.manufacturerName}. Confirm the exact part.`,
        });
      }
    } else {
      checks.push({
        id: "signature",
        label: "Electronic signature",
        status: "skip",
        detail: "A JEDEC response was seen but could not be decoded.",
      });
    }
  } else if (signature.i2cAddresses && signature.i2cAddresses.length > 0) {
    if (profile.family === "24xxx_i2c_eeprom") {
      checks.push({
        id: "signature",
        label: "Electronic signature",
        status: "warn",
        detail: `I²C EEPROM ACKed at ${signature.i2cAddresses.map((a) => "0x" + a.toString(16)).join(", ")}. Consistent, but capacity isn't electronically verifiable — the read below confirms addressing.`,
      });
    } else {
      signatureBlocks = true;
      checks.push({
        id: "signature",
        label: "Electronic signature",
        status: "fail",
        detail: `The chip answers on I²C, but this profile is ${profile.protocol.toUpperCase()} — protocol mismatch.`,
      });
    }
  } else {
    checks.push({
      id: "signature",
      label: "Electronic signature",
      status: "skip",
      detail: "This family exposes no standard electronic ID — verification rests on the read below.",
    });
  }

  // ---- Full-read check
  let readStatus: CheckStatus;
  if (read.byteLength !== read.expectedBytes) {
    readStatus = "fail";
    checks.push({
      id: "read",
      label: "Full read",
      status: "fail",
      detail: `Read ${read.byteLength} of ${read.expectedBytes} expected bytes — wrong size or addressing.`,
    });
  } else if (read.allSame) {
    readStatus = "fail";
    checks.push({
      id: "read",
      label: "Full read",
      status: "fail",
      detail: "The dump is uniform (all 0x00 / 0xFF) — the chip is blank or the pinout/wiring is wrong.",
    });
  } else if (read.entropy < 0.2 || read.uniqueBytes < 4) {
    readStatus = "warn";
    checks.push({
      id: "read",
      label: "Full read",
      status: "warn",
      detail: `Read completed but the data is low-entropy (${read.entropy.toFixed(2)}). Could be a mostly-empty chip — inspect the dump before trusting it.`,
    });
  } else {
    readStatus = "pass";
    checks.push({
      id: "read",
      label: "Full read",
      status: "pass",
      detail: `Read ${fmtBytes(read.byteLength)} of plausible data (entropy ${read.entropy.toFixed(2)}, ${read.uniqueBytes} distinct byte values).`,
    });
  }

  // ---- Overall verdict
  const current = effectiveProvenance(profile).confidence;
  let recommended: ChipConfidence = current;
  let summary: string;
  if (signatureBlocks) {
    recommended = "ai_suggested";
    summary = "The chip's electronic signature contradicts this profile. Not promotable — re-check the part number or the pinout.";
  } else if (readStatus === "pass") {
    recommended = "bench_verified";
    summary =
      checks[0].status === "pass"
        ? "Both the electronic signature and a clean full read confirm this profile. Ready to promote to bench-verified."
        : "A clean full read confirms the pinout and size on real silicon. Ready to promote to bench-verified.";
  } else if (readStatus === "warn") {
    recommended = current;
    summary = "The read worked but the data looks degenerate. Confirm the chip isn't blank before promoting.";
  } else {
    recommended = "ai_suggested";
    summary = "The read failed — the pinout or size is likely wrong. Fix the profile and retry.";
  }

  const canPromote =
    recommended === "bench_verified" &&
    CONFIDENCE_ORDER.indexOf(recommended) > CONFIDENCE_ORDER.indexOf(current);

  return {
    chipProfileId: profile.chipProfileId,
    checks,
    recommendedConfidence: recommended,
    canPromote,
    summary,
  };
}
