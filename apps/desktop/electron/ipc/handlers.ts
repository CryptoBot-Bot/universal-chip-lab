import { writeFile } from "node:fs/promises";
import os from "node:os";
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
import { createModuleRegistry, mergeBenchModules, mergeBusKnowledge, mergeVehicleProfiles } from "@ecu/vehicle-db";
import type { DiscoveredModuleInput } from "@ecu/vehicle-db";
import type { BenchModuleProfile, BusModuleKnowledge, VehicleProfile } from "@ecu/vehicle-db";
import {
  deleteStoredBusKnowledge,
  loadStoredBusKnowledge,
  saveStoredBusKnowledge,
} from "@ecu/vehicle-db/store";
import {
  deleteStoredVehicleProfile,
  loadStoredVehicleProfiles,
  saveStoredVehicleProfile,
} from "@ecu/vehicle-db/vehicleStore";
import {
  deleteStoredBenchModule,
  loadStoredBenchModules,
  saveStoredBenchModule,
} from "@ecu/vehicle-db/moduleStore";
import { JobFileManager, WorkspaceManager } from "@ecu/workspace";

import {
  addChipAsset,
  deleteChipAsset,
  listChipAssets,
  readChipAsset,
  readChipGuide,
  writeChipGuide,
} from "../chipAssets";
import { loadPairedDevices, savePairedDevices, type PairedDevice } from "../deviceRegistry";
import * as jobcount from "../jobcount";
import { deleteDump, exportDump, listDumps, readDumpSlice, type DumpFormat } from "../dumps";
import { mapBus, type BusMapInput } from "../resolver/busMapper";
import { deleteExplorerRun, listExplorerRuns, saveExplorerRun, type StoredExplorerRun } from "../explorerRuns";
import { exploreModule, type ExplorerEvent, type PriorKnowledge, type ExplorerSkeleton, type SeqItem, type BusFrame } from "../resolver/moduleExplorer";
import type { AddressCandidate, VehicleExplorerEvent } from "../resolver/vehicleExplorer";
import { identifyAndSave } from "../pipeline/identityPipeline";
import {
  captureDiagnostics, commitDiscovery, deepMapAndSave, discoverOnBus, piGet, piPost, readVin, vinDecodeCacheFile,
} from "../pipeline/vehiclePipeline";
import { identifyVehicle, censusModules, type IdentifyInput, type CensusInput } from "../resolver/vehicleIdentifier";
import { decodeVinOnline } from "../resolver/vinOnline";
import { mapModule, type MapModuleInput } from "../resolver/moduleMapper";
import { mapVehicle, type VehicleScan } from "../resolver/vehicleMapper";
import {
  generateChipGuide,
  resolveChip,
  scaffoldChipFromName,
  testApiKey,
  type ResolveChipInput,
} from "../resolver/chipResolver";
import { clearApiKey, getKeyStatus, setApiKey } from "../settings";
import { findPicoPort, findPicoPorts } from "../serial/picoSerial";
import { picoSessionCommand, stopPicoSession } from "../serial/picoSession";

import type { IpcChannel, IpcResponse } from "./channels";

interface RegisterOptions {
  projectRoot: string;
  appVersion: string;
}

/** Sweep the local /24 subnet(s) for SuperDevices (they answer /api/device). */
async function discoverDevices(): Promise<{ host: string; ip: string; hostname: string; model: string }[]> {
  const bases = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) {
        const p = ni.address.split(".");
        if (p.length === 4) bases.add(`${p[0]}.${p[1]}.${p[2]}`);
      }
    }
  }
  const targets: string[] = [];
  for (const base of bases) for (let h = 1; h <= 254; h++) targets.push(`${base}.${h}`);
  const found: { host: string; ip: string; hostname: string; model: string }[] = [];
  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const ip = targets[idx++];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 700);
      try {
        const res = await fetch(`http://${ip}:8080/api/device`, { signal: controller.signal });
        if (res.ok) {
          const d = (await res.json()) as { hostname?: string; model?: string };
          if (d?.hostname) found.push({ host: `${ip}:8080`, ip, hostname: d.hostname, model: d.model || "" });
        }
      } catch { /* not a SuperDevice */ } finally { clearTimeout(timer); }
    }
  }
  await Promise.all(Array.from({ length: 48 }, () => worker()));
  return found.sort((a, b) => a.ip.localeCompare(b.ip));
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
  const busIntelDir = path.join(layout.root, "vehicle-intel");
  const vehicleLibDir = path.join(layout.root, "vehicle-library");
  const benchModuleDir = path.join(layout.root, "bench-modules");
  const benchModuleAssetsDir = path.join(layout.root, "bench-module-assets");

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

  // ---- SuperDevice (Raspberry Pi 5 CAN interface, over its HTTP API)
  register("superDevice:status", (_e, p: { host?: string }) => piGet(p?.host, "/api/status"));
  // The daemon tries five ways to read a VIN (1.5 s each): the wait must outlast
  // them, or a car that does not answer shows as "cannot reach the device".
  register("superDevice:vin", (_e, p: { host?: string; iface?: string }) => readVin(p?.host, p?.iface || "can0"));
  register("superDevice:up", (_e, p: { host?: string; iface: string; bitrate?: number; fd?: boolean }) =>
    piPost(p?.host, "/api/up", { iface: p.iface, bitrate: p.bitrate ?? 500000, dbitrate: 2000000, fd: !!p.fd }));
  register("superDevice:down", (_e, p: { host?: string; iface: string }) =>
    piPost(p?.host, "/api/down", { iface: p.iface }));
  register("superDevice:get", (_e, p: { host?: string; path: string }) => {
    if (!p.path?.startsWith("/api/")) throw new Error("bad path");
    return piGet(p.host, p.path);
  });
  register("superDevice:post", (_e, p: { host?: string; path: string; body?: unknown }) => {
    if (!p.path?.startsWith("/api/")) throw new Error("bad path");
    return piPost(p.host, p.path, p.body ?? {});
  });
  register("superDevice:discover", () => discoverDevices());

  // ---- Pi device fleet: pairing registry + occupancy claims.
  // "Pairing" is a local bookmark; the claim (who is driving the device right
  // now) lives ON the Pi so every PC sees the same occupied/available truth.
  const devicesDir = path.join(layout.root, "devices");
  const claimOwner = os.hostname();
  register("devices:list", async () => ({
    owner: claimOwner,
    devices: await loadPairedDevices(devicesDir),
  }));
  register("devices:pair", async (_e, p: { host: string; hostname?: string; model?: string; nickname?: string }) => {
    const raw = (p.host || "").trim();
    if (!raw) throw new Error("no host");
    const host = raw.includes(":") ? raw : `${raw}:8080`;
    const devices = await loadPairedDevices(devicesDir);
    let dev = devices.find((d) => d.host === host);
    if (!dev) {
      dev = {
        id: `dev-${Date.now().toString(36)}`,
        host,
        hostname: p.hostname ?? "",
        model: p.model ?? "",
        nickname: p.nickname,
        pairedAt: new Date().toISOString(),
      };
      devices.push(dev);
      await savePairedDevices(devicesDir, devices);
    }
    return devices;
  });
  register("devices:unpair", async (_e, p: { id: string }) => {
    const devices = await loadPairedDevices(devicesDir);
    const next = devices.filter((d) => d.id !== p.id);
    await savePairedDevices(devicesDir, next);
    return next;
  });
  register("devices:update", async (_e, p: { id: string; patch: Partial<Pick<PairedDevice, "host" | "hostname" | "model" | "nickname" | "lastSeenAt">> }) => {
    const devices = await loadPairedDevices(devicesDir);
    const dev = devices.find((d) => d.id === p.id);
    if (!dev) throw new Error("device not paired");
    Object.assign(dev, p.patch);
    await savePairedDevices(devicesDir, devices);
    return devices;
  });
  register("devices:claim", (_e, p: { host?: string; force?: boolean }) =>
    piPost(p?.host, "/api/claim", { owner: claimOwner, force: !!p?.force }));
  register("devices:release", (_e, p: { host?: string; force?: boolean }) =>
    piPost(p?.host, "/api/release", { owner: claimOwner, force: !!p?.force }));

  // ---- JobCount link (encrypted device-token tunnel into a shop's garage)
  register("jobcount:status", () => jobcount.getStatus());
  register("jobcount:pair", (_e, p: { serverUrl: string; code: string }) =>
    jobcount.pair(p.serverUrl, p.code, opts.appVersion));
  register("jobcount:unpair", () => jobcount.unpair());
  register("jobcount:verify", () => jobcount.verify());
  register("jobcount:pushVehicle", (_e, p: jobcount.PushVehicleInput) => jobcount.pushVehicle(p));
  register("jobcount:listGarage", (_e, p: { q?: string }) => jobcount.listGarage(p?.q));

  // ---- AI Vehicle Explorer: discover modules on the real bus, then deep-map each
  //      one (reusing the per-module explorer), persisting the capability board
  //      into the YMM profile so next time we already know how to talk to it.
  //      The steps themselves live in ../pipeline/vehiclePipeline.ts, shared with
  //      the command-line runner (cli/vehicle.ts).
  let vehicleExplorerStop = false;

  register("vehicleExplorer:stop", () => { vehicleExplorerStop = true; return { ok: true }; });

  register("vehicleExplorer:discover", async (event, p: { host?: string; iface: string; ident?: boolean; known?: AddressCandidate[]; deep?: boolean }) => {
    vehicleExplorerStop = false;
    return discoverOnBus({
      host: p.host, iface: p.iface, ident: p.ident, known: p.known, deep: p.deep,
      onSweep: (r) => { try { event.sender.send("vehicleExplorer:event", { type: "sweep", ok: r.ok, found: r.responders?.length ?? 0, seconds: r.seconds }); } catch { /* window gone */ } },
      onSweepProgress: (progress) => { try { event.sender.send("vehicleExplorer:event", { type: "sweep-progress", progress }); } catch { /* window gone */ } },
      onProgress: (done, total, found) => { try { event.sender.send("vehicleExplorer:event", { type: "discover", done, total, found }); } catch { /* window gone */ } },
      onFound: (m) => { try { event.sender.send("vehicleExplorer:event", { type: "discover-hit", requestId: m.requestId, responseId: m.responseId, name: m.name, ident: m.ident }); } catch { /* window gone */ } },
      shouldStop: () => vehicleExplorerStop,
    });
  });

  // Identity read: every module's part numbers, versions, serial number, supplier,
  // build date — plain identification reads only, streamed live, filed per car (VIN).
  register("vehicleExplorer:identify", async (event, p: { host?: string; iface: string; profile: VehicleProfile; vin?: string; moduleIds?: string[]; sim?: string | null; extended?: boolean }) => {
    vehicleExplorerStop = false;
    return identifyAndSave(vehicleLibDir, {
      host: p.host, iface: p.iface, profile: p.profile, vin: p.vin, moduleIds: p.moduleIds, sim: p.sim, extended: p.extended,
      onEvent: (e: VehicleExplorerEvent) => { try { event.sender.send("vehicleExplorer:event", e); } catch { /* window gone */ } },
      shouldStop: () => vehicleExplorerStop,
    });
  });

  // Discovery as its own saving stage: persist the responders (address + lastSeen)
  // into the YMM profile, healing any pre-existing duplicate module entries.
  register("vehicleExplorer:commitDiscovery", (_e, p: { profile: VehicleProfile; discovered: DiscoveredModuleInput[] }) =>
    commitDiscovery(vehicleLibDir, p.profile, p.discovered ?? []));

  register("vehicleExplorer:start", async (event, p: {
    host?: string; iface: string; profile: VehicleProfile;
    targets: { moduleId: string; displayName: string; brand: string; category: string; protocol: string; requestId: string; responseId: string }[];
  }) => {
    vehicleExplorerStop = false;
    return deepMapAndSave({
      host: p.host, iface: p.iface, profile: p.profile, targets: p.targets, vehicleLibDir,
      onEvent: (e: VehicleExplorerEvent) => { try { event.sender.send("vehicleExplorer:event", e); } catch { /* window gone */ } },
      shouldStop: () => vehicleExplorerStop,
    });
  });

  // AI vehicle identifier — VIN structure + bus fingerprint + library candidates →
  // structured identity. Proposes only; the renderer binds on operator confirm.
  register("vehicleId:resolve", (_e, input: IdentifyInput) => identifyVehicle(input));
  // Diagnostic capture — everything a remote troubleshooter (a Claude Code session
  // away from the car) needs to see what happened: device health, both buses, the
  // raw VIN attempts, a full discovery with identification strings, a bus snapshot,
  // and the vehicle profile as saved. Written under <workspace>/reports/.
  register("vehicleLib:capture", (_e, p: { host?: string; iface: string; vin?: string; profile?: VehicleProfile; note?: string; extra?: unknown }) =>
    captureDiagnostics({ ...p, reportsDir: path.join(layout.root, "reports"), appVersion: opts.appVersion }));

  // Module census: name every discovered module from its part number (AI).
  register("vehicleId:census", (_e, input: CensusInput) => censusModules(input));
  // Free NHTSA vPIC decode (cached per VIN under the vehicle library) — step ① of identity.
  register("vehicleId:decodeOnline", (_e, p: { vin: string }) => decodeVinOnline(p.vin, vinDecodeCacheFile(vehicleLibDir)));

  // ---- AI Module Explorer (autonomous read-only diagnostic agent, streamed)
  const explorerRunsDir = path.join(layout.root, "explorer-runs");
  // Fold every prior run's verified result (plus the module's own known surface)
  // into a single prior the agent starts from — the self-improving run-to-run loop.
  function buildPriorKnowledge(
    runs: StoredExplorerRun[],
    module: { capabilities?: string[]; identity?: string; knownDtcs?: { code: string; desc: string }[] },
  ): PriorKnowledge {
    const services = new Set<string>();
    const capabilities = new Set<string>(module.capabilities ?? []);
    const dtcs = new Map<string, { code: string; desc: string }>();
    (module.knownDtcs ?? []).forEach((d) => dtcs.set(d.code, d));
    let identity = module.identity ?? "";
    for (const r of runs) {
      if (!r.result) continue;
      r.result.services.forEach((s) => services.add(s));
      r.result.capabilities.forEach((s) => capabilities.add(s));
      r.result.dtcs.forEach((d) => { if (!dtcs.has(d.code)) dtcs.set(d.code, d); });
      if (r.result.identity && r.result.identity.length > identity.length && r.result.identity !== "unknown") identity = r.result.identity;
    }
    return { runCount: runs.length, identity: identity || undefined, services: [...services], capabilities: [...capabilities], dtcs: [...dtcs.values()] };
  }

  let explorerStop = false;
  register("moduleExplorer:stop", () => { explorerStop = true; return { ok: true }; });
  register("moduleExplorer:start", async (event, p: {
    host?: string; iface: string; tx: string; rx: string;
    module: { moduleId?: string; displayName: string; brand: string; category: string; protocol: string; capabilities?: string[]; identity?: string; knownDtcs?: { code: string; desc: string }[]; skeleton?: ExplorerSkeleton };
  }) => {
    explorerStop = false;
    const send = (e: ExplorerEvent) => { try { event.sender.send("moduleExplorer:event", e); } catch { /* window gone */ } };
    let prior: PriorKnowledge | undefined;
    if (p.module.moduleId) {
      const runs = await listExplorerRuns(explorerRunsDir, p.module.moduleId);
      prior = buildPriorKnowledge(runs, p.module);
    }
    const deps = {
      probe: async (requests: string[]): Promise<SeqItem[]> => {
        const r = await piPost(p.host, "/api/isotp/seq", { iface: p.iface, tx: p.tx, rx: p.rx, requests, timeout: 2.0 }, 40000) as { results?: SeqItem[] };
        return r.results ?? [];
      },
      scanBus: async (ms: number): Promise<{ frames: BusFrame[]; window_ms?: number }> => {
        const r = await piGet(p.host, `/api/bus/monitor?iface=${encodeURIComponent(p.iface)}&ms=${ms}`, 12000) as { frames?: BusFrame[]; window_ms?: number };
        return { frames: r.frames ?? [], window_ms: r.window_ms };
      },
      onEvent: send,
      shouldStop: () => explorerStop,
    };
    try {
      return await exploreModule({ ...p.module, iface: p.iface, requestId: p.tx, responseId: p.rx, prior }, deps);
    } catch (e) {
      send({ type: "error", text: (e as Error).message });
      throw e;
    }
  });
  register("moduleExplorer:listRuns", (_e, p: { moduleId: string }) => listExplorerRuns(explorerRunsDir, p.moduleId));
  register("moduleExplorer:saveRun", async (_e, run: StoredExplorerRun) => {
    await saveExplorerRun(explorerRunsDir, run);
    return listExplorerRuns(explorerRunsDir, run.moduleId);
  });
  register("moduleExplorer:deleteRun", async (_e, p: { moduleId: string; runId: string }) => {
    const removed = await deleteExplorerRun(explorerRunsDir, p.moduleId, p.runId);
    return { removed, runs: await listExplorerRuns(explorerRunsDir, p.moduleId) };
  });

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

  // ---- vehicle bus intelligence — the growing knowledge base of what each
  // system on a real network answers, and what we can do with it. Seed records
  // ship in @ecu/vehicle-db (travel with publishes); learned ones persist to
  // disk here and merge on top; "bake" folds them into the bundled catalog.
  register("busIntel:list", async () => {
    const { records, errors } = await loadStoredBusKnowledge(busIntelDir);
    if (errors.length > 0) {
      console.warn(
        `[ECL] Skipped ${errors.length} invalid bus-knowledge record(s):`,
        errors.map((e) => `${e.file}: ${e.message}`).join("; "),
      );
    }
    return mergeBusKnowledge(records);
  });
  register("busIntel:save", async (_e, record: BusModuleKnowledge) => {
    await saveStoredBusKnowledge(busIntelDir, record, new Date().toISOString());
    const { records } = await loadStoredBusKnowledge(busIntelDir);
    return mergeBusKnowledge(records);
  });
  register("busIntel:delete", async (_e, p: { id: string }) => {
    const removed = await deleteStoredBusKnowledge(busIntelDir, p.id);
    const { records } = await loadStoredBusKnowledge(busIntelDir);
    return { removed, records: mergeBusKnowledge(records) };
  });
  register("busIntel:analyze", (_e, input: BusMapInput) => mapBus(input));
  // Bake learned records into the repo's bundled catalog so they ship with the
  // next release. Only works running from source (a packaged build can't edit
  // its own catalog). Mirrors chips:bakeCatalog.
  register("busIntel:bake", async () => {
    const { records } = await loadStoredBusKnowledge(busIntelDir);
    const target = path.join(
      opts.projectRoot,
      "packages", "vehicle-db", "src", "busKnowledgeCommunity.json",
    );
    try {
      await writeFile(target, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    } catch (err) {
      throw new Error(
        `Could not write the bundled catalog (${(err as Error).message}). This works when running from source (dev); a packaged build can't edit its own catalog.`,
      );
    }
    return { path: target, count: records.length };
  });

  // ---- vehicle library (Year/Make/Model profiles for the 3D cockpit)
  // Seed profiles ship in @ecu/vehicle-db (travel with publishes); learned ones
  // persist to disk here and merge on top; "bake" folds them into the bundle.
  // The library: vehicles actually read. `builtIn` adds the hand-written starter maps
  // (only the archived 3D cockpit / training room ask for them).
  register("vehicleLib:list", async (_e, p?: { builtIn?: boolean }) => {
    const { records, errors } = await loadStoredVehicleProfiles(vehicleLibDir);
    if (errors.length > 0) {
      console.warn(`[ECL] Skipped ${errors.length} invalid vehicle profile(s):`, errors.join("; "));
    }
    return mergeVehicleProfiles(records, { builtIn: !!p?.builtIn });
  });
  register("vehicleLib:save", async (_e, record: VehicleProfile) => {
    await saveStoredVehicleProfile(vehicleLibDir, record, new Date().toISOString());
    const { records } = await loadStoredVehicleProfiles(vehicleLibDir);
    return mergeVehicleProfiles(records);
  });
  register("vehicleLib:delete", async (_e, p: { id: string }) => {
    const removed = await deleteStoredVehicleProfile(vehicleLibDir, p.id);
    const { records } = await loadStoredVehicleProfiles(vehicleLibDir);
    return { removed, records: mergeVehicleProfiles(records) };
  });
  register("vehicleLib:analyze", (_e, scan: VehicleScan) => mapVehicle(scan));
  register("vehicleLib:bake", async () => {
    const { records } = await loadStoredVehicleProfiles(vehicleLibDir);
    const target = path.join(
      opts.projectRoot,
      "packages", "vehicle-db", "src", "vehicleProfileCommunity.json",
    );
    try {
      await writeFile(target, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    } catch (err) {
      throw new Error(
        `Could not write the bundled vehicle catalog (${(err as Error).message}). This works when running from source (dev); a packaged build can't edit its own catalog.`,
      );
    }
    return { path: target, count: records.length };
  });

  // ---- bench modules (Bench Module Master: the growing hookup + diagnostics
  // knowledge base). Seed modules ship in @ecu/vehicle-db; learned ones persist
  // to disk here and merge on top; "bake" folds them into the bundled catalog.
  // Same trust ladder as chips: analyze produces an ai_suggested draft; a real
  // bench session promotes it to bench_verified (an AI guess never writes).
  register("benchModules:list", async () => {
    const { records, errors } = await loadStoredBenchModules(benchModuleDir);
    if (errors.length > 0) {
      console.warn(`[ECL] Skipped ${errors.length} invalid bench module(s):`, errors.join("; "));
    }
    return mergeBenchModules(records);
  });
  register("benchModules:save", async (_e, record: BenchModuleProfile) => {
    await saveStoredBenchModule(benchModuleDir, record, new Date().toISOString());
    const { records } = await loadStoredBenchModules(benchModuleDir);
    return mergeBenchModules(records);
  });
  register("benchModules:delete", async (_e, p: { id: string }) => {
    const removed = await deleteStoredBenchModule(benchModuleDir, p.id);
    const { records } = await loadStoredBenchModules(benchModuleDir);
    return { removed, records: mergeBenchModules(records) };
  });
  register("benchModules:analyze", (_e, input: MapModuleInput) => mapModule(input));
  register("benchModules:bake", async () => {
    const { records } = await loadStoredBenchModules(benchModuleDir);
    const target = path.join(
      opts.projectRoot,
      "packages", "vehicle-db", "src", "benchModuleCommunity.json",
    );
    try {
      await writeFile(target, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    } catch (err) {
      throw new Error(
        `Could not write the bundled module catalog (${(err as Error).message}). This works when running from source (dev); a packaged build can't edit its own catalog.`,
      );
    }
    return { path: target, count: records.length };
  });
  // Photo gallery per saved module — reuses the chip-asset store under a separate
  // dir. The renderer refers to a module by its id; paths are sanitised server-side.
  register("benchModules:listAssets", (_e, p: { moduleId: string }) =>
    listChipAssets(benchModuleAssetsDir, p.moduleId),
  );
  register(
    "benchModules:addAsset",
    (_e, p: { moduleId: string; fileName: string; base64: string; mediaType: string; caption?: string }) =>
      addChipAsset(benchModuleAssetsDir, p.moduleId, {
        fileName: p.fileName,
        base64: p.base64,
        mediaType: p.mediaType,
        kind: "photo",
        ...(p.caption ? { caption: p.caption } : {}),
      }),
  );
  register("benchModules:readAsset", (_e, p: { moduleId: string; assetId: string }) =>
    readChipAsset(benchModuleAssetsDir, p.moduleId, p.assetId),
  );
  register("benchModules:deleteAsset", (_e, p: { moduleId: string; assetId: string }) =>
    deleteChipAsset(benchModuleAssetsDir, p.moduleId, p.assetId),
  );

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
  register("pico:findPorts", () => findPicoPorts());
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
