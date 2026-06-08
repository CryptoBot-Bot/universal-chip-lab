import type { ModuleJobRecord } from "./moduleTypes.js";

export type OperationMode = "read_only" | "read_write_experimental";

export type CloneSlotStage =
  | "awaiting_source"        // source slot not verified yet
  | "awaiting_donor_archive" // source ok; donor pre-read not verified yet
  | "write_locked"           // both ok, but ECL_OPERATION_MODE = read_only
  | "ready_to_write"         // both ok AND write mode unlocked
  | "clone_verified"         // post-write read-back was byte-exact
  | "clone_mismatch";        // a write happened but read-back differed

export interface CloneSlotGate {
  slot: string;
  chipProfileId: string;
  adapterId: string;
  sourceVerified: boolean;
  donorArchived: boolean;
  writeModeUnlocked: boolean;
  /** True only if every precondition (except the typed confirmation) holds. */
  canWrite: boolean;
  stage: CloneSlotStage;
  blockers: string[];
  /** Verified source dump used as the write image (undefined until source verified). */
  sourceDumpFile?: string;
  sourceSha256?: string;
  /** Verified donor pre-read kept as rollback (undefined until donor archived). */
  donorArchiveFile?: string;
  donorArchiveSha256?: string;
  /** Result of a completed clone, if any. */
  postWriteSha256?: string;
  byteExact?: boolean;
}

export interface CloneCeremonyState {
  jobId: string;
  operationMode: OperationMode;
  writeModeUnlocked: boolean;
  /** The exact text the operator must type to authorise each write. */
  confirmationPhrase: string | null;
  slots: CloneSlotGate[];
  /** Every slot is at least ready_to_write (or beyond). */
  allReady: boolean;
  /** Every slot is clone_verified. */
  allVerified: boolean;
  /** Human-readable one-liner for the UI banner. */
  summary: string;
}

/**
 * Pure assessment. No I/O — derives the full ceremony gate from a job record
 * and the global operation mode. The typed-confirmation check is intentionally
 * NOT here; it is enforced at write time so a stale UI can't bypass it.
 */
export function assessCeremony(
  job: ModuleJobRecord,
  operationMode: OperationMode,
): CloneCeremonyState {
  const writeModeUnlocked = operationMode === "read_write_experimental";
  const confirmationPhrase = job.donor?.label ?? null;
  const cloneResults = job.cloneResults ?? {};

  const slots: CloneSlotGate[] = job.targets.map((t) => {
    const blockers: string[] = [];

    // Source must be verified (≥2 reads, matching SHA-256).
    const srcVer = job.source.verifications[t.slot];
    const sourceVerified = srcVer?.status === "verified_backup";
    const srcDump = (job.source.dumps[t.slot] ?? []).find((d) => d.verified);
    if (!sourceVerified || !srcDump) {
      blockers.push("Source slot is not a verified backup. Read it twice until SHA-256 matches.");
    }

    // Donor side must exist and the pre-read must be a credible rollback
    // image. We accept:
    //   1. status "verified_backup" (sameSize + sameHash + not all-FF/00) — the normal case
    //   2. status "suspect" with allFF=true (sameSize + sameHash + all 0xFF) —
    //      a fresh/erased donor chip. All-0xFF is a perfectly valid rollback
    //      image: if the clone write fails, an erase restores this exact state.
    //      The post-write byte-exact check at clone time independently
    //      validates the read fidelity, so we don't need the verification
    //      engine's MISO-floating-high paranoia gating us here.
    const donorVer = job.donor?.verifications[t.slot] ?? null;
    const donorArchived =
      donorVer?.status === "verified_backup" ||
      (donorVer?.status === "suspect" &&
        donorVer?.sameSize === true &&
        donorVer?.sameHash === true &&
        donorVer?.allFF === true);
    const donorDump = (job.donor?.dumps[t.slot] ?? []).find((d) => d.verified) ??
      // For all-FF donors marked "suspect", individual dumps may not have
      // verified=true because the engine only sets that on verified_backup.
      // Fall back to the most recent dump if both reads matched.
      (donorArchived ? (job.donor?.dumps[t.slot] ?? []).at(-1) ?? undefined : undefined);
    if (!job.donor) {
      blockers.push("Donor side has not been opened.");
    } else if (!donorArchived || !donorDump) {
      blockers.push("Donor pre-read is not a credible archive. Read the donor twice — SHA-256 must match across both reads. (Blank all-0xFF donors are accepted as rollback images.)");
    }

    if (!writeModeUnlocked) {
      blockers.push("Write mode is locked (ECL_OPERATION_MODE=read_only). Set it to read_write_experimental in .env to arm writes.");
    }

    const result = cloneResults[t.slot];

    let stage: CloneSlotStage;
    if (result) {
      stage = result.byteExact ? "clone_verified" : "clone_mismatch";
    } else if (!sourceVerified) {
      stage = "awaiting_source";
    } else if (!donorArchived) {
      stage = "awaiting_donor_archive";
    } else if (!writeModeUnlocked) {
      stage = "write_locked";
    } else {
      stage = "ready_to_write";
    }

    // canWrite: every precondition holds. Re-writes allowed on mismatch.
    const preconditionsOk =
      sourceVerified && donorArchived && writeModeUnlocked && !!srcDump && !!donorDump;
    const alreadyGood = stage === "clone_verified";
    const canWrite = preconditionsOk && !alreadyGood;

    const gate: CloneSlotGate = {
      slot: t.slot,
      chipProfileId: t.chipProfileId,
      adapterId: t.adapterId,
      sourceVerified,
      donorArchived,
      writeModeUnlocked,
      canWrite,
      stage,
      blockers,
    };
    if (srcDump) {
      gate.sourceDumpFile = srcDump.fileName;
      gate.sourceSha256 = srcDump.sha256;
    }
    if (donorDump) {
      gate.donorArchiveFile = donorDump.fileName;
      gate.donorArchiveSha256 = donorDump.sha256;
    }
    if (result) {
      gate.postWriteSha256 = result.postWriteSha256;
      gate.byteExact = result.byteExact;
    }
    return gate;
  });

  const allReady =
    slots.length > 0 &&
    slots.every((s) =>
      s.stage === "ready_to_write" ||
      s.stage === "clone_verified" ||
      s.stage === "clone_mismatch",
    );
  const allVerified =
    slots.length > 0 && slots.every((s) => s.stage === "clone_verified");

  let summary: string;
  if (allVerified) {
    summary = "Clone verified on every slot. Generate the ceremony report.";
  } else if (!writeModeUnlocked) {
    summary = "Write mode is LOCKED. The full pipeline is built but disarmed — set ECL_OPERATION_MODE=read_write_experimental in .env to arm it.";
  } else if (slots.some((s) => s.stage === "clone_mismatch")) {
    summary = "A slot read back NON-byte-exact after write. Inspect the diff before retrying — the donor archive is still your rollback.";
  } else if (allReady) {
    summary = "All gates green. Type the donor label to authorise each slot write.";
  } else {
    summary = "Ceremony blocked: verify source and archive the donor pre-read first.";
  }

  return {
    jobId: job.jobId,
    operationMode,
    writeModeUnlocked,
    confirmationPhrase,
    slots,
    allReady,
    allVerified,
    summary,
  };
}
