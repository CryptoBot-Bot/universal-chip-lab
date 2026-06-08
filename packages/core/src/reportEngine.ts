import type { ProgrammerAdapter } from "@ecu/adapters";
import type { ChipProfile } from "@ecu/chip-db";

import type { OperationPlan } from "./protocolPlanner.js";
import type { SafetyAssessment } from "./safetyEngine.js";
import type { JobRecord } from "./types.js";

export interface ReportPayload {
  schemaVersion: 1;
  generatedAt: string;
  app: { name: string; version: string };
  job: JobRecord;
  chip: ChipProfile;
  adapter: {
    adapterId: string;
    displayName: string;
    type: ProgrammerAdapter["type"];
    safetyLevel: ProgrammerAdapter["safetyLevel"];
  };
  plan: OperationPlan;
  safety: SafetyAssessment;
  conclusion: string;
}

export interface ReportInput {
  job: JobRecord;
  chip: ChipProfile;
  adapter: ProgrammerAdapter;
  plan: OperationPlan;
  safety: SafetyAssessment;
  appVersion: string;
}

export class ReportEngine {
  build(input: ReportInput): ReportPayload {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      app: { name: "ECU Clone Lab", version: input.appVersion },
      job: input.job,
      chip: input.chip,
      adapter: {
        adapterId: input.adapter.adapterId,
        displayName: input.adapter.displayName,
        type: input.adapter.type,
        safetyLevel: input.adapter.safetyLevel,
      },
      plan: input.plan,
      safety: input.safety,
      conclusion: this.summarise(input),
    };
  }

  private summarise(input: ReportInput): string {
    const v = input.job.verification;
    if (!v) return "No verification has been run yet.";
    if (v.status === "verified_backup") {
      return `Verified backup obtained (${input.job.dumps.length} dumps, SHA-256 match, entropy ${v.entropyScore}).`;
    }
    if (v.status === "suspect") {
      return `Two reads matched but the dump looks suspect: ${v.warnings.join(" ")}`;
    }
    return `Reads did not match. ${v.warnings.join(" ")}`;
  }
}
