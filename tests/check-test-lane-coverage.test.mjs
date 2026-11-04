import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

// Mutation-lane self-checks are verified through real child exits. Never print
// the child environment; only bounded output is attached to failures.
const laneFlags = ["CONTROL_ROOM_B3B_LOAD", "CONTROL_ROOM_B3C_LOAD", "CONTROL_ROOM_B3C_REQUIRE_A2", "CONTROL_ROOM_B3C_REQUIRE_DESTRUCTIVE"];
function runLaneChild(args, extra = {}, timeout = 120000) {
  const env = { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", ...extra };
  delete env.NODE_TEST_CONTEXT;
  for (const flag of laneFlags) if (!(flag in extra)) delete env[flag];
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.error, undefined, "lane child must not fail to spawn or time out");
  assert.equal(result.signal, null, "lane child must exit normally, not by signal");
  return { status: result.status, output, tail: output.slice(-4000) };
}
function assertSelectionRefused(run, diagnostic) {
  assert.equal(run.status, 1, `lane child must exit 1, got ${run.status}\n${run.tail}`);
  assert.match(run.output, diagnostic, run.tail);
  assert.doesNotMatch(run.output, /Mutation lane: selected=/u, run.tail);
  assert.doesNotMatch(run.output, /timed out|cancelled [1-9]/iu, run.tail);
}

for (const [file, flag, parent] of [
  ["tests/improve-control-room-loop-monitoring.test.tsx", "CONTROL_ROOM_B3B_LOAD", "B3b product collector contention"],
  ["tests/improve-control-room-loop-finalization.test.tsx", "CONTROL_ROOM_B3C_LOAD", "B3c 24 finalizers retain once and refuse destruction"],
]) test(`${file} load lane refuses its name pattern without ${flag}`, () => {
  const run = runLaneChild(["scripts/run-tests-with-quarantine.mjs", "--import", "tsx", "--test", "--test-concurrency=1",
    "--test-timeout=600000", `--test-name-pattern=^${parent}$`, file], {}, 300000);
  assertSelectionRefused(run, /mutation lane selected without its enabling flag/u);
});

const fixtureFile = "tests/fixtures/mutation-lane-selfcheck/lane.ts";
function runFixture(lanes, pattern) {
  return runLaneChild(["--import", "tsx", "--test", ...(pattern === undefined ? [] : [`--test-name-pattern=${pattern}`]), fixtureFile],
    { MUTATION_LANE_FIXTURE: JSON.stringify({ lanes }) });
}
const parent = (name, probes = 2, expectedProbes = probes) => ({ name, probes, expectedProbes });
const lane = (parents, { enabled = true, expectedParents = parents.length } = {}) => ({ expectedParents, enabled, parents });

test("mutation lane fixture runs its selected enabled parent and reports its probes", () => {
  const run = runFixture([lane([parent("lane alpha")]), lane([parent("lane beta")])], "^lane alpha$");
  assert.equal(run.status, 0, run.tail);
  assert.match(run.output, /Mutation lane: selected=2\/2 parent=lane alpha/u, run.tail);
  assert.doesNotMatch(run.output, /parent=lane beta/u, run.tail);
});

test("mutation lane fixture keeps ordinary unpatterned and ordinary patterned runs green while disabled", () => {
  for (const pattern of [undefined, "^fixture ordinary test$"]) {
    const run = runFixture([lane([parent("lane alpha")], { enabled: false })], pattern);
    assert.equal(run.status, 0, run.tail);
    assert.match(run.output, /# pass 1/u, run.tail);
    assert.doesNotMatch(run.output, /Mutation lane: selected=/u, run.tail);
  }
});

test("mutation lane fixture refuses a pattern that selects a disabled lane", () => {
  assertSelectionRefused(runFixture([lane([parent("lane alpha")], { enabled: false })], "^lane alpha$"),
    /mutation lane selected without its enabling flag/u);
});

test("mutation lane fixture refuses renamed, partial, over-selected and drifted lanes", () => {
  assertSelectionRefused(runFixture([lane([parent("lane alpha renamed")])], "^lane alpha$"),
    /mutation lane must select exactly one registered lane/u);
  assertSelectionRefused(runFixture([lane([parent("lane alpha one"), parent("lane beta two")])], "^lane alpha"),
    /mutation lane must select every expected parent/u);
  assertSelectionRefused(runFixture([lane([parent("lane alpha")]), lane([parent("lane alpha too")])], "^lane alpha"),
    /mutation lane must select exactly one registered lane/u);
  assertSelectionRefused(runFixture([lane([parent("lane alpha")], { expectedParents: 2 })], "^lane alpha$"),
    /mutation lane registers every expected parent/u);
  assertSelectionRefused(runFixture([lane([parent("lane alpha"), parent("lane alpha")])], "^lane alpha$"),
    /mutation lane parent names are unique/u);
  for (const enabled of [true, false]) assertSelectionRefused(runFixture([lane([parent("lane alpha")], { enabled, expectedParents: 2 })]),
    /mutation lane registers every expected parent/u);
});

test("mutation lane fixture fails when executed probes drift from the expected count", () => {
  const run = runFixture([lane([parent("lane alpha", 1, 2)])], "^lane alpha$");
  assert.equal(run.status, 1, run.tail);
  assert.match(run.output, /lane alpha: executed expected probe count/u, run.tail);
  assert.doesNotMatch(run.output, /Mutation lane: selected=/u, run.tail);
});
