import vinext from "vinext";
import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";

// Standalone build: no Sites metadata, plugin, bindings or deployment configuration.
// The preview configuration reuses this same definition for its explicit Node target.
export default defineConfig({
  publicDir: false,
  define: { "process.env.CONTROL_ROOM_BUILD_TARGET": JSON.stringify("vps-node") },
  environments: {
    client: { build: { outDir: "dist-vps/client" } },
    rsc: { build: { rollupOptions: { external: ["pg-boss"], input: {
      runtime: "src/web/v1/private-process.ts", bootstrap: "src/web/v1/private-startup.ts",
      ideaAuthoring: "src/web/v1/private-idea-authoring-startup.ts",
      ownerBootstrap: "src/web/v1/private-owner-bootstrap.ts",
      ownerReview: "src/web/v1/private-owner-review.ts",
      taskDatabaseCheck: "src/web/v1/private-task-database-check.ts",
      nodeConnector: "src/node-bridge/private-node-entry.ts",
      serving: "src/web/v1/private-serving.ts", rehearsal: "src/web/v1/private-database-rehearsal.ts",
      preparation: "src/web/v1/private-fixture-preparation.ts", taskApplication: "src/web/v1/private-task-application.ts",
      taskBootstrap: "src/web/v1/private-task-startup.ts", nativeQueueFactories: "src/web/v1/installed-native-queue.ts",
      nativeQueueInspection: "src/persistence/pg-boss-schema-inspection.ts", taskHost: "src/web/v1/private-task-host.ts",
    } } } },
  },
  plugins: [vinext({ appDir: "private-app", rscOutDir: "dist-vps/server", ssrOutDir: "dist-vps/server/ssr" }), {
    name: "control-room-explicit-client-assets",
    async generateBundle() {
      if (this.environment.name !== "client") return;
      // Preserve the required local icon; this does not establish publication rights.
      this.emitFile({ type: "asset", fileName: "favicon.svg",
        source: await readFile(new URL("./public/favicon.svg", import.meta.url)) });
    },
  }],
});
