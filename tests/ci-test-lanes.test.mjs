import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createTestLanePlan, runTestLane } from "../scripts/run-ci-test-lane.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const prefix = "node --import tsx --test ";
const command = files => prefix + files.join(" ");
const main = ["tests/zeta.test.ts", "tests/alpha.test.tsx", "tests/echo.test.mjs", "tests/bravo.test.ts",
  "tests/yankee.test.ts", "tests/charlie.test.ts", "tests/delta.test.ts", "tests/foxtrot.test.ts", "tests/xray.test.ts"];
const scripts = () => ({ pretest: command(["tests/pre-two.test.ts", "tests/pre-one.test.mjs"]),
  test: command(main), posttest: command(["tests/post.test.tsx"]) });
const inventory = value => [value.pretest, value.test, value.posttest].flatMap(script => script.slice(prefix.length).split(" "));
function syntheticTree(t, value = scripts()) {
  const directory = mkdtempSync(join(tmpdir(), "control-room-ci-lanes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of inventory(value)) {
    const path = join(directory, file); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "// Synthetic runner input; not executed by the injected process capability.\n");
  }
  return directory;
}
async function rejectedLane(input) {
  let failed = false;
  try { failed = (await runTestLane(input)) !== 0; } catch { failed = true; }
  assert.equal(failed, true, "invalid lane must not report success");
}

test("canonical CI lanes exactly partition the default lifecycle and include the four missing CR14C tests", () => {
  const configured = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  const plan = createTestLanePlan(configured), all = Object.values(plan).flat(), expected = inventory(configured);
  assert.deepEqual(Object.keys(plan).sort(), ["main-1", "main-2", "main-3", "main-4", "post", "pre"]);
  assert.deepEqual([...all].sort(), [...expected].sort()); assert.equal(new Set(all).size, all.length);
  for (const file of all) assert.equal(statSync(join(root, file)).isFile(), true, file);
  for (const file of ["tests/web-owner-verification.test.ts", "tests/web-owner-verification-browser.test.tsx",
    "tests/document-structure-verifier.test.ts", "tests/native-quality-completion.test.ts"])
    assert.equal(configured.test.slice(prefix.length).split(" ").filter(value => value === file).length, 1, file);
});

test("main shards use deterministic sorted round-robin while pre/post preserve full lists and all outputs are frozen", () => {
  const input = scripts(), before = structuredClone(input), plan = createTestLanePlan(input), sorted = [...main].sort();
  assert.deepEqual(plan.pre, ["tests/pre-two.test.ts", "tests/pre-one.test.mjs"]);
  assert.deepEqual(plan.post, ["tests/post.test.tsx"]);
  for (let shard = 0; shard < 4; shard++) assert.deepEqual(plan[`main-${shard + 1}`], sorted.filter((_, index) => index % 4 === shard));
  assert.deepEqual(createTestLanePlan({ ...input, test: command([...main].reverse()) }), plan);
  assert.deepEqual(input, before); assert.equal(Object.isFrozen(plan), true);
  for (const files of Object.values(plan)) { assert.equal(Object.isFrozen(files), true); assert.ok(files.length > 0); }
  assert.throws(() => plan.pre.push("tests/unregistered.test.ts"));
  assert.throws(() => { plan["main-1"] = []; });
});

test("lane inventory rejects unsupported command syntax, paths, duplicate entries and empty shards", () => {
  for (const value of [null, undefined, "", "pnpm test", "node --test tests/a.test.ts", "node --import tsx --test",
    `${prefix}tests/a.test.ts && node tests/b.test.ts`, `${prefix}tests/*.test.ts`,
    `${prefix}--test-name-pattern=quality tests/a.test.ts`, `${prefix}'tests/a.test.ts'`,
    `${prefix}tests/a.test.ts;echo`, `${prefix}$TEST_FILE`, `${prefix}tests/a.test.ts\nnode evil.mjs`])
    assert.throws(() => createTestLanePlan({ ...scripts(), pretest: value }), String(value));
  for (const path of ["../tests/escape.test.ts", "/tmp/escape.test.ts", "tests/../escape.test.ts", "tests\\escape.test.ts",
    "src/a.test.ts", "tests/helper.ts", "tests/a.test.ts/child", "tests/a.test.ts?query", "tests/$(echo).test.ts"])
    assert.throws(() => createTestLanePlan({ ...scripts(), pretest: command([path]) }), path);
  assert.throws(() => createTestLanePlan({ ...scripts(), pretest: command(["tests/pre.test.ts", "tests/pre.test.ts"]) }));
  assert.throws(() => createTestLanePlan({ ...scripts(), posttest: command([main[0]]) }));
  assert.throws(() => createTestLanePlan({ ...scripts(), test: command(main.slice(0, 3)) }));
  assert.throws(() => createTestLanePlan({ ...scripts(), test: command([]) }));
});

test("selected lane runs exact current-node arguments with one file at a time and inherited process context", async t => {
  const configured = scripts(), directory = syntheticTree(t, configured), calls = [];
  const code = await runTestLane({ scripts: configured, lane: "main-2", root: directory,
    spawn: (...args) => { calls.push(args); return { status: 0, signal: null }; } });
  assert.equal(code, 0); assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
  assert.equal(executable, process.execPath);
  assert.deepEqual(args, ["--import", "tsx", "--test", "--test-concurrency=1", ...createTestLanePlan(configured)["main-2"]]);
  assert.equal(options.cwd, realpathSync(directory)); assert.equal(options.stdio, "inherit");
  assert.ok(options.env === undefined || options.env === process.env);
  assert.ok(options.shell === undefined || options.shell === false);
});

test("unknown lane and any missing/non-file inventory input prevent child launch", async t => {
  const configured = scripts(), directory = syntheticTree(t, configured); let launches = 0;
  const spawn = () => { launches++; return { status: 0 }; };
  for (const lane of ["main", "main-0", "main-5", "PRE", "", "pre;echo"])
    await rejectedLane({ scripts: configured, lane, root: directory, spawn });
  rmSync(join(directory, main[0]));
  await rejectedLane({ scripts: configured, lane: "pre", root: directory, spawn });
  mkdirSync(join(directory, main[0]));
  await rejectedLane({ scripts: configured, lane: "pre", root: directory, spawn });
  await rejectedLane({ scripts: { ...configured, test: command(main.slice(0, 3)) }, lane: "pre", root: directory, spawn });
  assert.equal(launches, 0);
});

test("nonzero status, missing status, termination and launch failure cannot pass or retry", async t => {
  const configured = scripts(), directory = syntheticTree(t, configured);
  for (const result of [{ status: 7, signal: null }, { status: null, signal: null }, { status: null, signal: "SIGTERM" },
    { status: 0, signal: "SIGTERM" }, { status: 0, error: new Error("synthetic launch failure") },
    { status: -1 }, { status: 256 }, { status: 1.5 }, {}]) {
    let launches = 0;
    const code = await runTestLane({ scripts: configured, lane: "pre", root: directory,
      spawn: () => { launches++; return result; } });
    assert.ok(Number.isInteger(code) && code > 0, JSON.stringify(result)); assert.equal(launches, 1);
    if (result.status === 7) assert.equal(code, 7);
  }
  let launches = 0;
  await rejectedLane({ scripts: configured, lane: "post", root: directory,
    spawn: () => { launches++; throw new Error("synthetic spawn exception"); } });
  assert.equal(launches, 1);
});

test("ordinary local Node child success and failure propagate through the injected process capability", async t => {
  const configured = scripts(), directory = syntheticTree(t, configured);
  for (const status of [0, 9]) {
    // These bounded ordinary children need no tsx resolution or fixture dependency tree.
    const code = await runTestLane({ scripts: configured, lane: "pre", root: directory,
      spawn: (_executable, _args, options) => spawnSync(process.execPath, ["-e", `process.exit(${status})`],
        { ...options, timeout: 5000 }) });
    assert.equal(code, status);
  }
});

test("importing the runner in an empty working directory is inert", t => {
  const directory = mkdtempSync(join(tmpdir(), "control-room-ci-import-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runner = new URL("../scripts/run-ci-test-lane.mjs", import.meta.url).href;
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(runner)});`],
    { cwd: directory, encoding: "utf8", timeout: 5000 });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.signal, null); assert.equal(imported.error, undefined);
  assert.equal(imported.stdout, ""); assert.equal(imported.stderr, "");
});
