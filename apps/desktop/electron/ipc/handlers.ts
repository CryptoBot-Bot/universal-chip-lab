import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { createAdapterRegistry, detectAll } from "@ecu/adapters";
import { assessProfileVerification, createChipRegistry, matchSignature } from "@ecu/chip-db";
import type { ChipProfile, ChipSignature, Protocol, ReadSummary } from "@ecu/chip-db";
import {
  deleteStoredProfile,
  loadStoredProfiles,
  saveStoredProfile,
} from "@ecu/chip-db/store";
import { JobEngine, ModuleJobEngine, SafetyEngine } from "@ecu/core";
import { analysePatterns, hexPreview, shannonEntropyNormalised } from "@ecu/dump-tools";
import { createModuleRegistry } from "@ecu/vehicle-db";
import { JobFileManager, WorkspaceManager } from "@ecu/workspace";

import {
  addChipAsset,
  deleteChipAsset,
  listChipAssets,
  readChipAsset,
  readChipGuide,
  writeChipGuide,
} from "../chipAssets";
import { deleteDump, exportDump, listDumps, readDumpSlice, type DumpFormat } from "../dumps";
import {
  generateChipGuide,
  resolveChip,
  scaffoldChipFromName,
  testApiKey,
  type ResolveChipInput,
} from "../resolver/chipResolver";
import { clearApiKey, getKeyStatus, setApiKey } from "../settings";
import { findPicoPort } from "../serial/picoSerial";
import { picoSessionCommand, stopPicoSession } from "../serial/picoSession";

import type { IpcChannel, IpcResponse } from "./channels";

interface RegisterOptions {
  projectRoot: string;
  appVersion: string;
}

export async function registerIpcHandlers(
  ipcMain: IpcMain,
  opts: RegisterOptions,
): Promise<void> {
  const chipRegistry = createChipRegistry();
  const moduleRegistry = createModuleRegistry();
  const adapterRegistry = createAdapterRegistry();
  const workspace = new WorkspaceManager(opts.projectRoot);
  const layout = await workspace.init();
  const jobFiles = new JobFileManager(layout);
  const chipAssetsDir = path.join(layout.root, "chip-assets");

  // Hydrate operator/AI-resolved profiles from disk so they appear in the
  // chip list and survive restarts. Built-in seed profiles are always present.
  const storedProfiles = await loadStoredProfiles(layout.chipDbDir);
  for (const profile of storedProfiles.profiles) chipRegistry.register(profile);
  if (storedProfiles.errors.length > 0) {
    console.warn(
      `[ECL] Skipped ${storedProfiles.errors.length} invalid stored chip profile(s):`,
      storedProfiles.errors.map((e) => `${e.file}: ${e.message}`).join("; "),
    );
  }

  const operationMode =
    process.env.ECL_OPERATION_MODE === "read_write_experimental"
      ? "read_write_experimental"
      : "read_only";
  const safetyEngine = new SafetyEngine({ operationMode });
  const jobEngine = new JobEngine({
    chipRegistry,
    adapterRegistry,
    jobFiles,
    safetyEngine,
    appVersion: opts.appVersion,
  });
  const moduleJobEngine = new ModuleJobEngine({
    chipRegistry,
    moduleRegistry,
    adapterRegistry,
    jobFiles,
    safetyEngine,
    operationMode,
    appVersion: opts.appVersion,
  });

  function register<T>(
    channel: IpcChannel,
    handler: (event: IpcMainInvokeEvent, payload: any) => Promise<T> | T,
  ): void {
    ipcMain.handle(channel, async (event, payload): Promise<IpcResponse<T>> => {
      try {
        const data = await handler(event, payload);
        return { ok: true, data };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    });
  }

  register("workspace:init", () => ({ root: layout.root, jobsDir: layout.jobsDir }));

  // ---- chips
  register("chips:list", () => chipRegistry.list());
  register("chips:resolve", (_e, input: ResolveChipInput) => resolveChip(input));

  // ---- settings (Anthropic API key)
  register("settings:getKeyStatus", () => getKeyStatus());
  register("settings:setApiKey", (_e, p: { key: string }) => {
    setApiKey(p.key);
    return getKeyStatus();
  });
  register("settings:clearApiKey", () => {
    clearApiKey();
    return getKeyStatus();
  });
  register("settings:testApiKey", (_e, p: { key?: string }) => testApiKey(p?.key));
  register("chips:saveProfile", async (_e, profile: ChipProfile) => {
    chipRegistry.register(profile); // validates; throws on a bad profile
    await saveStoredProfile(layout.chipDbDir, profile, new Date().toISOString());
    return chipRegistry.get(profile.chipProfileId);
  });
  register("chips:deleteProfile", async (_e, p: { id: string }) => {
    const removed = chipRegistry.unregister(p.id);
    await deleteStoredProfile(layout.chipDbDir, p.id);
    return { removed };
  });

  // Scan the chip's signature + do a full read with the profile, then assess.
  // Used by both verify (report only) and promote (re-derived server-side so a
  // stale UI cannot promote a profile the evidence doesn't support).
  async function runProfileVerification(
    profile: ChipProfile,
    adapterId: string,
    simulateChipId?: string,
  ): Promise<{ verification: ReturnType<typeof assessProfileVerification>; signature: ChipSignature }> {
    const adapter = adapterRegistry.get(adapterId);
    if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
    await adapter.connect();

    let signature: ChipSignature = { protocol: profile.protocol, noElectronicId: true };
    if (adapter.identifyChip) {
      const simulateChip = simulateChipId
        ? chipRegistry.get(simulateChipId)
        : chipRegistry.get(profile.chipProfileId);
      const idResult = await adapter.identifyChip(simulateChip ? { simulateChip } : {});
      signature = idResult.signature;
    }

    const readResult = await adapter.readMemory({ chipProfile: profile, tag: "verify_read" });
    const patterns = analysePatterns(readResult.data);
    const summary: ReadSummary = {
      byteLength: readResult.data.length,
      expectedBytes: profile.sizeBytes,
      allSame: patterns.allFF || patterns.all00,
      uniqueBytes: patterns.uniqueBytes,
      entropy: shannonEntropyNormalised(readResult.data),
    };
    return { verification: assessProfileVerification(profile, signature, summary), signature };
  }

  register("chips:exportLibrary", async () => {
    const { profiles } = await loadStoredProfiles(layout.chipDbDir);
    return profiles;
  });
  // Bake the operator's custom/AI chips into the repo's bundled catalog so they
  // ship with the next GitHub release and appear on a fresh install anywhere.
  // Only works running from source (a packaged build can't edit its own catalog).
  register("chips:bakeCatalog", async () => {
    const { profiles } = await loadStoredProfiles(layout.chipDbDir);
    const target = path.join(opts.projectRoot, "packages", "chip-db", "src", "seedProfiles", "community.json");
    try {
      await writeFile(target, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
    } catch (err) {
      throw new Error(
        `Could not write the bundled catalog (${(err as Error).message}). This works when running from source (dev); a packaged build can't edit its own catalog.`,
      );
    }
    return { path: target, count: profiles.length };
  });
  register("chips:importLibrary", async (_e, p: { profiles: ChipProfile[] }) => {
    const now = new Date().toISOString();
    let imported = 0;
    const errors: { id: string; message: string }[] = [];
    for (const profile of p.profiles ?? []) {
      try {
        chipRegistry.register(profile); // validates
        await saveStoredProfile(layout.chipDbDir, profile, now);
        imported += 1;
      } catch (err) {
        errors.push({
          id: (profile as ChipProfile)?.chipProfileId ?? "(unknown)",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { imported, errors };
  });

  register(
    "chips:verifyProfile",
    async (_e, p: { chipProfileId: string; adapterId: string; simulateChipId?: string }) => {
      const profile = chipRegistry.get(p.chipProfileId);
      if (!profile) throw new Error(`Unknown chip profile: ${p.chipProfileId}`);
      return runProfileVerification(profile, p.adapterId, p.simulateChipId);
    },
  );

  register(
    "chips:promoteProfile",
    async (_e, p: { chipProfileId: string; adapterId: string; simulateChipId?: string }) => {
      const profile = chipRegistry.get(p.chipProfileId);
      if (!profile) throw new Error(`Unknown chip profile: ${p.chipProfileId}`);
      // Re-derive the gate at promote time — never trust a verdict the UI sends.
      const { verification, signature } = await runProfileVerification(
        profile,
        p.adapterId,
        p.simulateChipId,
      );
      if (!verification.canPromote) {
        throw new Error(`Cannot promote: ${verification.summary}`);
      }
      const now = new Date().toISOString();
      const base = profile.provenance ?? {
        source: "operator" as const,
        confidence: "unverified" as const,
        createdAt: now,
      };
      const electronicSignature =
        signature.jedecId ??
        (signature.i2cAddresses?.length
          ? signature.i2cAddresses.map((a) => "0x" + a.toString(16)).join(",")
          : undefined);
      const promoted: ChipProfile = {
        ...profile,
        provenance: {
          ...base,
          confidence: "bench_verified",
          updatedAt: now,
          evidence: {
            ...base.evidence,
            ...(electronicSignature ? { electronicSignature } : {}),
          },
        },
      };
      chipRegistry.register(promoted);
      await saveStoredProfile(layout.chipDbDir, promoted, now);
      return promoted;
    },
  );
  register("chips:get", (_e, p: { id: string }) => chipRegistry.get(p.id));
  register("chips:search", (_e, p: { query: string }) => chipRegistry.search(p.query));
  register("chips:families", () => chipRegistry.families());
  register("chips:byFamily", (_e, p: { family: any }) => chipRegistry.byFamily(p.family));

  // ---- per-chip AI connection guide (cached on disk) + instruction images
  register("chips:guide", async (_e, p: { chipProfileId: string; generate?: boolean }) => {
    const profile = chipRegistry.get(p.chipProfileId);
    if (!profile) throw new Error(`Unknown chip profile: ${p.chipProfileId}`);
    const cached = await readChipGuide(chipAssetsDir, p.chipProfileId);
    if (cached && !p.generate) return cached;
    if (!p.generate) return null; // load-only: don't spend tokens until asked
    const guide = await generateChipGuide(profile);
    await writeChipGuide(chipAssetsDir, p.chipProfileId, guide);
    return guide;
  });
  register("chips:scaffold", (_e, p: { name: string; notes?: string }) =>
    scaffoldChipFromName(p),
  );
  register("chips:listAssets", (_e, p: { chipProfileId: string }) =>
    listChipAssets(chipAssetsDir, p.chipProfileId),
  );
  register(
    "chips:addAsset",
    (_e, p: { chipProfileId: string; fileName: string; base64: string; mediaType: string; kind: any; caption?: string }) =>
      addChipAsset(chipAssetsDir, p.chipProfileId, {
        fileName: p.fileName,
        base64: p.base64,
        mediaType: p.mediaType,
        kind: p.kind,
        ...(p.caption ? { caption: p.caption } : {}),
      }),
  );
  register("chips:readAsset", (_e, p: { chipProfileId: string; assetId: string }) =>
    readChipAsset(chipAssetsDir, p.chipProfileId, p.assetId),
  );
  register("chips:deleteAsset", (_e, p: { chipProfileId: string; assetId: string }) =>
    deleteChipAsset(chipAssetsDir, p.chipProfileId, p.assetId),
  );

  // ---- adapters
  register("adapters:list", () =>
    adapterRegistry.list().map((a) => ({
      adapterId: a.adapterId,
      displayName: a.displayName,
      type: a.type,
      supportedProtocols: a.supportedProtocols,
      supportedVoltages: a.supportedVoltages,
      canMeasureVoltage: a.canMeasureVoltage,
      canControlPower: a.canControlPower,
      canRead: a.canRead,
      canWrite: a.canWrite,
      canIdentify: a.canIdentify ?? false,
      safetyLevel: a.safetyLevel,
      description: a.description,
    })),
  );
  register("adapters:status", async (_e, p: { id: string }) => {
    const a = adapterRegistry.get(p.id);
    if (!a) throw new Error(`Unknown adapter: ${p.id}`);
    return a.getStatus();
  });
  register("adapters:test", async (_e, p: { id: string }) => {
    const a = adapterRegistry.get(p.id);
    if (!a) throw new Error(`Unknown adapter: ${p.id}`);
    await a.connect();
    return a.getStatus();
  });
  register(
    "adapters:identify",
    async (_e, p: { id: string; simulateChipId?: string; protocol?: Protocol }) => {
      const a = adapterRegistry.get(p.id);
      if (!a) throw new Error(`Unknown adapter: ${p.id}`);
      if (!a.identifyChip) {
        throw new Error(`Adapter "${a.displayName}" cannot scan for chip identity yet.`);
      }
      await a.connect();
      const simulateChip = p.simulateChipId ? chipRegistry.get(p.simulateChipId) : undefined;
      const result = await a.identifyChip({
        ...(simulateChip ? { simulateChip } : {}),
        ...(p.protocol ? { protocol: p.protocol } : {}),
      });
      const matches = matchSignature(result.signature, chipRegistry.list());
      return { signature: result.signature, matches, durationMs: result.durationMs };
    },
  );

  // Generic adapter read/write/erase — the unified backend for non-PicoForge
  // devices (Simulator now; CH347 / T48 later). The renderer passes the full
  // ChipProfile so the adapter has size/protocol without a registry lookup, and
  // bytes cross IPC as base64. Adapters are auto-connected on first use.
  register(
    "adapters:read",
    async (_e, p: { id: string; chipProfile: ChipProfile; offset?: number; length?: number; tag?: string }) => {
      const a = adapterRegistry.get(p.id);
      if (!a) throw new Error(`Unknown adapter: ${p.id}`);
      await a.connect();
      const result = await a.readMemory({
        chipProfile: p.chipProfile,
        ...(p.offset !== undefined ? { offset: p.offset } : {}),
        ...(p.length !== undefined ? { length: p.length } : {}),
        tag: p.tag ?? "read",
      });
      return { base64: result.data.toString("base64"), durationMs: result.durationMs };
    },
  );
  register(
    "adapters:write",
    async (_e, p: { id: string; chipProfile: ChipProfile; offset?: number; base64: string; tag?: string }) => {
      const a = adapterRegistry.get(p.id);
      if (!a) throw new Error(`Unknown adapter: ${p.id}`);
      if (!a.writeMemory) throw new Error(`Adapter "${a.displayName}" cannot write.`);
      await a.connect();
      const result = await a.writeMemory({
        chipProfile: p.chipProfile,
        ...(p.offset !== undefined ? { offset: p.offset } : {}),
        data: Buffer.from(p.base64, "base64"),
        tag: p.tag ?? "write",
      });
      return { bytesWritten: result.bytesWritten, durationMs: result.durationMs };
    },
  );
  register(
    "adapters:erase",
    async (_e, p: { id: string; chipProfile: ChipProfile }) => {
      const a = adapterRegistry.get(p.id);
      if (!a) throw new Error(`Unknown adapter: ${p.id}`);
      if (!a.writeMemory) throw new Error(`Adapter "${a.displayName}" cannot erase.`);
      await a.connect();
      // Erase = fill the whole array with 0xFF (the blank state for these parts).
      const blank = Buffer.alloc(p.chipProfile.sizeBytes, 0xff);
      const result = await a.writeMemory({ chipProfile: p.chipProfile, data: blank, tag: "erase" });
      return { bytesWritten: result.bytesWritten, durationMs: result.durationMs };
    },
  );

  // ---- single-chip jobs (Phase A)
  register("jobs:list", () => jobEngine.listJobs());
  register("jobs:get", (_e, p: { jobId: string }) => jobEngine.getJob(p.jobId));
  register("jobs:create", (_e, input: any) => jobEngine.createJob(input));
  register("jobs:setStatus", (_e, p: { jobId: string; status: any }) =>
    jobEngine.setStatus(p.jobId, p.status),
  );
  register("jobs:plan", (_e, p: { jobId: string }) => jobEngine.planOperation(p.jobId));
  register("jobs:safety", (_e, p: { jobId: string }) => jobEngine.assessSafety(p.jobId));
  register("jobs:read", (_e, p: { jobId: string; tag: string }) =>
    jobEngine.executeRead({ jobId: p.jobId, tag: p.tag }),
  );
  register("jobs:verify", (_e, p: { jobId: string }) => jobEngine.verify(p.jobId));
  register("jobs:report", (_e, p: { jobId: string }) => jobEngine.writeReport(p.jobId));
  register(
    "jobs:hexPreview",
    async (
      _e,
      p: { jobId: string; fileName: string; offset?: number; length?: number },
    ) => {
      const buf = await jobEngine.loadDump(p.jobId, p.fileName);
      return hexPreview(buf, { offset: p.offset, length: p.length });
    },
  );

  // ---- modules
  register("modules:list", () => moduleRegistry.list());
  register("modules:get", (_e, p: { id: string }) => moduleRegistry.get(p.id));
  register("modules:search", (_e, p: { query: string }) => moduleRegistry.search(p.query));
  register("modules:brands", () => moduleRegistry.brands());
  register("modules:byBrand", (_e, p: { brand: any }) => moduleRegistry.byBrand(p.brand));

  // ---- module jobs
  register("moduleJobs:list", () => moduleJobEngine.listJobs());
  register("moduleJobs:get", (_e, p: { jobId: string }) => moduleJobEngine.getJob(p.jobId));
  register("moduleJobs:create", (_e, input: any) => moduleJobEngine.createJob(input));
  register("moduleJobs:openDonor", (_e, p: { jobId: string; label: string }) =>
    moduleJobEngine.openDonorSide(p.jobId, p.label),
  );
  register(
    "moduleJobs:readSlot",
    (_e, p: { jobId: string; side: "source" | "donor"; slot: string; tag: string }) =>
      moduleJobEngine.readSlot(p),
  );
  register("moduleJobs:ceremony", (_e, p: { jobId: string }) =>
    moduleJobEngine.assessCeremony(p.jobId),
  );
  register(
    "moduleJobs:cloneWrite",
    (_e, p: { jobId: string; slot: string; donorLabelConfirmation: string }) =>
      moduleJobEngine.cloneWriteSlot(p),
  );
  register("moduleJobs:ceremonyReport", (_e, p: { jobId: string }) =>
    moduleJobEngine.writeCeremonyReport(p.jobId),
  );

  // ---- PicoForge serial bridge (main-process serial via System.IO.Ports)
  register("pico:findPort", () => findPicoPort());
  register(
    "pico:command",
    (_e, p: { port: string; command: string; reboot?: boolean; timeoutMs?: number }) =>
      picoSessionCommand(p.port, p.command, p.reboot ?? false, p.timeoutMs ?? 24000),
  );
  register("pico:disconnect", (_e, p: { port: string }) => {
    stopPicoSession(p.port);
    return { stopped: true };
  });
  register("pico:listDumps", () => listDumps(layout.dumpsDir));
  register("pico:readDump", (_e, p: { name: string; offset?: number; length?: number }) =>
    readDumpSlice(layout.dumpsDir, p.name, p.offset ?? 0, p.length ?? 8192),
  );
  register("pico:deleteDump", (_e, p: { name: string }) => deleteDump(layout.dumpsDir, p.name));
  register("pico:exportDump", (_e, p: { name: string; format: DumpFormat }) =>
    exportDump(layout.dumpsDir, p.name, p.format),
  );
  register(
    "pico:saveDump",
    async (_e, p: { name: string; base64: string; meta?: Record<string, unknown> }) => {
      const safe = (p.name || "dump").replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "dump";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const binPath = path.join(layout.dumpsDir, `${safe}_${stamp}.bin`);
      const bytes = Buffer.from(p.base64, "base64");
      await writeFile(binPath, bytes);
      await writeFile(
        binPath.replace(/\.bin$/, ".json"),
        JSON.stringify({ ...(p.meta ?? {}), bytes: bytes.length, savedAt: new Date().toISOString() }, null, 2),
      );
      return { path: binPath, bytes: bytes.length };
    },
  );

  // ---- tool detection
  register("tools:detect", () => detectAll());
}
