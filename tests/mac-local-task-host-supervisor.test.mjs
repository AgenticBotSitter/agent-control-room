import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { monitorActiveTaskHost } from "../scripts/mac-local/start-task-host.mjs";
import { inspectMacLocalHost } from "../scripts/mac-local/status.mjs";
import { RotatingHostLog, readHostState, rotateHostLog, stoppedBecause,
  superviseTaskHost } from "../scripts/mac-local/task-host-supervisor.mjs";
import { hostCommand, recordedHostCommand, runtimePaths, taskHostCommand } from "../scripts/mac-local/stack.mjs";

const repoRoot = join(import.meta.dirname, "..");
const supervisorModule = pathToFileURL(join(repoRoot, "scripts/mac-local/task-host-supervisor.mjs")).href;
const taskHostModule = pathToFileURL(join(repoRoot, "scripts/mac-local/start-task-host.mjs")).href;

async function rootFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acr-host-supervisor-"));
  await mkdir(join(root, "runtime"), { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const pidAlive = pid => {
  try {
    const state = execFileSync("/bin/ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Boolean(state) && !state.startsWith("Z");
  }
  catch (error) {
    if (error?.code !== "EPERM") return false;
    // Sandboxed local runners can refuse ps even for a child they own. kill(0)
    // remains a real kernel PID lookup; unsandboxed CI uses the stronger ps path.
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }
};

const exactProcess = (child, command) => {
  try {
    return execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(child.pid)],
      { encoding: "utf8" }).trim() === command.join(" ");
  } catch (error) {
    if (error?.code !== "EPERM") return false;
    if (JSON.stringify(child.spawnargs) !== JSON.stringify(command)) return false;
    try { process.kill(child.pid, 0); return true; }
    catch { return false; }
  }
};

async function killProcessGroup(pid) {
  if (!pidAlive(pid)) return;
  try { process.kill(-pid, "SIGKILL"); }
  catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  await waitFor(() => !pidAlive(pid), `fixture process ${pid} survived cleanup`);
}

async function closeWithin(child, timeoutMs = 2_000) {
  let timeout;
  try {
    return await Promise.race([
      once(child, "close"),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("supervisor did not exit promptly")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timeout); }
}

async function waitFor(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address(), port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.ok(port);
  return port;
}

const portOpen = port => new Promise(resolve => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setTimeout(250);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(false));
});

function startRealSupervisor(root, args) {
  const source = `import { superviseTaskHost } from ${JSON.stringify(supervisorModule)};\n`
    + `process.exitCode = await superviseTaskHost(${JSON.stringify(root)}, { args: ${JSON.stringify(args)} });\n`;
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
}

async function runningState(root) {
  let state;
  await waitFor(async () => {
    try { state = await readHostState(runtimePaths(root).hostState); }
    catch {}
    return state?.state === "running" && pidAlive(state.pid) && pidAlive(state.childPid);
  }, "real supervisor and child did not start");
  return state;
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

test("a later owner signal cannot reclassify an earlier hangup as deliberate", async t => {
  const root = await rootFixture(t), signals = new EventEmitter(), seen = [];
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => { seen.push(signal); return true; };
  const result = superviseTaskHost(root, { spawn: () => child, signals, unrefShutdown: false,
    onStarted: () => setImmediate(() => {
      signals.emit("SIGHUP");
      signals.emit("SIGTERM");
      child.emit("close", null, "SIGHUP");
    }) });
  assert.equal(await result, 1);
  assert.deepEqual(seen, ["SIGHUP", "SIGTERM"]);
  assert.equal((await readHostState(runtimePaths(root).hostState)).reason, "signal SIGHUP");
});

test("a replacement supervisor removes only an exact stale child before spawning", async t => {
  const root = await rootFixture(t), paths = runtimePaths(root), stalePid = 4_242, signals = [];
  await writeFile(paths.hostState, `${JSON.stringify({ state: "running", pid: 4_241,
    childPid: stalePid, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  let staleAlive = true;
  const exactAlive = (pid, command) => pid === stalePid && staleAlive
    && JSON.stringify(command) === JSON.stringify(taskHostCommand(root));
  assert.equal(await superviseTaskHost(root, {
    alive: exactAlive,
    signal: (pid, signal) => { signals.push([pid, signal]); staleAlive = false; },
    spawn: () => fakeChild({ code: 0, stdout: "", stderr: "" }),
  }), 1);
  assert.deepEqual(signals, [[-stalePid, "SIGKILL"]]);
});

test("real SIGHUP requests recovery while real SIGTERM and SIGINT remain deliberate", async t => {
  for (const [signal, expectedCode, expectedReason] of [
    ["SIGHUP", 1, "signal SIGHUP"],
    ["SIGTERM", 0, "requested SIGTERM"],
    ["SIGINT", 0, "requested SIGINT"],
  ]) {
    await t.test(signal, async t => {
      const root = await rootFixture(t);
      const supervisor = startRealSupervisor(root, ["-e", "setInterval(() => {}, 1000)"]);
      const state = await runningState(root);
      t.after(async () => {
        if (pidAlive(supervisor.pid)) supervisor.kill("SIGKILL");
        await killProcessGroup(state.childPid);
      });
      supervisor.kill(signal);
      const [code, exitSignal] = await closeWithin(supervisor);
      assert.equal(exitSignal, null);
      assert.equal(code, expectedCode);
      await waitFor(() => !pidAlive(state.childPid), `child survived ${signal}`);
      const stopped = await readHostState(runtimePaths(root).hostState);
      assert.deepEqual({ state: stopped.state, reason: stopped.reason }, { state: "stopped", reason: expectedReason });
      if (signal === "SIGHUP")
        assert.doesNotMatch(await readFile(runtimePaths(root).hostLog, "utf8"), /requested SIGHUP/u);
    });
  }
});

test("a hard-killed supervisor cannot orphan its port-holding child and restart can bind", async t => {
  const root = await rootFixture(t), port = await unusedPort();
  const childSource = `import { createServer } from "node:net";\n`
    + `import { monitorActiveTaskHost } from ${JSON.stringify(taskHostModule)};\n`
    + `const server = createServer(socket => { socket.on("error", () => {}); socket.end("ok"); });\n`
    + `await new Promise((resolve, reject) => { server.once("error", reject); server.listen(${port}, "127.0.0.1", resolve); });\n`
    + `monitorActiveTaskHost({ close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }, process, globalThis, process.stdin);\n`;
  const args = ["--input-type=module", "-e", childSource];
  const processes = new Set(), childPids = new Set();
  t.after(async () => {
    for (const child of processes) if (pidAlive(child.pid)) child.kill("SIGKILL");
    for (const pid of childPids) await killProcessGroup(pid);
  });

  const first = startRealSupervisor(root, args);
  processes.add(first);
  const state = await runningState(root);
  childPids.add(state.childPid);
  await waitFor(() => portOpen(port), "first supervised child did not bind its port");
  first.kill("SIGKILL");
  assert.deepEqual(await closeWithin(first), [null, "SIGKILL"]);
  await waitFor(() => !pidAlive(state.childPid), "child survived its supervisor's SIGKILL");
  await waitFor(async () => !await portOpen(port), "orphan kept the port open");

  const status = await inspectMacLocalHost(root, port, {
    serviceInstalled: async () => false,
    alive: pid => pidAlive(pid),
  });
  assert.equal(status.status, "dead");
  assert.equal(status.reason, "host stopped because its supervisor disappeared without recording an exit");

  const restarted = startRealSupervisor(root, args);
  processes.add(restarted);
  childPids.add((await runningState(root)).childPid);
  await waitFor(() => portOpen(port), "replacement child could not bind the released port");
  restarted.kill("SIGTERM");
  assert.deepEqual(await closeWithin(restarted), [0, null]);
  await waitFor(async () => !await portOpen(port), "replacement child did not release the port");
});

test("child-side escalation survives supervisor death during a hung shutdown", async t => {
  const root = await rootFixture(t), port = await unusedPort();
  const childSource = `import { createServer } from "node:net";\n`
    + `import { monitorActiveTaskHost } from ${JSON.stringify(taskHostModule)};\n`
    + `const server = createServer(socket => { socket.on("error", () => {}); socket.end("ok"); });\n`
    + `await new Promise((resolve, reject) => { server.once("error", reject); server.listen(${port}, "127.0.0.1", resolve); });\n`
    + `const timers = { setTimeout: (callback) => setTimeout(callback, 1000), clearTimeout };\n`
    + `monitorActiveTaskHost({ close: () => new Promise(() => {}) }, process, timers, process.stdin);\n`
    + `console.log("fixture hung shutdown ready");\n`;
  const supervisor = startRealSupervisor(root, ["--input-type=module", "-e", childSource]);
  const state = await runningState(root);
  t.after(async () => {
    if (pidAlive(supervisor.pid)) supervisor.kill("SIGKILL");
    await killProcessGroup(state.childPid);
  });
  await waitFor(() => portOpen(port), "hung-shutdown child did not bind its port");
  await waitFor(async () => (await readFile(runtimePaths(root).hostLog, "utf8")).includes("fixture hung shutdown ready"),
    "hung-shutdown child did not install its signal handler");
  supervisor.kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.doesNotThrow(() => process.kill(state.childPid, 0), "fixture must still be in its hung graceful close");
  supervisor.kill("SIGKILL");
  assert.deepEqual(await closeWithin(supervisor), [null, "SIGKILL"]);
  await waitFor(() => !pidAlive(state.childPid), "child-side escalation died with the supervisor");
  await waitFor(async () => !await portOpen(port), "hung child kept the port after supervisor death");
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

test("mac:status recognizes a serving legacy host with no supervisor state", async t => {
  const root = await rootFixture(t), paths = runtimePaths(root), port = await unusedPort();
  const bootstrap = `import { createServer } from "node:net";\n`
    + `const server = createServer(socket => socket.end("ok"));\n`
    + `server.listen(${port}, "127.0.0.1");\n`;
  const [command, ...args] = taskHostCommand(root);
  const legacy = spawn(command, args, {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, NODE_OPTIONS: `--import=${`data:text/javascript,${encodeURIComponent(bootstrap)}`}` },
  });
  t.after(() => killProcessGroup(legacy.pid));
  await writeFile(paths.hostPid, `${legacy.pid}\n`, { mode: 0o600 });
  await waitFor(() => portOpen(port), "legacy host fixture did not bind its port");

  const status = await inspectMacLocalHost(root, port, {
    serviceInstalled: async () => false,
    alive: (pid, expected) => pid === legacy.pid && exactProcess(legacy, expected),
  });
  assert.equal(status.status, "running");
  assert.equal(status.pid, legacy.pid);
  assert.equal(status.reason, undefined);
});

test("upgrade selection recognizes only the current supervisor or exact legacy host", () => {
  const root = "/protected/root", pid = 55;
  const same = expected => (_pid, command) => JSON.stringify(command) === JSON.stringify(expected);
  assert.deepEqual(recordedHostCommand(pid, root, same(hostCommand(root))), hostCommand(root));
  assert.deepEqual(recordedHostCommand(pid, root, same(taskHostCommand(root))), taskHostCommand(root));
  assert.equal(recordedHostCommand(pid, root, () => false), undefined);
});
