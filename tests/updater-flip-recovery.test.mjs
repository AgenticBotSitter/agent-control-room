import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ATTENDED_LINKS_V1, AttendedUpdaterFlipV1 } from "../src/updater/v1/attended-flip.mjs";
import { canonicalJsonV1 } from "../src/updater/v1/cli.mjs";
import { execGuardV1, guardScratchV1 } from "./support/updater-guard.mjs";
import { guardStatStandInV1 } from "../src/updater/v1/rehearsal/guard-ownership-fixture.mjs";
import { UpdaterMainLoopV1, UpdaterModeV1, UpdaterStateFilesV1 } from "../src/updater/v1/runtime.mjs";
import { UpdaterActuatorV1 } from "../src/updater/v1/actuator.mjs";
import { noteSelfUpgradeHealthV1 } from "../src/updater/v1/selfupgrade-state.mjs";
import { acquireKernelFileLockV1 } from "../src/installer/shared/private-process-lock.mjs";

const guard = join(process.cwd(), "src/updater/v1/guard/guard.sh");
const bootClock = () => ({ bootId: "test-boot", startedMono: 20000 });
const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const read = async path => JSON.parse(await readFile(path, "utf8"));
const links = ATTENDED_LINKS_V1.map((link, index) => ({ link, from: `old-${index}`, to: `new-${index}` }));

async function fixture(t) {
  const root = await guardScratchV1(t, "r7u"), bin = join(root, "fake-bin");
  for (const name of ["fake-bin", "updater-state/plans", "updater-state/confirmations", "updater", "runtime", "status"])
    await mkdir(join(root, name), { recursive: true });
  const commands = { uname: "echo Darwin", lockf: 'exec /usr/bin/lockf "$@"', stat: guardStatStandInV1(),
    clock: 'echo "${GUARD_BOOT:-test-boot} ${GUARD_ELAPSED:-20400}"',
    date: 'case "$1" in -u) echo 2026-10-03T12:00:00Z ;; *) echo 20000 ;; esac',
    launchctl: 'printf "%s\\n" "$*" >> "$CONTROL_ROOM_GUARD_ROOT/launchctl.log"; exit 0' };
  for (const [name, body] of Object.entries(commands)) {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`); await chmod(join(bin, name), 0o500);
  }
  for (const item of links) await symlink(item.to, join(root, item.link));
  await writeFile(join(root, "updater-state/heartbeat"), "stale");
  await writeFile(join(root, "updater-state/guard-heartbeat-observed"), "test-boot 20000 20000\n");
  await writeFile(join(root, "updater-state/self-update"), "Off\n");
  return { root, bin };
}
async function writeAttempt(f, overrides = {}, active = {}) {
  const record = { schema: "control-room.selfupgrade/v1", phase: "flipping", at: "2026-10-03T12:00:00.000Z",
    attemptId: "attempt-one", ...bootClock(), healthPassed: false, linkCount: links.length, links, ...overrides };
  await writeFile(join(f.root, "updater-state/selfupgrade.json"), JSON.stringify(record));
  await writeFile(join(f.root, "updater-state/selfupgrade-attempt.json"), JSON.stringify({
    schema: "control-room.selfupgrade-attempt/v1", attemptId: record.attemptId, bootId: record.bootId,
    startedMono: record.startedMono, ...active }));
  return record;
}
async function pointers(f) { return Promise.all(links.map(item => readlink(join(f.root, item.link)))); }
async function watch(f, extra = {}) {
  try {
    return { ...(await execGuardV1("/bin/sh", ["-p", guard, "watch"], { timeout: 10_000, env: {
      CONTROL_ROOM_GUARD_TESTING: "1", CONTROL_ROOM_GUARD_ROOT: f.root, CONTROL_ROOM_GUARD_TEST_BIN: f.bin,
      CONTROL_ROOM_GUARD_TEST_PATH: f.bin, CONTROL_ROOM_GUARD_TEST_LABEL_PREFIX: "xyz.agentcontrolroom.rehearsal.test",
      CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", GUARD_MTIME: "20000", ...extra,
    } })), code: 0 };
  } catch (error) { if (typeof error.code !== "number") throw error; return error; }
}

test("I01: the current unhealthy attempt waits for two observations before reverting and reports it", async t => {
  const f = await fixture(t); await writeAttempt(f);
  await unlink(join(f.root, "updater-state/guard-heartbeat-observed"));
  assert.equal((await watch(f, { GUARD_ELAPSED: "20000" })).code, 0);
  assert.deepEqual(await pointers(f), links.map(item => item.to));
  assert.equal((await watch(f, { GUARD_ELAPSED: "20100" })).code, 0);
  assert.deepEqual(await pointers(f), links.map(item => item.to));
  const result = await watch(f); assert.notEqual(result.code, 0);
  assert.match(result.stderr, /previous runtime.*unhealthy self-update/u);
  const record = await read(join(f.root, "updater-state/selfupgrade.json"));
  assert.equal(record.phase, "reverted"); assert.equal(record.state, "needs_attention");
  assert.equal(record.reason, "updater_selfupgrade_reverted"); assert.deepEqual(await pointers(f), links.map(item => item.from));
});

test("the guard syncs each flip record locally and refuses a failed sync before touching links", async t => {
  const f = await fixture(t); await writeAttempt(f);
  const command = join(f.bin, "sync-record");
  await writeFile(command, '#!/bin/sh\nprintf "sync\\n" >> "$CONTROL_ROOM_GUARD_ROOT/record-sync.log"\nexec /usr/bin/perl "$@"\n', { mode: 0o500 });
  assert.notEqual((await watch(f)).code, 0);
  assert.equal((await readFile(join(f.root, "record-sync.log"), "utf8")).trim().split("\n").length, 4);
  const refused = await fixture(t); await writeAttempt(refused);
  await writeFile(join(refused.bin, "sync-record"), "#!/bin/sh\nexit 73\n", { mode: 0o500 });
  const result = await watch(refused); assert.notEqual(result.code, 0); assert.match(result.stderr, /guard_refused:selfupgrade_record_failed/u);
  assert.deepEqual(await pointers(refused), links.map(item => item.to));
});

test("I02/I03/J03: a consumed flip never replays against a later working install", async t => {
  const f = await fixture(t); await writeAttempt(f); assert.notEqual((await watch(f)).code, 0);
  for (const item of links) { await unlink(join(f.root, item.link)); await symlink(item.to, join(f.root, item.link)); }
  const consumed = await readFile(join(f.root, "updater-state/selfupgrade.json"), "utf8");
  for (const elapsed of [22000, 26000, 40000]) {
    await writeFile(join(f.root, "updater-state/guard-heartbeat-observed"), `test-boot ${elapsed - 400} 20000\n`);
    await watch(f, { GUARD_ELAPSED: String(elapsed) });
    assert.deepEqual(await pointers(f), links.map(item => item.to));
    assert.equal(await readFile(join(f.root, "updater-state/selfupgrade.json"), "utf8"), consumed);
  }
  // Drive the real status loop over the guard's actual receipt, even while Off.
  const files = new UpdaterStateFilesV1(f.root, "lease-one"), mode = new UpdaterModeV1(files); await mode.initialize();
  const loop = new UpdaterMainLoopV1({ stateFiles: files, mode, runner: { runOnce: async () => ({ status: "idle" }) },
    store: { unhandledOwnerRequests: async () => [] }, ownerActions: { handle: async () => {} } });
  await loop.tick(); const status = await read(join(f.root, "status/status.json"));
  assert.equal(status.state, "needs_attention"); assert.equal(status.nextAction, "review_recovery"); assert.equal(status.needsYou, true);
});

test("stale, superseded, healthy and unprovable records are settled without moving links", async t => {
  const cases = [
    ["older boot", { bootId: "older-boot" }, {}, "updater_selfupgrade_previous_boot"],
    ["older than bound", { startedMono: 19499 }, {}, "updater_selfupgrade_expired"],
    ["clock reset", { startedMono: 20401 }, {}, "updater_selfupgrade_expired"],
    ["different attempt", {}, { attemptId: "attempt-two" }, "updater_selfupgrade_superseded"],
    ["different attempt start", {}, { startedMono: 20001 }, "updater_selfupgrade_superseded"],
    ["different attempt boot", {}, { bootId: "other-boot" }, "updater_selfupgrade_superseded"],
    ["different attempt schema", {}, { schema: "invalid" }, "updater_selfupgrade_superseded"],
    ["missing attempt schema", {}, { schema: undefined }, "updater_selfupgrade_superseded"],
    ["missing attempt id", {}, { attemptId: undefined }, "updater_selfupgrade_superseded"],
    ["missing attempt boot", {}, { bootId: undefined }, "updater_selfupgrade_superseded"],
    ["missing attempt start", {}, { startedMono: undefined }, "updater_selfupgrade_superseded"],
    ["health since flip", { healthPassed: true }, {}, "updater_selfupgrade_healthy"],
    ["legacy unbound", { bootId: null, startedMono: null, attemptId: null }, {}, "updater_selfupgrade_unproven"],
    ["missing health", { healthPassed: null }, {}, "updater_selfupgrade_unproven"],
    ["invalid start", { startedMono: "invalid" }, {}, "updater_selfupgrade_unproven"],
  ];
  for (const [name, record, active, reason] of cases) await t.test(name, async t => {
    const f = await fixture(t); await writeAttempt(f, record, active);
    assert.equal((await watch(f)).code, 0); assert.deepEqual(await pointers(f), links.map(item => item.to));
    const settled = await read(join(f.root, "updater-state/selfupgrade.json"));
    assert.equal(settled.phase, "settled"); assert.equal(settled.reason, reason);
  });
});

test("the fixed age bound includes 900 seconds, and settlement happens even with a fresh heartbeat", async t => {
  const current = await fixture(t); await writeAttempt(current, { startedMono: 19500 });
  assert.notEqual((await watch(current)).code, 0); assert.deepEqual(await pointers(current), links.map(item => item.from));
  const stale = await fixture(t); await writeAttempt(stale, { startedMono: 19499 });
  await unlink(join(stale.root, "updater-state/guard-heartbeat-observed"));
  assert.equal((await watch(stale)).code, 0); assert.equal((await read(join(stale.root, "updater-state/selfupgrade.json"))).phase, "settled");
});

test("a missing attempt, already restored links, or a moved link cannot authorize a revert", async t => {
  for (const damage of ["missing_attempt", "already_from", "moved_link"]) await t.test(damage, async t => {
    const f = await fixture(t); await writeAttempt(f);
    if (damage === "missing_attempt") await unlink(join(f.root, "updater-state/selfupgrade-attempt.json"));
    else for (const item of damage === "already_from" ? links : links.slice(0, 1)) {
      await unlink(join(f.root, item.link)); await symlink(damage === "already_from" ? item.from : "newer-version", join(f.root, item.link));
    }
    const before = await pointers(f); assert.equal((await watch(f)).code, 0); assert.deepEqual(await pointers(f), before);
    assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).phase, "settled");
  });
});

test("malformed link sets are refused before changing the first link", async t => {
  for (const damage of ["bad_second", "bad_target", "unsupported_link", "duplicate", "bad_count"]) await t.test(damage, async t => {
    const f = await fixture(t), invalid = links.map(item => ({ ...item }));
    if (damage === "bad_second") invalid[1].from = "../outside";
    if (damage === "bad_target") invalid[1].to = "../outside";
    if (damage === "unsupported_link") {
      invalid[1].link = "runtime/unknown-current";
      await symlink(invalid[1].to, join(f.root, invalid[1].link));
    }
    if (damage === "duplicate") invalid[1].link = invalid[0].link;
    await writeAttempt(f, { links: invalid, ...(damage === "bad_count" ? { linkCount: 0 } : {}) });
    assert.notEqual((await watch(f)).code, 0); assert.deepEqual(await pointers(f), links.map(item => item.to));
  });
});

test("damaged flip evidence refuses every link move while a stale updater can still restart", async t => {
  for (const evidence of ["{", JSON.stringify({ schema: "invalid", phase: "flipping" }),
    JSON.stringify({ schema: "control-room.selfupgrade/v1" })]) await t.test(evidence, async t => {
    const f = await fixture(t); await writeFile(join(f.root, "updater-state/selfupgrade.json"), evidence);
    for (const elapsed of [20000, 20100, 20400]) {
      if (elapsed === 20000) await unlink(join(f.root, "updater-state/guard-heartbeat-observed"));
      const result = await watch(f, { GUARD_ELAPSED: String(elapsed) });
      assert.notEqual(result.code, 0); assert.match(result.stderr, /guard_refused:malformed_state/u);
      assert.deepEqual(await pointers(f), links.map(item => item.to));
      assert.equal(await readFile(join(f.root, "updater-state/selfupgrade.json"), "utf8"), evidence);
      if (elapsed !== 20400) await assert.rejects(readFile(join(f.root, "launchctl.log")), { code: "ENOENT" });
    }
    assert.match(await readFile(join(f.root, "launchctl.log"), "utf8"), /kickstart/u);
  });
});

test("an interrupted revert retains attention and resumes only the remaining links once", async t => {
  const f = await fixture(t); await writeAttempt(f, { phase: "reverting", state: "needs_attention", reason: "updater_selfupgrade_reverted" });
  for (const item of links.slice(0, 2)) { await unlink(join(f.root, item.link)); await symlink(item.from, join(f.root, item.link)); }
  assert.notEqual((await watch(f)).code, 0); assert.deepEqual(await pointers(f), links.map(item => item.from));
  assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).state, "needs_attention");
});

test("a reverted intent that expires or crosses a boot keeps attention while settling without further moves", async t => {
  for (const state of [{ bootId: "older-boot" }, { startedMono: 19499 }]) await t.test(JSON.stringify(state), async t => {
    const f = await fixture(t); await writeAttempt(f, { ...state, phase: "reverting", state: "needs_attention",
      reason: "updater_selfupgrade_reverted" });
    assert.equal((await watch(f)).code, 0); assert.deepEqual(await pointers(f), links.map(item => item.to));
    const record = await read(join(f.root, "updater-state/selfupgrade.json"));
    assert.equal(record.phase, "settled"); assert.equal(record.state, "needs_attention"); assert.equal(record.reason, "updater_selfupgrade_reverted");
  });
});

test("a later successful full health check on the new bundle permanently ends automatic revert authority", async t => {
  const f = await fixture(t); await writeAttempt(f);
  const pair = { releaseId: "r1", pgDataId: "p1", schemaDigest: `sha256:${"1".repeat(64)}` };
  const actuator = new UpdaterActuatorV1({ root: f.root, health: async () => true });
  assert.equal(await actuator.health({ run_id: "run-one", detail: { from: pair, to: pair, releaseBytes: 1024 } }), true);
  assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).healthPassed, true);
  assert.equal((await watch(f)).code, 0); assert.deepEqual(await pointers(f), links.map(item => item.to));
  assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).reason, "updater_selfupgrade_healthy");
});

test("a health acknowledgement refuses a superseded attempt or malformed link set without changing its record", async t => {
  for (const damage of ["record_schema", "active_schema", "attempt", "boot", "start", "shape", "empty", "too_many", "duplicate", "link", "moved"])
    await t.test(damage, async t => {
    const f = await fixture(t); await writeAttempt(f);
    const recordPath = join(f.root, "updater-state/selfupgrade.json");
    if (["active_schema", "attempt", "boot", "start"].includes(damage)) {
      const activePath = join(f.root, "updater-state/selfupgrade-attempt.json"), active = await read(activePath);
      if (damage === "attempt") active.attemptId = "other-attempt";
      if (damage === "boot") active.bootId = "other-boot";
      if (damage === "start") active.startedMono += 1;
      if (damage === "active_schema") active.schema = "invalid";
      await writeFile(activePath, JSON.stringify(active));
    } else if (damage === "moved") {
      await unlink(join(f.root, links[0].link)); await symlink("newer-version", join(f.root, links[0].link));
    } else {
      const record = await read(recordPath);
      if (damage === "record_schema") record.schema = "invalid";
      if (damage === "shape") record.linkCount = 6;
      if (damage === "empty") { record.links = []; record.linkCount = 0; }
      if (damage === "too_many") { record.links.push(record.links[0]); record.linkCount = 6; }
      if (damage === "duplicate") record.links[1] = record.links[0];
      if (damage === "link") record.links[1].link = "outside";
      if (damage === "link") await symlink(record.links[1].to, join(f.root, "outside"));
      await writeFile(recordPath, JSON.stringify(record));
    }
    const before = await readFile(recordPath, "utf8");
    await assert.rejects(noteSelfUpgradeHealthV1(f.root, "attempt-one")); assert.equal(await readFile(recordPath, "utf8"), before);
  });
});

test("a health acknowledgement cannot overlap a guard transaction", async t => {
  const f = await fixture(t); await writeAttempt(f);
  const lock = await acquireKernelFileLockV1(join(f.root, "updater-state/guard.lock"));
  try { await assert.rejects(noteSelfUpgradeHealthV1(f.root, "attempt-one"), { code: "updater_flip_guard_busy" }); }
  finally { await lock.release(); }
  assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).healthPassed, false);
});

test("20 concurrent guard watches consume one flip and retain its durable attention record", { timeout: 30_000 }, async t => {
  const f = await fixture(t); await writeAttempt(f);
  const results = await Promise.all(Array.from({ length: 20 }, () => watch(f)));
  assert.equal(results.filter(result => /previous runtime.*unhealthy self-update/u.test(result.stderr ?? "")).length, 1);
  assert.deepEqual(await pointers(f), links.map(item => item.from));
  assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).phase, "reverted");
});

async function flipInput(f) {
  const directory = join(f.root, "bundle"); await mkdir(directory);
  const body = "export const version = 2;\n"; await writeFile(join(directory, "updater.mjs"), body, { mode: 0o500 });
  const manifest = { schema: "control-room.updater-bundle-manifest/v1", files: [
    { path: "updater.mjs", type: "file", mode: 0o500, sha256: digest(body) } ] };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  const plan = { schema: "control-room.install-plan/v2", planId: "plan-one", kind: "updater" };
  await writeFile(join(f.root, "updater-state/plans/plan-one.json"), JSON.stringify(plan));
  await writeFile(join(f.root, "updater-state/confirmations/plan-one.json"), JSON.stringify({ planId: "plan-one", confirmed: true,
    planDigest: digest(canonicalJsonV1(plan)) }));
  for (const item of links) { await unlink(join(f.root, item.link)); await symlink(item.from, join(f.root, item.link)); }
  return { planId: "plan-one", version: "u2", bundleDirectory: directory, expectedBundleDigest: digest(JSON.stringify(manifest)),
    links: links.map(({ link, to }) => ({ link, to })) };
}

test("F03/J01/J02: the real flip binds each interrupted phase; completing and pre-stage failures stay inert", async t => {
  for (const failed of ["stage", "restart", "first_health", "later_health", "none"]) await t.test(failed, async t => {
    const f = await fixture(t), input = await flipInput(f);
    const operations = { stage: async () => { if (failed === "stage") throw new Error("stage interrupted"); },
      restart: async () => { if (failed === "restart") throw new Error("restart interrupted"); },
      fullHealth: async ({ sample }) => !(failed === "first_health" || failed === "later_health" && sample === 1),
      waitForNextHeartbeat: async () => {} };
    const flip = new AttendedUpdaterFlipV1({ root: f.root, operations, bootClock });
    if (failed === "none") await flip.run(input); else await assert.rejects(flip.run(input));
    if (failed === "stage") {
      await assert.rejects(readFile(join(f.root, "updater-state/selfupgrade.json")), { code: "ENOENT" });
      assert.equal((await watch(f)).code, 0); assert.deepEqual(await pointers(f), links.map(item => item.from)); return;
    }
    const record = await read(join(f.root, "updater-state/selfupgrade.json"));
    assert.equal(record.bootId, "test-boot"); assert.equal(record.startedMono, 20000);
    assert.equal((await read(join(f.root, "updater-state/selfupgrade-attempt.json"))).attemptId, record.attemptId);
    assert.equal(record.healthPassed, ["none", "later_health"].includes(failed));
    const result = await watch(f);
    if (["restart", "first_health"].includes(failed)) {
      assert.notEqual(result.code, 0); assert.deepEqual(await pointers(f), links.map(item => item.from));
    } else {
      assert.equal(result.code, 0); assert.deepEqual(await pointers(f), links.map(item => item.to));
      assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).phase, failed === "none" ? "done" : "settled");
    }
  });
});

test("50 concurrent attended callers admit one attempt; a failure releases its lock for retry", async t => {
  const f = await fixture(t), input = await flipInput(f); let entered, release;
  const staged = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const operations = { stage: async () => { entered(); await gate; throw new Error("stage interrupted"); },
    restart: async () => {}, fullHealth: async () => true, waitForNextHeartbeat: async () => {} };
  const first = new AttendedUpdaterFlipV1({ root: f.root, operations, bootClock }).run(input).catch(error => error);
  await staged;
  const timer = setTimeout(release, 2000);
  const other = await Promise.all(Array.from({ length: 49 }, () => new AttendedUpdaterFlipV1({ root: f.root, operations, bootClock })
    .run(input).then(() => "unexpected", error => error.code))).finally(() => clearTimeout(timer));
  release(); assert.match((await first).message, /stage interrupted/u);
  assert.ok(other.every(code => code === "updater_flip_busy"));
  operations.stage = async () => {};
  await new AttendedUpdaterFlipV1({ root: f.root, operations, bootClock }).run(input);
  assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).phase, "done");
});

test("a late health result cannot erase the guard's revert record", async t => {
  const f = await fixture(t), input = await flipInput(f); let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  const operations = { stage: async () => {}, restart: async () => {}, fullHealth: async () => { enter(); await gate; return true; },
    waitForNextHeartbeat: async () => {} };
  const running = new AttendedUpdaterFlipV1({ root: f.root, operations, bootClock }).run(input).catch(error => error);
  await entered;
  try { assert.notEqual((await watch(f)).code, 0); } finally { finish(); }
  assert.equal((await running).code, "updater_flip_attempt_settled");
  const consumed = await read(join(f.root, "updater-state/selfupgrade.json"));
  await assert.rejects(noteSelfUpgradeHealthV1(f.root, consumed.attemptId), { code: "updater_flip_attempt_settled" });
  assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).state, "needs_attention");
  assert.deepEqual(await pointers(f), links.map(item => item.from));
});

test("a healthy attempt settled by the guard can finish its remaining health samples", async t => {
  const f = await fixture(t), input = await flipInput(f); let observed = false;
  const operations = { stage: async () => {}, restart: async () => {}, fullHealth: async () => true,
    waitForNextHeartbeat: async () => { if (!observed) {
      observed = true; assert.equal((await watch(f)).code, 0);
      assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).reason, "updater_selfupgrade_healthy");
    } } };
  await new AttendedUpdaterFlipV1({ root: f.root, operations, bootClock }).run(input);
  assert.equal((await read(join(f.root, "updater-state/selfupgrade.json"))).phase, "done");
  assert.deepEqual(await pointers(f), links.map(item => item.to));
});

test("final completion rereads attempt, phase and health before replacing a recovery record", async t => {
  for (const damage of [{ attemptId: "other-attempt" }, { phase: "reverted" }, { healthPassed: false }])
    await t.test(JSON.stringify(damage), async t => {
      const f = await fixture(t), input = await flipInput(f), path = join(f.root, "updater-state/selfupgrade.json");
      const handle = await open(join(f.root, "read-fixture"), "w+"), prototype = Object.getPrototypeOf(handle);
      const original = prototype.readFile; await handle.close(); let observations = 0, recovered;
      prototype.readFile = async function (...args) {
        const bytes = await original.apply(this, args);
        let value; try { value = JSON.parse(String(bytes)); } catch { return bytes; }
        if (value.schema !== "control-room.selfupgrade/v1" || ++observations !== 4) return bytes;
        recovered = { ...value, ...damage, state: "needs_attention", reason: "updater_selfupgrade_reverted" };
        await writeFile(path, JSON.stringify(recovered));
        return typeof bytes === "string" ? JSON.stringify(recovered) : Buffer.from(JSON.stringify(recovered));
      };
      try {
        await assert.rejects(new AttendedUpdaterFlipV1({ root: f.root, bootClock, operations: {
          stage: async () => {}, restart: async () => {}, fullHealth: async () => true, waitForNextHeartbeat: async () => {},
        } }).run(input), { code: "updater_flip_attempt_settled" });
      } finally { prototype.readFile = original; }
      assert.equal(observations, 4); assert.deepEqual(await read(path), recovered);
    });
});

test("an unavailable or malformed boot clock cannot arm automatic rollback", async t => {
  const f = await fixture(t), input = await flipInput(f), operations = { stage: async () => {}, restart: async () => {},
    fullHealth: async () => true, waitForNextHeartbeat: async () => {} };
  for (const clock of [() => ({ bootId: "invalid boot", startedMono: 2 }), () => ({ bootId: "test-boot", startedMono: -1 })])
    await assert.rejects(new AttendedUpdaterFlipV1({ root: f.root, operations, bootClock: clock }).run(input), { code: "updater_flip_clock_refused" });
  assert.deepEqual(await pointers(f), links.map(item => item.from));
});
