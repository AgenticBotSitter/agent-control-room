import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Build-only browser entry. No Sites configuration, server startup or public/ copy.
export default defineConfig({
  root: fileURLToPath(new URL("./contributor-demo", import.meta.url)),
  publicDir: false,
  build: { outDir: fileURLToPath(new URL("./dist-contributor/client", import.meta.url)),
    emptyOutDir: true, assetsDir: "_next/static", sourcemap: false },
  plugins: [react(), { name: "contributor-original-icon", async generateBundle() {
    this.emitFile({ type: "asset", fileName: "favicon.svg",
      source: await readFile(new URL("./public/favicon.svg", import.meta.url)) });
    // The shared asset loader allowlists these two PWA files for every client tree,
    // so the demo build must emit them like the production build does. The demo
    // never registers the worker, so this is bytes only, not a second PWA.
    for (const file of ["service-worker.js", "manifest.webmanifest"])
      this.emitFile({ type: "asset", fileName: file,
        source: await readFile(new URL(`./private-app/app/${file}`, import.meta.url)) });
  } }],
});
