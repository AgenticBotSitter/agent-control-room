import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { atomicWriteNoFollowV1, lchownNoFollowV1, readFileNoFollowV1 } from "../src/updater/v1/fs-safety.mjs";
import { FileStepJournalV1 } from "../src/updater/v1/journal.mjs";
import { UpdaterHeartbeatV1, UpdaterRunnerV1 } from "../src/updater/v1/runner.mjs";
import { UpdaterMainLoopV1, UpdaterModeV1, UpdaterStateFilesV1 } from "../src/updater/v1/runtime.mjs";
import { PostgresUpdaterStoreV1 } from "../src/updater/v1/store.mjs";
import { startUpdaterV1 } from "../src/updater/v1/updater.mjs";

const execFileAsync = promisify(execFile);

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "updater-skeleton-"));
  t.after(async () => { await import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true })); });
  await mkdir(join(root, "updater-state", "confirmations"), { recursive: true });
  await mkdir(join(root, "status"));
  return root;
}

test("R-FS helpers refuse symlink and hardlink swaps and atomically publish bounded files", async t => {
  const root = await temporaryRoot(t), lower = join(root, "lower");
  await mkdir(lower); await writeFile(join(lower, "state"), "safe\n", { mode: 0o600 });
  assert.equal(await readFileNoFollowV1(root, "lower/state"), "safe\n");
  await atomicWriteNoFollowV1(root, "lower/state", "new\n");
  assert.equal(await readFile(join(lower, "state"), "utf8"), "new\n");
  assert.equal((await lstat(join(lower, "state"))).mode & 0o777, 0o600);

  await writeFile(join(root, "outside"), "outside\n");
  await symlink(join(root, "outside"), join(lower, "trap"));
  await assert.rejects(readFileNoFollowV1(root, "lower/trap"), /updater_symlink_refused/u);
  await assert.rejects(atomicWriteNoFollowV1(root, "lower/trap", "damage"),
    /EEXIST|updater_symlink_refused|updater_file_refused/u);
  assert.equal(await readFile(join(root, "outside"), "utf8"), "outside\n", "a planted target is untouched");
  await mkdir(join(lower, "nested"));
  await symlink(join(root, "outside"), join(lower, "nested", "parent-link"));
  await assert.rejects(atomicWriteNoFollowV1(root, "lower/nested/parent-link/file", "damage"),
    /updater_symlink_refused/u, "a symlink at any lower-writable path component is refused");

  await link(join(lower, "state"), join(lower, "second-name"));
  await assert.rejects(readFileNoFollowV1(root, "lower/state"), /updater_file_refused/u,
    "a hard-linked state file is not trusted");
  await assert.rejects(lchownNoFollowV1(root, "lower/trap", process.getuid(), process.getgid()),
    /updater_symlink_refused/u, "ownership changes never follow a symlink");
});

test("R-FS reads refuse a planted FIFO without waiting for a writer", async t => {
  const root = await temporaryRoot(t), path = join(root, "updater-state/self-update");
  await execFileAsync("/usr/bin/mkfifo", [path]);
  let timer, unblock = Promise.resolve();
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    reject(new Error("fifo_read_blocked"));
    unblock = open(path, constants.O_WRONLY | constants.O_NONBLOCK).then(handle => handle.close()).catch(() => {});
  }, 250); });
  try {
    await assert.rejects(Promise.race([
      readFileNoFollowV1(root, "updater-state/self-update", { maxBytes: 16 }), timeout,
    ]), error => error?.code === "updater_file_refused", "a FIFO is rejected rather than blocking the updater");
  } finally { clearTimeout(timer); await unblock; }
});

const makeRun = () => ({ run_id: "run:00000000-0000-4000-8000-000000000001", plan_id: "plan-one", state: "approved",
  run_class: "code", lease_token: "lease-one", detail: {} });

class MemoryStore {
  constructor(run = makeRun()) { this.run = run; this.eventRows = []; this.heartbeats = []; this.requests = []; }
  async liveRun() { return this.run; }
  async events() { return this.eventRows; }
  async transition(_id, lease, state, detail, options = {}) {
    if (lease !== this.run.lease_token || options.terminal && !["succeeded", "rolled_back", "needs_attention", "refused"].includes(state))
      throw new Error("bad transition");
    this.run = { ...this.run, state, detail }; return this.run;
  }
  async appendEvent(_id, ordinal, state, detail) { this.eventRows.push({ ordinal, state, detail }); }
  async heartbeat(value) { this.heartbeats.push(value); }
  async unhandledOwnerRequests() { return [...this.requests]; }
  async finishOwnerRequest(id, outcome) { this.requests = this.requests.filter(row => row.id !== id); this.finished = [id, outcome]; }
}

class MemoryJournal {
  rows = [];
  async intent(value) { this.rows.push({ kind: "intent", ...value }); }
  async done(value) { this.rows.push({ kind: "done", ...value }); }
}

class Effects {
  calls = []; healthResult = true; measureResult; gate; fail;
  async #call(name) { this.calls.push(name); await this.gate; if (this.fail === name) throw Object.assign(new Error(name),
    { code: `updater_${name}_failed` }); }
  precheck() { return this.#call("precheck"); } stage() { return this.#call("stage"); }
  quickBackup() { return this.#call("quick_backup"); } drain() { return this.#call("drain"); }
  switchPair() { return this.#call("switch"); } restart() { return this.#call("restart"); }
  async health() { await this.#call("health"); return this.healthResult; }
  commitKnownGood() { return this.#call("known_good"); } rollback() { return this.#call("rollback"); }
  async measure() { await this.#call("measure"); return this.measureResult; }
}

function makeRunner({ flag = "On\n", rescued = false, mode = new UpdaterModeV1(), effects = new Effects(),
  store = new MemoryStore(), journal = new MemoryJournal(), journalUncertain = false } = {}) {
  let rescuePresent = rescued;
  const stateFiles = { leaseToken: "lease-one", readSelfUpdate: async () => flag,
    hasRescueMarker: async () => rescuePresent, journalUncertain: () => journalUncertain,
    async removeRescueMarker() { rescuePresent = false; } };
  const referee = { calls: 0, async assertPlanAllowed() { this.calls += 1; } };
  return { runner: new UpdaterRunnerV1({ store, effects, journal, mode, stateFiles, referee }),
    store, effects, journal, mode, referee, rescued: () => rescuePresent };
}

test("the updater state machine records intent before every repeat-safe effect and finishes a code run", async () => {
  const fixture = makeRunner(), result = await fixture.runner.runOnce();
  assert.equal(result.status, "succeeded");
  assert.deepEqual(fixture.effects.calls, ["precheck", "stage", "quick_backup", "drain", "switch", "restart",
    "health", "known_good"]);
  assert.deepEqual(fixture.store.eventRows.map(row => row.state),
    ["prechecked", "staged", "quick_backup", "draining", "switched", "restarted", "healthy"]);
  for (let index = 0; index < fixture.journal.rows.length; index += 2) {
    assert.equal(fixture.journal.rows[index].kind, "intent"); assert.equal(fixture.journal.rows[index + 1].kind, "done");
  }
  assert.equal(fixture.referee.calls, 1, "the running policy port decides before any effect");
});

test("Off, rescue, pause/stop, retry failure and a second concurrent caller fail closed", async t => {
  await t.test("self-update Off reads no referee and runs no effect", async () => {
    const fixture = makeRunner({ flag: "Off\n" }), result = await fixture.runner.runOnce();
    assert.equal(result.status, "refused"); assert.deepEqual(fixture.effects.calls, []); assert.equal(fixture.referee.calls, 0);
  });
  await t.test("a rescue marker forces uncertain and measures without advancing", async () => {
    const fixture = makeRunner({ rescued: true }), result = await fixture.runner.runOnce();
    assert.equal(result.status, "uncertain"); assert.deepEqual(fixture.effects.calls, []);
    assert.equal(fixture.store.run.state, "uncertain");
  });
  await t.test("a journal/display disagreement is uncertain before an effect", async () => {
    const fixture = makeRunner({ journalUncertain: true }), result = await fixture.runner.runOnce();
    assert.equal(result.status, "uncertain"); assert.deepEqual(fixture.effects.calls, []);
  });
  await t.test("only an explicit check-and-continue measures a rescue and it leaves uncertainty on a bad measurement", async () => {
    const fixture = makeRunner({ rescued: true }); await fixture.runner.runOnce();
    await assert.rejects(fixture.runner.checkAndContinue(), /updater_measurement_refused/u);
    assert.equal(fixture.rescued(), true); assert.equal(fixture.store.run.state, "uncertain");
    fixture.effects.measureResult = { state: "rolled_back", detail: { release: "known-good" } };
    assert.equal((await fixture.runner.checkAndContinue()).status, "rolled_back");
    assert.equal(fixture.rescued(), false); assert.equal(fixture.store.run.state, "rolled_back");
  });
  await t.test("an inconsistent check-and-continue runs rollback rather than advancing", async () => {
    const fixture = makeRunner({ rescued: true }); await fixture.runner.runOnce();
    fixture.effects.measureResult = { state: "rollback_required" };
    assert.equal((await fixture.runner.checkAndContinue()).status, "rolled_back");
    assert.deepEqual(fixture.effects.calls, ["measure", "rollback"]); assert.equal(fixture.rescued(), false);
  });
  await t.test("pause before drain waits and stop refuses without switching", async () => {
    const paused = new UpdaterModeV1(); paused.set("paused");
    const fixture = makeRunner({ mode: paused }), result = await fixture.runner.runOnce();
    assert.equal(result.status, "waiting"); assert.deepEqual(fixture.effects.calls, []);
    paused.set("stopped"); assert.equal((await fixture.runner.runOnce()).status, "refused");
    assert.ok(!fixture.effects.calls.includes("switch"));
  });
  await t.test("post-drain failure rolls back and preserves the original code", async () => {
    const fixture = makeRunner(); fixture.effects.fail = "restart";
    const result = await fixture.runner.runOnce();
    assert.equal(result.status, "rolled_back"); assert.equal(result.run.detail.originalCode, "updater_restart_failed");
    assert.deepEqual(fixture.effects.calls.slice(-2), ["restart", "rollback"]);
  });
  await t.test("50 simultaneous calls expose one actor and 49 busy outcomes", async () => {
    const fixture = makeRunner(); let release;
    fixture.effects.gate = new Promise(resolve => { release = resolve; });
    const first = fixture.runner.runOnce(); await new Promise(resolve => setImmediate(resolve));
    const burst = await Promise.all(Array.from({ length: 49 }, () => fixture.runner.runOnce()));
    assert.equal(burst.filter(row => row.status === "busy").length, 49);
    fixture.effects.gate = undefined; release(); assert.equal((await first).status, "succeeded");
  });
});

test("a torn live file journal becomes uncertain, then Check and continue archives it before settling", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "On\n");
  const journal = new FileStepJournalV1(root, { ownerUid: process.getuid() });
  await journal.done({ runId: "run:00000000-0000-4000-8000-000000000001", ordinal: 1, state: "staged", detail: {} });
  const complete = await readFile(join(root, "updater-state/journal.jsonl"));
  await writeFile(join(root, "updater-state/journal.jsonl"), complete.subarray(0, complete.length - 5), { mode: 0o600 });
  const store = new MemoryStore({ ...makeRun(), state: "staged" }), effects = new Effects();
  const updater = await startUpdaterV1({ root, store, journal, effects, referee: { async assertPlanAllowed() {} } });
  t.after(() => updater.stop());
  assert.equal(updater.loop.lastOutcome.status, "uncertain");
  assert.equal(store.run.state, "uncertain"); assert.deepEqual(effects.calls, []);
  const status = JSON.parse(await readFile(join(root, "status/status.json"), "utf8"));
  assert.deepEqual({ state: status.state, needsYou: status.needsYou }, { state: "uncertain", needsYou: true });
  assert.equal((await updater.runner.runOnce()).status, "uncertain", "a later tick does not livelock as error");
  await assert.rejects(updater.runner.checkAndContinue(), /updater_measurement_refused/u,
    "a failed owner measurement keeps the repaired journal recoverable for a retry");
  effects.measureResult = { state: "rolled_back", detail: { release: "known-good" } };
  assert.equal((await updater.runner.checkAndContinue()).status, "rolled_back");
  assert.equal(store.run.state, "rolled_back");
  assert.ok((await readdir(join(root, "updater-state"))).some(name => name.startsWith("journal.jsonl.poisoned-")));
  assert.ok((await journal.validate()).entries.length > 0, "settlement starts a fresh signed chain");
});

test("the heartbeat timer continues while a run step is hung", async t => {
  const root = await temporaryRoot(t), store = new MemoryStore(), stateFiles = new UpdaterStateFilesV1(root, "lease-one");
  const heartbeat = new UpdaterHeartbeatV1({ store, stateFiles, bootId: "boot-one", leaseToken: "lease-one",
    report: () => ({ state: "running", step: "slow_step" }), intervalMs: 10 });
  heartbeat.start();
  for (let tries = 0; store.heartbeats.length < 2 && tries < 200; tries += 1)
    await new Promise(resolve => setTimeout(resolve, 10));
  await heartbeat.stop();
  assert.ok(store.heartbeats.length >= 2, `expected repeated timer heartbeats, saw ${store.heartbeats.length}`);
  const disk = JSON.parse(await readFile(join(root, "updater-state/heartbeat"), "utf8"));
  assert.equal(disk.step, "slow_step");
});

test("heartbeat and loop timers contain a dropped write and retry on the next tick", async t => {
  const root = await temporaryRoot(t), store = new MemoryStore(), errors = [];
  let attempts = 0;
  store.heartbeat = async value => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("dropped"), { code: "connection_dropped" });
    store.heartbeats.push(value);
  };
  const stateFiles = new UpdaterStateFilesV1(root, "lease-one");
  const heartbeat = new UpdaterHeartbeatV1({ store, stateFiles, bootId: "boot-one", leaseToken: "lease-one",
    report: () => ({ state: "idle" }), intervalMs: 10, onError: error => errors.push(error.code) });
  heartbeat.start();
  for (let tries = 0; store.heartbeats.length < 1 && tries < 200; tries += 1)
    await new Promise(resolve => setTimeout(resolve, 10));
  await heartbeat.stop();
  assert.ok(errors.includes("connection_dropped")); assert.ok(store.heartbeats.length >= 1, "a later tick recovered");

  let loopAttempts = 0;
  const loop = new UpdaterMainLoopV1({ runner: { async runOnce() { loopAttempts += 1;
    if (loopAttempts === 1) throw Object.assign(new Error("dropped"), { code: "connection_dropped" });
    return { status: "idle" }; } }, store, stateFiles: { readSelfUpdate: async () => "On\n",
      hasRescueMarker: async () => false, async writeStatus() {} }, mode: new UpdaterModeV1(),
    ownerActions: { async handle() {} }, intervalMs: 10, onError: error => errors.push(error.code) });
  loop.start();
  for (let tries = 0; loopAttempts < 2 && tries < 200; tries += 1)
    await new Promise(resolve => setTimeout(resolve, 10));
  loop.stop();
  assert.ok(loopAttempts >= 2); assert.ok(errors.filter(code => code === "connection_dropped").length >= 2);
});

test("a failed initial heartbeat closes the control socket before startup returns", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "On\n");
  const store = new MemoryStore(undefined);
  store.heartbeat = async () => { throw Object.assign(new Error("down"), { code: "connection_dropped" }); };
  await assert.rejects(startUpdaterV1({ root, store }), error => error.code === "connection_dropped");
  await assert.rejects(lstat(join(root, "updater-state/control.sock")), /ENOENT/u,
    "failed startup did not leave a listener or stale socket");
});

test("startup reports a live run before its first heartbeat and reuses its durable token", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "On\n");
  const store = new MemoryStore(), effects = new Effects();
  const updater = await startUpdaterV1({ root, store,
    identity: { bootId: "boot-restarted", leaseToken: "lease-new" }, effects,
    referee: { async assertPlanAllowed() {} } });
  t.after(() => updater.stop());
  assert.equal(updater.identity.leaseToken, "lease-one");
  assert.deepEqual(store.heartbeats[0], { bootId: "boot-restarted", leaseToken: "lease-one",
    state: "running", step: "approved" });
  assert.deepEqual(store.heartbeats[1], { bootId: "boot-restarted", leaseToken: "lease-one",
    state: "idle", step: null });
  assert.equal(updater.loop.lastOutcome.status, "succeeded");
});

test("startup refuses when another database session still owns the updater lease", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "On\n");
  const store = new MemoryStore(); store.acquire = async () => ({ status: "busy", run: store.run });
  let started;
  try { started = await startUpdaterV1({ root, store }); }
  catch (error) { assert.match(error.message, /updater_live_session_busy/u); }
  if (started) { await started.stop(); assert.fail("startup accepted a busy database lease"); }
  await assert.rejects(lstat(join(root, "updater-state/control.sock")), /ENOENT/u);
});

test("startup settles the actuator's durable link transaction before opening its socket", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "Off\n");
  const store = new MemoryStore(null); let recovered = 0;
  const updater = await startUpdaterV1({ root, store, effects: { async recover() { recovered += 1; } } });
  try { assert.equal(recovered, 1); assert.ok(await lstat(join(root, "updater-state/control.sock"))); }
  finally { await updater.stop(); }
});

test("the main loop does not poll the runner while Off and rejects a risk-increasing request", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "Off\n");
  await mkdir(join(root, "releases/r7"), { recursive: true }); await symlink("releases/r7", join(root, "current"));
  await writeFile(join(root, "updater-state/guard-status.json"), JSON.stringify({
    schema: "control-room.guard-status/v1", updaterRestartsLastHour: 2, at: 1,
  }));
  const stateFiles = new UpdaterStateFilesV1(root, "lease-one"), store = new MemoryStore(undefined);
  store.requests = [{ id: "owner-request:00000000-0000-4000-8000-000000000001", request_kind: "resume" }];
  let runnerCalls = 0, actionCalls = 0;
  const loop = new UpdaterMainLoopV1({ runner: { async runOnce() { runnerCalls += 1; return { status: "idle" }; } }, store, stateFiles,
    mode: new UpdaterModeV1(), ownerActions: { async handle() { actionCalls += 1; } } });
  assert.equal((await loop.tick()).status, "idle"); assert.equal(runnerCalls, 0); assert.equal(actionCalls, 0);
  assert.equal(store.finished[1], "refused");
  const status = JSON.parse(await readFile(join(root, "status/status.json"), "utf8"));
  assert.equal(status.releaseId, "r7"); assert.equal(status.updaterRestartsLastHour, 2);
  await writeFile(join(root, "updater-state/rescued.json"), "{}\n");
  assert.equal((await loop.tick()).status, "uncertain", "the Off flag cannot hide a rescue marker");
  assert.equal(runnerCalls, 1, "a rescued active run is measured, never advanced by the watcher/build path");
});

test("a busy result with a live run is published as needs_attention", async () => {
  let written;
  const loop = new UpdaterMainLoopV1({ runner: { async runOnce() { return { status: "busy", liveRun: true }; } },
    store: new MemoryStore(undefined), stateFiles: { readSelfUpdate: async () => "On\n",
      hasRescueMarker: async () => false, async writeStatus(value) { written = value; } },
    mode: new UpdaterModeV1(), ownerActions: { async handle() {} } });
  assert.equal((await loop.tick()).status, "busy");
  assert.equal(written.state, "needs_attention"); assert.equal(written.needsYou, true);
});

test("the runner refuses an acquired result whose durable token does not match", async () => {
  const store = new MemoryStore(); store.acquire = async () => ({ status: "acquired", run: store.run,
    leaseToken: "lease-wrong" });
  const fixture = makeRunner({ store });
  const result = await fixture.runner.runOnce();
  assert.equal(result.status, "busy"); assert.equal(result.liveRun, true);
  assert.deepEqual(fixture.effects.calls, []);
});

test("the PostgreSQL adapter refuses a wrong production role and never transitions without the run lease", async () => {
  const roleClient = { async query(sql) {
    if (sql.startsWith("SET ")) return { rows: [] };
    return { rows: [{ current_user: "wrong_role", is_deployer: false, replication_role: "origin" }] };
  } };
  await assert.rejects(new PostgresUpdaterStoreV1(roleClient).initialize(), /updater_store_role_refused/u);

  const leaseClient = { async query(sql, params) {
    if (sql.includes("UPDATE updater.runs")) return { rows: sql.includes("AND lease_token=$2") && params[1] === "wrong"
      ? [] : [{ run_id: params[0], lease_token: params[1], state: params[2] }] };
    return { rows: [] };
  } };
  const store = new PostgresUpdaterStoreV1(leaseClient);
  await assert.rejects(store.transition("run:00000000-0000-4000-8000-000000000001", "wrong", "prechecked"),
    /updater_run_lease_lost/u);

  const acquisitionClient = acquired => ({ async query(sql) {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired }] };
    if (sql.includes("FROM updater.runs")) return { rows: [makeRun()] };
    if (sql.includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
    throw new Error(`unexpected query: ${sql}`);
  } });
  const busy = await new PostgresUpdaterStoreV1(acquisitionClient(false)).acquire("lease-new");
  assert.equal(busy.status, "busy"); assert.equal(busy.run.lease_token, "lease-one");
  const resumedStore = new PostgresUpdaterStoreV1(acquisitionClient(true));
  const resumed = await resumedStore.acquire("lease-new");
  assert.deepEqual({ status: resumed.status, leaseToken: resumed.leaseToken, resumed: resumed.resumed },
    { status: "acquired", leaseToken: "lease-one", resumed: true });
  await resumedStore.release();
});
