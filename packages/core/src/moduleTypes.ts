import type { DumpRecord, VerificationResult } from "./types.js";

export type ModuleJobStatus =
  | "draft"
  | "source_reading"
  | "source_verified"
  | "donor_pre_read"
  | "donor_pre_verified"
  | "ready_to_write"        // gated, MVP-1 keeps this disabled
  | "donor_writing"
  | "donor_post_read"
  | "clone_verified"
  | "warning"
  | "failed";

export interface ModuleMemoryTarget {
  /** Stable identifier within the job, e.g. "immo_eeprom". */
  slot: string;
  /** ID into @ecu/chip-db. */
  chipProfileId: string;
  /** Adapter to use for this specific memory (different chips may need different adapters). */
  adapterId: string;
  /** Where this memory lives — see ModuleMemoryRef in @ecu/vehicle-db. */
  accessMethod: string;
  /** Role label, free-form. */
  role: string;
  /** Notes from operator: PCB location, gotchas, photo references. */
  notes: string;
}

export interface ModuleSideRecord {
  /** Free-form identifier from the operator. */
  label: string;
  /** Photos under workspace/jobs/<jobId>/photos/source/ etc. */
  photoFileNames: string[];
  /** One DumpRecord per memory target, keyed by slot. */
  dumps: Record<string, DumpRecord[]>;
  /** One verification per slot. */
  verifications: Record<string, VerificationResult | null>;
}

export interface ModuleJobRecord {
  /** Module jobs use a different id prefix than chip jobs. */
  jobId: string;
  schemaVersion: 2;
  title: string;
  moduleProfileId: string;
  status: ModuleJobStatus;
  createdAt: string;
  updatedAt: string;
  workspacePath: string;
  notes: string;
  legalUseConfirmed: boolean;

  /** Memory targets active in this job. Subset of the module's full memory list. */
  targets: ModuleMemoryTarget[];

  source: ModuleSideRecord;
  donor: ModuleSideRecord | null;

  /** Per-slot clone outcome, keyed by slot. Populated by the Cloning Ceremony. */
  cloneResults: Record<string, CloneSlotResult>;

  /** Top-level warnings aggregated across all slots. */
  warnings: string[];
}

/**
 * Immutable record of one slot's write+verify. This is the chain-of-custody
 * artefact: which source image was written, which donor archive protects the
 * rollback, and whether the post-write read-back was byte-exact.
 */
export interface CloneSlotResult {
  slot: string;
  /** Verified source dump that was written into the donor. */
  sourceImageFile: string;
  sourceSha256: string;
  /** Verified donor pre-read kept as the rollback image — never overwritten. */
  donorArchiveFile: string;
  donorArchiveSha256: string;
  /** Donor read back AFTER the write. New file; archive untouched. */
  postWriteFile: string;
  postWriteSha256: string;
  bytesWritten: number;
  /** True only if post-write SHA-256 == source SHA-256. */
  byteExact: boolean;
  firstDifferingOffset: number;
  totalDifferingBytes: number;
  writtenAt: string;
  adapterId: string;
  /** Exact text the operator typed to authorise this write (the donor label). */
  operatorConfirmation: string;
}

export interface CreateModuleJobInput {
  title: string;
  moduleProfileId: string;
  notes?: string;
  legalUseConfirmed: boolean;
  /** Targets selected for THIS job. Operator may skip some memories. */
  targets: (Omit<ModuleMemoryTarget, "notes"> & { notes?: string })[];
}

export type ModuleJobStatusBadge = {
  label: string;
  tone: "" | "info" | "ok" | "warn" | "danger";
};

export const MODULE_JOB_STATUS_LABEL: Record<ModuleJobStatus, ModuleJobStatusBadge> = {
  draft:               { label: "Draft",                tone: "" },
  source_reading:      { label: "Source reading…",      tone: "info" },
  source_verified:     { label: "Source verified",      tone: "ok" },
  donor_pre_read:      { label: "Donor pre-reading…",   tone: "info" },
  donor_pre_verified:  { label: "Donor archive saved",  tone: "ok" },
  ready_to_write:      { label: "Ready to write",       tone: "warn" },
  donor_writing:       { label: "Writing donor…",       tone: "warn" },
  donor_post_read:     { label: "Post-write reading…",  tone: "info" },
  clone_verified:      { label: "Clone verified",       tone: "ok" },
  warning:             { label: "Warning",              tone: "warn" },
  failed:              { label: "Failed",               tone: "danger" },
};
