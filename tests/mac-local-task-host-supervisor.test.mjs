import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
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
import { healthRequestTagV1, healthResponseTagV1,
  LOCAL_HOST_HEALTH_ENDPOINT_V1 } from "../src/updater/v1/health-protocol.mjs";

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

function fakeHealthResponse(healthProbeKey, nonce, pid) {
  const releaseId = "dev", startedAt = "2026-09-30T00:00:00.000Z";
  const response = { schema: "control-room.local-host-health/v1", nonce, ready: true, pid, releaseId, startedAt };
  return { ...response, tag: healthResponseTagV1(healthProbeKey, LOCAL_HOST_HEALTH_ENDPOINT_V1, response) };
}

const ownedPids = new Map();

/** Records a pid this test started, so the fixture removes the protected root only once that pid
 * is gone. The registration must happen where the process is spawned, not in a later `t.after`:
 * node runs this fixture's teardown hook (registered inside rootFixture, before the test body) first,
 * so a pid added afterwards is never reaped. */
function ownPid(root, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return pid;
  const pids = ownedPids.get(root) ?? new Set();
  pids.add(pid);
  ownedPids.set(root, pids);
  return pid;
}

/** The pids this root's state file still records, and each confirmed to be *this* root's supervisor
 * or task host right now. A recorded pid whose command line is not ours is a pid the OS recycled,
 * so it is refused here exactly as mac:down refuses it — never signalled by a teardown.
 *
 * This is a backstop for a pid nobody registered. It only matches a supervisor started the way
 * launchd and mac:up start it, with the relative script path from hostCommand/taskHostCommand:
 * `alive` is an exact `ps -ww -o command=` equality, so a process spawned with an absolute script
 * path never matches (measured, this file's own entry-point spawns). Every process these tests
 * start is therefore registered at spawn time; this covers only what a real stack leaves behind. */
async function recordedHostPids(root) {
  let recorded;
  try { recorded = JSON.parse(await readFile(runtimePaths(root).hostState, "utf8")); }
  catch { return []; }
  return [recorded.pid, recorded.childPid]
    .filter(pid => Number.isSafeInteger(pid) && pid > 1
      && (alive(pid, hostCommand(root)) || alive(pid, taskHostCommand(root))));
}

/** Removes a protected root only after nothing this test started can still be writing into it.
 * The root is the supervisor's working area: a supervisor that is still streaming a child into
 * runtime/task-host.log when the tree is removed races the removal, and the teardown fails with
 * ENOTEMPTY on the runtime directory. The reap and the removal are therefore in that order, and
 * the reap waits for the pid to actually be gone. */
async function removeRoot(root) {
  const pids = new Set([...(ownedPids.get(root) ?? []), ...await recordedHostPids(root)]);
  ownedPids.delete(root);
  for (const pid of pids) await killProcessGroup(pid);
  await rm(root, { recursive: true, force: true });
}

async function rootFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acr-host-supervisor-"));
  await mkdir(join(root, "runtime"), { mode: 0o700 });
  t.after(() => removeRoot(root));
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

/** The process group a pid leads or belongs to, or undefined if the pid is gone. `ps` is the only
 * dependency-free way to read another process's pgid on macOS; kill(0) cannot answer it. The EPERM
 * branch matches pidAlive/exactProcess: a sandboxed local runner can refuse ps even for a child it
 * owns, and an unreadable pgid must not be silently read as "not in the group". */
const processGroupOf = pid => {
  try {
    const value = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const pgid = Number(value);
    return Number.isSafeInteger(pgid) && pgid > 1 ? pgid : undefined;
  }
  catch (error) {
    if (error?.code !== "EPERM") return undefined;
    // No portable fallback: group membership is a property of the OS process table, not of argv.
    // A caller that needs it under a sandbox must treat undefined as "not verified" and say so.
    return process.pid === pid ? process.pid : undefined;
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
  const supervisor = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
  return ownPid(root, supervisor.pid), supervisor;
}

/** Spawns the real supervisor entry point, registering its pid for the fixture teardown. The
 * registration is here, at the spawn, because a later `t.after` would run after the fixture has
 * already removed the root — see ownPid. */
function startSupervisorEntryPoint(root) {
  const supervisor = spawn(process.execPath, [join(repoRoot, "scripts/mac-local/task-host-supervisor.mjs"),
    "--protected-root", root],
  { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: join(root, "home") } });
  return ownPid(root, supervisor.pid), supervisor;
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
  const stopOwned = async pidPath => {
    const pid = await readPid(pidPath);
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await waitFor(() => !pidAlive(pid), `owned fixture process ${pid} survived SIGTERM`);
    }
    await rm(pidPath, { force: true });
    return "stopped";
  };
  try {
    await assert.rejects(
      startAndWait(command, paths.hostLog, paths.hostPid, async () => false, 1, "task host",
        { alive: pidAlive, stopRecorded: stopOwned }),
      /task host did not start within 1s/u,
    );
  } finally {
    const recorded = await readPid(paths.hostPid).catch(() => undefined);
    if (recorded) await killProcessGroup(recorded);
  }
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
  const pid = await startAndWait(command, paths.hostLog, paths.hostPid, () => portOpen(port), 5, "task host",
    { alive: pidAlive });
  started.push(pid);
  assert.equal(await readPid(paths.hostPid), pid);
  assert.equal(await readFile(paths.hostPid, "utf8"), `${pid}\n`);
});

test("mac:up readiness follows the private host record after a supervisor replacement", async t => {
  const { authenticatedHostReady } = await import(upModule);
  assert.equal(typeof authenticatedHostReady, "function",
    "readiness needs the host-written pid/state record instead of launchd's sampled pid");
  const root = await rootFixture(t), paths = runtimePaths(root);
  const healthProbeKey = Buffer.alloc(32, 5);
  await mkdir(join(root, "service"), { mode: 0o700 });
  await writeFile(join(root, "service", "health-probe.key"), `${healthProbeKey.toString("base64url")}\n`, { mode: 0o600 });
  await assert.rejects(readFile(join(root, "config", "owner-sign-in.txt"), "utf8"), { code: "ENOENT" },
    "readiness must not require an owner-code file");
  const supervisorPid = 4_242, childPid = 4_243;
  await writeFile(paths.hostPid, `${supervisorPid}\n`, { mode: 0o600 });
  await writeFile(paths.hostState, `${JSON.stringify({ schema: "control-room.mac-local-host-state/v1",
    state: "running", pid: supervisorPid, childPid, at: "2026-09-29T00:00:00.000Z" })}\n`, { mode: 0o600 });
  let requests = 0;
  const server = createHttpServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests += 1;
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/v1/local-host-health");
      assert.equal(request.headers.origin, `http://127.0.0.1:${server.address().port}`);
      const parsed = JSON.parse(body);
      assert.deepEqual(Object.keys(parsed), ["nonce", "reqTag"]);
      assert.match(parsed.nonce, /^[A-Za-z0-9_-]{43}$/u);
      if (parsed.reqTag !== healthRequestTagV1(healthProbeKey, parsed.nonce, LOCAL_HOST_HEALTH_ENDPOINT_V1)) {
        response.writeHead(403, { "content-type": "application/json" }); response.end("{}"); return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(fakeHealthResponse(healthProbeKey, parsed.nonce, childPid)));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const exactAlive = (pid, command) => pid === supervisorPid && command.join(" ") === hostCommand(root).join(" ")
    || pid === childPid && command.join(" ") === taskHostCommand(root).join(" ");
  assert.equal(await authenticatedHostReady(root, port, { alive: exactAlive }), supervisorPid,
    "the independent protected key permits readiness without an owner-code file");
  assert.equal(await authenticatedHostReady(root, port, { alive: exactAlive, healthProbeKey: Buffer.alloc(32, 6) }), undefined,
    "a different probe key cannot authenticate readiness");
  assert.equal(requests, 2);
});

test("mac:up readiness refuses a dead host before contacting its port", async t => {
  const { authenticatedHostReady } = await import(upModule);
  const root = await rootFixture(t), paths = runtimePaths(root), supervisorPid = 4_252, childPid = 4_253;
  await writeFile(paths.hostPid, `${supervisorPid}\n`, { mode: 0o600 });
  await writeFile(paths.hostState, `${JSON.stringify({ schema: "control-room.mac-local-host-state/v1",
    state: "running", pid: supervisorPid, childPid, at: "2026-09-29T00:00:00.000Z" })}\n`, { mode: 0o600 });
  let contacted = false;
  assert.equal(await authenticatedHostReady(root, 32_110, {
    alive: () => false, transport: async () => { contacted = true; throw new Error("must not contact"); },
    healthProbeKey: Buffer.alloc(32, 5),
  }), undefined);
  assert.equal(contacted, false);
});

test("mac:up readiness refuses a different process occupying the configured port", async t => {
  const { authenticatedHostReady } = await import(upModule);
  const root = await rootFixture(t), paths = runtimePaths(root), supervisorPid = 4_262, childPid = 4_263;
  await writeFile(paths.hostPid, `${supervisorPid}\n`, { mode: 0o600 });
  await writeFile(paths.hostState, `${JSON.stringify({ schema: "control-room.mac-local-host-state/v1",
    state: "running", pid: supervisorPid, childPid, at: "2026-09-29T00:00:00.000Z" })}\n`, { mode: 0o600 });
  const server = createHttpServer(async (request, response) => {
    const raw = await new Promise(resolve => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => resolve(body));
    });
    const { nonce } = JSON.parse(raw);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ schema: "control-room.local-host-health/v1", ready: true,
      pid: childPid, nonce, tag: `hmac-sha256:${"0".repeat(64)}` }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(await authenticatedHostReady(root, server.address().port, {
    alive: () => true,
    healthProbeKey: Buffer.alloc(32, 5),
  }), undefined);
});

test("mac:up authenticated readiness is bounded under a burst, drop, slow response, and mid-probe restart", async t => {
  const { authenticatedHostReady } = await import(upModule);
  const root = await rootFixture(t), paths = runtimePaths(root), supervisorPid = 4_272, childPid = 4_273;
  const healthProbeKey = Buffer.alloc(32, 5);
  const record = (pid = supervisorPid, child = childPid) => Promise.all([
    writeFile(paths.hostPid, `${pid}\n`, { mode: 0o600 }),
    writeFile(paths.hostState, `${JSON.stringify({ schema: "control-room.mac-local-host-state/v1",
      state: "running", pid, childPid: child, at: "2026-09-29T00:00:00.000Z" })}\n`, { mode: 0o600 }),
  ]);
  await record();
  let mode = "ready", requests = 0;
  const server = createHttpServer(async (request, response) => {
    const raw = await new Promise(resolve => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => resolve(body));
    });
    const { nonce } = JSON.parse(raw);
    requests += 1;
    if (mode === "drop") { request.socket.destroy(); return; }
    if (mode === "slow") return;
    if (mode === "restart") await record(supervisorPid + 10, childPid + 10);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(fakeHealthResponse(healthProbeKey, nonce, childPid)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const exactAlive = (pid, command) => [supervisorPid, supervisorPid + 10].includes(pid)
    ? command.join(" ") === hostCommand(root).join(" ")
    : [childPid, childPid + 10].includes(pid) && command.join(" ") === taskHostCommand(root).join(" ");
  const probe = () => authenticatedHostReady(root, port, { alive: exactAlive, timeoutMs: 50, healthProbeKey });

  const burst = await Promise.all(Array.from({ length: 50 }, probe));
  assert.deepEqual(new Set(burst), new Set([supervisorPid]), "all 50 parallel authenticated probes agree");
  assert.equal(requests, 50);
  mode = "drop";
  assert.equal(await probe(), undefined, "a dropped connection is not ready");
  mode = "ready";
  assert.equal(await probe(), supervisorPid, "a retry after the dropped connection can succeed");
  mode = "slow";
  assert.equal(await probe(), undefined, "a slow response stops at the probe deadline");
  mode = "restart";
  assert.equal(await probe(), undefined, "a restart halfway through cannot mix two host generations");
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
  assert.match(source, /if \(service\) return startService\(root, paths, mac\.port, hostReady\)/u,
    "launchd startup must use the same authenticated host-record probe as direct startup");
  const serviceStart = /async function startService[\s\S]*?\n\}/u.exec(source)?.[0] ?? "";
  assert.match(serviceStart, /waitFor\(hostReady, 90\)/u,
    "launchd readiness must follow the host-written record, not launchd's sampled pid");
  assert.doesNotMatch(serviceStart, /writePrivate\(paths\.hostPid/u,
    "mac:up must not overwrite the pid file written by the supervisor");
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
  // "supervisor error" after 90 seconds. Both halves have to be narrowed.
  //
  // So this drives the REAL supervisor entry point, and it requires the REAL task host it spawns to
  // serve. Serving is asserted against the port, not against a state file: the supervisor rewrites
  // task-host-state.json back to "stopped" the moment the host it spawned exits, so the window in
  // which it reads "running" is only as wide as that host's lifetime, and an earlier version of this
  // test polled it on a timer and failed whenever the poll missed (this file's CI job, and 5 of 30
  // local runs of this test on the unmodified tree). A bound port that answers is the owner's actual
  // evidence, and it does not go away.
  //
  // The host is the real start-task-host.mjs, so it does the real protected-root load. That load
  // needs a database this fixture does not have, so NODE_OPTIONS preloads a fixture that binds the
  // port the supervisor's host is meant to serve on, ahead of the real module. The supervisor
  // itself is untouched: it still spawns, tracks, and reports on the real host process.
  const root = await rootFixture(t), paths = runtimePaths(root), port = await unusedPort();
  await writeFile(paths.hostState, `${JSON.stringify({ state: "stopped", reason: "exit code 0",
    at: "2026-09-27T00:00:00.000Z" })}\n`, { mode: 0o600 });
  await chmod(paths.hostState, 0o644);
  // The supervisor runs this same NODE_OPTIONS preload, and the host is its child, so the preload
  // has to bind only in the host. The supervisor stamps CONTROL_ROOM_TASK_HOST_SUPERVISED=1 on the
  // child it spawns and not on itself, which is exactly the distinction needed here.
  const servingFixture = `if (process.env.CONTROL_ROOM_TASK_HOST_SUPERVISED === "1") {\n`
    + `  const { createServer } = await import("node:net");\n`
    + `  const server = createServer(socket => { socket.on("error", () => {}); socket.end("ok"); });\n`
    + `  server.listen(${port}, "127.0.0.1", () => console.log("fixture host serving on ${port}"));\n`
    + `  server.on("error", error => console.log("fixture host could not bind: " + error.message));\n`
    + `  setInterval(() => {}, 1000);\n`
    + `}\n`;
  const child = spawn(process.execPath, [join(repoRoot, "scripts/mac-local/task-host-supervisor.mjs"),
    "--protected-root", root], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: join(root, "home"),
      NODE_OPTIONS: `--import=${`data:text/javascript,${encodeURIComponent(servingFixture)}`}` } });
  ownPid(root, child.pid);

  // The claim, observed while the stack is up: the host is serving, on a port it bound itself.
  await waitFor(() => portOpen(port), "the task host must serve with an unreadable recorded stop reason");
  assert.ok(pidAlive(child.pid), "the supervisor must still be running while the host serves");

  // Then a deliberate stop, so the teardown is a clean recorded stop rather than a kill.
  child.kill("SIGTERM");
  const [code, exitSignal] = await closeWithin(child, 30_000);
  const log = readFileSync(paths.hostLog, "utf8");
  // The regression this test exists to catch, stated first because it is the most direct statement
  // of the claim. Widening the supervisor's read back to readHostState makes it die with
  // "supervisor error" here instead, and the host never serves at all.
  assert.doesNotMatch(log, /supervisor error/u,
    `an unreadable stop reason is not a supervisor error, so the supervisor must not have died on its own read. log:\n${log}`);
  assert.match(log, /could not be read/u, "the condition must be recorded so the owner can see it");
  assert.match(log, /host stopped because requested SIGTERM/u,
    `the host must have run on its own and then taken the deliberate stop, so the recorded reason must be the requested stop. log:\n${log}`);
  assert.equal(exitSignal, null);
  assert.equal(code, 0, "a deliberate stop is the only reason a supervisor exits successfully");
  await waitFor(async () => !await portOpen(port), "the host must release its port when it stops");
  assert.deepEqual(await readHostState(paths.hostState).then(state => ({ state: state.state, reason: state.reason })),
    { state: "stopped", reason: "requested SIGTERM" });
  await assert.rejects(readFile(paths.hostPid, "utf8"), error => error.code === "ENOENT");
});

test("the fixture removes a protected root only after the supervisor it started is gone", async t => {
  // The flake this pins: the protected root is the supervisor's working area, and it streams the
  // host it spawned into runtime/task-host.log. Removing the tree while that is still happening
  // fails the teardown with ENOTEMPTY on the runtime directory. The fixture therefore has to reap
  // what it started, by recorded pid, before it removes anything — and this asserts that directly
  // on removeRoot, because a test's own `t.after` hook runs after the fixture's and cannot do it.
  const root = await rootFixture(t);
  const supervisor = startRealSupervisor(root, ["-e", "setInterval(() => {}, 1000)"]);
  const state = await runningState(root);
  // Both are pids this test spawned, so the fixture is told about both: a supervisor spawned with a
  // fixture command line is deliberately not this root's exact task host, and removeRoot must not
  // infer a pid it was not given.
  ownPid(root, supervisor.pid);
  ownPid(root, state.childPid);
  assert.ok(pidAlive(supervisor.pid), "the supervisor must be running when the root is removed");

  await removeRoot(root);

  assert.equal(pidAlive(supervisor.pid), false,
    "removeRoot returned while the supervisor it started was still writing into the root it removed");
  assert.equal(pidAlive(state.childPid), false, "the host it started must be gone with its root");
  await assert.rejects(stat(root), error => error.code === "ENOENT", "the root must actually be gone");
});

test("the fixture's teardown never signals a pid that is not this root's host", async t => {
  // A teardown that trusted the recorded pids without checking what they are would SIGKILL a
  // process group the OS had recycled onto an unrelated program — the same authority boundary
  // mac:down enforces, reached from a test cleanup path where nothing else would catch it. The
  // impostor is detached, so killing its group is a real, observable act rather than a no-op.
  const root = await rootFixture(t), paths = runtimePaths(root);
  const impostor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    { cwd: repoRoot, stdio: "ignore", detached: true });
  t.after(async () => { if (pidAlive(impostor.pid)) process.kill(-impostor.pid, "SIGKILL"); });
  await waitFor(() => pidAlive(impostor.pid), "impostor fixture did not start");
  await writeFile(paths.hostState, `${JSON.stringify({ state: "running", pid: impostor.pid,
    childPid: impostor.pid, at: new Date().toISOString() })}\n`, { mode: 0o600 });

  await removeRoot(root);

  assert.ok(pidAlive(impostor.pid),
    "a recorded pid that is not this root's supervisor or host is recycled, and cleanup must not signal it");
  await assert.rejects(stat(root), error => error.code === "ENOENT", "the root must actually be gone");
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

  let reported;
  try {
    reported = execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(impostor.pid)],
      { encoding: "utf8" }).trim();
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    t.skip("sandbox refused the process-table read needed to verify exact argv");
    return;
  }
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
  //
  // Both recorded pids are exact-alive here, and deliberately so. With only the supervisor alive
  // the guard's second clause (the child's own exact-command check) returned early on its own and
  // this test passed whether or not the live-supervisor clause existed, so deleting that clause
  // changed nothing. The child is exact-alive in its own right below, which is what makes the
  // first clause the only thing standing between the replacement and a SIGKILL to a healthy group.
  const root = await rootFixture(t), paths = runtimePaths(root), supervisorPid = 4_241, childPid = 4_242;
  const recordRunning = () => writeFile(paths.hostState,
    `${JSON.stringify({ state: "running", pid: supervisorPid, childPid, at: new Date().toISOString() })}\n`,
    { mode: 0o600 });
  await recordRunning();
  // The child is alive until a signal in this fixture actually takes effect: the guard waits for
  // the kill to land and throws mac_local_stale_task_host_would_not_stop if it never does. Liveness
  // is folded into the selector, so deleting the live-supervisor clause shows up as a signal being
  // sent to a healthy child rather than as a wait-loop timeout.
  const live = { child: true };
  const exact = (pid, command) => {
    if (pid === supervisorPid) return JSON.stringify(command) === JSON.stringify(hostCommand(root));
    if (pid === childPid) return live.child && JSON.stringify(command) === JSON.stringify(taskHostCommand(root));
    return false;
  };
  const replace = async alive => {
    const signals = [];
    // Each run rewrites the state file it read, so the fixture has to be restored before the next
    // half. Without this the second run sees "stopped" and skips the guard entirely.
    await recordRunning();
    const code = await superviseTaskHost(root, { alive,
      signal: (pid, signal) => { signals.push([pid, signal]); live.child = false; },
      spawn: () => fakeChild({ code: 0, stdout: "", stderr: "" }) });
    return { code, signals };
  };

  // The refusal: a live exact supervisor holding its own exact task host.
  const refused = await replace(exact);
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.signals, [], "a live exact supervisor means there is no orphan to clean up");
  assert.equal(live.child, true, "the refusal is what left the healthy child running");

  // The control, on the same fixture: the moment the recorded supervisor is gone, the identical
  // child must be signalled. Without it, a fixture that could never signal would satisfy the
  // refusal above for the wrong reason, and this test would pin nothing.
  const orphan = await replace((pid, command) => exact(pid, command) && pid !== supervisorPid && live.child);
  assert.equal(orphan.code, 1);
  assert.deepEqual(orphan.signals, [[-childPid, "SIGKILL"]],
    "with the recorded supervisor gone, this exact child is the orphan the replacement must clear");
  assert.equal(live.child, false, "the orphan was killed before the replacement spawned");
});

test("openHostLog refuses a symlinked log even when its target is a private 0600 file we own", async t => {
  // The existing symlink assertion in "a host log and a host state file ... stay private and
  // unfollowed" points at a default-mode (0644) target, so the mode/uid check on the opened file
  // refuses it too. Deleting O_NOFOLLOW therefore changed nothing there. The target here is a
  // private 0600 regular file owned by this uid, so every other condition in openHostLog passes and
  // O_NOFOLLOW is the only thing that can refuse it. A symlink that resolves to a file we already
  // own is exactly the shape that matters: a restored backup, a link dropped in by something else
  // on the same account, or a log path an attacker-shaped link replaced.
  const root = await rootFixture(t), paths = runtimePaths(root), target = join(root, "private-target");
  await writeFile(target, "PRECIOUS\n", { mode: 0o600 });
  await chmod(target, 0o600);
  assert.equal((await stat(target)).mode & 0o777, 0o600,
    "the target must satisfy every other openHostLog condition, or this test proves nothing");
  await symlink(target, paths.hostLog);

  assert.throws(() => openHostLog(paths.hostLog),
    `O_NOFOLLOW must refuse a symlink at the log path even to a private target: ${paths.hostLog}`);
  assert.equal(await readFile(target, "utf8"), "PRECIOUS\n", "the target must not be written through");

  // The same refusal one layer up, end to end through the real RotatingHostLog: the unsafe entry
  // is replaced with a fresh private log and the target keeps its contents.
  const log = await RotatingHostLog.open(paths.hostLog, 4_096, 2);
  await log.line("fixture line");
  await log.close();
  assert.equal(await readFile(target, "utf8"), "PRECIOUS\n", "recovery must not append to the symlink target");
  assert.doesNotMatch(await readFile(paths.hostLog, "utf8"), /PRECIOUS/u);
  assert.match(await readFile(paths.hostLog, "utf8"), /replaced unsafe existing host log/u);
});

test("a hardlinked host log is refused before rotation and on the opened descriptor", async t => {
  // O_NOFOLLOW cannot see this one. A hardlink is a second directory entry for the same inode, so
  // open(path, O_NOFOLLOW) succeeds and the mode and uid checks on the opened file both pass. The
  // only thing that knows a name outside this private runtime still reaches every byte appended is
  // the link count, so it is checked in both places a log file is accepted: the lstat that decides
  // whether to rotate, and the fstat of the descriptor that is about to be written.
  const root = await rootFixture(t), paths = runtimePaths(root), other = join(root, "elsewhere/kept.log");
  await mkdir(join(root, "elsewhere"), { mode: 0o700 });
  await writeFile(paths.hostLog, "PRECIOUS\n", { mode: 0o600 });
  await chmod(paths.hostLog, 0o600);
  await link(paths.hostLog, other);
  assert.equal((await stat(paths.hostLog)).nlink, 2, "the fixture must be a real hardlink");
  assert.equal((await stat(paths.hostLog)).mode & 0o777, 0o600, "mode must not be what refuses it");

  // The pre-rotation check: rotation renames the directory entry, not the file, so rotating a
  // hardlinked log leaves its other name holding the live inode, still being appended to.
  await assert.rejects(rotateHostLog(paths.hostLog, 1, 2), /host_log_invalid/u,
    "a hardlinked log must not be rotated");

  // The descriptor check, on its own, with rotation never attempted, so the open itself is what
  // has to refuse. O_NOFOLLOW is inert here: the entry is a real file, not a symlink.
  assert.throws(() => openHostLog(paths.hostLog), /host_log_invalid/u,
    "a hardlinked log must be refused on the opened descriptor, not only before rotation");
  assert.equal((await stat(paths.hostLog)).nlink, 2, "a refused open must not have rewritten the log");
  assert.equal(await readFile(other, "utf8"), "PRECIOUS\n");

  // The refusal is fail-closed but not wedging: the real writer recovers through the same path the
  // loose-log case uses — remove the directory entry, create a fresh private single-link log.
  const log = await RotatingHostLog.open(paths.hostLog, 4_096, 2);
  await log.line("fixture line");
  await log.close();
  assert.equal(await readFile(other, "utf8"), "PRECIOUS\n", "the other name received nothing");
  assert.match(await readFile(paths.hostLog, "utf8"), /replaced unsafe existing host log/u);
});

test("an unsafe backup generation stops rotation, loose or hardlinked alike", async t => {
  // The blast radius of the link-count check, stated as a test rather than left implicit. A backup
  // generation is checked by the same helper the current log is, so a hardlinked `path.1` is
  // refused exactly the way a 0644 `path.1` already is on main: rotation stops instead of renaming
  // a file that still has a name outside this runtime. That is the safe direction — refusing, not
  // accepting — and it is the pre-existing contract for an unsafe backup, widened by one condition
  // and not invented here. The loose case is kept as the control so the hardlink case cannot pass
  // by making both halves fail for some other reason.
  for (const [name, unsafeBackup] of [
    ["loose backup (pre-existing on main)", async dir => {
      await writeFile(`${runtimePaths(dir).hostLog}.1`, "old generation\n", { mode: 0o644 });
      await chmod(`${runtimePaths(dir).hostLog}.1`, 0o644);
    }],
    ["hardlinked backup (new)", async dir => {
      await writeFile(`${runtimePaths(dir).hostLog}.1`, "old generation\n", { mode: 0o600 });
      await link(`${runtimePaths(dir).hostLog}.1`, join(dir, "kept-generation.log"));
    }],
  ]) {
    await t.test(name, async t => {
      const dir = await rootFixture(t), paths = runtimePaths(dir);
      await writeFile(paths.hostLog, "x".repeat(200), { mode: 0o600 });
      await unsafeBackup(dir);
      await assert.rejects(rotateHostLog(paths.hostLog, 10, 2), /host_log_invalid/u,
        "an unsafe backup must stop rotation, whether it is loose or hardlinked");
      assert.equal(await readFile(`${paths.hostLog}.1`, "utf8"), "old generation\n",
        "the refused backup generation must not be renamed or removed");
    });
  }
});

test("the real supervisor replaces a hardlinked log and never writes through the other name", async t => {
  // The user-visible half: the owner still gets a bounded private log, and the name outside the
  // private runtime receives nothing. This is the recovery path the loose-log case already uses —
  // refuse, remove the directory entry, create a fresh 0600 log — reached from a hardlink instead.
  const root = await rootFixture(t), paths = runtimePaths(root), other = join(root, "elsewhere/kept.log");
  await mkdir(join(root, "elsewhere"), { mode: 0o700 });
  await writeFile(paths.hostLog, "restored hardlink\n", { mode: 0o600 });
  await link(paths.hostLog, other);
  const supervisor = startRealSupervisor(root, ["-e", "console.log('FIXTURE-CHILD-OUTPUT'); process.exit(23)"]);
  t.after(async () => { if (pidAlive(supervisor.pid)) supervisor.kill("SIGKILL"); });
  assert.equal((await runToCompletion(supervisor)).code, 1);

  const kept = await readFile(other, "utf8");
  assert.doesNotMatch(kept, /FIXTURE-CHILD-OUTPUT/u, "the other name must not receive the host's output");
  assert.doesNotMatch(kept, /replaced unsafe existing host log/u, "the host log is not that file any more");
  const log = await readFile(paths.hostLog, "utf8");
  assert.match(log, /replaced unsafe existing host log with a new private log/u);
  assert.match(log, /FIXTURE-CHILD-OUTPUT/u, "the owner still gets the child output in the new private log");
  assert.match(log, /host stopped because exit code 23/u);
  assert.equal((await stat(paths.hostLog)).nlink, 1, "the live log must be a single-link file");
  assert.equal((await stat(paths.hostLog)).mode & 0o777, 0o600);
  assert.deepEqual(await readHostState(paths.hostState).then(state => ({ state: state.state, reason: state.reason })),
    { state: "stopped", reason: "exit code 23" });
});

test("a replacement supervisor signals the process group, so a non-detached grandchild cannot outlive it", async t => {
  // Mutation D: `process.kill(child.pid, signal)` instead of `process.kill(-child.pid, signal)`.
  // The real child is spawned detached, so it is a process-group leader, and its own helpers are
  // not all detached: src/node-bridge/private-macos-claude-code-process-host-ports.ts:149 and
  // src/node-bridge/codex-native-process.ts spawn without `detached`, so they land in the child's
  // group. Signalling only the pid stops the leader and leaves those helpers running, holding the
  // ports the next supervisor has to bind. So the claim under test is about the *group*.
  const root = await rootFixture(t), paths = runtimePaths(root);
  // The fixture child spawns a grandchild that reports its own pid on stdout, then idles. The
  // grandchild is NOT detached, so it inherits the child's process group; the real group
  // membership is read back from ps below rather than trusted from anything the fixture prints.
  const grandchildSource = `console.log(JSON.stringify({ pid: process.pid, alive: true }));\n`
    + `setInterval(() => {}, 1000);\n`;
  // The forwarding line is built by concatenation, not nested template literals, so the only
  // escaping here is the one this file's other fixtures use.
  const childSource = `import { spawn } from "node:child_process";\n`
    + `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}],\n`
    + `  { stdio: ["ignore", "pipe", "inherit"] });\n`
    + 'grandchild.stdout.on("data", chunk => process.stdout.write("grandchild ready " + chunk.toString("utf8")));\n'
    + `setInterval(() => {}, 1000);\n`;

  const supervisor = startRealSupervisor(root, ["--input-type=module", "-e", childSource]);
  const state = await runningState(root);
  const grandchildPid = { value: undefined };
  t.after(async () => {
    if (pidAlive(supervisor.pid)) supervisor.kill("SIGKILL");
    // closeWithin is already past by the time a failing assertion unwinds, so a leftover child is
    // not waited for: this hook has to bound itself. The pids are ours, recorded above.
    for (const pid of [grandchildPid.value, state.childPid]) if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  });

  // waitFor resolves to undefined, not to the check's value, so the pid is read back from the
  // mutable cell the check wrote.
  await waitFor(() => {
    const log = readFileSync(paths.hostLog, "utf8");
    const match = /grandchild ready \{"pid":(\d+),"alive":true\}/u.exec(log);
    if (!match) return false;
    grandchildPid.value = Number(match[1]);
    return grandchildPid.value > 1;
  }, "the fixture grandchild never reported its pid", 20_000);
  assert.ok(grandchildPid.value, "the grandchild pid was read from the host log");

  // The grandchild must really be in the child's process group, and really be alive. Otherwise this
  // test would pass for a reason that has nothing to do with the signal target.
  const childGroup = processGroupOf(state.childPid);
  if (childGroup === undefined) {
    t.skip("sandbox refused the process-group read needed to verify group membership");
    return;
  }
  assert.equal(childGroup, state.childPid, "the supervised child is spawned detached and leads its own group");
  assert.equal(processGroupOf(grandchildPid.value), childGroup,
    "a non-detached grandchild shares the child's group, which is what the group signal reaches");
  assert.ok(pidAlive(grandchildPid.value), "the grandchild is running before the stop");

  // A requested stop is a foreground stop, not a recovery: the leader takes SIGTERM, drains and
  // exits, and the supervisor has to record that as deliberate and exit 0. A child that cannot
  // stop on its own is the escalation case, covered by the next test, so here the SIGTERM is
  // expected to land and take the whole group with it.
  supervisor.kill("SIGTERM");
  await waitFor(() => !pidAlive(grandchildPid.value),
    `grandchild ${grandchildPid.value} outlived the supervisor's group signal: it was signalled by pid, not by group`);
  await waitFor(() => !pidAlive(state.childPid), "the supervised child survived a requested stop");
  const [code, exitSignal] = await closeWithin(supervisor, 10_000);
  assert.deepEqual([code, exitSignal], [0, null]);
  assert.equal((await readHostState(paths.hostState)).reason, "requested SIGTERM");
});

test("upgrade selection recognizes only the current supervisor or exact legacy host", () => {
  const root = "/protected/root", pid = 55;
  const same = expected => (_pid, command) => JSON.stringify(command) === JSON.stringify(expected);
  assert.deepEqual(recordedHostCommand(pid, root, same(hostCommand(root))), hostCommand(root));
  assert.deepEqual(recordedHostCommand(pid, root, same(taskHostCommand(root))), taskHostCommand(root));
  assert.equal(recordedHostCommand(pid, root, () => false), undefined);
});
