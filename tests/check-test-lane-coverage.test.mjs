import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findUncoveredTests, reachableTests, workflowCommands } from "../scripts/check-test-lane-coverage.mjs";

function fixture({ scripts, workflow, tests }) {
  const root = mkdtempSync(join(tmpdir(), "control-room-lane-coverage-"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (const file of tests) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(root, ".github/workflows/ci.yml"), workflow);
  return root;
}

test("an unused package script cannot disguise an uncovered test", () => {
  const root = fixture({
    scripts: { "test:live": "node --test tests/live.test.ts", "test:unused": "node --test tests/orphan.test.ts" },
    workflow: "steps:\n  - run: pnpm run test:live\n",
    tests: ["tests/live.test.ts", "tests/orphan.test.ts"],
  });
  try { assert.deepEqual(findUncoveredTests(root), ["tests/orphan.test.ts"]); }
  finally { rmSync(root, { recursive: true }); }
});

test("nested tests are discovered and workflow-reachable script chains are followed", () => {
  const root = fixture({
    scripts: { test: "pnpm test:nested", "test:nested": "node --test tests/nested/covered.test.mjs" },
    workflow: "steps:\n  - run: |\n      pnpm run test\n",
    tests: ["tests/nested/covered.test.mjs", "tests/nested/orphan.test.mjs"],
  });
  try { assert.deepEqual(findUncoveredTests(root), ["tests/nested/orphan.test.mjs"]); }
  finally { rmSync(root, { recursive: true }); }
});

test("look-alike filenames do not count as exact test arguments", () => {
  const reached = reachableTests({}, ["node --test tests/case.test.tsx"]);
  assert.equal(reached.has("tests/case.test.tsx"), true);
  assert.equal(reached.has("tests/case.test.ts"), false);
});

test("keep-going runner names reach their package chains without covering unused scripts", () => {
  const scripts = { suite: "pnpm a && pnpm b", a: "node --test tests/a.test.mjs",
    b: "node --test tests/b.test.mjs", unused: "node --test tests/unused.test.mjs" };
  assert.deepEqual([...reachableTests(scripts,
    ["node scripts/ci/run-scripts-keep-going.mjs --jobs 1 --expand suite"])].sort(),
    ["tests/a.test.mjs", "tests/b.test.mjs"]);
  for (const flags of ["--jobs 2", "--unknown"]) {
    assert.deepEqual([...reachableTests(scripts,
      [`node scripts/ci/run-scripts-keep-going.mjs ${flags} suite`])], []);
  }
});

test("quoted and block workflow commands are extracted", () => {
  assert.deepEqual(workflowCommands([
    "steps:",
    "  - run: pnpm install --frozen-lockfile",
    "  - run: 'pnpm run test:one'",
    "  - run: |",
    "      pnpm run test:two",
    "      node --test tests/direct.test.js",
  ].join("\n")), ["pnpm install --frozen-lockfile", "pnpm run test:one", "pnpm run test:two\nnode --test tests/direct.test.js"]);
});

// This is the real transitive relative-import graph: the lane guard imports the
// serial runner and both import the shared direct-entry guard. No package copy.
function preinstallGraph(t) {
  const root = mkdtempSync(join(tmpdir(), "control-room-preinstall-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["scripts/check-test-lane-coverage.mjs", "scripts/ci/run-scripts-keep-going.mjs",
    "src/installer/shared/is-main-module.mjs"]) {
    const target = join(root, file);
    mkdirSync(join(target, ".."), { recursive: true });
    const original = fileURLToPath(new URL("../" + file, import.meta.url));
    copyFileSync(original, target);
    assert.deepEqual(readFileSync(target), readFileSync(original), "copy the real module bytes including every import");
  }
  writeFileSync(join(root, "deny-loader.mjs"), `
    import { isBuiltin } from "node:module";
    const deny = id => { throw new Error("PREINSTALL_DEPENDENCY_DENIED: " + id); };
    export async function resolve(id, context, next) {
      if (!isBuiltin(id) && !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("file:")) deny(id);
      const result = await next(id, context);
      if (result.url.includes("/node_modules/")) deny(result.url);
      return result;
    }
    export function load(url, context, next) {
      if ((!url.startsWith("node:") && !url.startsWith("file:")) || url.includes("/node_modules/")) deny(url);
      return next(url, context);
    }
  `);
  // ESM loaders do not intercept createRequire. Deny both CJS resolution and
  // loading before Node can consult any provisioned ancestor node_modules.
  writeFileSync(join(root, "deny-cjs.cjs"), `
    const Module = require("node:module");
    const check = id => {
      if ((!Module.isBuiltin(id) && !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("file:"))
        || id.includes("/node_modules/")) throw new Error("PREINSTALL_DEPENDENCY_DENIED: " + id);
    };
    for (const key of ["_resolveFilename", "_load"]) {
      const original = Module[key];
      Module[key] = function(id, ...args) { check(id); return original.call(this, id, ...args); };
    }
  `);
  return {
    root,
    run(code) {
      const entry = join(root, "import-probe.mjs");
      writeFileSync(entry, code);
      return spawnSync(process.execPath, ["--no-warnings", "--experimental-loader",
        pathToFileURL(join(root, "deny-loader.mjs")).href, "--require", join(root, "deny-cjs.cjs"), entry], {
        cwd: root, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL",
        env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
      });
    },
  };
}

test("preinstall lane helper imports without dependencies", t => {
  const graph = preinstallGraph(t);
  mkdirSync(join(graph.root, "fixture/tests/nested"), { recursive: true });
  writeFileSync(join(graph.root, "fixture/tests/nested/unit.test.mjs"), "");
  const child = graph.run(String.raw`
    import assert from "node:assert/strict";
    const helpers = await import("./scripts/check-test-lane-coverage.mjs");
    const commands = helpers.workflowCommands("steps:\n  - run: pnpm run test:unit\n");
    assert.deepEqual(commands, ["pnpm run test:unit"]);
    assert.deepEqual([...helpers.reachableTests({ "test:unit": "pnpm run test:nested",
      "test:nested": "node --test tests/nested/unit.test.mjs" }, commands)], ["tests/nested/unit.test.mjs"]);
    assert.deepEqual(helpers.listTestFiles("fixture"), ["tests/nested/unit.test.mjs"]);
    assert.equal(process.exitCode ?? 0, 0, "import must not execute direct-entry CLI work");
    console.log("RESULT preinstall helpers imported and executed without dependencies");
  `);
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, "preinstall helper import must succeed; " + child.stderr);
  assert.equal(child.stderr, "", "import must not emit direct-entry diagnostics");
  assert.equal(child.stdout.trim(), "RESULT preinstall helpers imported and executed without dependencies",
    "import must not run either module's CLI");
});

for (const name of ["typescript", "eslint", "js-yaml"]) {
  for (const mode of ["ESM import", "ESM resolution", "CJS require", "CJS resolution"]) {
    test(`preinstall lane helper dependency denial positive control ${name} ${mode}`, t => {
      const graph = preinstallGraph(t);
      const request = JSON.stringify(name);
      const code = mode === "ESM import" ? `await import(${request});`
        : mode === "ESM resolution" ? `import.meta.resolve(${request});`
        : `import { createRequire } from "node:module"; const require = createRequire(import.meta.url); `
          + (mode === "CJS require" ? `require(${request});` : `require.resolve(${request});`);
      const child = graph.run(code);
      assert.ifError(child.error);
      assert.equal(child.signal, null);
      assert.equal(child.status, 1, "optional package request must be refused");
      assert.ok(child.stderr.includes("PREINSTALL_DEPENDENCY_DENIED: " + name), child.stderr);
      assert.equal(child.stdout, "");
    });
  }
}
