import type {
  ChipAsset,
  ChipAssetKind,
  ChipConnectGuide,
  ChipIdentification,
  ChipMatch,
  ChipProfile,
  ChipSignature,
  ProfileVerification,
} from "@ecu/chip-db";
import type {
  CloneCeremonyState,
  CloneSlotResult,
  CreateJobInput,
  CreateModuleJobInput,
  JobRecord,
  JobStatus,
  ModuleJobRecord,
  OperationPlan,
  SafetyAssessment,
  VerificationResult,
} from "@ecu/core";
import type { HexPreview } from "@ecu/dump-tools";
import type { ModuleProfile, VehicleBrand } from "@ecu/vehicle-db";

import type { IpcResponse } from "../../electron/ipc/channels";

export interface AdapterSummary {
  adapterId: string;
  displayName: string;
  type: "software" | "usb_serial" | "usb_bridge" | "external_tool" | "debug_probe";
  supportedProtocols: string[];
  supportedVoltages: number[];
  canMeasureVoltage: boolean;
  canControlPower: boolean;
  canRead: boolean;
  canWrite: boolean;
  canIdentify: boolean;
  safetyLevel: "training" | "field";
  description: string;
}

export interface IdentifyResult {
  signature: ChipSignature;
  matches: ChipMatch[];
  durationMs: number;
}

export interface ResolveChipRequest {
  images: { data: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" }[];
  memoryClass?: "eeprom" | "flash";
  markingsHint?: string;
  notes?: string;
}

export interface VerifyProfileRequest {
  chipProfileId: string;
  adapterId: string;
  simulateChipId?: string;
}

export interface VerifyProfileResult {
  verification: ProfileVerification;
  signature: ChipSignature;
}

export interface AdapterStatus {
  state: "disconnected" | "connecting" | "connected" | "error";
  message: string;
  port?: string;
  firmware?: string;
  measuredVoltage?: number;
}

export interface ToolStatus {
  tool: "flashrom" | "openocd" | "ch341eepromtool" | "pyftdi";
  installed: boolean;
  version?: string;
  detail: string;
}

export interface DumpEntry {
  name: string;
  sizeBytes: number;
  savedAt?: string;
  meta: Record<string, unknown>;
}

export interface KeyStatus {
  hasKey: boolean;
  source: "env" | "stored" | "none";
  masked: string | null;
  encryptionAvailable: boolean;
  storedUnencrypted: boolean;
}

async function unwrap<T>(promise: Promise<IpcResponse<T>>): Promise<T> {
  const resp = await promise;
  if (!resp.ok) throw new Error(resp.error);
  return resp.data;
}

const api = window.api;

export const Api = {
  workspace: {
    init: () => unwrap<{ root: string; jobsDir: string }>(api.workspace.init()),
  },
  chips: {
    list:     () => unwrap<ChipProfile[]>(api.chips.list() as never),
    get:      (id: string) => unwrap<ChipProfile | undefined>(api.chips.get(id) as never),
    search:   (q: string) => unwrap<ChipProfile[]>(api.chips.search(q) as never),
    families: () => unwrap<string[]>(api.chips.families() as never),
    byFamily: (family: string) => unwrap<ChipProfile[]>(api.chips.byFamily(family) as never),
    resolve:  (input: ResolveChipRequest) =>
      unwrap<ChipIdentification>(api.chips.resolve(input) as never),
    saveProfile:   (profile: ChipProfile) =>
      unwrap<ChipProfile>(api.chips.saveProfile(profile) as never),
    deleteProfile: (id: string) =>
      unwrap<{ removed: boolean }>(api.chips.deleteProfile(id) as never),
    verifyProfile: (input: VerifyProfileRequest) =>
      unwrap<VerifyProfileResult>(api.chips.verifyProfile(input) as never),
    promoteProfile: (input: VerifyProfileRequest) =>
      unwrap<ChipProfile>(api.chips.promoteProfile(input) as never),
    exportLibrary: () => unwrap<ChipProfile[]>(api.chips.exportLibrary() as never),
    importLibrary: (profiles: ChipProfile[]) =>
      unwrap<{ imported: number; errors: { id: string; message: string }[] }>(
        api.chips.importLibrary(profiles) as never,
      ),
    bakeCatalog: () => unwrap<{ path: string; count: number }>(api.chips.bakeCatalog() as never),
    guide: (input: { chipProfileId: string; generate?: boolean }) =>
      unwrap<ChipConnectGuide | null>(api.chips.guide(input) as never),
    scaffold: (input: { name: string; notes?: string }) =>
      unwrap<ChipProfile>(api.chips.scaffold(input) as never),
    listAssets: (chipProfileId: string) =>
      unwrap<ChipAsset[]>(api.chips.listAssets(chipProfileId) as never),
    addAsset: (input: { chipProfileId: string; fileName: string; base64: string; mediaType: string; kind: ChipAssetKind; caption?: string }) =>
      unwrap<ChipAsset>(api.chips.addAsset(input) as never),
    readAsset: (input: { chipProfileId: string; assetId: string }) =>
      unwrap<{ base64: string; mediaType: string; fileName: string }>(api.chips.readAsset(input) as never),
    deleteAsset: (input: { chipProfileId: string; assetId: string }) =>
      unwrap<{ removed: boolean }>(api.chips.deleteAsset(input) as never),
  },
  adapters: {
    list:   () => unwrap<AdapterSummary[]>(api.adapters.list() as never),
    status: (id: string) => unwrap<AdapterStatus>(api.adapters.status(id) as never),
    test:   (id: string) => unwrap<AdapterStatus>(api.adapters.test(id) as never),
    identify: (id: string, opts?: { simulateChipId?: string; protocol?: string }) =>
      unwrap<IdentifyResult>(api.adapters.identify(id, opts) as never),
    read: (input: { id: string; chipProfile: ChipProfile; offset?: number; length?: number; tag?: string }) =>
      unwrap<{ base64: string; durationMs: number }>(api.adapters.read(input) as never),
    write: (input: { id: string; chipProfile: ChipProfile; offset?: number; base64: string; tag?: string }) =>
      unwrap<{ bytesWritten: number; durationMs: number }>(api.adapters.write(input) as never),
    erase: (input: { id: string; chipProfile: ChipProfile }) =>
      unwrap<{ bytesWritten: number; durationMs: number }>(api.adapters.erase(input) as never),
  },
  jobs: {
    list:       () => unwrap<JobRecord[]>(api.jobs.list() as never),
    get:        (id: string) => unwrap<JobRecord>(api.jobs.get(id) as never),
    create:     (input: CreateJobInput) => unwrap<JobRecord>(api.jobs.create(input) as never),
    setStatus:  (id: string, status: JobStatus) =>
      unwrap<JobRecord>(api.jobs.setStatus(id, status) as never),
    plan:       (id: string) => unwrap<OperationPlan>(api.jobs.plan(id) as never),
    safety:     (id: string) => unwrap<SafetyAssessment>(api.jobs.safety(id) as never),
    read:       (id: string, tag: string) =>
      unwrap<{ job: JobRecord; dump: JobRecord["dumps"][number] }>(
        api.jobs.read(id, tag) as never,
      ),
    verify:     (id: string) => unwrap<VerificationResult>(api.jobs.verify(id) as never),
    report:     (id: string) => unwrap<string>(api.jobs.report(id) as never),
    hexPreview: (id: string, fileName: string, offset = 0, length = 512) =>
      unwrap<HexPreview>(api.jobs.hexPreview(id, fileName, offset, length) as never),
  },
  modules: {
    list:    () => unwrap<ModuleProfile[]>(api.modules.list() as never),
    get:     (id: string) => unwrap<ModuleProfile | undefined>(api.modules.get(id) as never),
    search:  (q: string) => unwrap<ModuleProfile[]>(api.modules.search(q) as never),
    brands:  () => unwrap<VehicleBrand[]>(api.modules.brands() as never),
    byBrand: (b: VehicleBrand) => unwrap<ModuleProfile[]>(api.modules.byBrand(b) as never),
  },
  moduleJobs: {
    list:      () => unwrap<ModuleJobRecord[]>(api.moduleJobs.list() as never),
    get:       (id: string) => unwrap<ModuleJobRecord>(api.moduleJobs.get(id) as never),
    create:    (input: CreateModuleJobInput) =>
      unwrap<ModuleJobRecord>(api.moduleJobs.create(input) as never),
    openDonor: (id: string, label: string) =>
      unwrap<ModuleJobRecord>(api.moduleJobs.openDonor(id, label) as never),
    readSlot:  (id: string, side: "source" | "donor", slot: string, tag: string) =>
      unwrap<{ job: ModuleJobRecord; dump: JobRecord["dumps"][number] }>(
        api.moduleJobs.readSlot(id, side, slot, tag) as never,
      ),
    ceremony:  (id: string) =>
      unwrap<CloneCeremonyState>(api.moduleJobs.ceremony(id) as never),
    cloneWrite: (id: string, slot: string, donorLabelConfirmation: string) =>
      unwrap<{ job: ModuleJobRecord; result: CloneSlotResult }>(
        api.moduleJobs.cloneWrite(id, slot, donorLabelConfirmation) as never,
      ),
    ceremonyReport: (id: string) =>
      unwrap<string>(api.moduleJobs.ceremonyReport(id) as never),
  },
  tools: {
    detect: () => unwrap<ToolStatus[]>(api.tools.detect() as never),
  },
  settings: {
    getKeyStatus: () => unwrap<KeyStatus>(api.settings.getKeyStatus() as never),
    setApiKey: (key: string) => unwrap<KeyStatus>(api.settings.setApiKey(key) as never),
    clearApiKey: () => unwrap<KeyStatus>(api.settings.clearApiKey() as never),
    testApiKey: (key?: string) =>
      unwrap<{ ok: boolean; error?: string }>(api.settings.testApiKey(key) as never),
  },
  pico: {
    findPort: () => unwrap<string | null>(api.pico.findPort() as never),
    command: (input: { port: string; command: string; reboot?: boolean; timeoutMs?: number }) =>
      unwrap<string>(api.pico.command(input) as never),
    disconnect: (port: string) =>
      unwrap<{ stopped: boolean }>(api.pico.disconnect({ port }) as never),
    saveDump: (input: { name: string; base64: string; meta?: Record<string, unknown> }) =>
      unwrap<{ path: string; bytes: number }>(api.pico.saveDump(input) as never),
    listDumps: () => unwrap<DumpEntry[]>(api.pico.listDumps() as never),
    readDump: (input: { name: string; offset?: number; length?: number }) =>
      unwrap<{ base64: string; total: number }>(api.pico.readDump(input) as never),
    deleteDump: (name: string) =>
      unwrap<{ removed: boolean }>(api.pico.deleteDump({ name }) as never),
    exportDump: (name: string, format: "json" | "hex" | "strings" | "text" | "md") =>
      unwrap<{ path: string }>(api.pico.exportDump({ name, format }) as never),
  },
  updates: {
    check: () =>
      api.updates.check() as Promise<{ ok: boolean; currentVersion?: string; latestVersion?: string | null; error?: string }>,
    install: () => api.updates.install() as Promise<{ ok: boolean; error?: string }>,
    getState: () =>
      api.updates.getState() as Promise<{ version: string; last: UpdateState | null }>,
    onState: (cb: (s: UpdateState) => void) => api.updates.onState(cb) as () => void,
  },
  publish: {
    readiness: () =>
      api.publish.readiness() as Promise<{ ready: boolean; isDev: boolean; currentVersion?: string; reasons: string[] }>,
    run: (bump: "patch" | "minor" | "major") =>
      api.publish.run(bump) as Promise<{ ok: boolean; version?: string; tagName?: string; error?: string }>,
    onLog: (cb: (entry: PublishLog) => void) => api.publish.onLog(cb) as () => void,
  },
};

export interface UpdateState {
  state: "checking" | "available" | "up-to-date" | "downloading" | "ready" | "error";
  version?: string;
  percent?: number;
  error?: string;
}

export interface PublishLog {
  jobId: string;
  kind: "step" | "out" | "err" | "ok" | "fail";
  line: string;
}
