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
import { killTargetIdentity, processIdentity, readCgroupMemory, recordChildExit } from "../scripts/ci/test-process-diagnostics.mjs";

const today = new Date("2026-09-28T12:00:00.000Z");
const valid = { test: "tests/example.test.mjs::flaky path", issue: "#123", added: "2026-09-14", owner: "test maintainer" };

function diagnosticEvents(output) {
  // TAP comment output escapes literal backslashes; Linux's direct wrapper fd
  // output has neither the comment prefix nor that extra escaping.
  return output.split("\n").map(line => line.startsWith("# ") ? line.slice(2).replaceAll("\\\\", "\\") : line)
    .filter(line => line.startsWith("[ci-test-diagnostic] "))
    .map(line => JSON.parse(line.slice("[ci-test-diagnostic] ".length)));
}

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
  for (const childStatus of [0, 7, null]) for (const ci of ["true", "false"]) for (const file of [
    "tests/codex-canonical-result-publication.test.ts",
    "tests/improve-control-room-loop-bridge.test.ts", "tests/sample.test.mjs",
  ]) {
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
      return { status: childStatus, signal: childStatus === null ? "SIGKILL" : null };
    }, { ...process.env, GITHUB_ACTIONS: ci });
    assert.equal(status, childStatus ?? 1, "diagnostics retain the real test verdict");
  }
});

test("survivor post-mortems resolve Linux cgroups and compare OOM counters without affecting verdicts", () => {
  let killed = false;
  const reads = [];
  const readKernel = path => {
    reads.push(path);
    const files = {
      "/proc/self/cgroup": "0::/job/step",
      "/sys/fs/cgroup/job/step/memory.current": killed ? "512" : "1024",
      "/sys/fs/cgroup/job/step/memory.max": "2048",
      "/sys/fs/cgroup/job/step/memory.peak": "2048",
      "/sys/fs/cgroup/job/step/memory.events": `low 0\nhigh 0\nmax 3\noom 1\noom_kill ${killed ? 1 : 0}\noom_group_kill 0`,
      "/sys/fs/cgroup/job/step/memory.events.local": `oom_kill ${killed ? 1 : 0}`,
    };
    return files[path] ?? null;
  };
  const before = readCgroupMemory(readKernel, "linux");
  killed = true;
  const events = [];
  const result = { pid: 42, status: null, signal: "SIGKILL" };
  recordChildExit(result, before, () => readCgroupMemory(readKernel, "linux"), (event, fields) => events.push({ event, ...fields }));
  assert.equal(events[0].event, "child-exit");
  assert.equal(events[0].childPid, 42);
  assert.equal(events[0].code, null);
  assert.equal(events[0].signal, "SIGKILL");
  assert.equal(events[0].cgroupMemoryAfter.peak, "2048");
  assert.equal(events[0].cgroupMemoryEventDelta.oom_kill, 1);
  assert.deepEqual(result, { pid: 42, status: null, signal: "SIGKILL" });
  assert.ok(reads.every(path => path === "/proc/self/cgroup" || path.startsWith("/sys/fs/cgroup/job/step/memory.")));
  assert.equal(readCgroupMemory(() => { throw new Error("unavailable"); }, "linux"), null);
  assert.equal(readCgroupMemory(() => assert.fail("non-Linux must not read proc"), "darwin"), null);
  assert.doesNotThrow(() => recordChildExit(result, before, () => { throw new Error("read failure"); }));
  assert.doesNotThrow(() => recordChildExit(result, before, () => null, () => { throw new Error("write failure"); }));

  const v1 = readCgroupMemory(path => ({
    "/proc/self/cgroup": "5:cpu,cpuacct:/other\n4:memory:/job",
    "/sys/fs/cgroup/memory/job/memory.failcnt": "4",
    "/sys/fs/cgroup/memory/job/memory.oom_control": "oom_kill_disable 0\nunder_oom 0\noom_kill 2",
  })[path] ?? null, "linux");
  assert.equal(v1.version, 1);
  assert.equal(v1.failcnt, "4");
  assert.match(v1.oomControl, /oom_kill 2/u);
});

test("post-mortem diagnostics preserve the original spawn error", () => {
  const error = Object.assign(new Error("synthetic spawn failure"), { code: "ENOENT" });
  for (const ci of ["true", "false"]) {
    assert.throws(() => runGate(["--test", "tests/codex-canonical-result-publication.test.ts"], [],
      () => ({ error, pid: 0, status: null, signal: null }), { ...process.env, GITHUB_ACTIONS: ci }),
    caught => caught === error);
  }
});

test("kill evidence distinguishes process targets, detached groups and the caller's group", () => {
  const stats = new Map([
    [10, "10 (runner with ) parentheses) S 2 10 10 0"],
    [20, "20 (owned child) S 10 20 20 0"],
    [21, "21 (owned grandchild) S 20 20 20 0"],
    [30, "30 (same group child) S 10 10 10 0"],
  ]);
  const identify = pid => processIdentity(pid, path => stats.get(Number(path.split("/")[2])) ?? null);
  const self = identify(10);
  assert.deepEqual(self, { pid: 10, ppid: 2, pgid: 10, session: 10 });
  assert.deepEqual(killTargetIdentity(-20, self, identify), {
    kind: "process-group", pgid: 20, leader: identify(20), sameProcessGroup: false,
  });
  assert.equal(killTargetIdentity(-10, self, identify).sameProcessGroup, true);
  assert.equal(killTargetIdentity(0, self, identify).sameProcessGroup, true);
  assert.equal(killTargetIdentity(21, self, identify).process.ppid, 20);
  assert.equal(killTargetIdentity(30, self, identify).sameProcessGroup, true);
  assert.equal(killTargetIdentity(999, self, identify).sameProcessGroup, null);
  assert.equal(killTargetIdentity(0, null, identify).pgid, null);
  assert.deepEqual(killTargetIdentity(-1, self, identify), { kind: "broadcast" });
});

test("the surviving wrapper records a real signal death and retains its existing failure exit", () => {
  const runner = new URL("../scripts/run-tests-with-quarantine.mjs", import.meta.url).href;
  const driver = `
    import { runGate } from ${JSON.stringify(runner)};
    process.exitCode = runGate(["-e", 'process.kill(process.pid, "SIGKILL")',
      "tests/codex-canonical-result-publication.test.ts"], []);
  `;
  const { NODE_TEST_CONTEXT: _context, CONTROL_ROOM_CI_TEST_DIAGNOSTICS_PID: _owner, ...env } = process.env;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    env: { ...env, GITHUB_ACTIONS: "true" }, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.signal, null, "the wrapper survives its owned child's signal death");
  const events = diagnosticEvents(result.stdout + result.stderr);
  const post = events.find(event => event.event === "child-exit");
  assert.ok(post, result.stderr);
  assert.equal(post.signal, "SIGKILL");
  assert.equal(post.code, null);
  assert.ok(post.childPid > 0);
  assert.ok("cgroupMemoryAfter" in post);
  assert.ok(!events.some(event => event.event === "process-exit" && event.pid === post.childPid), "signal death cannot emit a normal exit event");
});

test("importing post-mortem helpers cannot activate the preload through an inherited owner variable", () => {
  const helper = new URL("../scripts/ci/test-process-diagnostics.mjs", import.meta.url).href;
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const driver = `
    const original = process.kill;
    await import(${JSON.stringify(helper)});
    if (process.kill !== original) process.exitCode = 9;
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    env: { ...env, CONTROL_ROOM_CI_TEST_DIAGNOSTICS_PID: String(process.pid) }, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /\[ci-test-diagnostic\]/u);
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
    test('owned signal witness "quoted" \\u005c path', async () => {
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
  const events = diagnosticEvents(result.stdout + result.stderr);
  assert.ok(events.some(event => event.event === "test-start" && event.name === 'owned signal witness "quoted" \\ path'));
  assert.ok(events.some(event => event.event === "process.kill" && event.target < -1 && event.signal === "SIGTERM"));
  assert.ok(events.some(event => event.event === "child.kill" && event.target > 1 && event.signal === "SIGTERM"));
  if (process.platform === "linux") {
    const group = events.find(event => event.event === "process.kill" && event.target < -1);
    assert.equal(group.targetIdentity.pgid, -group.target);
    assert.equal(group.targetIdentity.leader.pgid, -group.target);
    assert.equal(group.targetIdentity.sameProcessGroup, false);
    const direct = events.find(event => event.event === "child.kill" && event.target > 1);
    assert.equal(direct.targetIdentity.process.pid, direct.target);
    assert.equal(direct.targetIdentity.process.ppid, direct.pid);
  }
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
