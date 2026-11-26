import { contextBridge, ipcRenderer } from "electron";

import type { IpcChannel, IpcResponse } from "./ipc/channels";

function invoke<T>(channel: IpcChannel, payload?: unknown): Promise<IpcResponse<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResponse<T>>;
}

const api = {
  workspace: {
    init: () => invoke<{ root: string; jobsDir: string }>("workspace:init"),
  },
  chips: {
    list:      () => invoke("chips:list"),
    get:       (id: string) => invoke("chips:get", { id }),
    search:    (query: string) => invoke("chips:search", { query }),
    families:  () => invoke("chips:families"),
    byFamily:  (family: string) => invoke("chips:byFamily", { family }),
    resolve:   (input: unknown) => invoke("chips:resolve", input),
    saveProfile:   (profile: unknown) => invoke("chips:saveProfile", profile),
    deleteProfile: (id: string) => invoke("chips:deleteProfile", { id }),
    verifyProfile: (input: unknown) => invoke("chips:verifyProfile", input),
    promoteProfile: (input: unknown) => invoke("chips:promoteProfile", input),
    exportLibrary: () => invoke("chips:exportLibrary"),
    importLibrary: (profiles: unknown) => invoke("chips:importLibrary", { profiles }),
    bakeCatalog: () => invoke("chips:bakeCatalog"),
    guide: (input: { chipProfileId: string; generate?: boolean }) => invoke("chips:guide", input),
    scaffold: (input: { name: string; notes?: string }) => invoke("chips:scaffold", input),
    listAssets: (chipProfileId: string) => invoke("chips:listAssets", { chipProfileId }),
    addAsset: (input: { chipProfileId: string; fileName: string; base64: string; mediaType: string; kind: string; caption?: string }) =>
      invoke("chips:addAsset", input),
    readAsset: (input: { chipProfileId: string; assetId: string }) => invoke("chips:readAsset", input),
    deleteAsset: (input: { chipProfileId: string; assetId: string }) => invoke("chips:deleteAsset", input),
  },
  adapters: {
    list:   () => invoke("adapters:list"),
    status: (id: string) => invoke("adapters:status", { id }),
    test:   (id: string) => invoke("adapters:test", { id }),
    identify: (id: string, opts?: { simulateChipId?: string; protocol?: string }) =>
      invoke("adapters:identify", { id, ...opts }),
    read:  (input: { id: string; chipProfile: unknown; offset?: number; length?: number; tag?: string }) =>
      invoke("adapters:read", input),
    write: (input: { id: string; chipProfile: unknown; offset?: number; base64: string; tag?: string }) =>
      invoke("adapters:write", input),
    erase: (input: { id: string; chipProfile: unknown }) =>
      invoke("adapters:erase", input),
  },
  jobs: {
    list:       () => invoke("jobs:list"),
    get:        (jobId: string) => invoke("jobs:get", { jobId }),
    create:     (input: unknown) => invoke("jobs:create", input),
    setStatus:  (jobId: string, status: string) => invoke("jobs:setStatus", { jobId, status }),
    plan:       (jobId: string) => invoke("jobs:plan", { jobId }),
    safety:     (jobId: string) => invoke("jobs:safety", { jobId }),
    read:       (jobId: string, tag: string) => invoke("jobs:read", { jobId, tag }),
    verify:     (jobId: string) => invoke("jobs:verify", { jobId }),
    report:     (jobId: string) => invoke("jobs:report", { jobId }),
    hexPreview: (jobId: string, fileName: string, offset = 0, length = 512) =>
      invoke("jobs:hexPreview", { jobId, fileName, offset, length }),
  },
  modules: {
    list:     () => invoke("modules:list"),
    get:      (id: string) => invoke("modules:get", { id }),
    search:   (query: string) => invoke("modules:search", { query }),
    brands:   () => invoke("modules:brands"),
    byBrand:  (brand: string) => invoke("modules:byBrand", { brand }),
  },
  busIntel: {
    list:    () => invoke("busIntel:list"),
    save:    (record: unknown) => invoke("busIntel:save", record),
    delete:  (id: string) => invoke("busIntel:delete", { id }),
    analyze: (input: unknown) => invoke("busIntel:analyze", input),
    bake:    () => invoke("busIntel:bake"),
  },
  vehicleLib: {
    list:    (payload?: { builtIn?: boolean }) => invoke("vehicleLib:list", payload),
    setSimulation: (payload: { on: boolean }) => invoke("vehicleLib:setSimulation", payload),
    save:    (record: unknown) => invoke("vehicleLib:save", record),
    delete:  (id: string) => invoke("vehicleLib:delete", { id }),
    bake:    () => invoke("vehicleLib:bake"),
    analyze: (scan: unknown) => invoke("vehicleLib:analyze", scan),
  },
  benchModules: {
    list:    () => invoke("benchModules:list"),
    save:    (record: unknown) => invoke("benchModules:save", record),
    delete:  (id: string) => invoke("benchModules:delete", { id }),
    analyze: (input: { images: { data: string; mediaType: string }[]; description: string }) =>
      invoke("benchModules:analyze", input),
    bake:    () => invoke("benchModules:bake"),
    listAssets: (moduleId: string) => invoke("benchModules:listAssets", { moduleId }),
    addAsset: (input: { moduleId: string; fileName: string; base64: string; mediaType: string; caption?: string }) =>
      invoke("benchModules:addAsset", input),
    readAsset: (input: { moduleId: string; assetId: string }) => invoke("benchModules:readAsset", input),
    deleteAsset: (input: { moduleId: string; assetId: string }) => invoke("benchModules:deleteAsset", input),
  },
  moduleJobs: {
    list:      () => invoke("moduleJobs:list"),
    get:       (jobId: string) => invoke("moduleJobs:get", { jobId }),
    create:    (input: unknown) => invoke("moduleJobs:create", input),
    openDonor: (jobId: string, label: string) =>
      invoke("moduleJobs:openDonor", { jobId, label }),
    readSlot:  (jobId: string, side: "source" | "donor", slot: string, tag: string) =>
      invoke("moduleJobs:readSlot", { jobId, side, slot, tag }),
    ceremony:  (jobId: string) => invoke("moduleJobs:ceremony", { jobId }),
    cloneWrite: (jobId: string, slot: string, donorLabelConfirmation: string) =>
      invoke("moduleJobs:cloneWrite", { jobId, slot, donorLabelConfirmation }),
    ceremonyReport: (jobId: string) => invoke("moduleJobs:ceremonyReport", { jobId }),
  },
  tools: {
    detect: () => invoke("tools:detect"),
  },
  superDevice: {
    status: (host?: string) => invoke("superDevice:status", { host }),
    readVin: (host?: string, iface?: string) => invoke("superDevice:vin", { host, iface }),
    setUp: (host: string | undefined, iface: string, bitrate: number, fd: boolean) =>
      invoke("superDevice:up", { host, iface, bitrate, fd }),
    setDown: (host: string | undefined, iface: string) => invoke("superDevice:down", { host, iface }),
    get: (host: string | undefined, path: string) => invoke("superDevice:get", { host, path }),
    post: (host: string | undefined, path: string, body?: unknown) => invoke("superDevice:post", { host, path, body }),
    discover: () => invoke("superDevice:discover"),
  },
  mechanic: {
    ask: (payload: { sessionId: string; profileId: string; vin?: string; host?: string; iface: string; question: string; voltage?: string; device: string }) => invoke("mechanic:ask", payload),
    stop: () => invoke("mechanic:stop"),
    reset: (payload: { sessionId: string }) => invoke("mechanic:reset", payload),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onEvent: (cb: (e: any) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_e: unknown, ev: any) => cb(ev);
      ipcRenderer.on("mechanic:event", handler);
      return () => ipcRenderer.removeListener("mechanic:event", handler);
    },
  },
  knowledge: {
    status: () => invoke("knowledge:status"),
    sync: () => invoke("knowledge:sync"),
    card: (payload: { profileId: string }) => invoke("knowledge:card", payload),
    dtcs: (payload: { codes: string[] }) => invoke("knowledge:dtcs", payload),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onEvent: (cb: (e: any) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_e: unknown, ev: any) => cb(ev);
      ipcRenderer.on("knowledge:event", handler);
      return () => ipcRenderer.removeListener("knowledge:event", handler);
    },
  },
  voltage: {
    read: (payload: { host?: string; iface: string; modules?: { id: string; req: string; resp: string }[]; asked?: boolean }) => invoke("voltage:read", payload),
  },
  devices: {
    list: () => invoke("devices:list"),
    pair: (input: { host: string; hostname?: string; model?: string; nickname?: string }) =>
      invoke("devices:pair", input),
    unpair: (id: string) => invoke("devices:unpair", { id }),
    update: (id: string, patch: Record<string, unknown>) => invoke("devices:update", { id, patch }),
    claim: (host: string | undefined, force?: boolean) => invoke("devices:claim", { host, force }),
    release: (host: string | undefined, force?: boolean) => invoke("devices:release", { host, force }),
  },
  moduleExplorer: {
    start: (payload: { host?: string; iface: string; tx: string; rx: string; module: unknown }) =>
      invoke("moduleExplorer:start", payload),
    stop: () => invoke("moduleExplorer:stop"),
    listRuns: (moduleId: string) => invoke("moduleExplorer:listRuns", { moduleId }),
    saveRun: (run: unknown) => invoke("moduleExplorer:saveRun", run),
    deleteRun: (moduleId: string, runId: string) => invoke("moduleExplorer:deleteRun", { moduleId, runId }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onEvent: (cb: (e: any) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_e: unknown, ev: any) => cb(ev);
      ipcRenderer.on("moduleExplorer:event", handler);
      return () => ipcRenderer.removeListener("moduleExplorer:event", handler);
    },
  },
  vehicleExplorer: {
    discover: (payload: { host?: string; iface: string; ident?: boolean; known?: { name: string; req: string; resp: string }[]; deep?: boolean }) => invoke("vehicleExplorer:discover", payload),
    commitDiscovery: (payload: { host?: string; iface?: string; profile: unknown; discovered: unknown[] }) =>
      invoke("vehicleExplorer:commitDiscovery", payload),
    start: (payload: { host?: string; iface: string; profile: unknown; targets: unknown[] }) =>
      invoke("vehicleExplorer:start", payload),
    stop: () => invoke("vehicleExplorer:stop"),
    identifyModules: (payload: { host?: string; iface: string; profile: unknown; vin?: string; moduleIds?: string[]; sim?: string | null; extended?: boolean }) =>
      invoke("vehicleExplorer:identify", payload),
    sweepModules: (payload: { host?: string; iface: string; profile: unknown; moduleIds?: string[]; condition: string; wide?: boolean; sim?: string | null }) =>
      invoke("vehicleExplorer:sweep", payload),
    labelModule: (payload: { profileId: string; moduleId: string }) => invoke("vehicleExplorer:label", payload),
    identify: (payload: unknown) => invoke("vehicleId:resolve", payload),
    decodeOnline: (vin: string) => invoke("vehicleId:decodeOnline", { vin }),
    census: (payload: unknown) => invoke("vehicleId:census", payload),
    capture: (payload: unknown) => invoke("vehicleLib:capture", payload),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onEvent: (cb: (e: any) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_e: unknown, ev: any) => cb(ev);
      ipcRenderer.on("vehicleExplorer:event", handler);
      return () => ipcRenderer.removeListener("vehicleExplorer:event", handler);
    },
  },
  jobcount: {
    status: () => invoke("jobcount:status"),
    pair: (serverUrl: string, code: string) => invoke("jobcount:pair", { serverUrl, code }),
    unpair: () => invoke("jobcount:unpair"),
    verify: () => invoke("jobcount:verify"),
    pushVehicle: (v: unknown) => invoke("jobcount:pushVehicle", v),
    listGarage: (q?: string) => invoke("jobcount:listGarage", { q }),
  },
  settings: {
    getKeyStatus: () => invoke("settings:getKeyStatus"),
    setApiKey: (key: string) => invoke("settings:setApiKey", { key }),
    clearApiKey: () => invoke("settings:clearApiKey"),
    testApiKey: (key?: string) => invoke("settings:testApiKey", { key }),
  },
  pico: {
    findPort: () => invoke("pico:findPort"),
    findPorts: () => invoke("pico:findPorts"),
    command: (input: { port: string; command: string; reboot?: boolean; timeoutMs?: number }) =>
      invoke("pico:command", input),
    disconnect: (input: { port: string }) => invoke("pico:disconnect", input),
    saveDump: (input: { name: string; base64: string; meta?: Record<string, unknown> }) =>
      invoke("pico:saveDump", input),
    listDumps: () => invoke("pico:listDumps"),
    readDump: (input: { name: string; offset?: number; length?: number }) =>
      invoke("pico:readDump", input),
    deleteDump: (input: { name: string }) => invoke("pico:deleteDump", input),
    exportDump: (input: { name: string; format: string }) => invoke("pico:exportDump", input),
  },
  updates: {
    check: () => ipcRenderer.invoke("app:check-for-updates"),
    install: () => ipcRenderer.invoke("app:install-update-now"),
    getState: () => ipcRenderer.invoke("app:get-update-state"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onState: (cb: (state: any) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_e: unknown, state: any) => cb(state);
      ipcRenderer.on("app:update-state", handler);
      return () => ipcRenderer.removeListener("app:update-state", handler);
    },
  },
  publish: {
    readiness: () => ipcRenderer.invoke("app:publish-readiness"),
    run: (bump: string) => ipcRenderer.invoke("app:publish-update", { bump }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onLog: (cb: (entry: any) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_e: unknown, entry: any) => cb(entry);
      ipcRenderer.on("app:publish-log", handler);
      return () => ipcRenderer.removeListener("app:publish-log", handler);
    },
  },
};

contextBridge.exposeInMainWorld("api", api);

export type EclApi = typeof api;
