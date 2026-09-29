import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { monitorActiveTaskHost } from "../scripts/mac-local/start-task-host.mjs";
import { inspectMacLocalHost } from "../scripts/mac-local/status.mjs";
import { readPreviousHostState, startAndWait } from "../scripts/mac-local/up.mjs";
import { RotatingHostLog, openHostLog, readHostState, rotateHostLog, stoppedBecause,
  superviseTaskHost } from "../scripts/mac-local/task-host-supervisor.mjs";
import { alive, hostCommand, readPid, recordedHostCommand, runtimePaths, stopRecorded,
  stopRecordedHost, taskHostCommand } from "../scripts/mac-local/stack.mjs";

const repoRoot = join(import.meta.dirname, "..");
const supervisorModule = pathToFileURL(join(repoRoot, "scripts/mac-local/task-host-supervisor.mjs")).href;
const taskHostModule = pathToFileURL(join(repoRoot, "scripts/mac-local/start-task-host.mjs")).href;
const upModule = pathToFileURL(join(repoRoot, "scripts/mac-local/up.mjs")).href;
const statusModule = join(repoRoot, "scripts/mac-local/status.mjs");

/** The accepting connection handler every fixture server shares. The "error" guard is load-bearing:
 * a readiness probe that connects and destroys its socket sends an RST on macOS, which reaches the
 * server as an unhandled "error" event and kills the fixture instead of the connection. The
 * earlier per-test copies of this line were one missed guard away from the same crash, so the
 * handler is written once here and every fixture uses it. */
const ACK_SERVER_SOURCE = `const server = createServer(socket => { socket.on("error", () => {}); socket.end("ok"); });\n`;

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

/** Runs a real child to completion and returns its exit code with everything it wrote. Used where
 * the claim is about what the owner sees on stdout and stderr, not just about an exit code. */
async function runToCompletion(child, timeoutMs = 30_000) {
  const chunks = [];
  child.stdout?.on("data", chunk => chunks.push(chunk));
  child.stderr?.on("data", chunk => chunks.push(chunk));
  const [code, signal] = await closeWithin(child, timeoutMs);
  return { code: code ?? 1, signal, output: Buffer.concat(chunks).toString("utf8") };
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
    + ACK_SERVER_SOURCE
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
    + ACK_SERVER_SOURCE
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

test("an unsafe backup never causes replacement of the private current log", async t => {
  const root = await rootFixture(t), path = runtimePaths(root).hostLog;
  await writeFile(path, "private current log\n", { mode: 0o600 });
  await writeFile(`${path}.1`, "loose backup\n", { mode: 0o644 });
  await chmod(`${path}.1`, 0o644);
  await assert.rejects(RotatingHostLog.open(path, 1, 2), /host_log_invalid/u);
  assert.equal(await readFile(path, "utf8"), "private current log\n",
    "only an unsafe current log may be replaced during recovery");
});

test("the real supervisor replaces a restored loose log instead of wedging recovery", async t => {
  for (const stateShape of ["no state", "loose state"]) {
    await t.test(stateShape, async t => {
      const root = await rootFixture(t), paths = runtimePaths(root);
      await writeFile(paths.hostLog, "restored log from backup\n", { mode: 0o644 });
      await chmod(paths.hostLog, 0o644);
      if (stateShape === "loose state") {
        await writeFile(paths.hostState, `${JSON.stringify({ state: "stopped", reason: "exit code 0",
          at: "2026-09-27T00:00:00.000Z" })}\n`, { mode: 0o644 });
        await chmod(paths.hostState, 0o644);
      }
      const supervisor = startRealSupervisor(root, ["-e", "process.exit(23)"]);
      t.after(async () => { if (pidAlive(supervisor.pid)) supervisor.kill("SIGKILL"); });
      const result = await runToCompletion(supervisor);
      assert.equal(result.code, 1);
      const log = await readFile(paths.hostLog, "utf8");
      assert.doesNotMatch(log, /restored log from backup/u, "the unsafe log must not be appended to");
      assert.match(log, /replaced unsafe existing host log with a new private log/u);
      assert.match(log, /host stopped because exit code 23/u);
      if (stateShape === "loose state") assert.match(log, /state file .* could not be read/u);
      assert.equal((await stat(paths.hostLog)).mode & 0o777, 0o600);
      assert.deepEqual(await readHostState(paths.hostState).then(state => ({ state: state.state, reason: state.reason })),
        { state: "stopped", reason: "exit code 23" });
    });
  }
});

test("the supervisor entry point reports an unopenable log on stderr and still records stopped state", async t => {
  const root = await rootFixture(t), paths = runtimePaths(root);
  await mkdir(paths.hostLog);
  const supervisor = spawn(process.execPath, [join(repoRoot, "scripts/mac-local/task-host-supervisor.mjs"),
    "--protected-root", root], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  t.after(async () => { if (pidAlive(supervisor.pid)) supervisor.kill("SIGKILL"); });
  const result = await runToCompletion(supervisor);
  assert.equal(result.code, 1);
  assert.match(result.output, /host stopped because supervisor error/u,
    "launchd's stderr path must retain the failure when the rotating log cannot open");
  assert.deepEqual(await readHostState(paths.hostState).then(state => ({ state: state.state, reason: state.reason })),
    { state: "stopped", reason: "supervisor error" });
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

test("the real mac:status reports dead rather than failing on a restored loose state file", async t => {
  const root = await rootFixture(t), paths = runtimePaths(root);
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config/mac-local.json"), `${JSON.stringify({ port: await unusedPort() })}\n`);
  await writeFile(paths.hostState, `${JSON.stringify({ state: "stopped", reason: "exit code 9",
    at: "2026-09-27T00:00:00.000Z" })}\n`, { mode: 0o644 });
  await chmod(paths.hostState, 0o644);
  const status = spawn(process.execPath, [statusModule, "--protected-root", root], {
    cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: join(root, "home") },
  });
  t.after(async () => { if (pidAlive(status.pid)) status.kill("SIGKILL"); });
  const result = await runToCompletion(status);
  assert.equal(result.code, 1);
  assert.match(result.output, /mac:status dead: host stopped because no stop reason was recorded/u);
  assert.match(result.output, /task-host-state\.json is unreadable and was ignored/u);
  assert.doesNotMatch(result.output, /mac:status FAILED|mac_local_host_state_invalid/u,
    "an unsafe diagnostic file must not turn health reporting into an internal failure");
});

test("mac:status recognizes a serving legacy host with no supervisor state", async t => {
  const root = await rootFixture(t), paths = runtimePaths(root), port = await unusedPort();
  const bootstrap = `import { createServer } from "node:net";\n`
    + ACK_SERVER_SOURCE
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

test("mac:up's start-failure path stops the process it started, removes the pid file, and reports the hint", async t => {
  // This is the path the removed import broke: a supervised host that never became ready. The
  // reference error fired before the cleanup and before the message, so the owner lost the hint
  // and the host was left running unsupervised behind a stale pid file.
  const root = await rootFixture(t), paths = runtimePaths(root);
  // A command that starts cleanly, records its own pid, and then exits without ever serving:
  // exactly the shape of a host that fails its own startup.
  const command = [process.execPath, "-e", "process.exit(1)"];
  await assert.rejects(
    startAndWait(command, paths.hostLog, paths.hostPid, async () => false, 1, "task host"),
    (error) => {
      assert.equal(error.message, "task host did not start within 1s (see runtime/task-host.log)");
      assert.doesNotMatch(error.message, /is not defined/u, "the failure must be the reported hint, not a reference error");
      return true;
    },
  );
  // The pid file is the only handle mac:down has on the process, so a failed start must not leave it.
  await assert.rejects(readFile(paths.hostPid, "utf8"), error => error.code === "ENOENT");
});

test("mac:up's start-failure path stops a process that is alive but not serving", async t => {
  // A supervisor can be alive and not yet serving (a slow database), which is precisely the case
  // that must not be left behind. The wait gives up on time, so the stop has to happen on that
  // path too, not only when the child died on its own.
  const root = await rootFixture(t), paths = runtimePaths(root);
  const source = "setInterval(() => {}, 1000);";
  const command = [process.execPath, "-e", source];
  try {
    await assert.rejects(
      startAndWait(command, paths.hostLog, paths.hostPid, async () => false, 1, "task host"),
      /task host did not start within 1s/u,
    );
  } finally { await killProcessGroup(Number((await readPid(paths.hostPid).catch(() => 0)) ?? 0)); }
  await assert.rejects(readFile(paths.hostPid, "utf8"), error => error.code === "ENOENT");
});

test("mac:up reports a successful start instead of treating a ready host as a failure", async t => {
  const root = await rootFixture(t), paths = runtimePaths(root), port = await unusedPort();
  // Single-line, because startAndWait confirms the process by exact `ps` command-line match, and
  // a multi-line -e argument does not survive that comparison intact.
  const source = `import { createServer } from "node:net"; const server = createServer(socket => { socket.on("error", () => {}); socket.end("ok"); }); server.listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000);`;
  const command = [process.execPath, "-e", source];
  const started = [];
  t.after(async () => { for (const pid of started) await killProcessGroup(pid); });
  const pid = await startAndWait(command, paths.hostLog, paths.hostPid, () => portOpen(port), 5, "task host");
  started.push(pid);
  assert.equal(await readPid(paths.hostPid), pid);
  assert.equal(await readFile(paths.hostPid, "utf8"), `${pid}\n`);
});

test("mac:up binds every stack helper its start-failure cleanup calls", async t => {
  // The regression was a call site left behind when the import was renamed. Nothing type-checks
  // .mjs here, and a dropped name can only ever be a ReferenceError, which fires before the stop
  // and before the message. This asserts the property that actually matters — every identifier
  // mac:up uses from stack.mjs is bound to an import of that module — rather than that nine
  // known names are present, so it also catches a name that was never imported at all, and it
  // survives a legitimate refactor of the call sites.
  const source = await readFile(new URL(upModule), "utf8");
  const imported = new Map(), bodies = [];
  for (const match of source.matchAll(/^import\s*\{[^}]*\}\s*from\s*"[^"]+";?/gms)) {
    for (const entry of (match[0].match(/\{([^}]*)\}/u)?.[1] ?? "").split(",").map(name => name.trim()).filter(Boolean)) {
      const bound = imported.get(entry) ?? [];
      bound.push(/\bfrom\s*"([^"]+)"/u.exec(match[0])?.[1]);
      imported.set(entry, bound);
    }
    bodies.push(match[0]);
  }
  const stackNames = Object.keys(await import(new URL("./stack.mjs", upModule)));
  // Every `stack.mjs` export that up.mjs mentions, which is the broader form of the original bug:
  // an identifier used in the file and never bound, rather than a missing one of nine known names.
  const body = source.split(bodies.join("\n")).join("\n");
  for (const name of stackNames) {
    if (!new RegExp(`(?<![\\w.$])${name}(?![\\w$])`, "u").test(body)) continue;
    assert.deepEqual(imported.get(name), ["./stack.mjs"],
      `up.mjs uses ${name} and must bind it from ./stack.mjs`);
  }
  assert.ok(stackNames.length > 0, "stack.mjs must export its helpers for the binding check to mean anything");
});

test("mac:up's whole preflight survives a host state file it cannot read", async t => {
  // The recorded stop reason only feeds a log line, so an unreadable state file — a restored
  // backup, a manual edit, any loose file in runtime/ — must not be the one thing that stops the
  // stack. The checks below it are the ones that can act, so the start continues and the owner
  // gets the reason plus how to clear it.
  for (const [name, body, mode] of [
    ["loose mode", `${JSON.stringify({ state: "stopped", reason: "exit code 0", at: "2026-09-27T00:00:00.000Z" })}\n`, 0o644],
    ["truncated json", `{"state":"stopped","reason":"exit code 0"`, 0o600],
    ["unknown state", `${JSON.stringify({ state: "paused", at: "2026-09-27T00:00:00.000Z" })}\n`, 0o600],
  ]) {
    await t.test(name, async t => {
      const root = await rootFixture(t), paths = runtimePaths(root);
      await writeFile(paths.hostState, body);
      await chmod(paths.hostState, mode);
      const output = [];
      const original = console.log;
      console.log = line => { output.push(line); };
      try { assert.equal(await readPreviousHostState(paths.hostState), undefined); }
      finally { console.log = original; }
      const logged = output.join("\n");
      assert.match(logged, /is unreadable/u);
      assert.match(logged, new RegExp(`to clear it: rm ${paths.hostState.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
        "the owner must be told what to clear");
      assert.doesNotMatch(logged, /mac:up FAILED/u);
    });
  }
  // A readable state file is still read, and an absent one is still simply absent.
  const clean = await rootFixture(t), paths = runtimePaths(clean);
  assert.equal(await readPreviousHostState(paths.hostState), undefined);
  await writeFile(paths.hostState, `${JSON.stringify({ state: "stopped", reason: "exit code 9",
    at: "2026-09-27T00:00:00.000Z" })}\n`, { mode: 0o600 });
  assert.equal((await readPreviousHostState(paths.hostState)).reason, "exit code 9");
});

test("mac:up continues past an unreadable state file to its own actionable refusal", async t => {
  // End to end through the real entry point: the remedy for the missing task runtime is the
  // owner's next action, so it is what a loose state file must produce, not an internal identifier.
  const root = await rootFixture(t), paths = runtimePaths(root);
  await writeFile(paths.hostState, `${JSON.stringify({ state: "stopped", reason: "exit code 0",
    at: "2026-09-27T00:00:00.000Z" })}\n`, { mode: 0o600 });
  await chmod(paths.hostState, 0o644);
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config/mac-local.json"), `${JSON.stringify({ port: 3210 })}\n`);
  const result = spawn(process.execPath, [join(repoRoot, "scripts/mac-local/up.mjs"), "--protected-root", root],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: join(root, "home") } });
  t.after(async () => { if (pidAlive(result.pid)) result.kill("SIGKILL"); });
  const { code, output } = await runToCompletion(result);
  assert.equal(code, 1);
  assert.match(output, /is unreadable/u, "the unreadable state file must be reported, not swallowed");
  assert.match(output, /task settings missing: run pnpm mac:prepare-task-runtime/u,
    "the actionable remedy must be the failure the owner sees");
  assert.doesNotMatch(output, /mac_local_host_state_invalid/u, "an internal identifier is not a remedy");
});

test("the task host serves even when its recorded stop reason is unreadable", async t => {
  // mac:up narrowing its own read is not sufficient on its own. mac:up launches the supervisor as a
  // separate process, and the supervisor re-reads the same file for the same log line. If only the
  // wrapper is narrowed, a loose state file moves the failure rather than removing it: mac:up
  // reports it and continues, the supervisor then dies on its own read, and the owner is left with
  // "supervisor error" after 90 seconds. Both halves have to be narrowed, so this drives the real
  // supervisor and requires the host to actually reach serving.
  const root = await rootFixture(t), paths = runtimePaths(root);
  await writeFile(paths.hostState, `${JSON.stringify({ state: "stopped", reason: "exit code 0",
    at: "2026-09-27T00:00:00.000Z" })}\n`, { mode: 0o600 });
  await chmod(paths.hostState, 0o644);
  const child = spawn(process.execPath, [join(repoRoot, "scripts/mac-local/task-host-supervisor.mjs"),
    "--protected-root", root],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: join(root, "home") } });
  t.after(async () => { if (pidAlive(child.pid)) child.kill("SIGKILL"); });
  const started = await waitFor(() => {
    if (child.exitCode !== null) return false;
    return readFileSync(paths.hostState, "utf8").includes("\"state\":\"running\"");
  }, "supervisor never reached running with an unreadable state file", 30_000)
    .then(() => true, () => false);
  const log = readFileSync(paths.hostLog, "utf8");
  assert.ok(started, `the host must serve, not die, on an unreadable state file. log:\n${log}`);
  assert.match(log, /could not be read/u, "the condition must be recorded so the owner can see it");
  assert.doesNotMatch(log, /supervisor error/u, "an unreadable stop reason is not a supervisor error");
});

test("the exact-command selector refuses a recycled or unrelated pid", async t => {
  // This selector is the authority boundary for the whole stack: it decides which PID mac:status
  // reports and which PID mac:down signals. A PID the OS recycled onto an unrelated process is
  // exactly the case it exists to refuse, so a real process with the wrong command line must not
  // be reported, claimed or signalled.
  const root = await rootFixture(t), paths = runtimePaths(root);
  const impostor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    { cwd: repoRoot, stdio: "ignore" });
  t.after(async () => { if (pidAlive(impostor.pid)) impostor.kill("SIGKILL"); await waitFor(() => !pidAlive(impostor.pid), "impostor survived cleanup"); });
  await waitFor(() => pidAlive(impostor.pid), "impostor fixture did not start");
  await writeFile(paths.hostPid, `${impostor.pid}\n`, { mode: 0o600 });
  t.after(() => rm(paths.hostPid, { force: true }));

  assert.equal(recordedHostCommand(impostor.pid, root), undefined,
    "a live pid whose command line is not this root's host must not be selected");
  assert.equal(alive(impostor.pid, hostCommand(root)), false);
  assert.equal(alive(impostor.pid, taskHostCommand(root)), false);

  // mac:status must not call it running, and must not claim it is serving either.
  const status = await inspectMacLocalHost(root, await unusedPort(), {
    serviceInstalled: async () => false,
    readHostState: async () => undefined,
    portOpen: async () => true,
  });
  assert.notEqual(status.status, "running");
  assert.equal(status.pid, undefined);

  // mac:down's selector must refuse it and send no signal at all.
  assert.equal(await stopRecordedHost(paths.hostPid, root, 1), "not_running");
  assert.ok(pidAlive(impostor.pid), "an unrelated pid must never be signalled");
  // The recorded pid file is cleared, because the refusal is "not this stack's process", not a
  // promise that some other stack's process is being stopped.
  await assert.rejects(readFile(paths.hostPid, "utf8"), error => error.code === "ENOENT");

  // The positive control: the exact command for this root is still selected, and a *different*
  // root's exact command is not.
  assert.deepEqual(recordedHostCommand(impostor.pid, root, (pid, command) => {
    assert.equal(pid, impostor.pid);
    return JSON.stringify(command) === JSON.stringify(hostCommand(root));
  }), hostCommand(root));
  assert.equal(recordedHostCommand(impostor.pid, root, (_pid, command) =>
    JSON.stringify(command) === JSON.stringify(hostCommand("/some/other/root"))), undefined);
});

test("alive is an exact command-line match, not a substring one", async t => {
  // `alive` is the primitive under every authority boundary in this stack: if it accepted a
  // command line that merely *contains* the expected command, then any process able to put our
  // command in its own argv — which a wrapper, a shell or an unrelated program can do by accident
  // or on purpose — would be treated as this root's task host and would be reported and signalled
  // as such. So a real process whose command line embeds the exact command must still be refused.
  const root = await rootFixture(t);
  const expected = hostCommand(root).join(" ");
  // The fixture's own argv carries the full expected command after a separator, so ps reports a
  // command line that contains it verbatim and is nonetheless a different program.
  const impostor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", expected],
    { cwd: repoRoot, stdio: "ignore" });
  t.after(async () => { if (pidAlive(impostor.pid)) impostor.kill("SIGKILL"); await waitFor(() => !pidAlive(impostor.pid), "impostor survived cleanup"); });
  await waitFor(() => pidAlive(impostor.pid), "impostor fixture did not start");

  const reported = execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(impostor.pid)],
    { encoding: "utf8" }).trim();
  assert.ok(reported.includes(expected),
    `the fixture must contain the expected command for this test to mean anything: ${reported}`);
  assert.notEqual(reported, expected, "the fixture must not be an exact match");
  assert.equal(alive(impostor.pid, hostCommand(root)), false, "a containing command line is not this root's host");
  assert.equal(alive(impostor.pid, taskHostCommand(root)), false);
  // The positive control, on the same real process: the command it actually runs is alive.
  assert.equal(alive(impostor.pid, [process.execPath, "-e", "setInterval(() => {}, 1000)", "--", expected]), true,
    "alive must still recognise a process by its own exact command line");
});

test("stopRecorded never signals a pid whose command line is not the recorded command", async t => {
  // The exact-alive guard is the second half of the same boundary: stopRecorded reads the command
  // from its own caller, so the only thing standing between a recycled pid and a SIGTERM is that
  // it re-checks the live command line before signalling.
  const root = await rootFixture(t), paths = runtimePaths(root);
  const impostor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    { cwd: repoRoot, stdio: "ignore" });
  t.after(async () => { if (pidAlive(impostor.pid)) impostor.kill("SIGKILL"); await waitFor(() => !pidAlive(impostor.pid), "impostor survived cleanup"); });
  await waitFor(() => pidAlive(impostor.pid), "impostor fixture did not start");
  await writeFile(paths.hostPid, `${impostor.pid}\n`, { mode: 0o600 });

  assert.equal(await stopRecorded(paths.hostPid, hostCommand(root), 1), "not_running");
  assert.ok(pidAlive(impostor.pid), "a pid that is not the recorded command must not be signalled");
  await assert.rejects(readFile(paths.hostPid, "utf8"), error => error.code === "ENOENT");
});

test("a host log and a host state file inside the protected root stay private and unfollowed", async t => {
  // These two are the privacy boundary for files inside the protected root: a symlink or a
  // world-readable file in runtime/ must not receive the host's log, and a foreign state file must
  // not steer the recorded reason. The write path creates them 0600; this proves the open and read
  // paths refuse anything that is not private, same-uid and a real file.
  const root = await rootFixture(t), paths = runtimePaths(root);
  const stateBody = `${JSON.stringify({ state: "stopped", reason: "exit code 3",
    at: "2026-09-27T00:00:00.000Z" })}\n`;
  const target = join(root, "target");
  await writeFile(target, "unchanged");

  // A symlink at either path must never be written through, and the state read must refuse it.
  for (const [name, path] of [["hostLog", paths.hostLog], ["hostState", paths.hostState]]) {
    await symlink(target, path);
    if (name === "hostLog") {
      // O_NOFOLLOW refuses at open time (ELOOP) rather than writing through to the target; the
      // assertion that matters is the refusal plus the untouched target, not the error's wording.
      assert.throws(() => openHostLog(path), `O_NOFOLLOW must refuse a symlink at ${name}`);
      await assert.rejects(rotateHostLog(path, 1, 2), /host_log_invalid/u);
    } else {
      await assert.rejects(readHostState(path), /host_state_invalid/u, "a symlinked state file must be refused");
    }
    await rm(path);
    assert.equal(await readFile(target, "utf8"), "unchanged", `${name} must not write through a symlink`);
  }

  // A world-readable file in the private runtime must be refused too, on both read paths.
  await writeFile(paths.hostLog, "loose\n", { mode: 0o644 });
  await chmod(paths.hostLog, 0o644);
  assert.throws(() => openHostLog(paths.hostLog), /host_log_invalid/u, "a loose log must be refused, not appended to");
  await assert.rejects(rotateHostLog(paths.hostLog, 1, 2), /host_log_invalid/u);
  await rm(paths.hostLog);
  await writeFile(paths.hostState, stateBody, { mode: 0o644 });
  await chmod(paths.hostState, 0o644);
  await assert.rejects(readHostState(paths.hostState), /host_state_invalid/u,
    "a world-readable state file must not steer the recorded reason");
  await rm(paths.hostState);

  // The private case still works, so the refusals above are about the file, not the path.
  await writeFile(paths.hostState, stateBody, { mode: 0o600 });
  assert.equal((await readHostState(paths.hostState)).reason, "exit code 3");
  assert.equal(typeof openHostLog(paths.hostLog), "number");
  assert.equal((await stat(paths.hostLog)).mode & 0o777, 0o600);
  // The supervisor's own write path produces exactly that private file, so a first start works.
  assert.equal(await superviseTaskHost(root, { spawn: () => fakeChild({ code: 0, stdout: "", stderr: "" }) }), 1);
  assert.equal((await stat(paths.hostState)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.hostLog)).mode & 0o777, 0o600);
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
  assert.equal(staleAlive, false, "the stale child must be gone before the replacement spawns");
});

test("a replacement supervisor never signals a recorded child pid that is not the exact task host", async t => {
  // stopStaleChild kills a recorded child only while that pid is *still* this root's exact task
  // host — the orphan the replacement must clear so it can bind. A recorded childPid that is
  // alive but under some other command is a pid the OS has recycled, and the exact-command check
  // is the only thing standing between that and a SIGKILL to an unrelated process group. The
  // existing stale-child test pins the kill side, so removing the check outright still satisfies
  // it; only the refusal side proves the guard exists.
  const root = await rootFixture(t), paths = runtimePaths(root), recycledPid = 4_242, signals = [];
  await writeFile(paths.hostState, `${JSON.stringify({ state: "running", pid: 4_241,
    childPid: recycledPid, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  // The recorded supervisor is gone. The recorded childPid is alive, but never as this root's
  // task host: it has been recycled onto an unrelated process.
  const code = await superviseTaskHost(root, {
    alive: (pid, command) => pid === recycledPid
      && JSON.stringify(command) !== JSON.stringify(taskHostCommand(root)),
    signal: (pid, signal) => signals.push([pid, signal]),
    spawn: () => fakeChild({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(code, 1, "the replacement still runs and requests recovery for its own child exit");
  assert.deepEqual(signals, [], "a recycled child pid must never be signalled");
});

test("a replacement supervisor refuses to clean up beside a live exact supervisor", async t => {
  // The first half of the same guard: if the recorded supervisor is still the exact supervisor for
  // this root, its child is already supervised and there is nothing to clean up. Without this the
  // replacement would kill a perfectly healthy supervised child.
  const root = await rootFixture(t), paths = runtimePaths(root), livePid = 4_242, signals = [];
  await writeFile(paths.hostState, `${JSON.stringify({ state: "running", pid: 4_241,
    childPid: livePid, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  // The old supervisor is alive; its child is an unrelated (already recycled) pid.
  const exactAlive = (pid, command) => pid === 4_241
    && JSON.stringify(command) === JSON.stringify(hostCommand(root));
  const code = await superviseTaskHost(root, {
    alive: exactAlive,
    signal: (pid, signal) => signals.push([pid, signal]),
    spawn: () => fakeChild({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(code, 1);
  assert.deepEqual(signals, [], "a live exact supervisor means there is no orphan to clean up");
});

test("upgrade selection recognizes only the current supervisor or exact legacy host", () => {
  const root = "/protected/root", pid = 55;
  const same = expected => (_pid, command) => JSON.stringify(command) === JSON.stringify(expected);
  assert.deepEqual(recordedHostCommand(pid, root, same(hostCommand(root))), hostCommand(root));
  assert.deepEqual(recordedHostCommand(pid, root, same(taskHostCommand(root))), taskHostCommand(root));
  assert.equal(recordedHostCommand(pid, root, () => false), undefined);
});
