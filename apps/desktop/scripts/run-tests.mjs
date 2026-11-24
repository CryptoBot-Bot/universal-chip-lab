// Runs the unit tests (node:test) of the desktop app and the workspace packages.
//
//   pnpm test                      (from the repo root or apps/desktop)
//
// Each *.test.ts is bundled with esbuild (same toolchain as the CLI build) into a
// temporary .mjs and handed to `node --test`, so tests import the real sources —
// the read-only policy, the identity decoders — with no extra test framework.
// A test may not import "electron": the safety rules it covers must stay plain code.

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..", "..", "..");
const roots = [path.join(repo, "packages"), path.join(repo, "apps", "desktop", "electron"), path.join(repo, "apps", "desktop", "src")];

function find(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) find(p, out);
    else if (e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const tests = roots.flatMap((r) => find(r));
if (!tests.length) { console.log("no tests found"); process.exit(0); }

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ual-tests-"));
const built = [];
for (const t of tests) {
  const out = path.join(outDir, path.relative(repo, t).replace(/[\\/]/g, "__").replace(/\.ts$/, ".mjs"));
  await build({
    entryPoints: [t], outfile: out, bundle: true, platform: "node", format: "esm", target: "node20",
    logLevel: "error", external: ["node:*"],
    plugins: [{
      name: "no-electron",
      setup(b) {
        // as in the CLI build: the resolver's one Electron dependency (the API-key store) → the CLI's
        b.onResolve({ filter: /^\.\.\/settings$/ }, (args) =>
          args.importer.replace(/\\/g, "/").includes("/electron/resolver/") ? { path: path.join(repo, "apps", "desktop", "cli", "settings.ts") } : undefined);
        b.onResolve({ filter: /^electron$/ }, () => ({ errors: [{ text: "tests must not import electron" }] }));
      },
    }],
  });
  built.push(out);
}
const r = spawnSync(process.execPath, ["--test", ...built], { stdio: "inherit" });
fs.rmSync(outDir, { recursive: true, force: true });
process.exit(r.status ?? 1);
