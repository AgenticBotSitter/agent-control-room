import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import ts from "typescript";
import { loadConfigFromFile } from "vite";
import { selectBuildTarget } from "../src/config/build-target.ts";

test("shared action-boundary labels retain readable wrapping rules at mobile breakpoints", () => {
  const css = readFileSync("styles/control-room.css", "utf8");
  const labels = css.match(/\.prototype-badge, \.simulation-only\s*\{([^}]+)\}/)?.[1];
  assert.ok(labels);
  assert.match(labels, /font-size:\s*\.875rem/);
  assert.match(labels, /max-width:\s*100%/);
  assert.match(labels, /min-width:\s*0/);
  assert.match(labels, /overflow-wrap:\s*anywhere/);
  assert.match(labels, /white-space:\s*normal/);
  assert.match(css, /\.hero-section, \.section-heading\s*\{\s*flex-wrap:\s*wrap;/);
  // Source-level regression for the removed hiding rules, not a rendered CSS cascade audit.
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\.(?:simulation-only|prototype-badge)\b/.test(rule[1])) continue;
    assert.doesNotMatch(rule[2], /display:\s*none|visibility:\s*hidden|opacity:\s*0(?:\s|;|$)/);
  }
});

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
  assert.match(readFileSync("private-app/app/layout.tsx", "utf8"), /styles\/control-room\.css/);
  assert.doesNotMatch(readFileSync("private-app/app/layout.tsx", "utf8"), /app\/globals\.css/);
  const runtime = readFileSync("src/web/v1/private-process.ts", "utf8");
  assert.match(runtime, /private_app_not_configured/); assert.match(runtime, /status: 503/);
  assert.doesNotMatch(guard, /matcher:/);
});

test("standalone build selects a configuration without private hosting dependencies", async () => {
  const config = readFileSync("vite.vps.config.ts", "utf8");
  assert.doesNotMatch(config, /hosting\.json|sites-vite-plugin|@cloudflare/);
  assert.match(readFileSync("scripts/build-vps.mjs", "utf8"), /configFile: "vite\.vps\.config\.ts"/);
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, "vite.vps.config.ts");
  assert.ok(loaded);
  assert.equal(loaded.config.publicDir, false);
  assert.equal(loaded.dependencies.some(path => /hosting\.json|sites-vite-plugin/.test(path)), false);
  assert.equal(loaded.config.define?.["process.env.CONTROL_ROOM_BUILD_TARGET"], '"vps-node"');
});

test("standalone type checking covers every build entry and routes without generated preview declarations", async () => {
  const parsed = ts.getParsedCommandLineOfConfigFile("tsconfig.vps.json", {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.options.strict, true);
  assert.equal(parsed.options.noEmit, true);
  assert.equal(parsed.options.incremental, false);
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, "vite.vps.config.ts");
  assert.ok(loaded);
  const inputs = loaded.config.environments?.rsc?.build?.rollupOptions?.input;
  assert.ok(inputs && typeof inputs === "object" && !Array.isArray(inputs));
  const roots = new Set(parsed.fileNames.map(file => path.relative(process.cwd(), file)));
  for (const entry of Object.values(inputs)) assert.ok(roots.has(entry), `Missing build entry: ${entry}`);
  for (const route of ts.sys.readDirectory("private-app", [".ts", ".tsx"])) {
    assert.ok(roots.has(route), `Missing framework route: ${route}`);
  }
  assert.ok(roots.has("middleware.ts"));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const sources = new Set(program.getSourceFiles().map(file => path.relative(process.cwd(), file.fileName)));
  assert.ok(sources.has("app/components/project-catalog.tsx"));
  assert.ok(sources.has("src/web/v1/private-process.ts"));
  assert.equal(sources.has("next-env.d.ts"), false);
  assert.equal(sources.has("app/page.tsx"), false);
  assert.equal(sources.has("vite.config.ts"), false);
  assert.equal([...sources].some(file => file.startsWith(".next/")), false);
});
