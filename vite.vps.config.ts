import vinext from "vinext";
import { defineConfig } from "vite";

// Standalone build: no Sites metadata, plugin, bindings or deployment configuration.
// The preview configuration reuses this same definition for its explicit Node target.
export default defineConfig({
  define: { "process.env.CONTROL_ROOM_BUILD_TARGET": JSON.stringify("vps-node") },
  environments: {
    client: { build: { outDir: "dist-vps/client" } },
    rsc: { build: { rollupOptions: { external: ["pg-boss"], input: {
      runtime: "src/web/v1/private-process.ts", bootstrap: "src/web/v1/private-startup.ts",
      serving: "src/web/v1/private-serving.ts", rehearsal: "src/web/v1/private-database-rehearsal.ts",
      preparation: "src/web/v1/private-fixture-preparation.ts", taskApplication: "src/web/v1/private-task-application.ts",
      taskBootstrap: "src/web/v1/private-task-startup.ts", nativeQueueFactories: "src/web/v1/installed-native-queue.ts",
      nativeQueueInspection: "src/persistence/pg-boss-schema-inspection.ts", taskHost: "src/web/v1/private-task-host.ts",
    } } } },
  },
  plugins: [vinext({ appDir: "private-app", rscOutDir: "dist-vps/server", ssrOutDir: "dist-vps/server/ssr" })],
});
