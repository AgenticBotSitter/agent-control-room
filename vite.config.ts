import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";
import { selectBuildTarget } from "./src/config/build-target";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";
const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ mode }) => {
  const target = selectBuildTarget(process.env.CONTROL_ROOM_BUILD_TARGET);
  const nodeTarget = target === "vps-node";
  const localPilotRequested = mode === "development"
    && process.env.CONTROL_ROOM_LOCAL_PILOT_MODE === "repository_fake";
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // PGlite is a Node-local development database and does not run inside the
  // Cloudflare worker simulator. Production and ordinary previews keep the
  // Cloudflare plugin; the explicit local pilot uses Vinext's Node runtime.
  const cloudflarePlugin = localPilotRequested || nodeTarget
    ? undefined
    : (await import("@cloudflare/vite-plugin")).cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      });

  return {
    define: { "process.env.CONTROL_ROOM_BUILD_TARGET": JSON.stringify(target) },
    ...(nodeTarget ? { environments: {
      client: { build: { outDir: "dist-vps/client" } },
      rsc: { build: { rollupOptions: { input: { runtime: "src/web/v1/private-process.ts", bootstrap: "src/web/v1/private-startup.ts" } } } },
    } } : {}),
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(nodeTarget ? { appDir: "private-app", rscOutDir: "dist-vps/server", ssrOutDir: "dist-vps/server/ssr" } : {}),
      ...(nodeTarget ? [] : [sites()]),
      ...(cloudflarePlugin ? [cloudflarePlugin] : []),
    ],
  };
});
