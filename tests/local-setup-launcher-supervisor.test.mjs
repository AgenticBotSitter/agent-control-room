import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  LOCAL_SETUP_HOST_READINESS_V1,
  superviseLocalSetupLauncherHostV1,
} from "../src/installer/v1/local-setup-launcher-supervisor.mjs";

const readiness = `${JSON.stringify(LOCAL_SETUP_HOST_READINESS_V1)}\n`;
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(opener = async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "",
  oversized: false, timedOut: false })) {
  const child = new EventEmitter(); child.pid = 4321;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const signals = new EventEmitter(), timers = [], kills = [], opens = [], spawns = [];
  const setTimer = (callback, ms) => { const timer = { callback, ms, active: true }; timers.push(timer); return timer; };
  const clearTimer = timer => { if (timer) timer.active = false; };
  const dependencies = {
    signals, setTimer, clearTimer, killGroup(pid, signal) { kills.push([pid, signal]); },
    spawnProcess(executable, args, options) { spawns.push({ executable, args, options }); return child; },
    async runOpener(spec) { opens.push(spec); return opener(spec); },
  };
  const promise = superviseLocalSetupLauncherHostV1({ executable: "/node", args: ["/host.mjs"],
    cwd: "/release", environment: { PATH: "/usr/bin:/bin", HOME: "/private/home" } }, dependencies);
  const fire = ms => {
    const timer = timers.find(candidate => candidate.active && candidate.ms === ms);
    assert.ok(timer, `missing active ${ms}ms timer`); timer.active = false; timer.callback();
  };
  return { child, signals, timers, kills, opens, spawns, promise, fire };
}

test("waits for exact readiness, opens only fixed /setup, and cleans descendants after the leader closes", async () => {
  const f = fixture();
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(f.spawns[0], { executable: "/node", args: ["/host.mjs"], options: {
    cwd: "/release", env: { PATH: "/usr/bin:/bin", HOME: "/private/home" }, shell: false,
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  } });
  assert.equal(f.opens.length, 0);
  f.child.stdout.emit("data", Buffer.from(readiness));
  await flush();
  assert.deepEqual(f.opens[0], { executable: "/usr/bin/open", args: ["http://127.0.0.1:3210/setup"],
    cwd: "/release", environment: { PATH: "/usr/bin:/bin", HOME: "/private/home" },
    timeoutMs: 15_000, terminationGraceMs: 2_000 });
  assert.equal(await Promise.race([f.promise.then(() => "closed"), Promise.resolve("alive")]), "alive");
  f.signals.emit("SIGTERM");
  assert.deepEqual(f.kills, [[4321, "SIGTERM"]]);
  f.child.emit("close", 0, null);
  assert.equal(await Promise.race([f.promise.then(() => "closed"), Promise.resolve("cleanup-pending")]), "cleanup-pending");
  f.fire(2_000);
  assert.deepEqual(await f.promise, { state: "setup_host_closed", ready: true, opened: true, reaped: true });
  assert.deepEqual(f.kills, [[4321, "SIGTERM"], [4321, "SIGKILL"]]);
  assert.deepEqual(f.signals.eventNames(), []);
});

test("escalates to KILL only when TERM does not close the child, then waits to reap it", async () => {
  const f = fixture(); f.child.stdout.emit("data", Buffer.from(readiness));
  await flush(); f.signals.emit("SIGHUP");
  f.fire(2_000);
  assert.deepEqual(f.kills, [[4321, "SIGTERM"], [4321, "SIGKILL"]]);
  assert.equal(await Promise.race([f.promise.then(() => "closed"), Promise.resolve("waiting")]), "waiting");
  f.child.emit("close", null, "SIGKILL");
  assert.equal((await f.promise).reaped, true);
});

test("refuses malformed, extra, oversized, or stderr output and reaps the group", async () => {
  for (const [label, emit] of [
    ["malformed", child => child.stdout.emit("data", Buffer.from("{}\n"))],
    ["extra", child => child.stdout.emit("data", Buffer.from(`${readiness}extra`))],
    ["oversized", child => child.stdout.emit("data", Buffer.alloc(4097, "a"))],
    ["stderr", child => child.stderr.emit("data", Buffer.from("private failure"))],
  ]) {
    const f = fixture(); emit(f.child); f.child.emit("close", 1, null); f.fire(2_000);
    await assert.rejects(f.promise, { message: "local_setup_host_output_refused" }, label);
    assert.equal(f.opens.length, 0); assert.deepEqual(f.kills.map(row => row[1]), ["SIGTERM", "SIGKILL"]);
  }
});

test("readiness timeout, opener failure, and early child exit all terminate and reap", async () => {
  {
    const f = fixture(); f.fire(15_000); f.child.emit("close", null, "SIGTERM"); f.fire(2_000);
    await assert.rejects(f.promise, { message: "local_setup_host_readiness_timeout" });
  }
  {
    const f = fixture(async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "failed",
      oversized: false, timedOut: false }));
    f.child.stdout.emit("data", Buffer.from(readiness)); await flush();
    f.child.emit("close", 1, null); f.fire(2_000);
    await assert.rejects(f.promise, { message: "local_setup_host_opener_failed" });
  }
  {
    const f = fixture(); f.child.emit("close", 0, null); f.fire(2_000);
    await assert.rejects(f.promise, { message: "local_setup_host_start_failed" });
  }
});

test("after readiness, any later output is fatal and normal parent exit is supervised", async () => {
  const f = fixture(); f.child.stdout.emit("data", Buffer.from(readiness));
  await flush();
  f.child.stdout.emit("data", Buffer.from("unexpected"));
  f.child.emit("close", null, "SIGTERM"); f.fire(2_000);
  await assert.rejects(f.promise, { message: "local_setup_host_output_refused" });

  const normal = fixture(); normal.child.stdout.emit("data", Buffer.from(readiness));
  await flush(); normal.signals.emit("beforeExit", 0);
  normal.child.emit("close", null, "SIGTERM"); normal.fire(2_000);
  assert.equal((await normal.promise).state, "setup_host_closed");
});
