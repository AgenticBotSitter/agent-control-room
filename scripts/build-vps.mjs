import { createBuilder } from "vite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { macLocalBuildSourceV1 } from "./mac-local/build-source.mjs";

// Build only: no vinext CLI dependency upgrades, prerender listener, startup or deployment.
process.env.CONTROL_ROOM_BUILD_TARGET = "vps-node";
const builder = await createBuilder({ mode: "production", configFile: "vite.vps.config.ts" });
await builder.buildApp();
const root = fileURLToPath(new URL("../", import.meta.url));
await writeFile(join(root, "dist-vps/server/mac-local-build-source.json"),
  `${JSON.stringify(await macLocalBuildSourceV1(root))}\n`, { encoding: "utf8", mode: 0o644 });
console.log("VPS Node artifact compiled in dist-vps; deployment bootstrap remains unconfigured.");
