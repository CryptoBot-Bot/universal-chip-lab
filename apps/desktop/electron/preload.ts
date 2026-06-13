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
  },
  adapters: {
    list:   () => invoke("adapters:list"),
    status: (id: string) => invoke("adapters:status", { id }),
    test:   (id: string) => invoke("adapters:test", { id }),
    identify: (id: string, opts?: { simulateChipId?: string; protocol?: string }) =>
      invoke("adapters:identify", { id, ...opts }),
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
  settings: {
    getKeyStatus: () => invoke("settings:getKeyStatus"),
    setApiKey: (key: string) => invoke("settings:setApiKey", { key }),
    clearApiKey: () => invoke("settings:clearApiKey"),
    testApiKey: (key?: string) => invoke("settings:testApiKey", { key }),
  },
  pico: {
    findPort: () => invoke("pico:findPort"),
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
