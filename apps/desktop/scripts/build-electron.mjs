// Bundles the Electron main process and preload into single CommonJS files.
// The workspace packages export `.ts` source, so we bundle everything into
// dist-electron/{main,preload}.cjs — Electron then has zero runtime resolution
// to worry about.

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const outDir = path.join(appRoot, "dist-electron");

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
  // Electron and Node built-ins must remain external.
  external: ["electron"],
  // Treat workspace packages as native imports (they resolve via pnpm symlinks
  // to their TS source — esbuild handles .ts files natively).
  loader: { ".ts": "ts" },
  tsconfig: path.join(appRoot, "electron/tsconfig.json"),
};

const targets = [
  {
    entryPoints: [path.join(appRoot, "electron/main.ts")],
    outfile: path.join(outDir, "main.cjs"),
  },
  {
    entryPoints: [path.join(appRoot, "electron/preload.ts")],
    outfile: path.join(outDir, "preload.cjs"),
  },
];

for (const target of targets) {
  await build({ ...common, ...target });
}

if (watch) {
  // Lazy import context for watch mode.
  const { context } = await import("esbuild");
  for (const target of targets) {
    const ctx = await context({ ...common, ...target });
    await ctx.watch();
  }
  // Keep the process alive.
  await new Promise(() => undefined);
}
