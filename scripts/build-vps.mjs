import { createBuilder } from "vite";

// Build only: no vinext CLI dependency upgrades, prerender listener, startup or deployment.
process.env.CONTROL_ROOM_BUILD_TARGET = "vps-node";
const builder = await createBuilder({ mode: "production", configFile: "vite.vps.config.ts" });
await builder.buildApp();
console.log("VPS Node artifact compiled in dist-vps; deployment bootstrap remains unconfigured.");
