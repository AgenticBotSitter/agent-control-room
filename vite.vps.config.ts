import vinext from "vinext";
import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";
import { posix, relative } from "node:path";

let buildRoot = "";

const attendedBundledPackages = Object.freeze(["pg", "pg-boss", "react", "react-dom"]);
const isAttendedBundledPackage = (name: unknown) => typeof name === "string"
  && attendedBundledPackages.some(packageName => name === packageName || name.startsWith(`${packageName}/`));

// Standalone build: no Sites metadata, plugin, bindings or deployment configuration.
// The preview configuration reuses this same definition for its explicit Node target.
export default defineConfig({
  publicDir: false,
  define: { "process.env.CONTROL_ROOM_BUILD_TARGET": JSON.stringify("vps-node"),
    "import.meta.controlRoomBundled": "true" },
  environments: {
    client: { build: { outDir: "dist-vps/client" } },
    // The attended release deliberately ships no node_modules. Keep this on the
    // whole server environment rather than listing today's database packages:
    // every explicit server input (including inputs added by another lane) must
    // carry its complete JavaScript dependency closure into dist-vps/server.
    rsc: { resolve: { noExternal: true }, build: { rollupOptions: { input: {
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
      agentTaskOperator: "src/web/v1/private-agent-task-operator-configuration.ts",
      articleExtraction: "src/project-adapters/news/v1/article-extraction-runtime.mjs",
      productConfiguration: "src/config/v1/product-configuration.ts",
      githubWorkerBroker: "src/github-app/v1/private-service.ts",
      workIntakePrivateService: "src/work-intake/v1/private-service.ts",
      localSetupHost: "src/installer/v1/local-setup-host.ts",
      localInstallationPlanBootstrap: "src/installer/v1/local-installation-plan-bootstrap.ts",
      privateLocalInstallationOperatorCli: "src/installer/v1/private-local-installation-operator-cli.ts",
      nightlyBackup: "src/installer/v1/nightly-backup-entry.ts",
      fleetGateway: "src/fleet/v1/gateway-entry.ts",
      firstOwner: "src/installer/v1/first-owner-entry.ts",
      macLocalProtectedLoader: "src/web/v1/mac-local-protected-loader.ts",
      macLocalHost: "src/web/v1/mac-local-host.ts",
      macLocalFleet: "src/fleet/v1/mac-local-composition.ts",
      privatePostgres: "src/web/v1/private-postgres.ts",
      macLocalTaskProvider: "src/web/v1/mac-local-task-provider.ts",
      macLocalDefaultTaskProvider: "src/web/v1/mac-local-default-task-provider.ts",
    } } } },
  },
  plugins: [vinext({ appDir: "private-app", rscOutDir: "dist-vps/server", ssrOutDir: "dist-vps/server/ssr" }), {
    name: "control-room-explicit-client-assets",
    configResolved(config) {
      // Source identities are useful in the browser, but Node bundles must use
      // their installed runtime URL rather than the builder's source checkout.
      buildRoot = config.root;
      for (const identity of config.plugins.filter(plugin => plugin.name === "vinext:import-meta-url"))
        identity.applyToEnvironment = environment => environment.name === "client";
    },
    transform(code, id) {
      if (id !== "\0virtual:vinext-rsc-entry") return;
      // Vinext uses this field only to name missing middleware exports in errors.
      // Keep imports intact; only the display path should be release-relative.
      return code.replace(/filePath: ("(?:[^"\\]|\\.)*")/gu, (_match, literal: string) =>
        `filePath: ${JSON.stringify(relative(buildRoot, JSON.parse(literal)))}`);
    },
    // Vinext's generic serverExternalPackages defaults include PostgreSQL and
    // React. The attended release has no node_modules, so remove only the
    // reviewed pure-JavaScript packages from that framework list. Optional
    // native packages (for example pg-native) stay external and unused.
    configEnvironment(name, config) {
      // React's shared error reporter includes an optional Node process.emit
      // fallback. A browser cannot use it; remove it only from client output.
      // Server error reporting keeps its normal Node implementation.
      if (name === "client") return { define: { "process.emit": "undefined" } };
      if (name !== "rsc" && name !== "ssr") return;
      if (Array.isArray(config.resolve?.external))
        config.resolve.external = config.resolve.external.filter(value => !isAttendedBundledPackage(value));
      const legacy = config as typeof config & { ssr?: { external?: unknown[] } };
      if (Array.isArray(legacy.ssr?.external))
        legacy.ssr.external = legacy.ssr.external.filter(value => !isAttendedBundledPackage(value));
    },
    async generateBundle(_options, bundle) {
      if (this.environment.name === "rsc") {
        // node:worker_threads entries are not browser Worker bundles. Preserve
        // the fixed worker and its parser module beside each generated importer,
        // including shared chunks, rather than relying on a source checkout.
        const directories = new Set(Object.values(bundle).filter(item => item.type === "chunk"
          && item.code.includes("./article-extraction-worker.mjs")).map(item => posix.dirname(item.fileName)));
        for (const directory of directories) for (const file of ["article-extraction-worker.mjs", "article-extraction.mjs"])
          this.emitFile({ type: "asset", fileName: posix.join(directory, file),
            source: await readFile(new URL(`./src/project-adapters/news/v1/${file}`, import.meta.url)) });
      }
      if (this.environment.name !== "client") return;
      // Preserve the required local icon; this does not establish publication rights.
      this.emitFile({ type: "asset", fileName: "favicon.svg",
        source: await readFile(new URL("./public/favicon.svg", import.meta.url)) });
      // The PWA is explicitly allowlisted. No general public directory is served.
      for (const file of ["service-worker.js", "manifest.webmanifest"])
        this.emitFile({ type: "asset", fileName: file,
          source: await readFile(new URL(`./private-app/app/${file}`, import.meta.url)) });
    },
  }],
});
