import type { ProgrammerAdapter } from "@ecu/adapters";
import type { ChipProfile } from "@ecu/chip-db";

import type { JobRecord, KnownFacts } from "./types.js";

export type SafetySeverity = "info" | "warning" | "blocker";

export interface SafetyFinding {
  id: string;
  severity: SafetySeverity;
  message: string;
}

export interface SafetyAssessment {
  canRead: boolean;
  canWrite: boolean;
  /** True only if there is at least one verified backup dump for this job. */
  hasVerifiedBackup: boolean;
  findings: SafetyFinding[];
}

export interface SafetyEngineOptions {
  /** Global lock from .env (ECL_OPERATION_MODE). MVP-1 stays in read-only mode. */
  operationMode: "read_only" | "read_write_experimental";
}

export class SafetyEngine {
  constructor(private readonly options: SafetyEngineOptions) {}

  /**
   * Pre-flight check. Run before any read/write. Surfaces blockers
   * (must be resolved) and warnings (operator must acknowledge in the UI).
   */
  assess(job: JobRecord, chip: ChipProfile, adapter: ProgrammerAdapter): SafetyAssessment {
    const findings: SafetyFinding[] = [];

    // Rule 1: legal use must be acknowledged.
    if (!job.legalUseConfirmed) {
      findings.push({
        id: "legal_use_not_confirmed",
        severity: "blocker",
        message:
          "The operator has not confirmed that this module is owned or authorised work. Confirm legal use in the New Job Wizard before continuing.",
      });
    }

    // Rule 2: adapter must support the chip protocol.
    if (!adapter.supportsProtocol(chip.protocol)) {
      findings.push({
        id: "protocol_not_supported",
        severity: "blocker",
        message: `Adapter "${adapter.displayName}" does not support the ${chip.protocol.toUpperCase()} protocol required by ${chip.displayName}.`,
      });
    }

    // Rule 3: known voltage must be inside the chip's voltage window.
    const knownV = job.knownFacts.voltage;
    if (typeof knownV !== "number" || Number.isNaN(knownV)) {
      findings.push({
        id: "voltage_unknown",
        severity: "warning",
        message: `Chip voltage was not specified. ${chip.displayName} expects ${chip.voltage.typical} V typical (range ${chip.voltage.min} – ${chip.voltage.max} V).`,
      });
    } else if (knownV < chip.voltage.min || knownV > chip.voltage.max) {
      findings.push({
        id: "voltage_out_of_range",
        severity: "blocker",
        message: `Specified voltage ${knownV} V is outside the chip's safe range (${chip.voltage.min} – ${chip.voltage.max} V).`,
      });
    } else if (!adapter.supportsVoltage(knownV)) {
      findings.push({
        id: "voltage_unsupported_by_adapter",
        severity: "warning",
        message: `Adapter "${adapter.displayName}" cannot natively drive ${knownV} V — a level shifter or external supply will be needed.`,
      });
    }

    // Rule 4: in-circuit warning — anything that isn't a loose chip or a
    // dedicated training board may be conflicting with a host MCU.
    if (
      job.targetType !== "loose_chip" &&
      job.targetType !== "training_board" &&
      (chip.protocol === "spi" || chip.protocol === "i2c")
    ) {
      findings.push({
        id: "in_circuit_read_warning",
        severity: "warning",
        message: `In-circuit ${chip.protocol.toUpperCase()} reads can fail if the host MCU holds the bus. Consider lifting the chip or holding the MCU in reset before reading.`,
      });
    }

    // Rule 5: write requires verified backup AND not in read-only mode.
    const hasVerifiedBackup = job.verification?.status === "verified_backup";
    const writeLockedByMode = this.options.operationMode === "read_only";

    if (writeLockedByMode) {
      findings.push({
        id: "write_locked_by_mode",
        severity: "info",
        message:
          "Write operations are disabled globally (ECL_OPERATION_MODE=read_only). MVP-1 keeps this lock on by default.",
      });
    } else if (!hasVerifiedBackup) {
      findings.push({
        id: "write_requires_verified_backup",
        severity: "blocker",
        message:
          "Write is locked until at least one verified backup exists for this job. Run Read twice and confirm the SHA-256 match first.",
      });
    }

    const hasBlocker = findings.some((f) => f.severity === "blocker");
    const canRead = !hasBlocker && adapter.canRead;
    const canWrite =
      !hasBlocker &&
      !writeLockedByMode &&
      hasVerifiedBackup &&
      adapter.canWrite &&
      chip.operations.write;

    return {
      canRead,
      canWrite,
      hasVerifiedBackup,
      findings,
    };
  }

  /**
   * Lightweight check used by the New Job Wizard before any adapter is even
   * selected — just guards on the known facts.
   */
  assessKnownFacts(chip: ChipProfile, facts: KnownFacts): SafetyFinding[] {
    const findings: SafetyFinding[] = [];
    if (typeof facts.voltage !== "number") {
      findings.push({
        id: "voltage_unknown",
        severity: "warning",
        message: "Voltage is unknown. The Safety Engine will require an explicit value before allowing any operation.",
      });
    } else if (facts.voltage < chip.voltage.min || facts.voltage > chip.voltage.max) {
      findings.push({
        id: "voltage_out_of_range",
        severity: "blocker",
        message: `Voltage ${facts.voltage} V is outside ${chip.displayName}'s safe range (${chip.voltage.min} – ${chip.voltage.max} V).`,
      });
    }
    return findings;
  }
}
