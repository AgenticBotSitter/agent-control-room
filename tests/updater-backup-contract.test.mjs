// Static contract checks for item 19a. These are the ones that do NOT need a
// cluster, and they exist because the two bugs this lane's first run actually
// hit were both of a kind a static check catches and a real-cluster run reports
// only as an opaque SQLSTATE:
//
//   1. the generation-id CHECK in the DDL and the regex in the store disagreed
//      ({2} vs {3} for the millisecond group), so every attempt was refused at
//      INSERT and the whole lane failed with "terminating connection due to
//      administrator command" — the kit's teardown error masking the real one;
//   2. the immutability trigger refused the legitimate in-flight completion, so
//      no backup could ever be recorded as verified.
//
// Both are now pinned below. The DDL is parsed rather than grepped, so a comment
// cannot satisfy or break the check.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { updaterDdlFilesV1, updaterTablesV1 } from "../src/updater/v1/schema-installer.ts";
import { BACKUP_LOCK_V1, BACKUP_MAX_AGE_SECONDS_V1, BACKUP_KEPT_GENERATIONS_V1, generationLeafV1 }
  from "../src/updater/v1/backup-store.mjs";
import { UpdaterBackupV1, assertSafeGenerationV1, backupManifestV1, resolveBackupRootPolicyV1 }
  from "../src/updater/v1/backup-runner.mjs";

const DDL_DIRECTORY = join(process.cwd(), "src/updater/v1/ddl");
const read = async file => readFile(join(DDL_DIRECTORY, file), "utf8");
const withoutComments = sql => sql.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/--[^\n]*/gu, "");

test("the generation-id grammar is the SAME in the DDL CHECK and in the store", async () => {
  const ddl = withoutComments(await read("0004_backups.sql"));
  const check = /generation_id text PRIMARY KEY CHECK \(generation_id ~\s*'([^']+)'\)/u.exec(ddl);
  assert.ok(check, "0004_backups.sql must CHECK the generation id against a literal grammar");
  // The DDL pattern is compiled as a JavaScript regex so the two are compared as
  // PATTERNS, not as textually similar strings. A {2} where the store says {3}
  // is invisible to a string comparison and fatal at run time.
  const ddlPattern = new RegExp(check[1], "u");
  const sample = "backup:2026-09-30T13-18-22-471Z";
  assert.ok(ddlPattern.test(sample),
    `the DDL grammar must accept a real generation id (${sample})`);
  // The store's own assertion must accept exactly the same set. Rather than
  // duplicating the regex, drive the store's exported function.
  assert.equal(generationLeafV1(sample), "2026-09-30_13-18-22-471",
    "the store accepts the id and renders the leaf the sweep will look for");
  for (const bad of ["backup:2026-09-30T13-18-22Z", "backup:2026-09-30T13-18-22-4Z", "backup:../etc",
    "backup:2026-09-30T13-18-22-471", "backup:2026-09-30T13-18-22-4711Z", ""]) {
    assert.throws(() => generationLeafV1(bad), /updater_backup_generation_refused/u,
      `the store must refuse ${JSON.stringify(bad)}`);
    assert.equal(ddlPattern.test(bad), false,
      `the DDL CHECK must also refuse ${JSON.stringify(bad)}`);
  }
  // The leaf transform must be injective over the grammar: two distinct ids can
  // never render to one directory name, or retention deletes the wrong one.
  const ids = ["backup:2026-01-01T02-30-00-000Z", "backup:2026-01-01T02-30-00-001Z",
    "backup:2026-01-01T02-30-01-000Z", "backup:2026-01-02T02-30-00-000Z"];
  const leaves = ids.map(generationLeafV1);
  assert.equal(new Set(leaves).size, ids.length, "distinct ids must render to distinct leaves");
  for (const leaf of leaves) assert.doesNotMatch(leaf, /[/\\]/u, "a leaf is one path component");
});

test("the in-flight completion path the store depends on is present in the trigger", async () => {
  const ddl = withoutComments(await read("0004_backups.sql"));
  // The store's completeAttempt UPDATEs a `failed`/`backup_in_progress` row into
  // `verified`, so the immutability guard MUST carve out exactly that. A guard
  // that is unconditionally immutable looks stricter and records every backup as
  // a failure, which is the failure mode this pins.
  const guard = /CREATE OR REPLACE FUNCTION updater\.guard_backup_generation_immutable\(\)[\s\S]*?\$\$;/u
    .exec(ddl);
  assert.ok(guard, "the generation immutability guard must exist");
  const body = guard[0];
  assert.match(body, /OLD\.failure_code <> 'backup_in_progress'/u,
    "the guard must be conditional on the row being in flight, or no backup can ever complete");
  assert.match(body, /NEW\.state <> 'verified'/u,
    "an in-flight row must only be allowed to complete into `verified`");
  // And the direction matters: a verified row must not be rewritable.
  assert.match(body, /IF NEW\.generation_id IS DISTINCT FROM OLD\.generation_id THEN/u,
    "the primary key must be immutable even on the completion path");
  // The store's own UPDATE must match the guard's carve-out, or the two
  // disagree and every completion is refused at run time.
  const store = await readFile(join(process.cwd(), "src/updater/v1/backup-store.mjs"), "utf8");
  assert.match(store, /state='failed' AND failure_code='backup_in_progress'/u,
    "completeAttempt must name the in-flight state the guard permits");
});

test("the backup lock key is the one item 18 will use, and is not the run lease's", async () => {
  const store = await readFile(join(process.cwd(), "src/updater/v1/backup-store.mjs"), "utf8");
  // §9.2's quiesce step takes "the backup lock" in-process, and §9.5 says the
  // nightly "needs no upgrader". Sharing the KEY is what makes those two
  // statements true at once; a second key would let both dump one cluster.
  const lease = /UPDATER_LEASE_LOCK_V1 = Object\.freeze\(\[(\d+), (\d+)\]\)/u
    .exec(await readFile(join(process.cwd(), "src/updater/v1/store.mjs"), "utf8"));
  assert.ok(lease, "the run lease lock key must exist and be readable");
  assert.notDeepEqual([...BACKUP_LOCK_V1], [Number(lease[1]), Number(lease[2])],
    "the backup lock must not be the updater's run lease key, or a backup would block or be blocked by an update run");
  assert.equal(store.includes(`[${BACKUP_LOCK_V1[0]}, ${BACKUP_LOCK_V1[1]}]`), true,
    "the exported key must be the one the store actually locks on");
});

test("the backup root policy requires a seal outside the install root and refuses a relative one", () => {
  const installRoot = "/Library/Application Support/Control Room";
  assert.equal(resolveBackupRootPolicyV1({ installRoot, backupRoot: `${installRoot}/backups` }).sealRequired, false,
    "inside the install root, R-FS (root 0700) is the boundary and a seal is optional");
  assert.equal(resolveBackupRootPolicyV1({ installRoot, backupRoot: "/Volumes/External/backups" }).sealRequired, true,
    "outside the install root, ownership may be disabled, so a seal is required");
  assert.throws(() => resolveBackupRootPolicyV1({ installRoot, backupRoot: "relative/path" }),
    /updater_backup_root_refused/u);
  assert.throws(() => resolveBackupRootPolicyV1({ installRoot, backupRoot: `${installRoot}/backups/../../etc` }),
    /updater_backup_root_refused/u, "a path that escapes the install root is refused");
  assert.throws(() => resolveBackupRootPolicyV1({ installRoot, backupRoot: "" }),
    /updater_backup_root_refused/u);
  assert.throws(() => resolveBackupRootPolicyV1({ installRoot, backupRoot: installRoot }),
    /updater_backup_root_refused/u,
    "the install root itself is not a backup root: the sweep would walk releases/ and pg/");
  assert.throws(() => resolveBackupRootPolicyV1({ installRoot: "not-absolute", backupRoot: "/x" }),
    /updater_backup_root_refused/u);
  assert.throws(() => resolveBackupRootPolicyV1({ installRoot, backupRoot: "/x\0y" }),
    /updater_backup_root_refused/u, "a NUL byte in a path is refused before it reaches the filesystem");
  // A root under the OWNER's home is the H15 hole in a different place: the
  // owner could rename the whole folder and put their own in its place. The
  // policy is what an installer will read, so it must refuse it rather than
  // accept it and rely on the installer noticing. The owner's EXTERNAL drive
  // is a different path (/Volumes/...), which is exactly why the seal exists.
  assert.throws(() => resolveBackupRootPolicyV1({ installRoot, backupRoot: "/Users/someone/backups" }),
    /updater_backup_root_refused/u, "a backup root inside the owner's home is refused");
  assert.equal(resolveBackupRootPolicyV1({ installRoot, backupRoot: "/Volumes/External/backups" })
    .sealRequired, true, "an external volume is the supported external-backup case, sealed");
});

test("a manifest is refused without every digest, and carries both for a sealed dump", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const good = { generationId: "backup:2026-09-30T13-18-22-471Z", createdAt: "2026-09-30T19:18:22.000Z",
    dumpSha256: digest, dumpBytes: 100, fileSha256: `sha256:${"b".repeat(64)}`, shapeDigest: `sha256:${"c".repeat(64)}`,
    rowCounts: [{ table: "t", count: 1 }], snapshotXid: null, encrypted: true, installRoot: "/opt/cr",
    pgVersion: "control-room.pg-version/v1" };
  const manifest = backupManifestV1(good);
  assert.equal(manifest.schema, "control-room.backup-manifest/v1");
  assert.equal(manifest.rowCountsDigest,
    `sha256:${createHash("sha256").update(JSON.stringify(good.rowCounts)).digest("hex")}`,
    "the row-counts digest is computed over the exact array the store records, so the two sides agree");
  for (const [field, value] of Object.entries({ dumpSha256: "sha256:short", fileSha256: null,
    shapeDigest: "not-a-digest", dumpBytes: 0, rowCounts: [], generationId: "../escape",
    installRoot: "relative", pgVersion: "other" })) {
    assert.throws(() => backupManifestV1({ ...good, [field]: value }), /updater_backup_manifest_refused/u,
      `a manifest with a bad ${field} must be refused`);
  }
});

test("the DDL directory holds exactly the loader's file list, and the backup tables are in it", async () => {
  const onDisk = (await readdir(DDL_DIRECTORY)).filter(name => name.endsWith(".sql")).sort();
  assert.deepEqual(onDisk, [...updaterDdlFilesV1()].sort(),
    "the DDL directory holds exactly the files the loader applies, with none orphaned");
  const ddl = withoutComments(await read("0004_backups.sql"));
  const created = new Set([...ddl.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?updater\.(\w+)/giu)]
    .map(match => match[1]));
  assert.deepEqual([...created].sort(), ["backup_generations", "backup_state"],
    "0004 creates the two backup tables and nothing else");
  for (const table of ["backup_generations", "backup_state"]) {
    assert.ok(updaterTablesV1.includes(table), `${table} must be in the loader's asserted table set`);
  }
  // Every function 0004 defines is REVOKEd from PUBLIC. Same rule 0003 holds to.
  for (const match of ddl.matchAll(/CREATE OR REPLACE FUNCTION updater\.(\w+)\(\)/gu)) {
    assert.match(ddl, new RegExp(`REVOKE ALL ON FUNCTION updater\\.${match[1]}\\(\\) FROM PUBLIC`, "u"),
      `${match[1]} must be revoked from PUBLIC`);
  }
  for (const match of ddl.matchAll(/ON updater\.(\w+)\s*\n\s*FOR EACH ROW EXECUTE FUNCTION/gu)) {
    assert.ok(updaterTablesV1.includes(match[1]),
      `${match[1]} must be an updater table, and the trigger must be attached to it`);
  }
  // The freshness function must be SECURITY DEFINER and STABLE, because the
  // plan trigger calls it while the inserting session must not be able to read
  // the ledger, and because it reads no table it writes.
  assert.match(ddl, /CREATE OR REPLACE FUNCTION updater\.backup_is_fresh\(\) RETURNS boolean\nLANGUAGE plpgsql STABLE SECURITY DEFINER/u);
  // The plan guard must take the SAME advisory lock the open-plan guard takes, in
  // the same order, or a plan insert and a backup completion race.
  const planGuard = /CREATE OR REPLACE FUNCTION updater\.guard_plan_backup_fresh\(\)[\s\S]*?\$\$;/u.exec(ddl);
  assert.ok(planGuard);
  assert.match(planGuard[0], /pg_advisory_xact_lock\(pg_catalog\.hashtextextended\('updater:open-plan', 0\)\)/u,
    "the backup guard must take the open-plan advisory lock, or a plan can be admitted as the last backup goes stale");
  const openGuard = /CREATE OR REPLACE FUNCTION updater\.guard_plan_open\(\)[\s\S]*?\$\$;/u
    .exec(withoutComments(await read("0003_guards.sql")));
  assert.ok(openGuard, "the open-plan guard must exist in 0003_guards.sql");
  assert.match(openGuard[0], /pg_advisory_xact_lock\(pg_catalog\.hashtextextended\('updater:open-plan', 0\)\)/u,
    "both guards must take the same advisory lock, or their serialisation does not serialise anything");
});

test("the design's defaults are the ones the DDL seeds, so a fresh install starts correct", async () => {
  const ddl = withoutComments(await read("0004_backups.sql"));
  // §9.5: 26 hours and fourteen generations. The seeded singleton and the
  // exported constants must agree, or the first backup uses different bounds
  // from every later one until something rewrites the row.
  assert.match(ddl, new RegExp(`VALUES \\(true, ${BACKUP_MAX_AGE_SECONDS_V1}, ${BACKUP_KEPT_GENERATIONS_V1}\\)`, "u"),
    "the seeded policy row must carry the design's 26 hours and fourteen generations");
  assert.equal(BACKUP_MAX_AGE_SECONDS_V1, 93_600);
  assert.equal(BACKUP_KEPT_GENERATIONS_V1, 14);
  // The age is deliberately two missed nights plus a margin: 26 not 24, so one
  // silently skipped night does not immediately turn the badge red.
  assert.equal(BACKUP_MAX_AGE_SECONDS_V1 / 3600, 26);
});

test("the safety check reports a generation that is not there, rather than throwing or claiming one is", async () => {
  // A missing generation is `null`, not a throw: the sweep asks about every id
  // the ledger knows, and a row with no directory is normal after a failed run
  // (the attempt is recorded, the bytes never landed).
  for (const root of ["/nonexistent-backup-root", "/nonexistent-backup-root/deeper"]) {
    assert.equal(await assertSafeGenerationV1(root, "backup:2026-09-30T13-18-22-471Z"), null,
      `a generation under a missing root is reported absent (${root}), not as a failure and not as present`);
  }
  // And an id outside the grammar is refused outright, so no caller-supplied
  // string can become a path component even in the "absent" direction.
  await assert.rejects(assertSafeGenerationV1("/tmp", "../../etc/passwd"),
    /updater_backup_generation_refused/u);
  await assert.rejects(assertSafeGenerationV1("/tmp", "backup:2026-09-30T13-18-22Z"),
    /updater_backup_generation_refused/u);
});

/**
 * The scheduling and lock decisions, driven with a store double.
 *
 * These are the parts of `runOnce` that decide WHEN a backup is admitted, and
 * they are the parts a real-cluster lane cannot reach on demand — "not due yet"
 * needs a next-due time in the future, and "the lock is held" needs a second
 * session. Both are cheap here and would each cost a real cluster to test
 * otherwise, so they are tested as logic and the SQL behind them is tested on a
 * cluster in the other lane.
 *
 * The double records every call, so an assertion can check what the runner DID
 * as well as what it returned. A double that only answers `status` would pass a
 * runner that wrote a `failed` row it should not have.
 */
class RecordingStore {
  constructor({ lockStatus = "acquired", nextDueAt = null, policy = { maxAgeSeconds: 93600, keptGenerations: 14 } } = {}) {
    this.lockStatus = lockStatus; this.nextDueAt = nextDueAt; this.policyValue = policy;
    this.calls = []; this.generationSeq = 0;
  }
  #record(name, detail = {}) { this.calls.push({ name, ...detail }); }
  async freshness() { this.#record("freshness"); return { fresh: false, lastSuccessAt: null, lastFailureCode: null,
    lastFailureAt: null, nextDueAt: this.nextDueAt, consecutiveFailures: 0, maxAgeSeconds: 93600 }; }
  async policy() { this.#record("policy"); return this.policyValue; }
  async acquireBackupLock() { this.#record("acquireBackupLock"); return { status: this.lockStatus, inFlight: false }; }
  async releaseBackupLock() { this.#record("releaseBackupLock"); }
  async scheduleNext(seconds) { this.#record("scheduleNext", { seconds }); this.nextDueAt = null; }
  async beginAttempt() { this.#record("beginAttempt"); this.generationSeq += 1;
    return { generationId: `backup:2026-01-0${this.generationSeq}T02-30-00-00${this.generationSeq}Z` }; }
  async completeAttempt(detail) { this.#record("completeAttempt", detail); return { generationId: detail.generationId }; }
  async failAttempt(detail) { this.#record("failAttempt", detail); return detail; }
  async latestAttempt() { return null; }
  async verifiedGenerations() { return []; }
  async pinnedGenerations() { return []; }
  async knownGenerationIds() { return []; }
  names() { return this.calls.map(entry => entry.name); }
}

const throwingPorts = {
  dump: async () => { throw new Error("dump_must_not_run"); },
  restoreVerify: async () => { throw new Error("restoreVerify_must_not_run"); },
  seal: async () => { throw new Error("seal_must_not_run"); },
  writeManifest: async () => { throw new Error("writeManifest_must_not_run"); },
};

const makeBackup = (store, extra = {}) => new UpdaterBackupV1({ store, ports: throwingPorts,
  policy: { installRoot: "/opt/control-room", backupRoot: "/opt/control-room/backups", seal: false,
    freeSpaceFloorBytes: 0 }, ...extra });

test("a backup that is not due is not started, and writes nothing", async () => {
  const store = new RecordingStore({ nextDueAt: new Date(Date.now() + 3_600_000).toISOString() });
  const outcome = await makeBackup(store).runOnce();
  assert.equal(outcome.status, "not_due");
  assert.match(outcome.message, /not due yet/u);
  // The lock is not even taken: a not-due check that took the shared backup lock
  // would block a database upgrade for no reason.
  assert.deepEqual(store.names(), ["freshness"],
    "a not-due tick touches the database once and stops there");
  assert.ok(outcome.nextDueAt);
});

test("a due backup takes the lock, and a held lock refuses without recording an attempt", async () => {
  const held = new RecordingStore({ lockStatus: "busy" });
  const busy = await makeBackup(held).runOnce({ manual: true });
  assert.equal(busy.status, "busy");
  assert.equal(busy.code, "updater_backup_lock_busy");
  // `beginAttempt` MUST NOT appear: a deferred backup is not a failed one, and a
  // `failed` row here would turn Home red on every database update.
  assert.deepEqual(held.names(), ["acquireBackupLock", "scheduleNext"],
    "a refused-for-lock backup reschedules and writes no attempt row");
  const scheduled = held.calls.find(entry => entry.name === "scheduleNext");
  assert.ok(scheduled.seconds > 0 && scheduled.seconds <= 900,
    "and reschedules within the quarter hour, so it is not a day away and not never");
  // The lock is NOT released on the busy path, because it was never taken.
  assert.ok(!held.names().includes("releaseBackupLock"),
    "releasing a lock this caller never held would release somebody else's");

  const free = new RecordingStore();
  const attempted = await makeBackup(free).runOnce({ manual: true });
  // The dump throws, so the run fails — but it must have taken, attempted and
  // released the lock on the way through, in that order.
  assert.equal(attempted.status, "failed");
  assert.deepEqual(free.names().slice(0, 3), ["acquireBackupLock", "policy", "beginAttempt"]);
  assert.ok(free.names().includes("failAttempt"));
  assert.equal(free.names().at(-1), "releaseBackupLock",
    "the lock is released on the failure path too, which is the whole reason it is a session lock");
});

test("a second concurrent caller is refused as busy, not queued behind the first", async () => {
  const store = new RecordingStore();
  const backup = makeBackup(store);
  const [first, second] = await Promise.all([backup.runOnce({ manual: true }),
    backup.runOnce({ manual: true })]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, ["busy", "failed"],
    "exactly one caller ran; the other was told the Mac is busy");
  const busy = first.status === "busy" ? first : second;
  assert.equal(busy.code, "updater_backup_already_running",
    "an in-process second caller is a refusal with its own code, not a second dump");
  // The refusal happened before the lock, so it cannot have disturbed the first.
  assert.equal(store.names().filter(name => name === "acquireBackupLock").length, 1);
});

test("an unconfigured backup root refuses before touching the database", async () => {
  const store = new RecordingStore();
  const backup = new UpdaterBackupV1({ store, ports: throwingPorts,
    policy: { installRoot: "/opt/control-room", backupRoot: null, seal: false } });
  const outcome = await backup.runOnce({ manual: true });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "updater_backup_root_unconfigured");
  assert.deepEqual(store.names(), [],
    "nothing was written, and no lock was taken, for a root that is not configured");
});

test("the badge is plain words and is derived from the freshness predicate", async () => {
  const backup = makeBackup(new RecordingStore());
  assert.deepEqual(await backup.status(), { fresh: false, state: "none", lastSuccessAt: null,
    lastFailureCode: null, lastFailureAt: null, nextDueAt: null, consecutiveFailures: 0,
    badge: "never run" },
  "with nothing ever attempted the badge says so in words rather than showing a number");
});
