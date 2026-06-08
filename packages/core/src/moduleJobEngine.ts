import type { AdapterRegistry, ProgrammerAdapter } from "@ecu/adapters";
import { isWriteTrusted } from "@ecu/chip-db";
import type { ChipProfile, ChipRegistry } from "@ecu/chip-db";
import { compareDumps, sha256 } from "@ecu/dump-tools";
import type { ModuleRegistry } from "@ecu/vehicle-db";
import type { JobFileManager } from "@ecu/workspace";

import {
  CloneCeremonyState,
  OperationMode,
  assessCeremony,
} from "./cloningCeremony.js";
import { SafetyEngine } from "./safetyEngine.js";
import {
  CloneSlotResult,
  CreateModuleJobInput,
  ModuleJobRecord,
  ModuleJobStatus,
  ModuleMemoryTarget,
  ModuleSideRecord,
} from "./moduleTypes.js";
import {
  DumpRecord,
  JobRecord,
} from "./types.js";
import { VerificationEngine } from "./verificationEngine.js";

export interface ModuleJobEngineDeps {
  chipRegistry: ChipRegistry;
  moduleRegistry: ModuleRegistry;
  adapterRegistry: AdapterRegistry;
  jobFiles: JobFileManager;
  safetyEngine: SafetyEngine;
  /** Global write lock. read_only keeps the Cloning Ceremony disarmed. */
  operationMode: OperationMode;
  appVersion: string;
}

export interface CloneWriteInput {
  jobId: string;
  slot: string;
  /** Operator must type the donor label exactly to authorise the write. */
  donorLabelConfirmation: string;
  onLog?: (line: string) => void;
}

export interface CloneWriteResult {
  job: ModuleJobRecord;
  result: CloneSlotResult;
}

export type ModuleSide = "source" | "donor";

export interface ReadSlotInput {
  jobId: string;
  side: ModuleSide;
  slot: string;
  tag: string;
}

export interface ReadSlotResult {
  job: ModuleJobRecord;
  dump: DumpRecord;
}

/**
 * Module-level job orchestrator. A module job represents one ECU recovery:
 * read N memories from a SOURCE module, archive them, optionally read N
 * memories from a DONOR module (always before writing), then (eventually,
 * Phase D+) write source→donor and verify by reading the donor back.
 *
 * Files live under <workspace>/jobs/<jobId>/{source,donor}/{photos,dumps,logs}.
 */
export class ModuleJobEngine {
  private readonly verifier = new VerificationEngine();

  constructor(private readonly deps: ModuleJobEngineDeps) {}

  async createJob(input: CreateModuleJobInput): Promise<ModuleJobRecord> {
    const module = this.deps.moduleRegistry.get(input.moduleProfileId);
    if (!module) throw new Error(`Unknown module profile: ${input.moduleProfileId}`);

    const targets: ModuleMemoryTarget[] = input.targets.length > 0
      ? input.targets.map((t) => ({
          slot: t.slot,
          chipProfileId: t.chipProfileId,
          adapterId: t.adapterId,
          accessMethod: t.accessMethod,
          role: t.role,
          notes: t.notes ?? "",
        }))
      : module.memories.map((m) => ({
          slot: m.role,
          chipProfileId: m.chipProfileId,
          adapterId: "mock_adapter",
          accessMethod: m.accessMethod,
          role: m.role,
          notes: m.note ?? "",
        }));

    // Validate chips + adapters resolve.
    for (const t of targets) {
      const chip = this.deps.chipRegistry.get(t.chipProfileId);
      if (!chip) throw new Error(`Target ${t.slot}: unknown chip profile ${t.chipProfileId}`);
      const adapter = this.deps.adapterRegistry.get(t.adapterId);
      if (!adapter) throw new Error(`Target ${t.slot}: unknown adapter ${t.adapterId}`);
    }

    const now = new Date();
    const jobId = makeModuleJobId(now, module.moduleProfileId);
    const paths = await this.deps.jobFiles.ensureLayout(jobId);

    const record: ModuleJobRecord = {
      jobId,
      schemaVersion: 2,
      title: input.title.trim() || `${module.displayName} — recovery`,
      moduleProfileId: module.moduleProfileId,
      status: "draft",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      workspacePath: paths.root,
      notes: input.notes ?? "",
      legalUseConfirmed: input.legalUseConfirmed,
      targets,
      source: emptySide("original"),
      donor: null,
      cloneResults: {},
      warnings: [],
    };

    await this.deps.jobFiles.writeJobRecord(jobId, record);
    await this.deps.jobFiles.appendLog(
      jobId,
      `module_job_created module=${module.moduleProfileId} targets=${targets.length}`,
    );
    return record;
  }

  async listJobs(): Promise<ModuleJobRecord[]> {
    const ids = await this.deps.jobFiles.listJobIds();
    const out: ModuleJobRecord[] = [];
    for (const id of ids) {
      try {
        const raw = await this.deps.jobFiles.readJobRecord<JobRecord | ModuleJobRecord>(id);
        if ("schemaVersion" in raw && raw.schemaVersion === 2) {
          out.push(raw);
        }
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async getJob(jobId: string): Promise<ModuleJobRecord> {
    return this.deps.jobFiles.readJobRecord<ModuleJobRecord>(jobId);
  }

  async openDonorSide(jobId: string, donorLabel: string): Promise<ModuleJobRecord> {
    const job = await this.getJob(jobId);
    if (job.donor) return job;
    job.donor = emptySide(donorLabel || "donor");
    job.status = "donor_pre_read";
    job.updatedAt = new Date().toISOString();
    await this.deps.jobFiles.writeJobRecord(jobId, job);
    await this.deps.jobFiles.appendLog(jobId, `donor_side_opened label=${donorLabel}`);
    return job;
  }

  async readSlot(input: ReadSlotInput): Promise<ReadSlotResult> {
    const job = await this.getJob(input.jobId);
    const target = job.targets.find((t) => t.slot === input.slot);
    if (!target) throw new Error(`Unknown target slot: ${input.slot}`);

    const chip = this.requireChip(target.chipProfileId);
    const adapter = this.requireAdapter(target.adapterId);

    // Build a shim JobRecord just for the SafetyEngine pre-flight.
    const safetyJob: JobRecord = {
      jobId: job.jobId,
      title: job.title,
      targetType: "ecu_module",
      chipProfileId: chip.chipProfileId,
      adapterId: adapter.adapterId,
      mode: "read",
      status: "ready_to_read",
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      workspacePath: job.workspacePath,
      notes: job.notes,
      legalUseConfirmed: job.legalUseConfirmed,
      knownFacts: { voltage: chip.voltage.typical },
      dumps: [],
      verification: null,
      warnings: [],
    };
    const safety = this.deps.safetyEngine.assess(safetyJob, chip, adapter);
    if (!safety.canRead) {
      const blockers = safety.findings.filter((f) => f.severity === "blocker");
      throw new Error(
        `Read blocked by Safety Engine on slot ${input.slot}: ${blockers.map((b) => b.message).join("; ")}`,
      );
    }

    await ensureConnected(adapter);

    job.status = input.side === "source" ? "source_reading" : "donor_pre_read";
    await this.deps.jobFiles.writeJobRecord(input.jobId, job);
    await this.deps.jobFiles.appendLog(
      input.jobId,
      `slot_read_start side=${input.side} slot=${input.slot} chip=${chip.chipProfileId} adapter=${adapter.adapterId} tag=${input.tag}`,
    );

    const result = await adapter.readMemory({ chipProfile: chip, tag: input.tag });
    const fileName = `${input.side}_${input.slot}_${input.tag}.bin`;
    await this.deps.jobFiles.writeDump(input.jobId, fileName, result.data, { overwrite: true });

    const dump: DumpRecord = {
      dumpId: `${input.side}_${input.slot}_${input.tag}_${Date.now()}`,
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

    const side = input.side === "source" ? job.source : ensureDonor(job);
    const existing = side.dumps[input.slot] ?? [];
    side.dumps[input.slot] = [...existing.filter((d) => d.fileName !== fileName), dump];

    // Try to verify if we have ≥2 reads of this slot on this side.
    const sideDumps = side.dumps[input.slot]!;
    if (sideDumps.length >= 2) {
      const [a, b] = sideDumps.slice(-2);
      const [aData, bData] = await Promise.all([
        this.deps.jobFiles.readDump(input.jobId, a!.fileName),
        this.deps.jobFiles.readDump(input.jobId, b!.fileName),
      ]);
      const verification = this.verifier.verify({
        jobId: input.jobId,
        dumps: [
          { record: a!, data: aData },
          { record: b!, data: bData },
        ],
      });
      side.verifications[input.slot] = verification;
      if (verification.status === "verified_backup") {
        side.dumps[input.slot] = sideDumps.map((d) =>
          verification.inputDumps.includes(d.fileName) ? { ...d, verified: true } : d,
        );
      }
    } else {
      side.verifications[input.slot] = null;
    }

    job.status = aggregateStatus(job);
    job.updatedAt = new Date().toISOString();
    await this.deps.jobFiles.writeJobRecord(input.jobId, job);
    await this.deps.jobFiles.appendLog(
      input.jobId,
      `slot_read_done side=${input.side} slot=${input.slot} sha256=${dump.sha256} bytes=${dump.sizeBytes}`,
    );

    return { job, dump };
  }

  // -------------------------------------------------------------------------
  // Cloning Ceremony
  // -------------------------------------------------------------------------

  async assessCeremony(jobId: string): Promise<CloneCeremonyState> {
    const job = await this.getJob(jobId);
    if (!job.cloneResults) job.cloneResults = {};
    return assessCeremony(job, this.deps.operationMode);
  }

  /**
   * Write one verified source slot into the donor, read the donor back, and
   * confirm byte-exactness. Refuses unless every gate is green AND the
   * operator typed the donor label exactly. The donor pre-read archive is
   * NEVER touched — it is the rollback image.
   */
  async cloneWriteSlot(input: CloneWriteInput): Promise<CloneWriteResult> {
    const log = (line: string) => {
      input.onLog?.(line);
      return this.deps.jobFiles.appendLog(input.jobId, line);
    };

    const job = await this.getJob(input.jobId);
    if (!job.cloneResults) job.cloneResults = {};
    if (!job.donor) throw new Error("Donor side has not been opened.");

    const target = job.targets.find((t) => t.slot === input.slot);
    if (!target) throw new Error(`Unknown target slot: ${input.slot}`);

    const chip = this.requireChip(target.chipProfileId);
    const adapter = this.requireAdapter(target.adapterId);

    // Write-trust gate: never write to a donor using a chip profile whose
    // pinout hasn't been confirmed on real silicon. AI-resolved profiles stay
    // `ai_suggested` until the verify step promotes them to `bench_verified`.
    if (!isWriteTrusted(chip)) {
      throw new Error(
        `Write blocked: the profile "${chip.displayName}" is not bench-verified. ` +
          `Verify it against the chip's electronic signature and a real read before cloning into a donor.`,
      );
    }

    // Re-assess the gate from scratch — a stale UI cannot bypass this.
    const state = assessCeremony(job, this.deps.operationMode);
    const gate = state.slots.find((s) => s.slot === input.slot);
    if (!gate) throw new Error(`Slot ${input.slot} not found in ceremony state.`);
    if (!gate.canWrite) {
      throw new Error(
        `Write blocked for slot ${input.slot}: ${gate.blockers.join(" ") || "preconditions not met"}`,
      );
    }

    // Typed-confirmation gate (the "type the resource name" pattern).
    if (input.donorLabelConfirmation !== job.donor.label) {
      throw new Error(
        `Confirmation text does not match the donor label "${job.donor.label}". Write aborted.`,
      );
    }

    if (!gate.sourceDumpFile || !gate.donorArchiveFile) {
      throw new Error("Internal: verified source/donor files missing despite green gate.");
    }
    if (!adapter.writeMemory) {
      throw new Error(
        `Adapter "${adapter.displayName}" does not implement writeMemory. Pick a write-capable adapter for slot ${input.slot}.`,
      );
    }

    const sourceBytes = await this.deps.jobFiles.readDump(input.jobId, gate.sourceDumpFile);
    if (sourceBytes.length !== chip.sizeBytes) {
      throw new Error(
        `Source image is ${sourceBytes.length} B but the donor chip ${chip.displayName} is ${chip.sizeBytes} B. Refusing to write a size-mismatched image.`,
      );
    }
    const sourceSha = sha256(sourceBytes);

    await ensureConnected(adapter);

    // ---- WRITE -----------------------------------------------------------
    job.status = "donor_writing";
    job.updatedAt = new Date().toISOString();
    await this.deps.jobFiles.writeJobRecord(input.jobId, job);
    await log(
      `clone_write_start slot=${input.slot} chip=${chip.chipProfileId} adapter=${adapter.adapterId} ` +
        `src=${gate.sourceDumpFile} srcSha=${sourceSha} donorArchive=${gate.donorArchiveFile}`,
    );

    const writeRes = await adapter.writeMemory({
      chipProfile: chip,
      data: sourceBytes,
      tag: `clone_${input.slot}`,
    });

    const writeDump: DumpRecord = {
      dumpId: `donor_${input.slot}_write_${Date.now()}`,
      jobId: input.jobId,
      fileName: gate.sourceDumpFile, // image written == verified source image
      operation: "write",
      sizeBytes: sourceBytes.length,
      sha256: sourceSha,
      createdAt: new Date().toISOString(),
      adapterId: adapter.adapterId,
      chipProfileId: chip.chipProfileId,
      verified: false,
    };

    // ---- POST-WRITE READ-BACK -------------------------------------------
    job.status = "donor_post_read";
    job.updatedAt = new Date().toISOString();
    await this.deps.jobFiles.writeJobRecord(input.jobId, job);
    await log(`clone_write_done slot=${input.slot} bytes=${writeRes.bytesWritten}; reading donor back…`);

    const readBack = await adapter.readMemory({
      chipProfile: chip,
      tag: `${input.slot}_postwrite`,
    });
    const postFile = `donor_${input.slot}_postwrite_1.bin`;
    await this.deps.jobFiles.writeDump(input.jobId, postFile, readBack.data, {
      overwrite: true, // post-write file, NOT the archive — safe to overwrite on retry
    });
    const postSha = sha256(readBack.data);
    const cmp = compareDumps(sourceBytes, readBack.data);
    const byteExact = cmp.sameSize && cmp.sameHash;

    const postDump: DumpRecord = {
      dumpId: `donor_${input.slot}_postwrite_${Date.now()}`,
      jobId: input.jobId,
      fileName: postFile,
      operation: "verify",
      sizeBytes: readBack.data.length,
      sha256: postSha,
      createdAt: new Date().toISOString(),
      adapterId: adapter.adapterId,
      chipProfileId: chip.chipProfileId,
      verified: byteExact,
    };

    const donor = job.donor;
    const slotDumps = donor.dumps[input.slot] ?? [];
    donor.dumps[input.slot] = [
      ...slotDumps.filter((d) => d.fileName !== postFile && d.operation !== "write"),
      writeDump,
      postDump,
    ];

    const result: CloneSlotResult = {
      slot: input.slot,
      sourceImageFile: gate.sourceDumpFile,
      sourceSha256: sourceSha,
      donorArchiveFile: gate.donorArchiveFile,
      donorArchiveSha256: gate.donorArchiveSha256 ?? "",
      postWriteFile: postFile,
      postWriteSha256: postSha,
      bytesWritten: writeRes.bytesWritten,
      byteExact,
      firstDifferingOffset: cmp.firstDifferingOffset,
      totalDifferingBytes: cmp.totalDifferingBytes,
      writtenAt: new Date().toISOString(),
      adapterId: adapter.adapterId,
      operatorConfirmation: input.donorLabelConfirmation,
    };
    job.cloneResults[input.slot] = result;

    job.status = cloneRollupStatus(job);
    if (!byteExact) {
      job.warnings = [
        ...job.warnings.filter((w) => !w.startsWith(`slot ${input.slot}:`)),
        `slot ${input.slot}: post-write read-back NOT byte-exact (${cmp.totalDifferingBytes} bytes differ, first @0x${cmp.firstDifferingOffset.toString(16)}). Donor archive ${gate.donorArchiveFile} is the rollback.`,
      ];
    }
    job.updatedAt = new Date().toISOString();
    await this.deps.jobFiles.writeJobRecord(input.jobId, job);
    await log(
      `clone_verify slot=${input.slot} byteExact=${byteExact} postSha=${postSha} ` +
        `diffBytes=${cmp.totalDifferingBytes}`,
    );

    return { job, result };
  }

  async writeCeremonyReport(jobId: string): Promise<string> {
    const job = await this.getJob(jobId);
    const module = this.deps.moduleRegistry.get(job.moduleProfileId);
    if (!job.cloneResults) job.cloneResults = {};
    const state = assessCeremony(job, this.deps.operationMode);

    const report = {
      schemaVersion: 1 as const,
      kind: "clone-ceremony" as const,
      generatedAt: new Date().toISOString(),
      app: { name: "ECU Clone Lab", version: this.deps.appVersion },
      job: {
        jobId: job.jobId,
        title: job.title,
        moduleProfileId: job.moduleProfileId,
        status: job.status,
        legalUseConfirmed: job.legalUseConfirmed,
        notes: job.notes,
      },
      module: module
        ? {
            displayName: module.displayName,
            brand: module.brand,
            manufacturer: module.manufacturer,
            cloneAccessibility: module.cloneAccessibility,
            donorCompatibilityNote: module.donorCompatibilityNote,
          }
        : null,
      operationMode: this.deps.operationMode,
      sourceLabel: job.source.label,
      donorLabel: job.donor?.label ?? null,
      slots: job.targets.map((t) => ({
        slot: t.slot,
        chipProfileId: t.chipProfileId,
        adapterId: t.adapterId,
        gate: state.slots.find((s) => s.slot === t.slot)?.stage ?? "unknown",
        result: job.cloneResults[t.slot] ?? null,
      })),
      verdict: state.allVerified
        ? "CLONE VERIFIED — every slot read back byte-exact."
        : "INCOMPLETE — not every slot is byte-exact verified.",
    };

    return this.deps.jobFiles.writeNamedReport(jobId, "clone-ceremony.json", report);
  }

  private requireChip(id: string): ChipProfile {
    const c = this.deps.chipRegistry.get(id);
    if (!c) throw new Error(`Unknown chip profile: ${id}`);
    return c;
  }

  private requireAdapter(id: string): ProgrammerAdapter {
    const a = this.deps.adapterRegistry.get(id);
    if (!a) throw new Error(`Unknown adapter: ${id}`);
    return a;
  }
}

function emptySide(label: string): ModuleSideRecord {
  return { label, photoFileNames: [], dumps: {}, verifications: {} };
}

function ensureDonor(job: ModuleJobRecord): ModuleSideRecord {
  if (!job.donor) job.donor = emptySide("donor");
  return job.donor;
}

function aggregateStatus(job: ModuleJobRecord): ModuleJobStatus {
  const sourceSlots = job.targets.map((t) => job.source.verifications[t.slot]);
  const sourceVerified = sourceSlots.length > 0 && sourceSlots.every((v) => v?.status === "verified_backup");

  if (!job.donor) {
    return sourceVerified ? "source_verified" : (sourceSlots.some((v) => v) ? "source_reading" : "draft");
  }

  const donorSlots = job.targets.map((t) => job.donor!.verifications[t.slot]);
  const donorVerified = donorSlots.length > 0 && donorSlots.every((v) => v?.status === "verified_backup");

  if (donorVerified && sourceVerified) return "donor_pre_verified";
  if (donorSlots.some((v) => v)) return "donor_pre_read";
  return sourceVerified ? "source_verified" : "draft";
}

function cloneRollupStatus(job: ModuleJobRecord): ModuleJobStatus {
  const results = job.cloneResults ?? {};
  const slotResults = job.targets.map((t) => results[t.slot]);
  const written = slotResults.filter(Boolean);
  if (written.length === 0) return aggregateStatus(job);
  if (slotResults.every((r) => r && r.byteExact)) return "clone_verified";
  if (written.some((r) => r && !r.byteExact)) return "warning";
  return "donor_post_read";
}

async function ensureConnected(adapter: ProgrammerAdapter): Promise<void> {
  const status = await adapter.getStatus();
  if (status.state !== "connected") await adapter.connect();
}

function makeModuleJobId(date: Date, moduleId: string): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const stamp = date.getTime().toString(36);
  const slug = moduleId.replace(/[^a-z0-9]+/gi, "_");
  return `${yyyy}-${mm}-${dd}_module_${slug}_${stamp}`;
}
