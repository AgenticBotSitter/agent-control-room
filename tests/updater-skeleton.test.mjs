import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants, mkdtempSync, realpathSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { atomicWriteNoFollowV1, lchownNoFollowV1, readFileNoFollowV1 } from "../src/updater/v1/fs-safety.mjs";
import { FileStepJournalV1 } from "../src/updater/v1/journal.mjs";
import { UpdaterHeartbeatV1, UpdaterRunnerV1 } from "../src/updater/v1/runner.mjs";
import { UpdaterMainLoopV1, UpdaterModeV1, UpdaterStateFilesV1 } from "../src/updater/v1/runtime.mjs";
import { PostgresUpdaterStoreV1 } from "../src/updater/v1/store.mjs";
import { startUpdaterV1 } from "../src/updater/v1/updater.mjs";
import { sendControlRequestV1 } from "../src/updater/v1/control-socket.mjs";
import { UpdaterWatcherV1 } from "../src/updater/v1/watcher.mjs";

const execFileAsync = promisify(execFile);

async function temporaryRoot(t) {
  const root = realpathSync(mkdtempSync("/private/tmp/updater-skeleton-"));
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

/** R12 custody seam. The production process is root and the key file is
 * root-owned 0600; a developer test is neither, so the ONLY thing injected is
 * the identity the custody check reads. The sender, its store and its send
 * path are the real ones, so these tests still run the default construction. */
const ROOT_VAPID = Object.freeze({ schema: "control-room.updater-vapid/v1", subject: "mailto:owner@example.invalid",
  publicKey: "A".repeat(88), privateKey: "b".repeat(48) });
async function rootHeldVapid(root) {
  await writeFile(join(root, "updater-state/vapid.json"), `${JSON.stringify(ROOT_VAPID)}\n`, { mode: 0o600 });
  return { getuid: () => 0, lstat: async path => Object.assign(await lstat(path), { uid: 0 }) };
}

class MemoryStore {
  constructor(run = makeRun()) { this.run = run; this.eventRows = []; this.heartbeats = []; this.requests = [];
    this.queued = []; this.pushRows = []; }
  async liveRun() { return this.run; }
  async events() { return this.eventRows; }
  // The mirror row is written BY the transition, in the same step, because that
  // is the store's contract since B4: `updater.record_run_step` moves the row and
  // its journal mirror in one statement, and the runner asks for it by naming the
  // state it is moving to. A fake that appended separately would model the OLD
  // two-statement contract, and the runner's `#nextOrdinal` reads `events()` — so
  // the journal's intent/done lines would all carry ordinal 1, which is
  // `updater_journal_ordinal_refused` on the next read.
  async transition(_id, lease, state, detail, options = {}) {
    if (lease !== this.run.lease_token || options.terminal && !["succeeded", "rolled_back", "needs_attention", "refused"].includes(state))
      throw new Error("bad transition");
    this.run = { ...this.run, state, detail };
    if (!options.terminal) this.eventRows.push({ ordinal: this.eventRows.length + 1, state, detail });
    return this.run;
  }
  async heartbeat(value) { this.heartbeats.push(value); }
  async unhandledOwnerRequests() { return [...this.requests]; }
  async finishOwnerRequest(id, outcome) { this.requests = this.requests.filter(row => row.id !== id); this.finished = [id, outcome]; }
  // The four R12 alert ports, so the DEFAULT sender in `startUpdaterV1` can be
  // constructed against this fake exactly as it is against the real store.
  async subscriptions() { return this.subscriptionsValue ?? []; }
  async pending() { return this.pushRows.filter(row => !row.sent); }
  async begin(id) { const row = this.pushRows.find(item => item.id === id); if (!row || row.sent) return false;
    row.attempts += 1; return true; }
  async finish(id, { sent, errorCode = null } = {}) { const row = this.pushRows.find(item => item.id === id);
    if (row) { row.sent = sent; row.errorCode = errorCode; } }
  async queue(template) { this.queued.push(template); }
}

class MemoryJournal {
  rows = [];
  async intent(value) { this.rows.push({ kind: "intent", ...value }); }
  async done(value) { this.rows.push({ kind: "done", ...value }); }
}

class Effects {
  calls = []; healthResult = true; measureResult; gate; fail; failValue; liveVersion = "old";
  async #call(name) {
    this.calls.push(name); await this.gate;
    if (name === "switch") this.liveVersion = "new";
    if (name === "rollback") this.liveVersion = "old";
    if (this.fail === name) throw this.failValue ?? Object.assign(new Error(name), { code: `updater_${name}_failed` });
  }
  precheck() { return this.#call("precheck"); } stage() { return this.#call("stage"); }
  quickBackup() { return this.#call("quick_backup"); } drain() { return this.#call("drain"); }
  switchPair() { return this.#call("switch"); } restart() { return this.#call("restart"); }
  async health() { await this.#call("health"); return this.healthResult; }
  commitKnownGood() { return this.#call("known_good"); } rollback() { return this.#call("rollback"); }
  async measure() { await this.#call("measure"); return this.measureResult; }
}

function makeRunner({ flag = "On\n", rescued = false, mode = new UpdaterModeV1(), effects = new Effects(),
  store = new MemoryStore(), journal = new MemoryJournal(), journalUncertain = false, referee: suppliedReferee } = {}) {
  let rescuePresent = rescued;
  const stateFiles = { leaseToken: "lease-one", readSelfUpdate: async () => flag,
    hasRescueMarker: async () => rescuePresent, journalUncertain: () => journalUncertain,
    async removeRescueMarker() { rescuePresent = false; } };
  const referee = suppliedReferee ?? { calls: 0, async assertPlanAllowed() { this.calls += 1; } };
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

test("every failed update step preserves the old version and keeps the file journal valid", async t => {
  for (const step of ["precheck", "stage", "quick_backup", "drain", "switch", "restart", "health", "known_good"])
    await t.test(step, async t => {
      const root = await temporaryRoot(t), journal = new FileStepJournalV1(root, { ownerUid: process.getuid() });
      const effects = new Effects(); effects.fail = step;
      const fixture = makeRunner({ effects, journal });
      const result = await fixture.runner.runOnce();
      const beforeDrain = ["precheck", "stage", "quick_backup"].includes(step);
      const terminal = beforeDrain ? "refused" : "rolled_back";
      assert.equal(result.status, terminal, `${step}: the failure reaches the correct recovery boundary`);
      assert.equal(fixture.store.run.state, terminal, `${step}: the outcome is durable`);
      assert.equal(effects.calls.at(-1), beforeDrain ? step : "rollback");
      if (beforeDrain) assert.ok(!effects.calls.includes("rollback"), "no recovery effect may downgrade a healthy source");
      assert.equal(effects.liveVersion, "old", `${step}: the known-good version is live`);
      const entries = (await journal.validate()).entries;
      assert.ok(entries.some(entry => entry.kind === "intent" && entry.detail?.effect === step),
        `${step}: the failed physical effect has a durable intent`);
      assert.ok(entries.length >= (beforeDrain ? 3 : 4), `${step}: failed intent and terminal recovery remain a valid chain`);
    });

  for (const step of ["precheck", "drain"]) await t.test(`a non-Error ${step} failure honors the drain boundary`, async t => {
    const root = await temporaryRoot(t), journal = new FileStepJournalV1(root, { ownerUid: process.getuid() });
    const effects = new Effects(); effects.fail = step; effects.failValue = "connection_dropped";
    const result = await makeRunner({ effects, journal }).runner.runOnce();
    assert.equal(result.status, step === "precheck" ? "refused" : "rolled_back");
    if (step === "precheck") { assert.equal(result.code, "updater_step_failed"); assert.deepEqual(effects.calls, ["precheck"]); }
    else { assert.equal(result.run.detail.originalCode, "updater_step_failed"); assert.equal(effects.calls.at(-1), "rollback"); }
    assert.equal(effects.liveVersion, "old");
    await journal.validate();
  });

  await t.test("a later update succeeds in the same journal after a failed update", async t => {
    const root = await temporaryRoot(t), journal = new FileStepJournalV1(root, { ownerUid: process.getuid() });
    const effects = new Effects(), store = new MemoryStore(); effects.fail = "restart";
    const fixture = makeRunner({ effects, store, journal });
    assert.equal((await fixture.runner.runOnce()).status, "rolled_back");
    store.run = { ...makeRun(), run_id: "run:00000000-0000-4000-8000-000000000002" };
    store.eventRows = []; effects.fail = undefined; effects.calls = [];
    assert.equal((await fixture.runner.runOnce()).status, "succeeded");
    assert.equal(effects.calls.at(-1), "known_good");
    assert.deepEqual([...new Set((await journal.validate()).entries.map(entry => entry.runId))],
      ["run:00000000-0000-4000-8000-000000000001", "run:00000000-0000-4000-8000-000000000002"]);
  });
});

test("Check and continue resumes a durable rollback start from both phone and Mac", async t => {
  for (const source of ["web", "root"]) await t.test(source, async () => {
    const effects = new Effects(), store = new MemoryStore({ ...makeRun(), state: "rollback_started",
      detail: { originalCode: "updater_restart_failed" } });
    const fixture = makeRunner({ effects, store });
    const result = await fixture.runner.checkAndContinue({ source });
    assert.equal(result.status, "rolled_back");
    assert.deepEqual(effects.calls, ["rollback"]);
    assert.equal(effects.liveVersion, "old");
  });
});

test("Off, rescue, pause/stop, retry failure and a second concurrent caller fail closed", async t => {
  await t.test("self-update Off reads no referee and runs no effect", async () => {
    const fixture = makeRunner({ flag: "Off\n" }), result = await fixture.runner.runOnce();
    assert.equal(result.status, "refused"); assert.deepEqual(fixture.effects.calls, []); assert.equal(fixture.referee.calls, 0);
  });
  await t.test("a referee refusal before the first effect remains a refusal, not a rollback", async () => {
    const referee = { calls: 0, async assertPlanAllowed() { this.calls += 1;
      throw Object.assign(new Error("policy"), { code: "updater_referee_refused" }); } };
    const fixture = makeRunner({ referee }), result = await fixture.runner.runOnce();
    assert.equal(result.status, "refused"); assert.equal(result.code, "updater_referee_refused");
    assert.deepEqual(fixture.effects.calls, []); assert.equal(referee.calls, 1);
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
    const paused = new UpdaterModeV1(); await paused.set("paused");
    const fixture = makeRunner({ mode: paused }), result = await fixture.runner.runOnce();
    assert.equal(result.status, "waiting"); assert.deepEqual(fixture.effects.calls, []);
    await paused.set("stopped"); assert.equal((await fixture.runner.runOnce()).status, "refused");
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

test("P1b: only root Check and continue clears a no-run rescue marker on the default path", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "Off\n");
  await writeFile(join(root, "updater-state/rescued.json"), "{}\n", { mode: 0o600 });
  const store = new MemoryStore(null);
  const updater = await startUpdaterV1({ alerts: null, root, store });
  t.after(() => updater.stop());
  updater.loop.stop();
  assert.equal(updater.loop.lastOutcome.status, "uncertain");
  assert.match(updater.loop.lastOutcome.message, /no update is running, clear the rescue on the Mac/u);
  await assert.rejects(updater.runner.checkAndContinue(),
    error => error?.code === "updater_web_rescue_clear_refused");
  store.requests = [{ id: "owner-request:00000000-0000-4000-8000-000000000001",
    request_kind: "check_and_continue" }];
  assert.equal((await updater.loop.tick()).status, "uncertain");
  assert.equal(store.finished[1], "refused");
  assert.equal(await readFile(join(root, "updater-state/rescued.json"), "utf8"), "{}\n");
  const status = JSON.parse(await readFile(join(root, "status/status.json"), "utf8"));
  assert.deepEqual({ state: status.state, needsYou: status.needsYou }, { state: "uncertain", needsYou: true });
  const socket = join(root, "updater-state/control.sock");
  const results = await Promise.allSettled(Array.from({ length: 50 }, (_, index) => sendControlRequestV1(socket, {
    schema: "control-room.updater-control/v1", requestId: `p1b-root-clear-${index}`,
    verb: "check-and-continue", arguments: [],
  })));
  assert.equal(results.filter(result => result.status === "fulfilled" && result.value.status === "idle").length, 1);
  assert.equal(results.filter(result => (result.status === "fulfilled" && result.value.status === "busy")
    || (result.status === "rejected" && result.reason?.code === "updater_check_continue_refused")).length, 49);
  await assert.rejects(lstat(join(root, "updater-state/rescued.json")), /ENOENT/u);
  store.requests = [{ id: "owner-request:00000000-0000-4000-8000-000000000002",
    request_kind: "check_and_continue" }];
  assert.equal((await updater.loop.tick()).status, "idle");
  assert.equal(store.finished[1], "refused", "a retry after the marker was cleared is refused");
});

test("P7: Pause and Stop survive restart, a request-row Resume is refused, and root control may Resume", async t => {
  for (const [index, requested] of ["pause", "stop"].entries()) {
    const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "On\n");
    const store = new MemoryStore(null);
    let updater = await startUpdaterV1({ alerts: null, root, store }); updater.loop.stop();
    t.after(async () => { await updater?.stop(); });
    const socket = join(root, "updater-state/control.sock");
    const burst = await Promise.all(Array.from({ length: 50 }, (_, caller) => sendControlRequestV1(socket, {
      schema: "control-room.updater-control/v1", requestId: `p7-${index}-${caller}`, verb: requested, arguments: [],
    })));
    assert.equal(burst.every(result => result.accepted === true), true);
    assert.equal(await updater.loop.mode.read(), requested === "pause" ? "paused" : "stopped");
    await updater.stop();

    updater = await startUpdaterV1({ alerts: null, root, store }); updater.loop.stop();
    assert.equal(await updater.loop.mode.read(), requested === "pause" ? "paused" : "stopped");
    if (requested === "stop") {
      store.requests = [{ id: "owner-request:00000000-0000-4000-8000-000000000009", request_kind: "pause" }];
      await updater.loop.tick();
      assert.equal(store.finished[1], "refused", "a web Pause cannot lower the owner's durable Stop");
      assert.equal(await updater.loop.mode.read(), "stopped");
    }
    store.requests = [{ id: `owner-request:00000000-0000-4000-8000-00000000000${index + 2}`,
      request_kind: "resume" }];
    await updater.loop.tick();
    assert.equal(store.finished[1], "refused");
    assert.equal(await updater.loop.mode.read(), requested === "pause" ? "paused" : "stopped");
    assert.deepEqual(await sendControlRequestV1(socket, { schema: "control-room.updater-control/v1",
      requestId: `p7-resume-${index}`, verb: "resume", arguments: [] }), { accepted: true });
    assert.equal(await updater.loop.mode.read(), "running");
    await updater.stop();
  }
});

test("a malformed saved updater mode refuses startup instead of silently resuming", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "On\n");
  await writeFile(join(root, "updater-state/mode.json"), '{"schema":"control-room.updater-mode/v1","mode":"running","extra":true}\n');
  const store = new MemoryStore(null);
  let started;
  try { started = await startUpdaterV1({ alerts: null, root, store }); }
  catch (error) { assert.match(error.message, /updater_mode_state_refused/u); }
  if (started) { await started.stop(); assert.fail("startup accepted malformed durable mode state"); }
  await assert.rejects(lstat(join(root, "updater-state/control.sock")), /ENOENT/u);
});

test("P8a: the default control handlers publish and consume the registration without an injected handler", async t => {
  const productionSource = await readFile("src/updater/v1/updater.mjs", "utf8");
  assert.match(productionSource, /new PasskeyStoreV1\(client\)/u);
  assert.match(productionSource, /if \(ownsPasskeyStore\) await passkeyStore\.initialize\(\)/u);
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "Off\n");
  const registrationSecret = "A".repeat(43), registrationDigest = `sha256:${"b".repeat(64)}`;
  const calls = [];
  const store = new MemoryStore(null);
  store.openRegistration = async value => { calls.push(["open", value]); };
  store.consumeRegistration = async value => { calls.push(["consume", value]); return true; };
  // THE MODE THE DAEMON WAS TOLD, recorded. MEASURED: with `mode` hard-coded to
  // `add` in the handler, every test in the repository still passed — the CLI
  // test only asserted what the CLI SENT, and nothing asserted what the daemon
  // DID with it. A daemon that substitutes `add` for a told `initial` is the H2
  // bug one process further in, so this records what the authority was asked for.
  const modes = [];
  const passkeys = {
    // The challenge is NON-NULL ONLY FOR `add`, exactly as the real
    // `PasskeyAuthorityV1.beginRegistration` behaves: there is no passkey to
    // authorize an `initial` registration, so it has no authorization challenge.
    // MEASURED: with a challenge for every mode, the daemon published an
    // `initial` row carrying one, and the assertion below caught it — a fixture
    // that always answered the same thing was hiding whether the daemon honoured
    // the mode it was told.
    async beginRegistration(input) { modes.push(input.mode); return { registrationSecret, registrationDigest,
      authorizationChallenge: input.mode === "add" ? "C".repeat(43) : null,
      expiresAt: "2026-10-01T00:00:00.000Z",
      config: { installationId: "install-fixture", expectedOrigin: "https://mac.example.test" } }; },
    async registrationOptions(secret) { assert.equal(secret, registrationSecret); return {
      schema: "control-room.passkey-registration-options/v1", registrationDigest, publicKey: { challenge: "D".repeat(43) } }; },
    async completeRegistration({ registrationSecret: secret, typedCode }) {
      assert.equal(secret, registrationSecret); assert.equal(typedCode, "ABC234");
      return { credentialId: "credential", coolingOffUntil: null };
    },
  };
  const updater = await startUpdaterV1({ alerts: null, root, store, passkeys }); updater.loop.stop(); t.after(() => updater.stop());
  const socket = join(root, "updater-state/control.sock");
  const begun = await sendControlRequestV1(socket, { schema: "control-room.updater-control/v1",
    requestId: "p8-begin", verb: "passkey-add-begin", arguments: [] });
  assert.equal(begun.registrationSecret, registrationSecret);
  // No argument means `add`, which is what an older CLI sends.
  assert.deepEqual(modes, ["add"], "a passkey-add-begin with no argument keeps the pre-existing meaning");
  assert.equal(begun.mode, "add", "and the reply names the mode it used, so the CLI can print the right message");
  const completed = await sendControlRequestV1(socket, { schema: "control-room.updater-control/v1",
    requestId: "p8-complete", verb: "passkey-add-complete", arguments: [registrationSecret, "ABC234"] });
  assert.equal(completed.credentialId, "credential");
  assert.equal(calls[0][0], "open"); assert.equal(calls[0][1].optionsJson.registrationDigest, registrationDigest);
  assert.deepEqual(calls[1], ["consume", registrationDigest]);

  // A TOLD `initial` is honoured, and reaches both the authority and the store.
  // `openRegistration`'s `mode` and `authorizationChallenge` must agree with it: an
  // `initial` row with a non-null authorization challenge is a row the web would
  // try to satisfy with an assertion the owner does not have yet.
  const told = await sendControlRequestV1(socket, { schema: "control-room.updater-control/v1",
    requestId: "p8-begin-initial", verb: "passkey-add-begin", arguments: ["initial"] });
  assert.equal(told.mode, "initial");
  assert.deepEqual(modes, ["add", "initial"], "the daemon asks the authority for the mode it was told");
  const initialOpen = calls.find(entry => entry[0] === "open" && entry[1].mode === "initial");
  assert.ok(initialOpen, "and publishes a row in that same mode");
  assert.equal(initialOpen[1].authorizationChallenge, null,
    "an initial registration carries no authorization challenge: there is no passkey to authorize it");
  // And an unknown mode is refused rather than defaulted.
  await assert.rejects(sendControlRequestV1(socket, { schema: "control-room.updater-control/v1",
    requestId: "p8-begin-bogus", verb: "passkey-add-begin", arguments: ["not-a-mode"] }),
    /updater_passkey_arguments_refused/u);
});

test("a journal with middle corruption becomes uncertain, then Check and continue archives it before settling", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "On\n");
  const journal = new FileStepJournalV1(root, { ownerUid: process.getuid() });
  await journal.done({ runId: "run:00000000-0000-4000-8000-000000000001", ordinal: 1, state: "staged", detail: {} });
  const complete = await readFile(join(root, "updater-state/journal.jsonl"));
  await writeFile(join(root, "updater-state/journal.jsonl"), Buffer.concat([complete, Buffer.from('{"torn"\n{}\n')]), { mode: 0o600 });
  const store = new MemoryStore({ ...makeRun(), state: "staged" }), effects = new Effects();
  const updater = await startUpdaterV1({ root, store, journal, effects, referee: { async assertPlanAllowed() {} },
    alertRuntime: await rootHeldVapid(root) });
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

test("a newer-release race or watcher network failure cannot stop an in-flight update", async t => {
  const runCase = async watcher => {
    const errors = [], fixture = makeRunner();
    const loop = new UpdaterMainLoopV1({ runner: fixture.runner, store: fixture.store,
      stateFiles: { readSelfUpdate: async () => "On\n", hasRescueMarker: async () => false,
        publicFacts: async () => ({}), async writeStatus() {} },
      mode: fixture.mode, ownerActions: { async handle() {} }, watcher,
      onError: error => errors.push(error.code ?? error.message) });
    const result = await loop.tick();
    assert.equal(result.status, "succeeded");
    assert.equal(fixture.store.run.state, "succeeded");
    assert.equal(fixture.effects.calls.at(-1), "known_good");
    return errors;
  };

  await t.test("a newer release loses the plan race after the run becomes live", async () => {
    const oldCommit = "a".repeat(40), newCommit = "b".repeat(40);
    const watcher = new UpdaterWatcherV1({
      source: { fromCommit: "0".repeat(40), async fetchMain() {
        return { commit: newCommit, tree: "1".repeat(40), repository: "fixture" };
      }, async isAncestor() { return true; } },
      ci: { async statusForCommit() { return { commit: newCommit, checkRuns: [{ commit: newCommit,
        name: "required", appSlug: "github-actions", conclusion: "success", id: "1" }] }; } },
      classifier: { async classify() { return { classification: "code-only", classes: ["code"],
        protectedPaths: [], filesChanged: 1, filesAdded: 0, filesDeleted: 0, changesDatabase: false,
        changesUpdater: false, changedPaths: ["README.md"] }; } },
      plans: { async liveRun() { return null; }, async openPlan() { return { planId: "plan-old",
        plan: { candidate: { commit: oldCommit } } }; }, async databaseNow() { return new Date(); },
      async replaceOpenPlan() { throw Object.assign(new Error("live run"), { code: "23514" }); } },
      planFiles: { async write() {} }, installationId: "install-test", requiredChecks: ["required"],
    });
    assert.deepEqual(await runCase(watcher), ["23514"]);
  });

  await t.test("a dropped watcher connection is reported and the runner still finishes", async () => {
    const watcher = { async tick() {
      throw Object.assign(new Error("offline"), { code: "watcher_source_fetch_refused" });
    } };
    assert.deepEqual(await runCase(watcher), ["watcher_source_fetch_refused"]);
  });
});

test("a failed initial heartbeat closes the control socket before startup returns", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "On\n");
  const store = new MemoryStore(undefined);
  store.heartbeat = async () => { throw Object.assign(new Error("down"), { code: "connection_dropped" }); };
  await assert.rejects(startUpdaterV1({ root, store, alertRuntime: await rootHeldVapid(root) }),
    error => error.code === "connection_dropped");
  await assert.rejects(lstat(join(root, "updater-state/control.sock")), /ENOENT/u,
    "failed startup did not leave a listener or stale socket");
});

test("startup reports a live run before its first heartbeat and reuses its durable token", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "On\n");
  const store = new MemoryStore(), effects = new Effects();
  const updater = await startUpdaterV1({ root, store,
    identity: { bootId: "boot-restarted", leaseToken: "lease-new" }, effects,
    referee: { async assertPlanAllowed() {} }, alertRuntime: await rootHeldVapid(root) });
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
  try { started = await startUpdaterV1({ root, store, alertRuntime: await rootHeldVapid(root) }); }
  catch (error) { assert.match(error.message, /updater_live_session_busy/u); }
  if (started) { await started.stop(); assert.fail("startup accepted a busy database lease"); }
  await assert.rejects(lstat(join(root, "updater-state/control.sock")), /ENOENT/u);
});

test("startup settles the actuator's durable link transaction before opening its socket", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "Off\n");
  const store = new MemoryStore(null); let recovered = 0;
  const updater = await startUpdaterV1({ root, store, effects: { async recover() { recovered += 1; } },
    alertRuntime: await rootHeldVapid(root) });
  try { assert.equal(recovered, 1); assert.ok(await lstat(join(root, "updater-state/control.sock"))); }
  finally { await updater.stop(); }
});

test("the main loop does not poll the runner while Off and rejects a risk-increasing request", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "Off\n");
  await mkdir(join(root, "releases/r7"), { recursive: true }); await symlink("releases/r7", join(root, "current"));
  await writeFile(join(root, "updater-state/guard-status.json"), JSON.stringify({
    schema: "control-room.guard-status/v1", updaterRestartsLastHour: 2, at: Math.floor(Date.now() / 1000),
  }));
  const stateFiles = new UpdaterStateFilesV1(root, "lease-one"), store = new MemoryStore(undefined);
  store.requests = [{ id: "owner-request:00000000-0000-4000-8000-000000000001", request_kind: "resume" }];
  let runnerCalls = 0, actionCalls = 0, watcherCalls = 0;
  const loop = new UpdaterMainLoopV1({ runner: { async runOnce() { runnerCalls += 1; return { status: "idle" }; } }, store, stateFiles,
    mode: new UpdaterModeV1(), ownerActions: { async handle() { actionCalls += 1; } }, watcher: { async tick() { watcherCalls += 1; } } });
  assert.equal((await loop.tick()).status, "idle"); assert.equal(runnerCalls, 0); assert.equal(actionCalls, 0);
  assert.equal(watcherCalls, 0, "Off never invokes the source watcher");
  assert.equal(store.finished[1], "refused");
  const status = JSON.parse(await readFile(join(root, "status/status.json"), "utf8"));
  assert.equal(status.releaseId, "r7"); assert.equal(status.updaterRestartsLastHour, 2);
  await writeFile(join(root, "updater-state/rescued.json"), "{}\n");
  assert.equal((await loop.tick()).status, "uncertain", "the Off flag cannot hide a rescue marker");
  assert.equal(runnerCalls, 1, "a rescued active run is measured, never advanced by the watcher/build path");
  assert.equal(watcherCalls, 0, "even the rescue path does not wake the watcher while Off");
});

test("the production call shape starts the REAL alert sender; only an explicit null or false turns it off", async t => {
  // Review blocker 1. The old ternary read the ABSENCE of the `alerts` key as
  // "off" and an explicit `null` as "on", so the production entry point — which
  // passes no options — started with `alerts === null` and no alert could ever
  // fire. The default path below is the shape `src/updater/v1/updater.mjs` uses
  // when it is invoked as a program: no `alerts` key at all.
  const root = await temporaryRoot(t);
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  const store = new MemoryStore();
  // The started updaters are stopped in a `finally`, so a FAILING assertion —
  // which is exactly what a guard mutation produces — cannot leak a 5s loop
  // timer and hang the test runner instead of reporting the failure.
  const started = [];
  t.after(async () => { for (const updater of started.splice(0)) await updater.stop().catch(() => {}); });
  const updater = await startUpdaterV1({ root, store,
    identity: { bootId: "boot-wiring", leaseToken: "lease-new" },
    alertRuntime: await rootHeldVapid(root) });
  started.push(updater);
  assert.ok(updater.alerts, "no `alerts` key means the real sender, not null");
  assert.equal(updater.alerts.constructor.name, "UpdaterAlertSenderV1");
  assert.equal(updater.alerts.root, root, "it is bound to the real root");
  assert.equal(updater.loop.alerts, updater.alerts, "the main loop drives the same sender");
  await updater.stop();
  // An explicit opt-out still works, for a caller that supplies its own port.
  for (const optOut of [{ alerts: null }, { alerts: false }]) {
    const off = await startUpdaterV1({ root, store, ...optOut, alertRuntime: await rootHeldVapid(root) });
    started.push(off);
    assert.equal(off.alerts, null, `explicit ${JSON.stringify(optOut)} turns the sender off`);
    assert.equal(off.loop.alerts, null);
    await off.stop();
  }
});

test("startup refuses a VAPID key that is not root-held, and does not strand the lease", async t => {
  // The custody gate the review found was dead code. A key readable by anyone
  // but root is a refusal, and it must happen BEFORE the session lease is taken
  // so a refusal cannot leave a second updater permanently locked out.
  const root = await temporaryRoot(t);
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  const key = join(root, "updater-state/vapid.json");
  await writeFile(key, `${JSON.stringify(ROOT_VAPID)}\n`, { mode: 0o644 });
  const store = new MemoryStore();
  let acquired = 0;
  store.acquire = async token => { acquired += 1; return { status: "acquired", run: store.run, leaseToken: token }; };
  // Both attempts below are expected to REFUSE, so nothing is started — but if a
  // guard mutation makes one of them start instead, the updater it returns owns
  // a 5s loop timer. Registering every successful start means a broken guard is
  // reported as a failed assertion rather than as a hung test runner.
  const started = [];
  t.after(async () => { for (const updater of started.splice(0)) await updater.stop().catch(() => {}); });
  const start = async options => {
    const updater = await startUpdaterV1({ root, store, ...options });
    started.push(updater); return updater;
  };
  await assert.rejects(start({ alertRuntime: { getuid: () => 0,
    lstat: async path => Object.assign(await lstat(path), { uid: 0 }) } }),
  /updater_vapid_permissions_refused/u);
  assert.equal(acquired, 0, "the key is checked before the updater takes its lease");
  await chmod(key, 0o600);
  await assert.rejects(start({ alertRuntime: { getuid: () => 501 } }),
    /updater_vapid_not_root/u);
  assert.equal(acquired, 0);
});

test("a missing VAPID key is a warning, not a refusal: the updater still runs its release", async t => {
  // §15 item 21: install-night pushes come from item 8's minimal sender, and the
  // key is written by the installer. A not-yet-installed key must not stop the
  // updater from applying the release it was woken for.
  const root = await temporaryRoot(t);
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  const warnings = [];
  const store = new MemoryStore();
  const updater = await startUpdaterV1({ root, store, onTimerError: error => warnings.push(error.code),
    alertRuntime: { getuid: () => 0 } });
  try {
    assert.equal(updater.alerts, null, "no sender without a key, so no send is attempted");
    assert.deepEqual(warnings, ["updater_vapid_unavailable"], "the absence is reported once, as a warning");
  } finally { await updater.stop(); }
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

test("the main loop feeds updater and health facts to the alert sender without trusting free-form text", async () => {
  const facts = [], alerts = { async reconcile(value) { facts.push(value); }, async tick() {} };
  const loop = new UpdaterMainLoopV1({ runner: { async runOnce() { return { status: "uncertain" }; } },
    store: new MemoryStore(undefined), stateFiles: { readSelfUpdate: async () => "On\n", hasRescueMarker: async () => false,
      publicFacts: async () => ({}), async writeStatus() {} }, mode: new UpdaterModeV1(), ownerActions: { async handle() {} },
    alerts, alertFacts: async () => ({ webDown: true, backupMissing: true }) });
  await loop.tick();
  assert.deepEqual(facts, [{ webDown: true, backupMissing: true, needsOwner: false, uncertain: true, rescue: false }]);
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

test("a torn final file entry resumes the production updater loop without asking the owner to repair history", async t => {
  const root = await temporaryRoot(t); await writeFile(join(root, "updater-state/self-update"), "On\n");
  const journal = new FileStepJournalV1(root, { ownerUid: process.getuid() });
  const runId = "run:00000000-0000-4000-8000-000000000001";
  await journal.done({ runId, ordinal: 1, state: "staged", detail: {} });
  const path = join(root, "updater-state/journal.jsonl"), prefix = await readFile(path);
  await writeFile(path, Buffer.concat([prefix, Buffer.from('{"schema":"control-room.updater-journal/v1","kind":"intent"')]));
  const store = new MemoryStore({ ...makeRun(), state: "staged" }), effects = new Effects();
  const updater = await startUpdaterV1({ root, store, journal, effects, referee: { async assertPlanAllowed() {} },
    alertRuntime: await rootHeldVapid(root) });
  try {
    assert.equal(updater.loop.lastOutcome.status, "succeeded");
    assert.equal(store.run.state, "succeeded");
    assert.ok((await readFile(path)).subarray(0, prefix.length).equals(prefix));
    assert.equal((await readdir(join(root, "updater-state"))).some(name => name.startsWith("journal.jsonl.poisoned-")), false);
    const status = JSON.parse(await readFile(join(root, "status/status.json"), "utf8"));
    assert.equal(status.needsYou, false);
  } finally { await updater.stop(); }
});


test("R5S-06: forty partial status failures preserve the old status and leave no temporary files", async t => {
  const root = await temporaryRoot(t), path = join(root, "status/status.json"), original = fsPromises.open;
  await atomicWriteNoFollowV1(root, "status/status.json", "old status\n");
  let closed = 0;
  fsPromises.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).includes("/.status.json.")) {
      const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
      handle.writeFile = async content => { await write(String(content).slice(0, 16));
        throw Object.assign(new Error("partial_disk_full"), { code: "ENOSPC" }); };
      let counted = false;
      handle.close = async () => { await close(); if (!counted) { closed += 1; counted = true; } };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await Promise.all(Array.from({ length: 40 }, () => assert.rejects(
      atomicWriteNoFollowV1(root, "status/status.json", '{"state":"running","selfUpdate":"Off"}\n'), { code: "ENOSPC" })));
    assert.equal(closed, 40);
    assert.deepEqual(await readdir(join(root, "status")), ["status.json"]);
    assert.equal(await readFile(path, "utf8"), "old status\n");
  } finally { fsPromises.open = original; syncBuiltinESMExports(); }
  await atomicWriteNoFollowV1(root, "status/status.json", "retry status\n");
  assert.deepEqual(await readdir(join(root, "status")), ["status.json"]);
  assert.equal(await readFile(path, "utf8"), "retry status\n");
});

test("R5S-06: sync, close, chmod and rename failures clean owned temporaries before retry", async t => {
  for (const fault of ["sync", "close", "chmod", "rename"]) {
    await t.test(fault, async t => {
      const root = await temporaryRoot(t), path = join(root, "status/status.json");
      await atomicWriteNoFollowV1(root, "status/status.json", "old status\n");
      const originalOpen = fsPromises.open, originalChmod = fsPromises.chmod, originalRename = fsPromises.rename;
      let closed = false, injected = false;
      const fail = () => { injected = true; throw Object.assign(new Error("injected_status_failure"), { code: "EIO" }); };
      fsPromises.open = async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).includes("/.status.json.")) {
          const close = handle.close.bind(handle);
          handle.close = async () => { if (fault === "close" && !injected) fail(); await close(); closed = true; };
          if (fault === "sync") handle.sync = async () => fail();
        }
        return handle;
      };
      if (fault === "chmod") fsPromises.chmod = async () => fail();
      if (fault === "rename") fsPromises.rename = async () => fail();
      syncBuiltinESMExports();
      try {
        await assert.rejects(atomicWriteNoFollowV1(root, "status/status.json", "new status\n"), { code: "EIO" });
        assert.equal(closed, true);
        assert.equal(await readFile(path, "utf8"), "old status\n");
        assert.deepEqual(await readdir(join(root, "status")), ["status.json"]);
      } finally {
        fsPromises.open = originalOpen; fsPromises.chmod = originalChmod; fsPromises.rename = originalRename;
        syncBuiltinESMExports();
      }
      await atomicWriteNoFollowV1(root, "status/status.json", "retry status\n");
      assert.equal(await readFile(path, "utf8"), "retry status\n");
    });
  }
});


test("R5S-06: publication cleanup never removes a replacement at the old temporary name", async t => {
  const root = await temporaryRoot(t), original = fsPromises.rename; let replacement;
  fsPromises.rename = async (from, to) => {
    await original(from, to); replacement = from;
    await writeFile(from, "unowned replacement", { mode: 0o600 });
  };
  syncBuiltinESMExports();
  try {
    await atomicWriteNoFollowV1(root, "status/status.json", "published status\n");
    assert.equal(await readFile(replacement, "utf8"), "unowned replacement");
    assert.equal(await readFile(join(root, "status/status.json"), "utf8"), "published status\n");
  } finally { fsPromises.rename = original; syncBuiltinESMExports(); }
});


test("R5S-06: failed write cleanup preserves a substituted temporary inode", async t => {
  const root = await temporaryRoot(t);
  const original = fsPromises.open; let replacement;
  fsPromises.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).includes("/.status.json.")) handle.writeFile = async () => {
      replacement = args[0]; await fsPromises.rename(replacement, `${replacement}.owned`);
      await writeFile(replacement, "unowned replacement", { mode: 0o600 });
      throw Object.assign(new Error("partial_disk_full"), { code: "ENOSPC" });
    };
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(atomicWriteNoFollowV1(root, "status/status.json", "new status\n"), { code: "ENOSPC" });
    assert.equal(await readFile(replacement, "utf8"), "unowned replacement");
  } finally { fsPromises.open = original; syncBuiltinESMExports(); }
});
