import type { AdapterRegistry, ProgrammerAdapter } from "@ecu/adapters";
import type { ChipProfile, ChipRegistry } from "@ecu/chip-db";
import { sha256 } from "@ecu/dump-tools";
import type { JobFileManager } from "@ecu/workspace";

import { ProtocolPlanner } from "./protocolPlanner.js";
import { ReportEngine } from "./reportEngine.js";
import { SafetyAssessment, SafetyEngine } from "./safetyEngine.js";
import {
  CreateJobInput,
  DumpRecord,
  JobRecord,
  JobStatus,
  VerificationResult,
} from "./types.js";
import { VerificationEngine } from "./verificationEngine.js";

export interface JobEngineDeps {
  chipRegistry: ChipRegistry;
  adapterRegistry: AdapterRegistry;
  jobFiles: JobFileManager;
  safetyEngine: SafetyEngine;
  appVersion: string;
}

export interface ReadOperationInput {
  jobId: string;
  tag: "read_1" | "read_2" | "post_write_verify" | string;
}

export interface ReadOperationResult {
  job: JobRecord;
  dump: DumpRecord;
}

export class JobEngine {
  private readonly planner = new ProtocolPlanner();
  private readonly verifier = new VerificationEngine();
  private readonly reportEngine = new ReportEngine();

  constructor(private readonly deps: JobEngineDeps) {}

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const chip = this.requireChip(input.chipProfileId);
    const adapter = this.requireAdapter(input.adapterId);

    const now = new Date();
    const jobId = makeJobId(now, chip.chipProfileId, input.targetType);
    const paths = await this.deps.jobFiles.ensureLayout(jobId);

    const job: JobRecord = {
      jobId,
      title: input.title.trim() || `${chip.displayName} — ${input.targetType}`,
      targetType: input.targetType,
      chipProfileId: chip.chipProfileId,
      adapterId: adapter.adapterId,
      mode: "read",
      status: "wiring_required",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      workspacePath: paths.root,
      notes: input.notes ?? "",
      legalUseConfirmed: input.legalUseConfirmed,
      knownFacts: { ...input.knownFacts },
      dumps: [],
      verification: null,
      warnings: [],
    };

    await this.deps.jobFiles.writeJobRecord(jobId, job);
    await this.deps.jobFiles.appendLog(
      jobId,
      `job_created chip=${chip.chipProfileId} adapter=${adapter.adapterId} target=${input.targetType}`,
    );
    return job;
  }

  async listJobs(): Promise<JobRecord[]> {
    const ids = await this.deps.jobFiles.listJobIds();
    const records: JobRecord[] = [];
    for (const id of ids) {
      try {
        const raw = await this.deps.jobFiles.readJobRecord<JobRecord & { schemaVersion?: number }>(id);
        // Module jobs (schemaVersion 2) live alongside chip jobs in jobs/ —
        // filter them out so this list stays type-clean.
        if ((raw as { schemaVersion?: number }).schemaVersion === undefined) {
          records.push(raw);
        }
      } catch {
        /* skip malformed */
      }
    }
    return records;
  }

  async getJob(jobId: string): Promise<JobRecord> {
    return this.deps.jobFiles.readJobRecord<JobRecord>(jobId);
  }

  async assessSafety(jobId: string): Promise<SafetyAssessment> {
    const job = await this.getJob(jobId);
    const chip = this.requireChip(job.chipProfileId);
    const adapter = this.requireAdapter(job.adapterId);
    return this.deps.safetyEngine.assess(job, chip, adapter);
  }

  async planOperation(jobId: string) {
    const job = await this.getJob(jobId);
    const chip = this.requireChip(job.chipProfileId);
    const adapter = this.requireAdapter(job.adapterId);
    return this.planner.plan(chip, adapter);
  }

  async setStatus(jobId: string, status: JobStatus): Promise<JobRecord> {
    const job = await this.getJob(jobId);
    job.status = status;
    job.updatedAt = new Date().toISOString();
    await this.deps.jobFiles.writeJobRecord(jobId, job);
    await this.deps.jobFiles.appendLog(jobId, `status=${status}`);
    return job;
  }

  async executeRead(input: ReadOperationInput): Promise<ReadOperationResult> {
    const job = await this.getJob(input.jobId);
    const chip = this.requireChip(job.chipProfileId);
    const adapter = this.requireAdapter(job.adapterId);

    const safety = this.deps.safetyEngine.assess(job, chip, adapter);
    if (!safety.canRead) {
      const blockers = safety.findings.filter((f) => f.severity === "blocker");
      throw new Error(
        `Read blocked by Safety Engine: ${blockers.map((b) => b.message).join("; ") || "unknown blocker"}`,
      );
    }

    await ensureConnected(adapter);

    job.status = "reading";
    job.updatedAt = new Date().toISOString();
    await this.deps.jobFiles.writeJobRecord(input.jobId, job);
    await this.deps.jobFiles.appendLog(
      input.jobId,
      `read_start tag=${input.tag} chip=${chip.chipProfileId} adapter=${adapter.adapterId}`,
    );

    const result = await adapter.readMemory({
      chipProfile: chip,
      tag: input.tag,
    });

    const fileName = `${input.tag}.bin`;
    await this.deps.jobFiles.writeDump(input.jobId, fileName, result.data);

    const dump: DumpRecord = {
      dumpId: `${input.tag}_${Date.now()}`,
      jobId: input.jobId,
      fileName,
      operation: "read",
      sizeBytes: result.data.length,
      sha256: sha256(result.data),
      createdAt: new Date().toISOString(),
      adapterId: adapter.adapterId,
      chipProfileId: chip.chipProfileId,
      verified: false,
    };

    job.dumps = [...job.dumps.filter((d) => d.fileName !== fileName), dump];
    job.status = "read_complete";
    job.updatedAt = new Date().toISOString();
    await this.deps.jobFiles.writeJobRecord(input.jobId, job);
    await this.deps.jobFiles.appendLog(
      input.jobId,
      `read_complete tag=${input.tag} bytes=${result.data.length} sha256=${dump.sha256}`,
    );

    return { job, dump };
  }

  async verify(jobId: string): Promise<VerificationResult> {
    const job = await this.getJob(jobId);
    if (job.dumps.length < 2) {
      throw new Error("Need at least two dumps to verify. Run Read 1 then Read 2 first.");
    }
    job.status = "verifying";
    await this.deps.jobFiles.writeJobRecord(jobId, job);
    await this.deps.jobFiles.appendLog(jobId, "verify_start");

    const last = job.dumps.slice(-2);
    const [a, b] = await Promise.all(
      last.map(async (d) => ({
        record: d,
        data: await this.deps.jobFiles.readDump(jobId, d.fileName),
      })),
    );

    const verification = this.verifier.verify({
      jobId,
      dumps: [a!, b!],
    });

    job.verification = verification;
    job.warnings = verification.warnings;
    if (verification.status === "verified_backup") {
      job.status = "verified_backup";
      job.dumps = job.dumps.map((d) =>
        verification.inputDumps.includes(d.fileName) ? { ...d, verified: true } : d,
      );
    } else {
      job.status = "warning";
    }
    job.updatedAt = new Date().toISOString();
    await this.deps.jobFiles.writeJobRecord(jobId, job);
    await this.deps.jobFiles.appendLog(
      jobId,
      `verify_complete status=${verification.status} entropy=${verification.entropyScore} sameHash=${verification.sameHash}`,
    );

    return verification;
  }

  async writeReport(jobId: string): Promise<string> {
    const job = await this.getJob(jobId);
    const chip = this.requireChip(job.chipProfileId);
    const adapter = this.requireAdapter(job.adapterId);
    const plan = this.planner.plan(chip, adapter);
    const safety = this.deps.safetyEngine.assess(job, chip, adapter);
    const report = this.reportEngine.build({
      job,
      chip,
      adapter,
      plan,
      safety,
      appVersion: this.deps.appVersion,
    });
    return this.deps.jobFiles.writeReport(jobId, report);
  }

  async loadDump(jobId: string, fileName: string): Promise<Buffer> {
    return this.deps.jobFiles.readDump(jobId, fileName);
  }

  private requireChip(id: string): ChipProfile {
    const chip = this.deps.chipRegistry.get(id);
    if (!chip) throw new Error(`Unknown chip profile: ${id}`);
    return chip;
  }

  private requireAdapter(id: string): ProgrammerAdapter {
    const adapter = this.deps.adapterRegistry.get(id);
    if (!adapter) throw new Error(`Unknown adapter: ${id}`);
    return adapter;
  }
}

async function ensureConnected(adapter: ProgrammerAdapter): Promise<void> {
  const status = await adapter.getStatus();
  if (status.state !== "connected") {
    await adapter.connect();
  }
}

function makeJobId(date: Date, chipId: string, target: string): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const ms = date.getTime().toString(36);
  const slug = chipId.replace(/[^a-z0-9]+/gi, "_");
  return `${yyyy}-${mm}-${dd}_${slug}_${target}_${ms}`;
}
