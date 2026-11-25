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
import type { BenchModuleProfile, BusModuleKnowledge, CarInventory, IdentRecord, ModuleInventoryEntry, ModuleProfile, ModuleSweep, OnlineVinDecode, VehicleBrand, VehicleProfile } from "@ecu/vehicle-db";

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

export interface CensusInput {
  vehicle: { year: number | null; make: string; model: string; trim?: string; platform?: string; engine?: string };
  ecus: IdentifyEcuEvidence[];
  known?: { responseId: string; label: string; category: string }[];
}
export interface CensusModule {
  responseId: string; label: string; shortName: string; category: string; supplier?: string; summary: string;
  protocol: "uds" | "kwp2000" | "obd2" | "unknown"; memoryRead: "obd" | "obd_partial" | "bench"; likelyServices: string[]; notes?: string;
}
export interface CensusResult { modules: CensusModule[]; tokensIn: number; tokensOut: number }
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

export interface BusObservationNode {
  id: string;
  name: string;
  kind: "module" | "obd" | "bcast";
  hz: number;
  count: number;
  lastData: string;
}

export interface BusMapRequest {
  nodes: BusObservationNode[];
  probeLog?: string;
  snapshot?: string;
  notes?: string;
}

export interface BusMapResult {
  modules: BusModuleKnowledge[];
  summary: string;
}

export interface EcuObservation {
  responseId: string;
  requestId?: string;
  supportedPids: string[];
  identifiers: { did: string; ascii: string }[];
  dtcs: string[];
  liveSample: { name: string; value: string }[];
}

export interface VehicleScan {
  vin: string;
  year: number | null;
  make: string | null;
  country: string;
  ecus: EcuObservation[];
  notes?: string;
}

export interface MappedModule {
  responseId: string;
  name: string;
  category: string;
  supplier: string;
  protocol: string;
  memoryRead: string;
  capabilities: string[];
  confidence: "low" | "medium" | "high";
  rationale: string;
}

export interface VehicleMapResult {
  vehicle: { year: string; make: string; model: string; platform: string; summary: string };
  modules: MappedModule[];
}

// ---- Bench Module Master (AI module mapper output; mirrors electron/resolver/moduleMapper) ----
export interface MappedHookupPin {
  pin: string;
  signal: "power" | "ignition" | "ground" | "can_h" | "can_l" | "kline" | "lin" | "wake" | "flexray" | "other";
  connectTo: string;
  required: boolean;
  note: string;
}
export interface MappedBus {
  name: string;
  protocol: "uds" | "kwp2000" | "obd2" | "canfd" | "kline" | "unknown";
  bitrate: number;
  requestId: string;
  responseId: string;
  termination: boolean;
}
export interface ModuleMapResult {
  displayName: string;
  brand: string;
  category: "ecm" | "tcm" | "abs" | "srs" | "bcm" | "ipc" | "hvac" | "gateway" | "immo" | "eps" | "adas" | "radio" | "other";
  partNumbers: string[];
  applications: string[];
  powerNote: string;
  hookup: MappedHookupPin[];
  buses: MappedBus[];
  asciiConnector: string;
  cautions: string[];
  references: { label: string; url: string }[];
  capabilities: string[];
  knownDtcs: { code: string; desc: string }[];
  confidence: "low" | "medium" | "high";
  rationale: string;
}
export interface ModuleMapRequest {
  images: { data: string; mediaType: string }[];
  description: string;
}

// ---- AI Module Explorer (autonomous read-only agent, streamed) ----
export interface PriorKnowledge {
  runCount: number; identity?: string; services: string[]; capabilities: string[];
  dtcs: { code: string; desc: string }[];
}
export interface ExplorerResult {
  summary: string; identity: string; services: string[]; capabilities: string[];
  dtcs: { code: string; desc: string }[]; confidence: "low" | "medium" | "high"; verification: string;
  outcome: "concluded" | "partial"; tokensIn: number; tokensOut: number; steps: number; newFindings: string[];
  sessions?: { id: string; label: string }[];
  identification?: { id: string; label: string; value: string; session?: string }[];
  liveData?: { id: string; label: string; session?: string; note?: string }[];
  broadcastFrames?: { canId: string; hz?: number; decode?: string }[];
  operations?: { op: string; status: string; request?: string; session?: string; nrc?: string; detail?: string }[];
}
export type ExplorerEvent =
  | { type: "status"; text: string }
  | { type: "prior"; knowledge: PriorKnowledge }
  | { type: "thought"; text: string }
  | { type: "action"; tool: string; input: unknown }
  | { type: "observation"; tool: string; summary: string; detail?: string }
  | { type: "finding"; kind: string; title: string; detail: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; steps: number }
  | { type: "done"; result: ExplorerResult }
  | { type: "error"; text: string };
export interface ExplorerSkeleton {
  partNumbers: string[];
  applications: string[];
  bitrate?: number;
  fd?: boolean;
  sessions: { id: string; label: string }[];
  services: string[];
  identification: { id: string; label: string; value?: string; session?: string }[];
  liveData: { id: string; label: string; session?: string }[];
  broadcastFrames: { canId: string; hz?: number; decode?: string }[];
  operations: { op: string; status: string; request?: string; session?: string }[];
  dtcs: { code: string; desc: string }[];
  cloneVerdict?: string;
}
export interface ExplorerStartInput {
  host?: string; iface: string; tx: string; rx: string;
  module: { moduleId?: string; displayName: string; brand: string; category: string; protocol: string; capabilities?: string[]; identity?: string; knownDtcs?: { code: string; desc: string }[]; skeleton?: ExplorerSkeleton };
}
export interface ExplorerRun {
  id: string; moduleId: string; displayName: string; iface: string; tx: string; rx: string;
  startedAt: string; endedAt: string; outcome: "concluded" | "partial" | "error";
  result: ExplorerResult | null; newFindings: string[]; priorRunCount: number;
  tokensIn: number; tokensOut: number; steps: number; transcript: string;
}

// ---- AI Vehicle Explorer (whole-car deep map: discover modules → map each) ----
export interface DiscoveredIdent { partNo?: string; supplier?: string; sw?: string; hw?: string; serial?: string; vin?: string }
export interface DiscoveredModule {
  name: string; requestId: string; responseId: string; firstBytes: string; negative: boolean; ident?: DiscoveredIdent;
}
export interface IdentifyEcuEvidence {
  responseId: string; requestId?: string; label?: string;
  partNo?: string; supplier?: string; sw?: string; hw?: string; serial?: string; vin?: string;
}
export interface IdentifyCandidate {
  id: string; year: number | null; make: string; model: string; trim?: string; bodyType?: string;
  wmi?: string[]; responders: string[]; similarity: number; explored: number; hintKind?: string;
}
export interface IdentifyInput {
  vin: string;
  decode: { valid: boolean; wmi: string; vds: string; make: string | null; year: number | null; country: string; region: string; bodyTypeHint: string; checkDigitValid: boolean };
  bus: { iface?: string; responders: string[]; ecus: IdentifyEcuEvidence[]; calId?: string; cvn?: string };
  candidates: IdentifyCandidate[];
  operatorNote?: string;
}
export interface IdentifyResult {
  year: number | null; make: string; model: string; trim?: string;
  bodyType: "sedan" | "suv" | "truck" | "van" | "minivan" | "hatchback" | "coupe" | "wagon";
  platform?: string; engine?: string; market?: string;
  confidence: "high" | "medium" | "low";
  matchedProfileId: string | null;
  rationale: string; evidence: string[]; warnings: string[];
  modules: { responseId: string; label: string; category: string; supplier?: string }[];
  tokensIn: number; tokensOut: number;
}
export interface VehicleExplorerTarget {
  moduleId: string; displayName: string; brand: string; category: string;
  protocol: string; requestId: string; responseId: string;
}
/** GET /api/scan/sweep/status while the device's address sweep runs. */
export interface SweepProgress {
  running: boolean;
  phase?: "listen" | "probe" | "confirm" | "done" | "error";
  iface?: string; lo?: string; hi?: string;
  probed?: number; total?: number; current?: string | null;
  hits?: { req: string; resp: string }[];
  skipped?: string[];
  broadcast?: number;
  elapsed?: number;
  error?: string;
}

export type VehicleExplorerEvent =
  | { type: "discover"; done: number; total: number; found: number }
  | { type: "sweep"; ok: boolean; found: number; seconds?: number }
  | { type: "sweep-progress"; progress: SweepProgress }
  | { type: "discover-hit"; requestId: string; responseId: string; name: string; ident?: { partNo?: string; supplier?: string; sw?: string; hw?: string; serial?: string; vin?: string } }
  | { type: "ident-start"; total: number; modules: { moduleId: string; label: string; requestId: string; responseId: string; protectedKind?: string }[] }
  | { type: "ident-module"; moduleId: string; label: string; index: number; total: number; phase: "start" | "done"; protectedKind?: string; entry?: ModuleInventoryEntry }
  | { type: "ident-record"; moduleId: string; record: IdentRecord }
  | { type: "ident-done"; inventory: CarInventory }
  | { type: "sweep-module"; moduleId: string; label: string; index: number; total: number; phase: "start" | "progress" | "done"; asked: number; of: number; answered: number; sweep?: ModuleSweep }
  | { type: "module-start"; moduleId: string; displayName: string; index: number; total: number }
  | { type: "module-event"; moduleId: string; event: ExplorerEvent }
  | { type: "module-done"; moduleId: string; result: ExplorerResult }
  | { type: "status"; text: string }
  | { type: "error"; text: string };

// ---- SuperDevice (Raspberry Pi 5 CAN interface) ----
export interface SuperDeviceIface {
  name: string;
  present: boolean;
  up?: boolean;
  bitrate?: number;
  dbitrate?: number;
  fd?: boolean;
  canstate?: string;
  rx?: number;
  tx?: number;
  rxerr?: number;
  role?: string;
}
export interface SuperDeviceStatus {
  ifaces: SuperDeviceIface[];
  sys: { temp: number | null; uptime: string; model: string; kernel: string; load: string };
}
/** A module that may report its own supply voltage (standard OBD addresses only). */
export interface VoltageSource { id: string; req: string; resp: string }
export interface VoltageReading {
  at: string;
  state: "ok" | "silent" | "busy" | "down";
  volts: number | null;
  rpm: number | null;
  modules: { id: string; volts: number }[];
}
export interface VinReadResult {
  ok: boolean;
  vin?: string;
  error?: string;
  raw?: string;
}
export interface DiscoveredDevice { host: string; ip: string; hostname: string; model: string }

// ---- Pi device fleet (Devices tab) ----
export interface PairedDevice {
  id: string;
  host: string;
  hostname: string;
  model: string;
  nickname?: string;
  pairedAt: string;
  lastSeenAt?: string;
}
export interface DeviceClaim { owner: string; since: string; expires_in: number }
export interface DeviceBattery { present: boolean; voltage?: number; percent?: number; external_power?: boolean }
export interface PowerGuardState { state: "ok" | "countdown" | "shutting-down" | "no-ups" | "ups-degraded"; seconds_left?: number; grace?: number; soc?: number }
export interface PiDeviceInfo {
  hostname: string;
  ip: string;
  ssid: string;
  model: string;
  claim: DeviceClaim | null;
  battery: DeviceBattery;
  power?: PowerGuardState | null;
}
export interface SavedWifiNetwork { name: string; autoconnect: boolean; active: boolean }
export interface NearbyWifiNetwork { ssid: string; signal: number; secure: boolean }
export interface ClaimResult { ok: boolean; claim?: DeviceClaim; occupied_by?: string; error?: string }

// ---- JobCount link ----
export interface JobCountStatus {
  linked: boolean;
  serverUrl: string | null;
  shopId: string | null;
  shopName: string | null;
  deviceId: string | null;
  encryptionAvailable: boolean;
  storedUnencrypted: boolean;
}
export interface PushVehicleInput {
  vin?: string;
  year?: number | null;
  make?: string;
  model?: string;
  mileage?: number;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
}
export interface PushVehicleResult {
  ok: boolean;
  created: boolean;
  vehicle: { id: string; vin: string; year: number | null; make: string; model: string };
  error?: string;
}
export interface GarageVehicle {
  id: string; vin: string; year: number | null; make: string; model: string;
  trim: string; plate: string; mileage: number | null; customerName: string;
  source: string; status: string; createdAt: string;
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
  busIntel: {
    list:    () => unwrap<BusModuleKnowledge[]>(api.busIntel.list() as never),
    save:    (record: BusModuleKnowledge) =>
      unwrap<BusModuleKnowledge[]>(api.busIntel.save(record) as never),
    delete:  (id: string) =>
      unwrap<{ removed: boolean; records: BusModuleKnowledge[] }>(api.busIntel.delete(id) as never),
    analyze: (input: BusMapRequest) => unwrap<BusMapResult>(api.busIntel.analyze(input) as never),
    bake:    () => unwrap<{ path: string; count: number }>(api.busIntel.bake() as never),
  },
  vehicleLib: {
    /** Vehicles actually read. `{ builtIn: true }` adds the hand-written starter maps (archive tools only). */
    list:   (payload?: { builtIn?: boolean }) => unwrap<VehicleProfile[]>(api.vehicleLib.list(payload) as never),
    /** Work on the sandbox copy of the library while a simulator answers (real cars' records stay untouched). */
    setSimulation: (payload: { on: boolean }) => unwrap<{ on: boolean }>(api.vehicleLib.setSimulation(payload) as never),
    save:   (record: VehicleProfile) => unwrap<VehicleProfile[]>(api.vehicleLib.save(record) as never),
    delete: (id: string) =>
      unwrap<{ removed: boolean; records: VehicleProfile[] }>(api.vehicleLib.delete(id) as never),
    bake:   () => unwrap<{ path: string; count: number }>(api.vehicleLib.bake() as never),
    analyze: (scan: VehicleScan) => unwrap<VehicleMapResult>(api.vehicleLib.analyze(scan) as never),
  },
  benchModules: {
    list:    () => unwrap<BenchModuleProfile[]>(api.benchModules.list() as never),
    save:    (record: BenchModuleProfile) => unwrap<BenchModuleProfile[]>(api.benchModules.save(record) as never),
    delete:  (id: string) =>
      unwrap<{ removed: boolean; records: BenchModuleProfile[] }>(api.benchModules.delete(id) as never),
    analyze: (input: ModuleMapRequest) => unwrap<ModuleMapResult>(api.benchModules.analyze(input) as never),
    bake:    () => unwrap<{ path: string; count: number }>(api.benchModules.bake() as never),
    listAssets: (moduleId: string) => unwrap<ChipAsset[]>(api.benchModules.listAssets(moduleId) as never),
    addAsset: (input: { moduleId: string; fileName: string; base64: string; mediaType: string; caption?: string }) =>
      unwrap<ChipAsset>(api.benchModules.addAsset(input) as never),
    readAsset: (input: { moduleId: string; assetId: string }) =>
      unwrap<{ base64: string; mediaType: string; fileName: string }>(api.benchModules.readAsset(input) as never),
    deleteAsset: (input: { moduleId: string; assetId: string }) =>
      unwrap<{ removed: boolean }>(api.benchModules.deleteAsset(input) as never),
  },
  vehicleExplorer: {
    /** `known`: the profile's own addresses (always re-probed); `deep`: run the device's address sweep first. */
    discover: (payload: { host?: string; iface: string; ident?: boolean; known?: { name: string; req: string; resp: string }[]; deep?: boolean }) =>
      unwrap<DiscoveredModule[]>(api.vehicleExplorer.discover(payload) as never),
    commitDiscovery: (payload: { host?: string; iface?: string; profile: VehicleProfile; discovered: DiscoveredModule[] }) =>
      unwrap<VehicleProfile>(api.vehicleExplorer.commitDiscovery(payload) as never),
    start: (payload: { host?: string; iface: string; profile: VehicleProfile; targets: VehicleExplorerTarget[] }) =>
      unwrap<VehicleProfile>(api.vehicleExplorer.start(payload) as never),
    stop: () => unwrap<{ ok: boolean }>(api.vehicleExplorer.stop() as never),
    /** Read every module's identity (part numbers, versions, serial…) and file it under the car's VIN. Read-only. */
    identifyModules: (payload: { host?: string; iface: string; profile: VehicleProfile; vin?: string; moduleIds?: string[]; sim?: string | null; extended?: boolean }) =>
      unwrap<{ profile: VehicleProfile; inventory: CarInventory }>(api.vehicleExplorer.identifyModules(payload) as never),
    /** Completeness sweep: read every identifier of each (non-protected) module, twice. Read-only, no AI. */
    sweepModules: (payload: { host?: string; iface: string; profile: VehicleProfile; moduleIds?: string[]; condition: string; wide?: boolean; sim?: string | null }) =>
      unwrap<{ profile: VehicleProfile; sweeps: Record<string, ModuleSweep>; skipped: string[] }>(api.vehicleExplorer.sweepModules(payload) as never),
    identify: (payload: IdentifyInput) => unwrap<IdentifyResult>(api.vehicleExplorer.identify(payload) as never),
    decodeOnline: (vin: string) => unwrap<OnlineVinDecode>(api.vehicleExplorer.decodeOnline(vin) as never),
    census: (payload: CensusInput) => unwrap<CensusResult>(api.vehicleExplorer.census(payload) as never),
    capture: (payload: { host?: string; iface: string; vin?: string; profile?: VehicleProfile; note?: string; extra?: unknown }) =>
      unwrap<{ path: string; bytes: number; summary: string }>(api.vehicleExplorer.capture(payload) as never),
    onEvent: (cb: (e: VehicleExplorerEvent) => void) => api.vehicleExplorer.onEvent(cb),
  },
  moduleExplorer: {
    start: (p: ExplorerStartInput) => unwrap<ExplorerResult>(api.moduleExplorer.start(p) as never),
    stop: () => unwrap<{ ok: boolean }>(api.moduleExplorer.stop() as never),
    onEvent: (cb: (e: ExplorerEvent) => void) => api.moduleExplorer.onEvent(cb),
    listRuns: (moduleId: string) => unwrap<ExplorerRun[]>(api.moduleExplorer.listRuns(moduleId) as never),
    saveRun: (run: ExplorerRun) => unwrap<ExplorerRun[]>(api.moduleExplorer.saveRun(run) as never),
    deleteRun: (moduleId: string, runId: string) =>
      unwrap<{ removed: boolean; runs: ExplorerRun[] }>(api.moduleExplorer.deleteRun(moduleId, runId) as never),
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
  superDevice: {
    status:  (host?: string) => unwrap<SuperDeviceStatus>(api.superDevice.status(host) as never),
    readVin: (host?: string, iface?: string) =>
      unwrap<VinReadResult>(api.superDevice.readVin(host, iface) as never),
    setUp:   (host: string | undefined, iface: string, bitrate: number, fd: boolean) =>
      unwrap<{ result: string }>(api.superDevice.setUp(host, iface, bitrate, fd) as never),
    setDown: (host: string | undefined, iface: string) =>
      unwrap<{ result: string }>(api.superDevice.setDown(host, iface) as never),
    get:  <T = unknown>(host: string | undefined, path: string) =>
      unwrap<T>(api.superDevice.get(host, path) as never),
    post: <T = unknown>(host: string | undefined, path: string, body?: unknown) =>
      unwrap<T>(api.superDevice.post(host, path, body) as never),
    discover: () => unwrap<DiscoveredDevice[]>(api.superDevice.discover() as never),
  },
  voltage: {
    /** Supply voltage now. `asked` = the operator clicked (may bring the bus up). Gives way to any scan. */
    read: (payload: { host?: string; iface: string; modules?: VoltageSource[]; asked?: boolean }) =>
      unwrap<VoltageReading>(api.voltage.read(payload) as never),
  },
  devices: {
    list: () => unwrap<{ owner: string; devices: PairedDevice[] }>(api.devices.list() as never),
    pair: (input: { host: string; hostname?: string; model?: string; nickname?: string }) =>
      unwrap<PairedDevice[]>(api.devices.pair(input) as never),
    unpair: (id: string) => unwrap<PairedDevice[]>(api.devices.unpair(id) as never),
    update: (id: string, patch: Partial<Pick<PairedDevice, "host" | "hostname" | "model" | "nickname" | "lastSeenAt">>) =>
      unwrap<PairedDevice[]>(api.devices.update(id, patch) as never),
    claim: (host: string | undefined, force?: boolean) =>
      unwrap<ClaimResult>(api.devices.claim(host, force) as never),
    release: (host: string | undefined, force?: boolean) =>
      unwrap<ClaimResult>(api.devices.release(host, force) as never),
  },
  jobcount: {
    status: () => unwrap<JobCountStatus>(api.jobcount.status() as never),
    pair: (serverUrl: string, code: string) => unwrap<JobCountStatus>(api.jobcount.pair(serverUrl, code) as never),
    unpair: () => unwrap<JobCountStatus>(api.jobcount.unpair() as never),
    verify: () => unwrap<{ ok: boolean; shopName?: string; deviceType?: string; error?: string }>(api.jobcount.verify() as never),
    pushVehicle: (v: PushVehicleInput) => unwrap<PushVehicleResult>(api.jobcount.pushVehicle(v) as never),
    listGarage: (q?: string) => unwrap<{ ok: boolean; count: number; vehicles: GarageVehicle[] }>(api.jobcount.listGarage(q) as never),
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
    findPorts: () => unwrap<string[]>(api.pico.findPorts() as never),
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
