import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertMutationLaneCoverage, findUncoveredTests, reachableTests, workflowCommands,
} from "../scripts/check-test-lane-coverage.mjs";

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

// Load-lane contract: each load lane keeps its enable flag, exact selection and module.
const actualScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const actualWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const loadLanes = [
  { name: "test:improve-control-room-loop-monitoring-load", flag: "CONTROL_ROOM_B3B_LOAD",
    pattern: '--test-name-pattern="^B3b product collector contention$"',
    module: "tests/improve-control-room-loop-monitoring.test.tsx" },
  { name: "test:improve-control-room-loop-finalization-load", flag: "CONTROL_ROOM_B3C_LOAD",
    pattern: '--test-name-pattern="^B3c 24 finalizers retain once and refuse destruction$"',
    module: "tests/improve-control-room-loop-finalization.test.tsx" },
];

function mutated(name, change) {
  const scripts = structuredClone(actualScripts), before = scripts[name];
  scripts[name] = change(before);
  assert.notEqual(scripts[name], before, `${name}: mutation must change the command`);
  return scripts;
}

function replaced(search, replacement) {
  return command => {
    assert.ok(command.includes(search), `fixture expects ${search}`);
    return command.replace(search, replacement);
  };
}

test("the current load-lane package commands and workflow satisfy the mutation lane contract", () => {
  assert.doesNotThrow(() => assertMutationLaneCoverage(structuredClone(actualScripts), actualWorkflow));
});

for (const lane of loadLanes) {
  const other = loadLanes.find(candidate => candidate !== lane);
  const mutations = {
    "missing enable flag": replaced(`${lane.flag}=1 `, ""),
    "renamed enable flag": replaced(`${lane.flag}=1`, `${lane.flag}_RENAMED=1`),
    "enable flag value 0": replaced(`${lane.flag}=1`, `${lane.flag}=0`),
    "missing name pattern": replaced(` ${lane.pattern}`, ""),
    "unanchored name pattern": replaced(lane.pattern, lane.pattern.replace("^", "").replace("$", "")),
    "wrong name pattern": replaced(lane.pattern, other.pattern),
    "missing agent CLI block flag": replaced("CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 ", ""),
    "wrong test module": replaced(lane.module, other.module),
    "echo instead of invocation": command => `echo ${command}`,
    "swallowed exit": command => `${command} || true`,
    "flag only in an unrelated variable value": replaced(`${lane.flag}=1`, `NOTE=${lane.flag}=1`),
    "pattern only inside a comment": command => `${command.replace(` ${lane.pattern}`, "")} # ${lane.pattern}`,
    "parallel execution": replaced("--test-concurrency=1", "--test-concurrency=4"),
    "changed process timeout": replaced("--test-timeout=600000", "--test-timeout=60000"),
  };
  for (const [label, change] of Object.entries(mutations)) {
    test(`${lane.name}: ${label} is rejected`, () => {
      assert.throws(() => assertMutationLaneCoverage(mutated(lane.name, change), actualWorkflow),
        error => error instanceof assert.AssertionError && error.message.includes(lane.name));
    });
  }
  test(`${lane.name}: cannot borrow the other load lane's valid command`, () => {
    const scripts = structuredClone(actualScripts);
    scripts[lane.name] = actualScripts[other.name];
    assert.throws(() => assertMutationLaneCoverage(scripts, actualWorkflow),
      error => error instanceof assert.AssertionError && error.message.includes(lane.name));
  });
}

test("swapped load-lane commands are rejected even though each command is individually valid", () => {
  const scripts = structuredClone(actualScripts);
  [scripts[loadLanes[0].name], scripts[loadLanes[1].name]] = [scripts[loadLanes[1].name], scripts[loadLanes[0].name]];
  assert.throws(() => assertMutationLaneCoverage(scripts, actualWorkflow), assert.AssertionError);
});
