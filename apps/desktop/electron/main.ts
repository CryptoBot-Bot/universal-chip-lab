import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { registerIpcHandlers } from "./ipc/handlers";
import { stopAllPicoSessions } from "./serial/picoSession";
import { setupPublish } from "./publish";
import { setupAutoUpdater } from "./updater";

// CommonJS shim — `__dirname` is available natively under the Electron main
// process bundle (tsc emits CommonJS for the main process).

const DEV_SERVER_URL = process.env.ECL_DEV_SERVER_URL ?? "http://localhost:5173";
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

/**
 * Tiny dotenv loader — reads `<projectRoot>/.env` (if present) and merges any
 * KEY=VALUE lines into process.env. Lines already set in the OS environment
 * are left alone (shell wins, file is a fallback). No external dependency.
 *
 * Keeps the safety design: the in-code default for `ECL_OPERATION_MODE`
 * stays `read_only`. To enable writes, the operator must explicitly set
 * `ECL_OPERATION_MODE=read_write_experimental` in `.env` — and now the app
 * actually reads that file.
 */
function loadEnvFile(projectRoot: string): { loaded: boolean; keys: string[] } {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return { loaded: false, keys: [] };
  const raw = fs.readFileSync(envPath, "utf8");
  const applied: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key) continue;
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Strip inline comments (only outside of quotes — naive but enough for our needs).
    const hashIdx = value.indexOf(" #");
    if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();

    // Shell-set vars win — let the OS environment override the file.
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return { loaded: true, keys: applied };
}

function resolveProjectRoot(): string {
  // dist-electron/main.cjs → ../..  in the packaged tree, or
  // apps/desktop/electron → ../../..  in dev. Walk up until package.json with
  // workspaces is found.
  let cursor = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.resolve(cursor, "package.json");
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require(candidate);
      if (pkg.workspaces || pkg.name === "ecu-clone-lab") {
        return path.dirname(candidate);
      }
    } catch {
      /* keep walking */
    }
    cursor = path.dirname(cursor);
  }
  return process.cwd();
}

async function createMainWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, "preload.cjs");
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0b1118",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });

  // ---- Web Serial: let the PicoForge bridge talk to the Pico over USB ----
  const ses = mainWindow.webContents.session;
  ses.setPermissionCheckHandler((_wc, permission) =>
    permission === "serial" ? true : true,
  );
  ses.setDevicePermissionHandler(() => true);
  ses.on("select-serial-port", (event, portList, _webContents, callback) => {
    event.preventDefault();
    // Prefer a Raspberry Pi RP2040 (Pico) by USB vendor id 0x2E8A; else first port.
    const pico = portList.find(
      (p) => (p.vendorId ?? "").toLowerCase() === "2e8a",
    );
    callback(pico?.portId ?? portList[0]?.portId ?? "");
  });

  if (isDev) {
    await mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = path.resolve(__dirname, "..", "dist", "index.html");
    await mainWindow.loadURL(pathToFileURL(indexPath).toString());
  }
  mainWindow.show();
}

app.whenReady().then(async () => {
  const projectRoot = resolveProjectRoot();
  const env = loadEnvFile(projectRoot);
  if (env.loaded) {
    console.log(`[ECL] Loaded .env from ${projectRoot} — keys applied: ${env.keys.join(", ") || "(none — all already set in OS env)"}`);
  } else {
    console.log(`[ECL] No .env file at ${projectRoot} — using OS env + in-code defaults.`);
  }
  console.log(`[ECL] ECL_OPERATION_MODE = ${process.env.ECL_OPERATION_MODE ?? "(unset → read_only)"}`);
  // In the installed app the bundle dir is read-only, so the workspace (dumps,
  // jobs, chip library) lives under userData; in dev it stays in the repo.
  const workspaceRoot = app.isPackaged ? app.getPath("userData") : projectRoot;
  await registerIpcHandlers(ipcMain, { projectRoot: workspaceRoot, appVersion: app.getVersion() });
  await createMainWindow();
  setupAutoUpdater(() => mainWindow);
  // Dev-only: publish releases from inside the app (bump → commit → tag → push).
  setupPublish(() => mainWindow, {
    repoRoot: projectRoot,
    appPkgPath: path.resolve(__dirname, "..", "package.json"),
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("will-quit", () => {
  stopAllPicoSessions(); // release the serial port / kill the relay process
});

app.on("window-all-closed", () => {
  stopAllPicoSessions();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

