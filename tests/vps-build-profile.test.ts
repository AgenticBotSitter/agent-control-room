import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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
  const config = readFileSync("vite.config.ts", "utf8");
  assert.match(config, /dist-vps\/server/); assert.match(config, /dist-vps\/client/);
  const guard = readFileSync("middleware.ts", "utf8");
  assert.match(guard, /private_app_not_configured/); assert.match(guard, /status: 503/);
  assert.doesNotMatch(guard, /matcher:/);
  assert.deepEqual(JSON.parse(readFileSync(".openai/hosting.json", "utf8")), { d1: null, r2: null });
});
