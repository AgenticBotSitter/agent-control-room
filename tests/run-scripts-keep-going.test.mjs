import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { expandScripts, parseArguments, runUnits } from "../scripts/ci/run-scripts-keep-going.mjs";
import { reachableTests, workflowCommands } from "../scripts/check-test-lane-coverage.mjs";

const runner = fileURLToPath(new URL("../scripts/ci/run-scripts-keep-going.mjs", import.meta.url));
const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("expansion preserves ordered units and duplicate invocations, while leaf prerequisites stay intact", () => {
  const source = { suite: "pnpm a && pnpm run nested && pnpm a", nested: "pnpm b && pnpm c",
    a: "node a.mjs", b: "node build.mjs && node b.mjs", c: "node c.mjs" };
  assert.deepEqual(expandScripts(source, ["suite"], true), ["a", "b", "c", "a"]);
  assert.deepEqual(expandScripts(source, ["suite"]), ["suite"]);
  assert.deepEqual(expandScripts(source, ["b"], true), ["b"]);
});

test("invalid inputs, missing scripts, cycles and unsupported parallelism fail before running units", () => {
  for (const args of [[], ["--unknown"], ["a;echo"], ["--jobs"], ["--jobs", "2", "a"]])
    assert.throws(() => parseArguments(args));
  assert.deepEqual(parseArguments(["--", "--jobs", "1", "--expand", "suite"]), { names: ["suite"], expand: true });
  assert.throws(() => expandScripts({}, ["missing"], true), /Unknown/u);
  assert.throws(() => expandScripts({ "a;echo": "node a" }, ["a;echo"], true), /Unknown/u);
  assert.throws(() => expandScripts({ a: "pnpm b", b: "pnpm a" }, ["a"], true), /Cyclic/u);
  assert.throws(() => expandScripts({ a: "pnpm missing && pnpm b", b: "node b" }, ["a"], true), /Unknown/u);
});

test("all units run after failures and spawn errors; summaries and GitHub groups stay balanced", () => {
  const calls = [], logs = [];
  const status = runUnits(["fail", "spawn-error", "pass"], name => {
    calls.push(name);
    if (name === "spawn-error") throw Object.assign(new Error(), { code: "ENOENT" });
    return { status: name === "fail" ? 7 : 0 };
  }, message => logs.push(message), true);
  assert.equal(status, 7);
  assert.deepEqual(calls, ["fail", "spawn-error", "pass"]);
  assert.equal(logs.filter(line => line.startsWith("::group::")).length, 3);
  assert.equal(logs.filter(line => line === "::endgroup::").length, 3);
  assert.match(logs.join("\n"), /fail \| FAIL \| \d+\.\d{3}/u);
  assert.match(logs.join("\n"), /spawn-error \| FAIL/u);
  assert.match(logs.join("\n"), /pass \| PASS/u);
  assert.match(logs.at(-1), /Completed 3 unit\(s\); 2 failed/u);
});

test("a burst of fifty serial units reaches the last unit, and a retry can succeed", () => {
  const names = Array.from({ length: 50 }, (_, index) => `unit-${index}`), calls = [];
  assert.equal(runUnits(names, name => { calls.push(name); return { status: name === "unit-20" ? 1 : 0 }; }, () => {}, false), 1);
  assert.deepEqual(calls, names);
  assert.equal(runUnits(names, () => ({ status: 0 }), () => {}, false), 0);
});

test("null and missing statuses fail closed even when later units pass", () => {
  for (const failure of [{ status: null }, {}]) {
    const calls = [], logs = [];
    assert.equal(runUnits(["failed", "passed"], name => {
      calls.push(name);
      return name === "failed" ? failure : { status: 0 };
    }, message => logs.push(message), true), 1);
    assert.deepEqual(calls, ["failed", "passed"]);
    assert.ok(logs.includes("::error::failed FAILED (status 1)"));
    assert.match(logs.at(-1), /Completed 2 unit\(s\); 1 failed/u);
  }
});

test("a raw signal-killed unit fails closed and the next unit still runs", () => {
  const child = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], { timeout: 5_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, "SIGKILL");
  assert.equal(child.status, null);
  const calls = [];
  const status = runUnits(["killed", "passed"], name => {
    calls.push(name);
    return name === "passed" ? { status: 0 } : child;
  }, () => {}, false);
  assert.equal(status, 1);
  assert.deepEqual(calls, ["killed", "passed"]);
});

test("failure annotations appear outside groups before the next unit begins", () => {
  const logs = [];
  let beforeNextUnit;
  assert.equal(runUnits(["failed", "passed"], name => {
    if (name === "passed") beforeNextUnit = [...logs];
    return { status: name === "failed" ? 4 : 0 };
  }, message => logs.push(message), true), 4);
  assert.deepEqual(beforeNextUnit, [
    "::group::failed", "::endgroup::", "::error::failed FAILED (status 4)", "::group::passed",
  ]);
  assert.equal(logs.filter(line => line.startsWith("::error::")).length, 1);
  const localLogs = [];
  assert.equal(runUnits(["failed"], () => ({ status: 4 }), message => localLogs.push(message), false), 4);
  assert.ok(localLogs.every(line => !line.startsWith("::")));
});

test("a real CLI temp-package run continues after a deliberate failure and exits nonzero at the end", () => {
  const root = mkdtempSync(join(tmpdir(), "acr-ci-keep-going-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    suite: "pnpm first && pnpm broken && pnpm last",
    first: "node -e \"console.log('FIRST-RAN')\"",
    broken: "node -e \"console.log('FAILURE-RAN'); process.exit(3)\"",
    last: "node -e \"console.log('LAST-RAN')\"",
    interrupted: "node -e \"process.kill(process.pid, 'SIGTERM')\"",
  } }));
  const env = { ...process.env, GITHUB_ACTIONS: "true", COREPACK_ENABLE_NETWORK: "0" };
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(process.execPath, [runner, "--jobs", "1", "--expand", "suite"],
      { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /FIRST-RAN[\s\S]*FAILURE-RAN[\s\S]*LAST-RAN/u);
    assert.match(result.stdout, /first \| PASS[\s\S]*broken \| FAIL[\s\S]*last \| PASS/u);
    assert.match(result.stdout, /Completed 3 unit\(s\); 1 failed/u);
    assert.equal(result.stdout.split("::endgroup::").length - 1, 3);
    const retry = spawnSync(process.execPath, [runner, "first", "last"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(retry.status, 0, retry.stderr);
    const interrupted = spawnSync(process.execPath, [runner, "interrupted", "last"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(interrupted.status, 0);
    assert.match(interrupted.stdout, /interrupted \| FAIL[\s\S]*last \| PASS/u);
    const bad = spawnSync(process.execPath, [runner, "first", "missing"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(bad.status, 0);
    assert.doesNotMatch(bad.stdout, /FIRST-RAN/u);
    const unavailable = spawnSync(process.execPath, [runner, "first", "last"], {
      cwd: root, env: { ...env, PATH: root }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(unavailable.status, 1);
    assert.match(unavailable.stdout, /first \| FAIL[\s\S]*last \| FAIL/u);
    assert.match(unavailable.stderr, /ENOENT/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two concurrent callers run their entire independent plans", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "acr-ci-concurrent-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    good: "node -e \"console.log('GOOD-RAN')\"", bad: "node -e \"process.exit(1)\"",
  } }));
  const children = [];
  const run = () => new Promise((resolve, reject) => {
    const env = { ...process.env, COREPACK_ENABLE_NETWORK: "0" };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [runner, "bad", "good"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    child.stdin.end();
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", status => resolve({ status, output }));
  });
  try {
    const results = await Promise.all([run(), run()]);
    for (const result of results) {
      assert.equal(result.status, 1);
      assert.match(result.output, /bad \| FAIL[\s\S]*good \| PASS/u);
      assert.match(result.output, /GOOD-RAN/u);
    }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("the component and catch-up replacements expand to exactly the legacy ordered unit lists and test sets", () => {
  const replacements = [
    [["test:components", "test:mac-upgrade"], true],
    [["test:components", "test:attack-kit"], true],
    [["test:demo", "test:build:demo"], false],
    [["test"], false],
    [["test:updater", "test:updater-schema", "test:updater-passkey-postgres", "test:pg-runtime-postgres"], false],
    [["test:build:articles"], false],
  ];
  for (const [names, expand] of replacements) {
    // Independently expand the pre-change component chain, whose package script
    // remains available unchanged for local callers.
    const legacyUnits = names.flatMap(name => name === "test:components"
      ? scripts[name].split(" && ").map(part => part.replace(/^pnpm (?:run )?/u, "")) : [name]);
    const units = expandScripts(scripts, names, expand);
    assert.deepEqual(units, legacyUnits);
    const legacy = names.map(name => `pnpm run ${name}`);
    assert.deepEqual([...reachableTests(scripts, units.map(name => `pnpm run ${name}`))].sort(),
      [...reachableTests(scripts, legacy)].sort());
    const invocation = `node scripts/ci/run-scripts-keep-going.mjs ${expand ? "--expand " : ""}${names.join(" ")}`;
    assert.ok(workflowCommands(workflow).some(command => command.includes(invocation)), invocation);
  }
});

test("every independent component check and catch-up connector check still runs after a previous failure", () => {
  const components = workflow.slice(workflow.indexOf("  test-components:"), workflow.indexOf("  test-updater:"));
  const steps = components.split("      - name: ").slice(1).filter(step => /\n        run: (?:pnpm run test:|node )/u.test(step));
  assert.ok(steps.length >= 9);
  for (const step of steps) assert.match(step, /if: \$\{\{ !cancelled\(\) \}\}/u);
  const catchUp = workflow.slice(workflow.indexOf("      - name: Component lanes (merge gate)"), workflow.indexOf("      - name: Updater lane (merge gate)"));
  assert.match(catchUp, /run-scripts-keep-going\.mjs --expand test:components test:attack-kit \|\| status=\$\?/u);
  assert.match(catchUp, /resource-bound-local-start-contract-v2\.test\.ts \|\| status=\$\?/u);
  assert.match(catchUp, /exit "\$\{status\}"/u);
  assert.doesNotMatch(components, /continue-on-error:/u);
  assert.doesNotMatch(catchUp, /continue-on-error:/u);
});
