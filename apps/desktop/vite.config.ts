import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const repoRoot = path.resolve(__dirname, "..", "..");

export default defineConfig({
  plugins: [react()],
  base: "./",
  root: ".",
  publicDir: "public",
  resolve: {
    alias: {
      "@ecu/core":       path.join(repoRoot, "packages/core/src/index.ts"),
      "@ecu/chip-db":    path.join(repoRoot, "packages/chip-db/src/index.ts"),
      "@ecu/adapters":   path.join(repoRoot, "packages/adapters/src/index.ts"),
      "@ecu/dump-tools": path.join(repoRoot, "packages/dump-tools/src/index.ts"),
      "@ecu/workspace":  path.join(repoRoot, "packages/workspace/src/index.ts"),
      "@ecu/vehicle-db": path.join(repoRoot, "packages/vehicle-db/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
});
