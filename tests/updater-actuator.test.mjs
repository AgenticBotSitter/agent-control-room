import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectOldReleasesV1, DiskReserveV1, PairHistoryV1, UpdaterActuatorV1 }
  from "../src/updater/v1/actuator.mjs";
import { recoverPairLinksV1, switchPairLinksV1 } from "../src/updater/v1/release-layout.mjs";

const digest = value => `sha256:${String(value).padStart(64, "0")}`;
const pair = (releaseId, pgDataId, value = pgDataId.slice(-1)) => ({ releaseId, pgDataId, schemaDigest: digest(value) });

async function fixtureV1(t, { releases = ["r0", "r1", "r2", "r3"], data = ["p0", "p1", "p2", "p3"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "updater-actuator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([mkdir(join(root, "updater-state")), mkdir(join(root, "releases")), mkdir(join(root, "pg"))]);
  for (const id of releases) { await mkdir(join(root, "releases", id)); await writeFile(join(root, "releases", id, "manifest"), id); }
  for (const id of data) await mkdir(join(root, "pg", `data-${id}`));
  await symlink("releases/r2", join(root, "current")); await symlink("releases/r1", join(root, "previous"));
  await symlink("data-p2", join(root, "pg/current"));
  await writeFile(join(root, "updater-state/known-good"), `${JSON.stringify({
    schema: "control-room.known-good/v1", count: 3, pairs: [pair("r0", "p2", 2), pair("r1", "p2", 2), pair("r2", "p2", 2)],
  })}\n`);
  await writeFile(join(root, "rescue-reserve.bin"), Buffer.alloc(4096));
  return root;
}

const runV1 = (to = pair("r3", "p2", 2), extra = {}) => ({ run_id: "run-one", state: "draining", detail: {
  from: pair("r2", "p2", 2), to, releaseBytes: 1024, databaseBytes: 0, databaseClass: "none", ...extra,
} });

function actuatorV1(root, overrides = {}) {
  const calls = [], reserve = overrides.reserve ?? new DiskReserveV1(root, { reserveBytes: 4096,
    minimumHeadroomBytes: 1024, diskFree: async () => 100_000,
    createReserve: async () => writeFile(join(root, "rescue-reserve.bin"), Buffer.alloc(4096)) });
  const services = { quickBackup: async () => calls.push("backup"), drain: async () => calls.push("drain"),
    restart: async () => calls.push("restart"), measure: async () => calls.push("measure"), ...overrides.services };
  const artifacts = { verifySource: async () => calls.push("source"),
    unpackRelease: async (_run, destination) => { calls.push("unpack"); await writeFile(join(destination, "manifest"), "new"); },
    verifyRelease: async () => { calls.push("verify"); }, verifyPair: async () => true, ...overrides.artifacts };
  const actuator = new UpdaterActuatorV1({ root, services, artifacts, reserve,
    health: overrides.health ?? (async () => true), schemaDigest: overrides.schemaDigest ?? (async () => digest(2)),
    history: overrides.history, fault: overrides.fault });
  return { actuator, calls, services, artifacts, reserve };
}

test("pair links resume safely after a kill at every journal and filesystem step", async t => {
  const cuts = ["after_prepared", "after_previous_intent", "after_previous_effect", "after_previous_done",
    "after_database_intent", "after_database_effect", "after_database_done", "after_release_intent",
    "after_release_effect", "after_release_done", "after_completed"];
  for (const cut of cuts) {
    await t.test(cut, async t => {
      const root = await fixtureV1(t); let armed = true;
      await assert.rejects(switchPairLinksV1({ root, operationId: "switch-one", from: pair("r2", "p2", 2),
        to: pair("r3", "p3", 3), fault: step => { if (armed && step === cut) { armed = false;
          throw Object.assign(new Error("killed"), { code: "simulated_kill" }); } } }), /killed/u);
      const recovered = await recoverPairLinksV1(root);
      assert.ok(["completed"].includes(recovered.status), cut);
      assert.equal(await readlink(join(root, "current")), "releases/r3");
      assert.equal(await readlink(join(root, "pg/current")), "data-p3");
      assert.equal(await readlink(join(root, "previous")), "releases/r2");
    });
  }
});

test("an interrupted pair switch rolls back when either target disappears", async t => {
  const root = await fixtureV1(t); let armed = true;
  await assert.rejects(switchPairLinksV1({ root, operationId: "switch-missing", from: pair("r2", "p2", 2),
    to: pair("r3", "p3", 3), fault: step => { if (armed && step === "after_database_done") {
      armed = false; throw Object.assign(new Error("killed"), { code: "simulated_kill" }); } } }), /killed/u);
  await rm(join(root, "releases/r3"), { recursive: true });
  assert.equal((await recoverPairLinksV1(root)).status, "rolled_back");
  assert.equal(await readlink(join(root, "current")), "releases/r2");
  assert.equal(await readlink(join(root, "pg/current")), "data-p2");
});

test("disk admission happens before unpack and a full or stopped unpack leaves no partial release", async t => {
  const root = await fixtureV1(t); await rm(join(root, "releases/r3"), { recursive: true });
  const low = new DiskReserveV1(root, { reserveBytes: 4096,
    minimumHeadroomBytes: 1024, diskFree: async () => 3000 });
  let unpacked = 0;
  const denied = actuatorV1(root, { reserve: low, artifacts: { unpackRelease: async () => { unpacked += 1; } } });
  await assert.rejects(denied.actuator.stage(runV1()), /updater_disk_reserve_low/u);
  assert.equal(unpacked, 0, "no archive byte was unpacked below the reserve threshold");

  const full = actuatorV1(root, { artifacts: { unpackRelease: async (_run, destination) => {
    await writeFile(join(destination, "partial"), "partial"); throw Object.assign(new Error("full"), { code: "ENOSPC" });
  } } });
  await assert.rejects(full.actuator.stage(runV1()), error => error.code === "ENOSPC");
  await assert.rejects(readFile(join(root, "releases/.staging-r3/partial")), /ENOENT/u);
  assert.equal(await readlink(join(root, "current")), "releases/r2");

  const stopped = actuatorV1(root, { artifacts: { unpackRelease: async () => {
    throw Object.assign(new Error("stopped"), { code: "ABORT_ERR" });
  } } });
  await assert.rejects(stopped.actuator.stage(runV1()), error => error.code === "ABORT_ERR");
  const retry = actuatorV1(root); await retry.actuator.stage(runV1());
  assert.equal(await readFile(join(root, "releases/r3/manifest"), "utf8"), "new");

  await unlink(join(root, "rescue-reserve.bin"));
  const sparse = await open(join(root, "rescue-reserve.bin"), "wx", 0o600);
  await sparse.truncate(4096); await sparse.close();
  await assert.rejects(new DiskReserveV1(root, { reserveBytes: 4096 }).assertIntact(),
    /updater_rescue_reserve_refused/u, "a sparse file is not a preallocated rescue reserve");
});

test("planted symlinks in state, releases, staging, database and reserve never escape the root", async t => {
  const cases = [
    ["state", async root => { await unlink(join(root, "updater-state/known-good"));
      await symlink(join(root, "outside"), join(root, "updater-state/known-good"));
      await assert.rejects(new PairHistoryV1(root).knownGood(), /updater_symlink_refused/u); }],
    ["release", async root => { await rm(join(root, "releases/r3"), { recursive: true });
      await symlink(join(root, "outside-dir"), join(root, "releases/r3"));
      await assert.rejects(switchPairLinksV1({ root, operationId: "link-release", from: pair("r2", "p2", 2),
        to: pair("r3", "p3", 3) }), /updater_symlink_refused/u); }],
    ["database", async root => { await rm(join(root, "pg/data-p3"), { recursive: true });
      await symlink(join(root, "outside-dir"), join(root, "pg/data-p3"));
      await assert.rejects(switchPairLinksV1({ root, operationId: "link-database", from: pair("r2", "p2", 2),
        to: pair("r3", "p3", 3) }), /updater_symlink_refused/u); }],
    ["reserve", async root => { await unlink(join(root, "rescue-reserve.bin"));
      await symlink(join(root, "outside"), join(root, "rescue-reserve.bin"));
      await assert.rejects(new DiskReserveV1(root, { reserveBytes: 4096 }).assertIntact(), /updater_symlink_refused/u); }],
    ["staging", async root => { await mkdir(join(root, "outside-dir"));
      await symlink(join(root, "outside-dir"), join(root, "releases/.staging-r3"));
      await actuatorV1(root).actuator.stage(runV1());
      assert.deepEqual(await import("node:fs/promises").then(fs => fs.readdir(join(root, "outside-dir"))), []); }],
  ];
  for (const [name, attack] of cases) await t.test(name, async t => {
    const root = await fixtureV1(t); await writeFile(join(root, "outside"), "untouched"); await mkdir(join(root, "outside-dir"));
    if (name === "staging") await rm(join(root, "outside-dir"), { recursive: true });
    await attack(root); assert.equal(await readFile(join(root, "outside"), "utf8"), "untouched");
  });
});

test("50 parallel actuator switches have one winner", async t => {
  const root = await fixtureV1(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { actuator } = actuatorV1(root, { fault: async step => { if (step === "after_prepared") await gate; } });
  const first = actuator.switchPair(runV1()); await new Promise(resolve => setImmediate(resolve));
  const burst = await Promise.allSettled(Array.from({ length: 49 }, () => actuator.switchPair(runV1())));
  assert.equal(burst.filter(row => row.status === "rejected" && row.reason.code === "updater_actuator_busy").length, 49);
  release(); await first;
  assert.equal(await readlink(join(root, "current")), "releases/r3");
});

test("a database-pair switch requires the item-5 clean-stop proof", async t => {
  const root = await fixtureV1(t), databaseRun = runV1(pair("r3", "p3", 3), { databaseClass: "additive",
    databaseBytes: 2048 });
  await assert.rejects(actuatorV1(root).actuator.switchPair(databaseRun), /updater_database_not_stopped/u);
  const allowed = actuatorV1(root, { services: { databaseStopped: async () => true } });
  await allowed.actuator.switchPair(databaseRun);
  assert.equal(await readlink(join(root, "current")), "releases/r3");
  assert.equal(await readlink(join(root, "pg/current")), "data-p3");
});

test("rollback walks past a corrupt release and uses the reserve only for ENOSPC recovery", async t => {
  const root = await fixtureV1(t), history = new PairHistoryV1(root);
  await writeFile(join(root, "updater-state/known-good"), `${JSON.stringify({ schema: "control-room.known-good/v1", count: 3,
    pairs: [pair("r0", "p2", 2), pair("r1", "p2", 2), pair("r2", "p2", 2)] })}\n`);
  let restartAttempts = 0, depleted = 0;
  const reserve = new DiskReserveV1(root, { reserveBytes: 4096, minimumHeadroomBytes: 1,
    diskFree: async () => 100_000, createReserve: async () => writeFile(join(root, "rescue-reserve.bin"), Buffer.alloc(4096)),
    onDepleted: async () => { depleted += 1; } });
  const { actuator } = actuatorV1(root, { history, reserve,
    artifacts: { verifyPair: async candidate => candidate.releaseId !== "r1" },
    services: { restart: async () => { restartAttempts += 1;
      if (restartAttempts === 1) throw Object.assign(new Error("full"), { code: "ENOSPC" }); } } });
  const restored = await actuator.rollback(runV1());
  assert.equal(restored.releaseId, "r0", "the corrupt newer pair was skipped");
  assert.equal(restartAttempts, 2, "the reserve funded one retry after disk exhaustion");
  assert.equal(depleted, 0); assert.equal(await readlink(join(root, "current")), "releases/r0");
  assert.equal((await readFile(join(root, "rescue-reserve.bin"))).length, 4096);
});

test("rollback walks past a missing release directory in the rescue chain", async t => {
  const root = await fixtureV1(t); await rm(join(root, "releases/r1"), { recursive: true });
  const restored = await actuatorV1(root).actuator.rollback(runV1());
  assert.equal(restored.releaseId, "r0");
  assert.equal(await readlink(join(root, "current")), "releases/r0");
});

test("pair history keeps three automatic pairs and demotes old data to restore points", async t => {
  const root = await fixtureV1(t), history = new PairHistoryV1(root);
  await history.appendKnownGood(pair("r3", "p2", 2));
  assert.deepEqual((await history.knownGood()).map(item => item.releaseId), ["r1", "r2", "r3"]);
  await mkdir(join(root, "releases/r4")); await mkdir(join(root, "pg/data-p4"));
  const outcome = await history.recordDatabaseSuccess({ installed: pair("r4", "p4", 4), from: pair("r3", "p2", 2),
    n1Compatible: true });
  assert.deepEqual(outcome.knownGood.map(item => [item.releaseId, item.pgDataId]), [["r3", "p4"], ["r4", "p4"]]);
  assert.deepEqual(outcome.restorePoints.map(item => item.releaseId), ["r1", "r2", "r3"]);
});

test("retention never deletes current, previous, automatic or restore-chain releases", async t => {
  const root = await fixtureV1(t, { releases: ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"],
    data: ["p2"] });
  await writeFile(join(root, "updater-state/restore-points.json"), `${JSON.stringify({
    schema: "control-room.restore-points/v1", count: 1, pairs: [pair("r3", "p0", 0)],
  })}\n`);
  await mkdir(join(root, "releases/.staging-r4")); await mkdir(join(root, "releases/.staging-r7"));
  const removed = await collectOldReleasesV1(root, { keep: 5, openStagingReleaseIds: ["r4"] });
  assert.equal(removed.length, 4);
  for (const id of ["r0", "r1", "r2", "r3", "r4"]) await readFile(join(root, "releases", id, "manifest"));
  assert.ok(removed.every(id => ["r5", "r6", "r7", ".staging-r7"].includes(id)));
  await readFile(join(root, "releases/r4/manifest"));
  await symlink(join(root, "outside"), join(root, "releases/planted")); await writeFile(join(root, "outside"), "safe");
  await assert.rejects(collectOldReleasesV1(root), /updater_retention_symlink_refused/u);
  assert.equal(await readFile(join(root, "outside"), "utf8"), "safe");
});

test("bad and missing actuator input refuses before any side effect", async t => {
  const root = await fixtureV1(t), { actuator, calls } = actuatorV1(root);
  await assert.rejects(actuator.precheck({ run_id: "bad", detail: {} }), /updater_actuator_plan_refused/u);
  assert.deepEqual(calls, []);
});
