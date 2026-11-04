import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assertMutationLaneCoverage, findUncoveredTests, reachableTests, workflowCommands } from "../scripts/check-test-lane-coverage.mjs";

function realLaneInputs() {
  const load = createRequire(import.meta.resolve("eslint"))("js-yaml").load;
  return {
    scripts: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts,
    jobs: load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")).jobs,
  };
}

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

test("the CLI exits non-zero and names a test file no workflow command reaches", () => {
  const root = mkdtempSync(join(tmpdir(), "control-room-lane-coverage-cli-"));
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    mkdirSync(join(root, "tests"));
    copyFileSync(new URL("../package.json", import.meta.url), join(root, "package.json"));
    copyFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), join(root, ".github/workflows/ci.yml"));
    writeFileSync(join(root, "tests/orphan-lane-coverage-fixture.test.mjs"), "");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/check-test-lane-coverage.mjs", import.meta.url))],
      { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /tests\/orphan-lane-coverage-fixture\.test\.mjs/u);
  } finally { rmSync(root, { recursive: true }); }
});

test("a block command ends at the next step, so it cannot absorb a sibling's text", () => {
  assert.deepEqual(workflowCommands([
    "steps:",
    "  - run: |",
    "      pnpm run test:one",
    "  - name: Not a command",
    "    env:",
    "      NOTE: node --test tests/fake.test.mjs",
  ].join("\n")), ["pnpm run test:one"]);
});

test("a mutation lane job marked continue-on-error is refused", () => {
  const { scripts, jobs } = realLaneInputs();
  assertMutationLaneCoverage(scripts, jobs);
  jobs["mutation-checks-candidate"]["continue-on-error"] = true;
  assert.throws(() => assertMutationLaneCoverage(scripts, jobs));
});
