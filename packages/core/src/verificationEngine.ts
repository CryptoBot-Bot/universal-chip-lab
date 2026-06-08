import {
  analysePatterns,
  compareDumps,
  shannonEntropyNormalised,
} from "@ecu/dump-tools";

import type { DumpRecord, VerificationResult } from "./types.js";

const SUSPECT_ENTROPY_THRESHOLD = 0.25;

export interface VerifyInput {
  jobId: string;
  dumps: { record: DumpRecord; data: Buffer }[];
}

export class VerificationEngine {
  verify(input: VerifyInput): VerificationResult {
    if (input.dumps.length < 2) {
      throw new Error("Verification requires at least two dumps.");
    }
    const [a, b] = input.dumps;
    const cmp = compareDumps(a!.data, b!.data);
    const patterns = analysePatterns(a!.data);
    const entropy = shannonEntropyNormalised(a!.data);
    const warnings: string[] = [];

    if (!cmp.sameSize) {
      warnings.push(
        `Dumps differ in size: ${cmp.sizeA} B vs ${cmp.sizeB} B. The two reads do not represent the same chip contents.`,
      );
    }
    if (!cmp.sameHash) {
      warnings.push(
        `SHA-256 mismatch. First differing offset: 0x${cmp.firstDifferingOffset.toString(16)} (${cmp.totalDifferingBytes} bytes differ).`,
      );
    }
    if (patterns.allFF) {
      warnings.push(
        "Dump is entirely 0xFF — this usually means an erased chip or a failed read (MISO floating high).",
      );
    }
    if (patterns.all00) {
      warnings.push(
        "Dump is entirely 0x00 — this usually means a failed read or VCC/CS held wrong.",
      );
    }
    if (entropy < SUSPECT_ENTROPY_THRESHOLD && !patterns.allFF && !patterns.all00) {
      warnings.push(
        `Very low entropy (${entropy.toFixed(3)}) — only ${patterns.uniqueBytes} distinct byte values. Suspect partial / mirrored read.`,
      );
    }

    const status: VerificationResult["status"] =
      cmp.sameSize && cmp.sameHash && !patterns.allFF && !patterns.all00
        ? "verified_backup"
        : cmp.sameSize && cmp.sameHash
          ? "suspect"
          : "mismatch";

    return {
      verificationId: `verify_${Date.now()}`,
      jobId: input.jobId,
      inputDumps: input.dumps.map((d) => d.record.fileName),
      sameSize: cmp.sameSize,
      sameHash: cmp.sameHash,
      allFF: patterns.allFF,
      all00: patterns.all00,
      entropyScore: Number(entropy.toFixed(3)),
      uniqueBytes: patterns.uniqueBytes,
      status,
      warnings,
      createdAt: new Date().toISOString(),
    };
  }
}
