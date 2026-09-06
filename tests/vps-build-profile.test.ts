import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadConfigFromFile } from "vite";
import { selectBuildTarget } from "../src/config/build-target.ts";

test("build target defaults to Sites and explicitly selects Node without accepting an unknown target", () => {
  assert.equal(selectBuildTarget(undefined), "sites");
  assert.equal(selectBuildTarget("vps-node"), "vps-node");
  assert.throws(() => selectBuildTarget("production"));
});
test("installed Node server exposes startup/shutdown ownership without starting it", () => {
  const declarations = readFileSync("node_modules/vinext/dist/server/prod-server.d.ts", "utf8");
  assert.match(declarations, /startProdServer/);
  assert.match(declarations, /server: import\("node:http"\)\.Server/);
  assert.match(declarations, /outDir\?: string/);
});
test("VPS build uses isolated artifacts and its all-route readiness guard cannot expose the preview", () => {
  const config = readFileSync("vite.vps.config.ts", "utf8");
  assert.match(config, /dist-vps\/server/); assert.match(config, /dist-vps\/client/);
  const guard = readFileSync("middleware.ts", "utf8");
  assert.match(guard, /handlePrivateWebRequest/);
  assert.match(config, /appDir: "private-app"/);
  const runtime = readFileSync("src/web/v1/private-process.ts", "utf8");
  assert.match(runtime, /private_app_not_configured/); assert.match(runtime, /status: 503/);
  assert.doesNotMatch(guard, /matcher:/);
  assert.deepEqual(JSON.parse(readFileSync(".openai/hosting.json", "utf8")), { d1: null, r2: null });
});

test("standalone build selects a configuration without private hosting dependencies", async () => {
  const config = readFileSync("vite.vps.config.ts", "utf8");
  assert.doesNotMatch(config, /hosting\.json|sites-vite-plugin|@cloudflare/);
  assert.match(readFileSync("scripts/build-vps.mjs", "utf8"), /configFile: "vite\.vps\.config\.ts"/);
  assert.match(readFileSync("vite.config.ts", "utf8"), /if \(nodeTarget\) return \(await import\("\.\/vite\.vps\.config"\)\)\.default/);
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, "vite.vps.config.ts");
  assert.ok(loaded);
  assert.equal(loaded.dependencies.some(path => /hosting\.json|sites-vite-plugin/.test(path)), false);
  assert.equal(loaded.config.define?.["process.env.CONTROL_ROOM_BUILD_TARGET"], '"vps-node"');
});
