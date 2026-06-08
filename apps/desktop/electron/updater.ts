/**
 * Auto-update plumbing (mirrors the jobcount-phone-desktop pattern).
 *
 * electron-updater reads a GitHub Releases feed (configured via the `publish`
 * block in package.json; electron-builder writes `app-update.yml` into the
 * packaged app). Updates are MANUAL-ONLY here — we never check on our own; the
 * user clicks "Check for updates" in the sidebar. When a newer version is
 * found we download it in the background and arm an "Install & Restart" button.
 *
 * electron-updater is bundled into main.cjs by esbuild; we require() it so a
 * missing module degrades gracefully (e.g. an unbuilt dev checkout).
 */
import { app, ipcMain, type BrowserWindow } from "electron";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let autoUpdater: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  autoUpdater = require("electron-updater").autoUpdater;
} catch {
  autoUpdater = null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastEvent: any = null;

export function setupAutoUpdater(getWindow: () => BrowserWindow | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const broadcast = (payload: any) => {
    lastEvent = payload;
    const w = getWindow();
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send("app:update-state", payload);
      } catch {
        /* window gone */
      }
    }
  };

  if (autoUpdater) {
    autoUpdater.autoDownload = true; // start downloading as soon as a check finds one
    autoUpdater.autoInstallOnAppQuit = false; // never install silently; user clicks Install
    autoUpdater.on("checking-for-update", () => broadcast({ state: "checking" }));
    autoUpdater.on("update-available", (info: { version?: string }) => broadcast({ state: "available", version: info?.version }));
    autoUpdater.on("update-not-available", (info: { version?: string }) => broadcast({ state: "up-to-date", version: info?.version }));
    autoUpdater.on("download-progress", (p: { percent?: number }) => broadcast({ state: "downloading", percent: Math.round(p?.percent || 0) }));
    autoUpdater.on("update-downloaded", (info: { version?: string }) => broadcast({ state: "ready", version: info?.version }));
    autoUpdater.on("error", (err: Error) => broadcast({ state: "error", error: String(err?.message || err) }));
  }

  ipcMain.handle("app:check-for-updates", async () => {
    if (!app.isPackaged) return { ok: false, error: "Updates only work in the installed app (not the dev build)." };
    if (!autoUpdater) return { ok: false, error: "Updater unavailable." };
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, currentVersion: app.getVersion(), latestVersion: r?.updateInfo?.version ?? null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle("app:install-update-now", () => {
    if (!autoUpdater) return { ok: false, error: "Updater unavailable." };
    try {
      autoUpdater.quitAndInstall(false, true); // close, run installer, relaunch
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle("app:get-update-state", () => ({ version: app.getVersion(), last: lastEvent }));
}
