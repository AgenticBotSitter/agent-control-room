import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { monitorActiveTaskHost } from "../scripts/mac-local/start-task-host.mjs";
import { inspectMacLocalHost } from "../scripts/mac-local/status.mjs";
import { RotatingHostLog, readHostState, rotateHostLog, stoppedBecause,
  superviseTaskHost } from "../scripts/mac-local/task-host-supervisor.mjs";
import { hostCommand, recordedHostCommand, runtimePaths, taskHostCommand } from "../scripts/mac-local/stack.mjs";

async function rootFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acr-host-supervisor-"));
  await mkdir(join(root, "runtime"), { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fakeChild({ code = 1, signal = null, stdout = "stdout line\n", stderr = "stderr line\n" } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const once = child.once.bind(child);
  let scheduled = false;
  child.once = (event, listener) => {
    const result = once(event, listener);
    if (event === "close" && !scheduled) {
      scheduled = true;
      setImmediate(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", code, signal);
      });
    }
    return result;
  };
  return child;
}

test("the supervisor captures both streams, records exit code, and leaves private bounded state", async t => {
  const root = await rootFixture(t), paths = runtimePaths(root);
  await writeFile(paths.hostState, `${JSON.stringify({ state: "running", pid: 999,
    childPid: 1_000, at: "2026-09-27T00:00:00.000Z" })}\n`, { mode: 0o600 });
  const code = await superviseTaskHost(root, { spawn: () => fakeChild({ code: 17 }), maxLogBytes: 1_024, backups: 2 });
  assert.equal(code, 1);
  const log = await readFile(paths.hostLog, "utf8");
  assert.match(log, /stdout line/u);
  assert.match(log, /stderr line/u);
  assert.match(log, /host stopped because supervisor disappeared without recording an exit/u);
  assert.match(log, /host stopped because exit code 17/u);
  assert.deepEqual(await readHostState(paths.hostState).then(value => ({ state: value.state, reason: value.reason })),
    { state: "stopped", reason: "exit code 17" });
  assert.equal((await stat(paths.hostLog)).mode & 0o777, 0o600);
  await assert.rejects(readFile(paths.hostPid, "utf8"), error => error.code === "ENOENT");
});

test("a signalled child and an unexpected clean exit both request service recovery", async t => {
  const signalled = await rootFixture(t);
  assert.equal(await superviseTaskHost(signalled, { spawn: () => fakeChild({ code: null, signal: "SIGABRT" }) }), 1);
  assert.match(await readFile(runtimePaths(signalled).hostLog, "utf8"), /host stopped because signal SIGABRT/u);
  const clean = await rootFixture(t);
  assert.equal(await superviseTaskHost(clean, { spawn: () => fakeChild({ code: 0, stdout: "", stderr: "" }) }), 1);
  assert.equal(stoppedBecause(0, null), "exit code 0");
});

test("a requested stop is forwarded, bounded, and recorded as deliberate", async t => {
  const root = await rootFixture(t), paths = runtimePaths(root), signals = new EventEmitter(), seen = [];
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => {
    seen.push(signal);
    if (signal === "SIGKILL") setImmediate(() => child.emit("close", null, "SIGKILL"));
    return true;
  };
  const result = superviseTaskHost(root, { spawn: () => child, signals, shutdownMs: 5, unrefShutdown: false,
    onStarted: () => setImmediate(() => signals.emit("SIGTERM")) });
  assert.equal(await result, 0);
  assert.deepEqual(seen, ["SIGTERM", "SIGKILL"]);
  assert.match(await readFile(paths.hostLog, "utf8"), /host stopped because requested SIGTERM/u);
});

test("a stop arriving before spawn is retained and forwarded without orphaning the child", async t => {
  const root = await rootFixture(t), signals = new EventEmitter(), seen = [];
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => {
    seen.push(signal);
    setImmediate(() => child.emit("close", 0, null));
    return true;
  };
  assert.equal(await superviseTaskHost(root, { signals, beforeSpawn: () => signals.emit("SIGTERM"),
    spawn: () => child, unrefShutdown: false }), 0);
  assert.deepEqual(seen, ["SIGTERM"]);
});

test("the task host marks an unhandled rejection failed before asynchronous cleanup", async () => {
  const runtime = new EventEmitter(), output = [], exits = [];
  runtime.stderr = { write: value => output.push(value) };
  runtime.exit = code => exits.push(code);
  let finishClose;
  const active = { close: () => new Promise(resolve => { finishClose = resolve; }) };
  const scheduled = [], cleared = [];
  const timers = {
    setTimeout: callback => { const token = { callback }; scheduled.push(token); return token; },
    clearTimeout: token => cleared.push(token),
  };
  monitorActiveTaskHost(active, runtime, timers);
  runtime.emit("unhandledRejection", new Error("fixture handler rejection"));
  assert.equal(runtime.exitCode, 1, "failure status must be synchronous");
  assert.equal(scheduled.length, 1, "the referenced watchdog remains armed during cleanup");
  assert.match(output.join(""), /host stopped because unhandled rejection/u);
  finishClose();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [1]);
  assert.deepEqual(cleared, scheduled);
});

test("real uncaught exceptions and unhandled rejections reach the rotating crash log", async t => {
  for (const [name, source] of [
    ["uncaught", "throw new Error('fixture uncaught')"],
    ["rejection", "Promise.reject(new Error('fixture rejection'))"],
  ]) {
    await t.test(name, async t => {
      const root = await rootFixture(t), paths = runtimePaths(root);
      assert.equal(await superviseTaskHost(root, { args: ["--unhandled-rejections=strict", "-e", source] }), 1);
      const log = await readFile(paths.hostLog, "utf8");
      assert.match(log, new RegExp(`fixture ${name}`, "u"));
      assert.match(log, /host stopped because exit code 1/u);
    });
  }
});

test("the rotating writer bounds a long-running stream and retains three private generations", async t => {
  const root = await rootFixture(t), path = runtimePaths(root).hostLog;
  const log = await RotatingHostLog.open(path, 32, 3);
  await log.write("a".repeat(20));
  await log.write("b".repeat(40));
  await log.write("c".repeat(50));
  await log.close();
  for (const candidate of [path, `${path}.1`, `${path}.2`, `${path}.3`]) {
    const entry = await stat(candidate);
    assert.ok(entry.size <= 32, `${candidate} must be bounded`);
    assert.equal(entry.mode & 0o777, 0o600);
  }
});

test("rotation refuses a symlink and a loose existing log", async t => {
  const root = await rootFixture(t), path = runtimePaths(root).hostLog, target = join(root, "target");
  await writeFile(target, "unchanged");
  await symlink(target, path);
  await assert.rejects(rotateHostLog(path, 1, 2), /host_log_invalid/u);
  assert.equal(await readFile(target, "utf8"), "unchanged");
  await rm(path);
  await writeFile(path, "loose", { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(rotateHostLog(path, 1, 2), /host_log_invalid/u);
});

test("mac:status distinguishes serving, unhealthy, and dead/restarting hosts", async () => {
  const root = "/protected/root";
  const base = {
    serviceInstalled: async () => true,
    serviceStatus: async () => ({ installed: true, loaded: true, pid: 55, enabled: true, definition: "current", state: "running" }),
    readPid: async () => 44,
    alive: () => true,
    readHostState: async () => ({ state: "running", pid: 55, childPid: 66,
      at: new Date().toISOString(), lastStop: { reason: "exit code 9" } }),
  };
  assert.equal((await inspectMacLocalHost(root, 3210, { ...base, portOpen: async () => true })).status, "running");
  const unhealthy = await inspectMacLocalHost(root, 3210, { ...base, portOpen: async () => false });
  assert.equal(unhealthy.status, "unhealthy");
  assert.match(unhealthy.reason, /running but not serving/u);
  const missingChild = await inspectMacLocalHost(root, 3210, { ...base,
    alive: pid => pid !== 66, portOpen: async () => true });
  assert.equal(missingChild.status, "unhealthy");
  assert.match(missingChild.reason, /supervisor is running but its task host is not/u);
  const dead = await inspectMacLocalHost(root, 3210, { ...base, alive: () => false, portOpen: async () => false });
  assert.equal(dead.status, "dead/restarting");
  assert.equal(dead.reason, "host stopped because its supervisor disappeared without recording an exit");
});

test("upgrade selection recognizes only the current supervisor or exact legacy host", () => {
  const root = "/protected/root", pid = 55;
  const same = expected => (_pid, command) => JSON.stringify(command) === JSON.stringify(expected);
  assert.deepEqual(recordedHostCommand(pid, root, same(hostCommand(root))), hostCommand(root));
  assert.deepEqual(recordedHostCommand(pid, root, same(taskHostCommand(root))), taskHostCommand(root));
  assert.equal(recordedHostCommand(pid, root, () => false), undefined);
});
