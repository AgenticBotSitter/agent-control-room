import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertMutationLaneCoverage, findUncoveredTests, reachableTests, workflowCommands } from "../scripts/check-test-lane-coverage.mjs";

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

// Independent measured budget contract: saved CI exhausted 550s, whereas the
// R13 local full run took 283.2s. Reserve 900s for the parent, 60s for runner
// cleanup, another 60s for the CI step, and setup headroom in the job.
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const yaml = createRequire(import.meta.resolve("eslint"))("js-yaml");
const workflow = yaml.load(readFileSync(".github/workflows/ci.yml", "utf8")).jobs;
const bridge = readFileSync("tests/improve-control-room-loop-bridge-mutations.test.ts", "utf8");
const bridgeLane = "test:improve-control-room-loop-bridge-mutations";

test("bridge mutation lane retains its measured parent, runner, step and job budgets", () => {
  assertMutationLaneCoverage(scripts, workflow, bridge);
  assert.match(scripts[bridgeLane], /--test-timeout=960000(?: |$)/u);
  assert.equal(workflow["mutation-checks-lineage"]["timeout-minutes"], 50);
  assert.equal(workflow["mutation-checks-lineage"].steps.find(step => step.run === `pnpm run ${bridgeLane}`)["timeout-minutes"], 17);
});

test("bridge lane guard rejects a stale, missing or commented parent timeout", () => {
  for (const replacement of ["timeout:550000", "timeout:600000", "timeout:1800000", "timeout:900000,timeout:550000", "/* timeout:900000 */", "concurrency:2"]) {
    const altered = bridge.replace(/timeout:\s*\d+/u, replacement);
    assert.notEqual(altered, bridge, "the independent parent-timeout mutation must apply");
    assert.throws(() => assertMutationLaneCoverage(scripts, workflow, altered), { name: "AssertionError" }, replacement);
  }
});

test("bridge lane guard rejects reduced, missing, widened or overriding runner timeouts", () => {
  for (const replacement of ["--test-timeout=600000", "", "--test-timeout=1800000", "--test-timeout=960000 --test-timeout=550000"]) {
    const altered = { ...scripts, [bridgeLane]: scripts[bridgeLane].replace(/--test-timeout=\d+/u, replacement) };
    assert.throws(() => assertMutationLaneCoverage(altered, workflow, bridge), { name: "AssertionError" }, replacement);
  }
});

test("bridge lane guard rejects insufficient workflow step and job headroom", () => {
  for (const target of ["step", "job"]) {
    const altered = structuredClone(workflow);
    const job = altered["mutation-checks-lineage"];
    if (target === "step") job.steps.find(step => step.run === `pnpm run ${bridgeLane}`)["timeout-minutes"] = 10;
    else job["timeout-minutes"] = 45;
    assert.throws(() => assertMutationLaneCoverage(scripts, altered, bridge), { name: "AssertionError" }, target);
  }
});
