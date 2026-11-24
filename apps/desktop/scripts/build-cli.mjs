// Bundles the command-line vehicle runner (cli/vehicle.ts) into one CommonJS
// file, dist-cli/vehicle.cjs, that plain Node runs — no Electron.
//
// It bundles the SAME resolver sources the app uses (electron/resolver/*,
// electron/pipeline/*). Their one Electron dependency is the API-key lookup in
// electron/settings.ts (safeStorage); the plugin below points that import at
// cli/settings.ts instead, and fails the build if anything else reaches for
// "electron" — so the CLI can never quietly grow an Electron dependency.

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

const noElectron = {
  name: "no-electron",
  setup(b) {
    b.onResolve({ filter: /^\.\.\/settings$/ }, (args) => {
      if (args.importer.replace(/\\/g, "/").includes("/electron/resolver/")) {
        return { path: path.join(appRoot, "cli", "settings.ts") };
      }
      return undefined;
    });
    b.onResolve({ filter: /^electron$/ }, (args) => ({
      errors: [{ text: `the CLI bundle must not import "electron" (imported by ${args.importer})` }],
    }));
  },
};

await build({
  entryPoints: [path.join(appRoot, "cli/vehicle.ts")],
  outfile: path.join(appRoot, "dist-cli/vehicle.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: "inline",
  logLevel: "warning",
  loader: { ".ts": "ts" },
  tsconfig: path.join(appRoot, "cli/tsconfig.json"),
  plugins: [noElectron],
});
