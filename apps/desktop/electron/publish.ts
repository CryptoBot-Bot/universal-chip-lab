/**
 * Dev-only "publish" plumbing (mirrors jobcount-phone-desktop).
 *
 * In the dev build the user can cut a release from inside the app: pick a
 * version bump, we verify the git tree is clean + has an origin remote, bump
 * apps/desktop/package.json, then commit → tag `vX.Y.Z` → push. The pushed tag
 * fires the GitHub Actions release workflow, which builds the installer and
 * publishes it — which the auto-updater in installed apps then offers.
 *
 * Every git command's output is streamed to the renderer via `app:publish-log`.
 * All of this is hard-disabled in the packaged (prod) app.
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { app, ipcMain, type BrowserWindow } from "electron";

let getWin: () => BrowserWindow | null = () => null;
let repoRoot = process.cwd();
let appPkgPath = "";

function streamLine(jobId: string, kind: string, line: string) {
  const w = getWin();
  if (w && !w.isDestroyed()) {
    try {
      w.webContents.send("app:publish-log", { jobId, kind, line });
    } catch {
      /* window gone */
    }
  }
}

// Runs one child process, streaming stdout/stderr to the renderer. git is on
// PATH and needs no shell; npm-family commands need a shell on Windows.
function runStep(jobId: string, label: string, command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    streamLine(jobId, "step", `\n$ ${label}`);
    const isWin = process.platform === "win32";
    const needsShell = isWin && /^(npm|npx|pnpm|yarn)$/i.test(command);

    let spawnCmd = command;
    let spawnArgs = args;
    if (needsShell) {
      const q = (a: string) => (/[\s"&|<>^()%]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
      spawnCmd = [command, ...args.map(q)].join(" ");
      spawnArgs = [];
    }

    const proc = spawn(spawnCmd, spawnArgs, { cwd: repoRoot, env: process.env, shell: needsShell });
    proc.stdout?.on("data", (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => streamLine(jobId, "out", l)));
    proc.stderr?.on("data", (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => streamLine(jobId, "err", l)));
    proc.on("close", (code) => {
      streamLine(jobId, code === 0 ? "ok" : "fail", `[exit ${code}]`);
      resolve(code ?? -1);
    });
    proc.on("error", (e) => {
      streamLine(jobId, "fail", `spawn error: ${e.message}`);
      resolve(-1);
    });
  });
}

function bumpVersion(current: string, bump: string): string | null {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === "major") { maj++; min = 0; pat = 0; }
  else if (bump === "minor") { min++; pat = 0; }
  else pat++;
  return `${maj}.${min}.${pat}`;
}

export function setupPublish(getWindow: () => BrowserWindow | null, opts: { repoRoot: string; appPkgPath: string }): void {
  getWin = getWindow;
  repoRoot = opts.repoRoot;
  appPkgPath = opts.appPkgPath;

  ipcMain.handle("app:publish-readiness", async () => {
    if (app.isPackaged) return { ready: false, isDev: false, currentVersion: app.getVersion(), reasons: ["Publishing is only available in the dev build."] };
    const reasons: string[] = [];
    try {
      const status = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim();
      if (status) reasons.push("Working tree has uncommitted changes — commit or stash them first.");
    } catch {
      reasons.push("Not a git repo (run `git init`) or git isn't on PATH.");
    }
    try {
      const remote = execSync("git remote get-url origin", { cwd: repoRoot, encoding: "utf8" }).trim();
      if (!remote) reasons.push("No 'origin' remote configured.");
    } catch {
      reasons.push("No 'origin' remote — add your GitHub repo as origin.");
    }
    return { ready: reasons.length === 0, isDev: true, currentVersion: app.getVersion(), reasons };
  });

  ipcMain.handle("app:publish-update", async (_e, payload: { bump?: string }) => {
    if (app.isPackaged) return { ok: false, error: "Publishing is only available in the dev build." };
    const bump = String(payload?.bump || "patch").toLowerCase();
    if (!["patch", "minor", "major"].includes(bump)) return { ok: false, error: "Invalid bump — expected patch / minor / major." };

    const jobId = `pub_${Date.now()}`;
    let pkg: { version: string };
    try {
      pkg = JSON.parse(fs.readFileSync(appPkgPath, "utf8"));
    } catch {
      return { ok: false, error: "Could not read apps/desktop/package.json." };
    }
    const newVersion = bumpVersion(pkg.version, bump);
    if (!newVersion) return { ok: false, error: `Could not bump version "${pkg.version}".` };

    pkg.version = newVersion;
    fs.writeFileSync(appPkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    const tagName = `v${newVersion}`;
    streamLine(jobId, "step", `Bumped version → ${newVersion}`);

    const relPkg = path.relative(repoRoot, appPkgPath).split(path.sep).join("/");
    const steps: [string, string, string[]][] = [
      [`git add ${relPkg}`, "git", ["add", relPkg]],
      [`git commit -m "Release ${tagName}"`, "git", ["commit", "-m", `Release ${tagName}`]],
      [`git tag ${tagName}`, "git", ["tag", tagName]],
      ["git push origin HEAD", "git", ["push", "origin", "HEAD"]],
      [`git push origin ${tagName}`, "git", ["push", "origin", tagName]],
    ];
    for (const [label, cmd, args] of steps) {
      const code = await runStep(jobId, label, cmd, args);
      if (code !== 0) return { ok: false, jobId, version: newVersion, tagName, error: `Step failed: ${label}` };
    }
    streamLine(jobId, "ok", `\n✓ Tag ${tagName} pushed — GitHub Actions is now building the installer.`);
    return { ok: true, jobId, version: newVersion, tagName };
  });
}
