import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateQuarantine } from "../scripts/check-test-quarantine.mjs";
import { runtimeAssemblyMemoryGuardArgs } from "../scripts/run-runtime-assembly-memory-guard.mjs";
import { runGate } from "../scripts/run-tests-with-quarantine.mjs";

const today = new Date("2026-09-28T12:00:00.000Z");
const valid = { test: "tests/example.test.mjs::flaky path", issue: "#123", added: "2026-09-14", owner: "test maintainer" };

test("expired and issue-less quarantine entries fail validation", () => {
  assert.match(validateQuarantine([{ ...valid, added: "2026-09-13" }], today).join("\n"), /15 days old/);
  assert.match(validateQuarantine([{ ...valid, issue: "" }], today).join("\n"), /GitHub issue/);
  assert.deepEqual(validateQuarantine([valid], today), []);
  assert.match(validateQuarantine([{ ...valid, test: "tests/browser/example.spec.ts::journey" }], today).join("\n"), /Node tests/);
});

test("quarantined failures leave the gate green while ordinary failures fail it", async t => {
  const root = await mkdtemp(join(tmpdir(), "test-quarantine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests", "sample.test.mjs"), `
    import test from "node:test";
    import assert from "node:assert/strict";
    test("known flaky", () => assert.fail("quarantined failure"));
    test("ordinary", () => assert.ok(true));
  `);
  const runner = fileURLToPath(new URL("../scripts/run-tests-with-quarantine.mjs", import.meta.url));
  const quarantine = [{ test: "tests/sample.test.mjs::known flaky", issue: "#123", added: new Date().toISOString().slice(0, 10), owner: "test maintainer" }];
  await writeFile(join(root, "tests", "quarantine.json"), JSON.stringify(quarantine));
  const gate = spawnSync(process.execPath, [runner, "--test", "tests/sample.test.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(gate.status, 0, gate.stderr);

  quarantine[0].test = "tests/sample.test.mjs::ordinary";
  await writeFile(join(root, "tests", "quarantine.json"), JSON.stringify(quarantine));
  const failed = spawnSync(process.execPath, [runner, "--test", "tests/sample.test.mjs"], { cwd: root, encoding: "utf8" });
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /quarantined failure/);
});

test("the runtime-assembly memory guard preserves its limits through the quarantine runner", () => {
  const args = runtimeAssemblyMemoryGuardArgs("/repository");
  assert.deepEqual(args, [
    "/repository/scripts/run-tests-with-quarantine.mjs",
    "--max-old-space-size=2048",
    "--import",
    "tsx",
    "--test",
    "tests/private-local-installation-runtime-assembly.test.ts",
  ]);
});

test("runner shutdown diagnostics preserve CI arguments and verdicts only in the affected lanes", () => {
  const previous = process.env.GITHUB_ACTIONS;
  try {
    for (const ci of ["true", "false"]) for (const file of [
      "tests/codex-canonical-result-publication.test.ts",
      "tests/improve-control-room-loop-bridge.test.ts", "tests/sample.test.mjs",
    ]) {
      process.env.GITHUB_ACTIONS = ci;
      const args = ["--import", "tsx", "--test", "--test-concurrency=1", file];
      const diagnostic = ci === "true" && file !== "tests/sample.test.mjs";
      const status = runGate(args, [], (command, actual, options) => {
        assert.equal(command, process.execPath);
        assert.deepEqual(actual.slice(diagnostic ? 2 : 0), args);
        if (diagnostic) {
          assert.equal(actual[0], "--import");
          assert.match(actual[1], /\/ci\/test-process-diagnostics\.mjs$/u);
          assert.equal(options.env.CONTROL_ROOM_CI_TEST_DIAGNOSTICS_PID, String(process.pid));
        }
        assert.equal(options.env.NODE_TEST_CONTEXT, undefined);
        assert.equal(options.stdio, "inherit");
        return { status: 7 };
      });
      assert.equal(status, 7, "diagnostics retain the real test verdict");
    }
  } finally {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  }
});

test("shutdown diagnostics observe exact child and group signals without changing their targets", async t => {
  const root = await mkdtemp(join(tmpdir(), "ci-test-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "signal.test.mjs");
  await writeFile(file, `
    import assert from "node:assert/strict";
    import test from "node:test";
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    test("owned signal witness", async () => {
      const children = [];
      const launch = async () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
          { detached: true, stdio: "ignore" });
        const closed = once(child, "close");
        children.push({ child, closed });
        await once(child, "spawn");
        return { child, closed };
      };
      try {
        const canary = await launch();
        const group = await launch();
        process.kill(-group.child.pid, "SIGTERM");
        assert.equal((await group.closed)[1], "SIGTERM");
        assert.equal(process.kill(canary.child.pid, 0), true);
        const direct = await launch();
        direct.child.kill("SIGTERM");
        assert.equal((await direct.closed)[1], "SIGTERM");
        assert.equal(process.kill(canary.child.pid, 0), true);
      } finally {
        for (const { child, closed } of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          await closed;
        }
      }
    });
    test("diagnostic failure witness", () => assert.fail("preserved failure"));
  `);
  const helper = new URL("../scripts/ci/test-process-diagnostics.mjs", import.meta.url).href;
  const driver = `
    import { spawnSync } from "node:child_process";
    process.env.CONTROL_ROOM_CI_TEST_DIAGNOSTICS_PID = String(process.pid);
    const result = spawnSync(process.execPath, ["--import", ${JSON.stringify(helper)},
      "--test", ${JSON.stringify(file)}], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
  `;
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", driver], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /preserved failure/u);
  // Linux writes straight to the wrapper; other platforms use TAP's stderr
  // forwarding, which prefixes captured diagnostic lines with '# '.
  const events = (result.stdout + result.stderr).split("\n").map(line => line.replace(/^# /u, ""))
    .filter(line => line.startsWith("[ci-test-diagnostic] "))
    .map(line => JSON.parse(line.slice("[ci-test-diagnostic] ".length)));
  assert.ok(events.some(event => event.event === "test-start" && event.name === "owned signal witness"));
  assert.ok(events.some(event => event.event === "process.kill" && event.target < -1 && event.signal === "SIGTERM"));
  assert.ok(events.some(event => event.event === "child.kill" && event.target > 1 && event.signal === "SIGTERM"));
  assert.ok(events.some(event => event.event === "process-start" && event.memory.rss > 0));
  assert.ok(events.some(event => event.event === "process-exit"));
});

test("CI reports quarantine failures without adding them to the merge gate", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const job = workflow.match(/  quarantined-tests:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]+:|$)/)?.[1] ?? "";
  const gate = workflow.match(/  merge-gate:\n([\s\S]*)$/)?.[1] ?? "";
  assert.match(job, /continue-on-error: true/);
  assert.match(job, /pnpm run test:quarantined/);
  assert.doesNotMatch(gate.match(/needs: \[([^\]]+)\]/)?.[1] ?? "", /quarantined-tests/);
});
