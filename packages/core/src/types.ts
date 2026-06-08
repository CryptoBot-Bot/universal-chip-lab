import type { ChipProfile } from "@ecu/chip-db";

export type JobTargetType =
  | "loose_chip"
  | "ecu_module"
  | "tcu_module"
  | "instrument_cluster"
  | "airbag_module"
  | "bcm_body_module"
  | "training_board";

export type JobStatus =
  | "not_started"
  | "wiring_required"
  | "safety_check_required"
  | "ready_to_read"
  | "reading"
  | "read_complete"
  | "verifying"
  | "verified_backup"
  | "warning"
  | "failed";

export type JobMode = "read" | "write" | "verify";

export interface KnownFacts {
  chipMarking?: string;
  packageType?: string;
  hasPhoto?: boolean;
  modulePartNumber?: string;
  /** Volts. Undefined if unknown — triggers Safety Engine warning. */
  voltage?: number;
}

export interface JobRecord {
  jobId: string;
  title: string;
  targetType: JobTargetType;
  chipProfileId: string;
  adapterId: string;
  mode: JobMode;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  workspacePath: string;
  notes: string;
  legalUseConfirmed: boolean;
  knownFacts: KnownFacts;
  dumps: DumpRecord[];
  verification: VerificationResult | null;
  warnings: string[];
}

export interface DumpRecord {
  dumpId: string;
  jobId: string;
  fileName: string;
  operation: "read" | "write" | "verify";
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  adapterId: string;
  chipProfileId: string;
  verified: boolean;
}

export interface VerificationResult {
  verificationId: string;
  jobId: string;
  inputDumps: string[];
  sameSize: boolean;
  sameHash: boolean;
  allFF: boolean;
  all00: boolean;
  /** Normalised Shannon entropy in [0, 1]. */
  entropyScore: number;
  uniqueBytes: number;
  status: "verified_backup" | "mismatch" | "suspect";
  warnings: string[];
  createdAt: string;
}

export interface CreateJobInput {
  title: string;
  targetType: JobTargetType;
  chipProfileId: string;
  adapterId: string;
  knownFacts: KnownFacts;
  notes?: string;
  legalUseConfirmed: boolean;
}

export type ChipProfileLite = Pick<
  ChipProfile,
  "chipProfileId" | "displayName" | "family" | "protocol" | "sizeBytes"
>;
