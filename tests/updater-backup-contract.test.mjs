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
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { updaterDdlFilesV1, updaterTablesV1 } from "../src/updater/v1/schema-installer.ts";
import { BACKUP_LOCK_TABLE_V1, BACKUP_MAX_AGE_SECONDS_V1, BACKUP_KEPT_GENERATIONS_V1, assertRowCountsV1,
  generationLeafV1 } from "../src/updater/v1/backup-store.mjs";
import { UpdaterBackupV1, assertBackupRootOnDiskV1, assertSafeGenerationV1, backupManifestV1,
  resolveBackupRootPolicyV1 } from "../src/updater/v1/backup-runner.mjs";
import { isQuotedIdentifierV1 } from "../src/updater/v1/backup-evidence.mjs";

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
  const sample = "backup:2026-09-30T13-18-22-4712Z";
  assert.ok(ddlPattern.test(sample),
    `the DDL grammar must accept a real generation id (${sample})`);
  // The store's own assertion must accept exactly the same set. Rather than
  // duplicating the regex, drive the store's exported function.
  assert.equal(generationLeafV1(sample), "2026-09-30_13-18-22-4712",
    "the store accepts the id and renders the leaf the sweep will look for");
  for (const bad of ["backup:2026-09-30T13-18-22Z", "backup:2026-09-30T13-18-22-4Z", "backup:../etc",
    "backup:2026-09-30T13-18-22-471", "backup:2026-09-30T13-18-22-47123Z", ""]) {
    assert.throws(() => generationLeafV1(bad), /updater_backup_generation_refused/u,
      `the store must refuse ${JSON.stringify(bad)}`);
    assert.equal(ddlPattern.test(bad), false,
      `the DDL CHECK must also refuse ${JSON.stringify(bad)}`);
  }
  // The leaf transform must be injective over the grammar: two distinct ids can
  // never render to one directory name, or retention deletes the wrong one.
  const ids = ["backup:2026-01-01T02-30-00-0001Z", "backup:2026-01-01T02-30-00-0012Z",
    "backup:2026-01-01T02-30-01-0003Z", "backup:2026-01-02T02-30-00-0004Z"];
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
  // BOTH settle directions must be present. A guard that only allowed the
  // completion was a real bug: a disk-full or a verify failure could not be
  // recorded at all, so its row stayed `backup_in_progress` forever and the
  // failure count never moved. Measured on a real cluster.
  assert.match(body, /NEW\.state = 'verified' AND NEW\.failure_code IS NULL/u,
    "an in-flight row must be allowed to complete into `verified` with the failure cleared");
  assert.match(body, /ELSIF NEW\.state = 'failed' AND NEW\.failure_code IS NOT NULL/u,
    "AND to settle as failed with a real code, or no failure can ever be recorded");
  assert.match(body, /NEW\.failure_code <> 'backup_in_progress'/u,
    "and the in-flight marker is not itself a failure code");
  // And the direction matters: a verified row must not be rewritable.
  assert.match(body, /IF NEW\.generation_id IS DISTINCT FROM OLD\.generation_id THEN/u,
    "the primary key must be immutable even on the completion path");
  // The store's own UPDATE must match the guard's carve-out, or the two
  // disagree and every completion is refused at run time.
  const store = await readFile(join(process.cwd(), "src/updater/v1/backup-store.mjs"), "utf8");
  assert.match(store, /state='failed' AND failure_code='backup_in_progress'/u,
    "completeAttempt must name the in-flight state the guard permits");
});

test("the backup lock is a row lock a release cannot take, not a public advisory key", async () => {
  const store = await readFile(join(process.cwd(), "src/updater/v1/backup-store.mjs"), "utf8");
  const ddl = withoutComments(await read("0004_backups.sql"));
  // Review backup19b H1a: an advisory key is global, and the web and the
  // migrator each held the old one and stopped every backup. The store must not
  // take an advisory lock at all for the backup, and must take the row lock with
  // NOWAIT so a busy lock is an answer, never a wait.
  assert.doesNotMatch(withoutComments(store), /pg_try_advisory_lock|pg_advisory_lock\(/u,
    "the backup lock is not an advisory lock any login could take");
  assert.match(store, /SELECT singleton FROM updater\.backup_lock WHERE singleton FOR UPDATE NOWAIT/u);
  assert.equal(BACKUP_LOCK_TABLE_V1, "updater.backup_lock");
  assert.match(store, /idle_in_transaction_session_timeout/u, "the holding session is bounded");
  // Only the deployer (the owner) can take it: the web is revoked and granted
  // nothing on it, and nothing in 0004 grants it to anybody.
  assert.match(ddl, /REVOKE ALL ON updater\.backup_lock FROM control_room_private_web;/u);
  assert.doesNotMatch(ddl, /GRANT[^;]*ON[^;]*updater\.backup_lock/u, "no grant on the lock's table");
});

test("row-count keys accept every legal identifier and refuse what the ledger refuses", () => {
  // Review backup19b H1b: one `public."Audit"` used to fail every backup.
  const hostile = ['public."Audit"', 'public."t1"";ALTER ROLE x SUPERUSER;--"', 'public."表_ünï"', "updater.plans",
    `public."${'"'.repeat(63).replaceAll('"', '""')}"`];
  assert.deepEqual(assertRowCountsV1(hostile.map((table, count) => ({ table, count }))).map(entry => entry.table),
    hostile);
  for (const bad of [[], [{ table: "", count: 1 }], [{ table: "x".repeat(258), count: 1 }],
    [{ table: "public.t", count: -1 }], [{ table: "public.t", count: 1.5 }], [{ table: "a\0b", count: 1 }],
    [{ table: 7, count: 1 }]]) {
    assert.throws(() => assertRowCountsV1(bad), /updater_backup_row_counts_refused/u, JSON.stringify(bad));
  }
});

test("the evidence reader's identifier cross-check accepts exactly the two safe renderings", () => {
  // C1: the server quotes, this checks. Either rendering is ONE identifier.
  assert.equal(isQuotedIdentifierV1("plans", "plans"), true);
  assert.equal(isQuotedIdentifierV1("Audit", '"Audit"'), true);
  assert.equal(isQuotedIdentifierV1('t1";DROP', '"t1"";DROP"'), true);
  assert.equal(isQuotedIdentifierV1("select", '"select"'), true, "a quoted keyword is fine");
  for (const [name, quoted] of [['t1";DROP', '"t1";DROP"'], ["Audit", "Audit"], ['a"b', '"a"b"'],
    ["x", '"x"; SELECT 1; --'], ["a\0b", '"a\0b"'], ["", '""'], ["x".repeat(64), "x".repeat(64)]]) {
    assert.equal(isQuotedIdentifierV1(name, quoted), false, `${JSON.stringify(quoted)} is refused for ${JSON.stringify(name)}`);
  }
});

test("the backup root is checked on disk: symlinks, loose modes and writable ancestors are refused", async t => {
  const base = await mkdtemp(join(await realpath(tmpdir()), "b19-root-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 2 }));
  const ownerUid = process.getuid();
  const good = join(base, "good");
  await mkdir(good, { mode: 0o700 });
  const root = await assertBackupRootOnDiskV1(good, { ownerUid });
  assert.equal(root.backupRoot, good);
  await root.handle.close();
  const cases = [];
  const linkTarget = join(base, "target"); await mkdir(linkTarget, { mode: 0o700 });
  await symlink(linkTarget, join(base, "link")); cases.push(["a symlinked root", join(base, "link")]);
  const open = join(base, "open"); await mkdir(open, { mode: 0o700 }); await chmod(open, 0o777);
  cases.push(["a 0777 root", open]);
  const readable = join(base, "readable"); await mkdir(readable, { mode: 0o700 }); await chmod(readable, 0o750);
  cases.push(["a group-readable root", readable]);
  const shared = join(base, "shared"); await mkdir(join(shared, "backups"), { recursive: true, mode: 0o700 });
  await chmod(shared, 0o777); cases.push(["a world-writable ancestor", join(shared, "backups")]);
  const real = join(base, "real"); await mkdir(join(real, "backups"), { recursive: true, mode: 0o700 });
  await symlink(real, join(base, "alias")); cases.push(["a symlinked ancestor", join(base, "alias", "backups")]);
  const file = join(base, "file"); await writeFile(file, "x", { mode: 0o600 }); cases.push(["a file", file]);
  cases.push(["a missing root", join(base, "missing")]);
  for (const [label, path] of cases) {
    await assert.rejects(assertBackupRootOnDiskV1(path, { ownerUid }), /updater_backup_root_unsafe/u, label);
  }
  await assert.rejects(assertBackupRootOnDiskV1(good, { ownerUid: ownerUid + 1 }), /updater_backup_root_unsafe/u,
    "a root owned by somebody else is refused");
  // A sticky world-writable ancestor (like /private/tmp) is accepted: nobody
  // else can rename our entries out of it.
  const sticky = join(base, "sticky"); await mkdir(join(sticky, "backups"), { recursive: true, mode: 0o700 });
  await chmod(sticky, 0o1777);
  const accepted = await assertBackupRootOnDiskV1(join(sticky, "backups"), { ownerUid });
  await accepted.handle.close();
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
  const good = { generationId: "backup:2026-09-30T13-18-22-4712Z", createdAt: "2026-09-30T19:18:22.000Z",
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
  assert.deepEqual([...created].sort(), ["backup_generations", "backup_lock", "backup_state"],
    "0004 creates the two backup tables and the backup lock's table, and nothing else");
  for (const table of ["backup_generations", "backup_state", "backup_lock"]) {
    assert.ok(updaterTablesV1.includes(table), `${table} must be in the loader's asserted table set`);
  }
  // Every function 0004 defines is REVOKEd from PUBLIC. Same rule 0003 holds to.
  // The pattern must match EVERY arity, not just the zero-argument one: a
  // function declared with parameters (`backup_row_counts_shape(value jsonb)`)
  // does not match `\w+\(\)`, so the first version of this loop silently skipped
  // the one CHECK helper with a parameter, and it reached the web login as an
  // EXECUTABLE PUBLIC routine. cook/v1's passkey lane caught the consequence.
  const definedFunctions = [...ddl.matchAll(/CREATE OR REPLACE FUNCTION updater\.(\w+)\(([^)]*)\)/gu)]
    .map(match => ({ name: match[1], arity: (match[2] ?? "").trim() === "" ? 0 : (match[2] ?? "").split(",").length }));
  assert.ok(definedFunctions.length >= 5, "0004 still defines its functions (this loop has something to check)");
  for (const { name, arity } of definedFunctions) {
    // Matched by NAME and ARITY, not by the full signature. The CREATE spells
    // its parameters as `name type` (`value jsonb`) and the REVOKE spells the
    // same routine as the bare TYPES (`jsonb`) -- PostgreSQL's two spellings of
    // one signature -- so a signature-to-signature comparison matches nothing.
    // Name plus arity is exactly as strong here: 0004 declares each name once.
    const arguments_ = arity === 0 ? "" : arity === 1 ? "[^)]*" : `[^)]*(?:,[^)]*){${arity - 1}}`;
    assert.match(ddl, new RegExp(`REVOKE ALL ON FUNCTION updater\\.${name}\\(${arguments_}\\) FROM PUBLIC`, "u"),
    `${name} must be revoked from PUBLIC`);
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
    assert.equal(await assertSafeGenerationV1(root, "backup:2026-09-30T13-18-22-4712Z"), null,
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
  async acquireBackupLock() { this.#record("acquireBackupLock"); this.held = this.lockStatus === "acquired";
    return { status: this.lockStatus }; }
  async releaseBackupLock() { this.#record("releaseBackupLock"); this.held = false; }
  holdsBackupLock() { return this.held === true; }
  async scheduleNext(seconds) { this.#record("scheduleNext", { seconds }); this.nextDueAt = null; }
  // The id is minted to the REAL grammar, four tie-break digits wide. An
  // earlier version of this double used three, and the runner's own
  // `generationLeafV1` — which re-checks the grammar — refused it, so three
  // tests failed with `updater_backup_generation_refused` for a reason that had
  // nothing to do with what they were testing.
  async beginAttempt() { this.#record("beginAttempt"); this.generationSeq += 1;
    return { generationId: `backup:2026-01-01T02-30-00-${String(this.generationSeq).padStart(4, "0")}Z` }; }
  async completeAttempt(detail) { this.#record("completeAttempt", detail); return { generationId: detail.generationId }; }
  async failAttempt(detail) { this.#record("failAttempt", detail); return detail; }
  async latestAttempt() { return null; }
  async verifiedGenerations() { return []; }
  async pinnedGenerations() { return []; }
  async knownGenerationIds() { return []; }
  async ledgerRows() { return []; }
  async inFlightGenerations() { this.#record("inFlightGenerations"); return []; }
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

test("a due backup takes the lock, and a held lock is RECORDED as a failed attempt", async () => {
  const held = new RecordingStore({ lockStatus: "busy" });
  const busy = await makeBackup(held).runOnce({ manual: true });
  assert.equal(busy.status, "busy");
  assert.equal(busy.code, "updater_backup_lock_busy");
  // Review backup19b H1: a skip that recorded nothing let a held lock stop every
  // backup silently. The busy lock is now a failed attempt with its own code.
  // (The badge follows freshness, so this does not turn Home red while the last
  // backup is fresh.)
  assert.deepEqual(held.names(), ["acquireBackupLock", "policy", "beginAttempt", "failAttempt", "scheduleNext"],
    "a refused-for-lock backup records a failed attempt and reschedules");
  assert.equal(held.calls.find(entry => entry.name === "failAttempt").code, "updater_backup_lock_busy");
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
  // The root does not exist on disk here, so the run fails at the ON-DISK root
  // check (H2) — before any dump — and that failure is the one recorded.
  assert.equal(attempted.code, "updater_backup_root_unsafe");
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

test("an unconfigured backup root is a RECORDED failure, and touches no disk", async () => {
  const store = new RecordingStore();
  const backup = new UpdaterBackupV1({ store, ports: throwingPorts,
    policy: { installRoot: "/opt/control-room", backupRoot: null, seal: false } });
  const outcome = await backup.runOnce({ manual: true });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "updater_backup_root_unconfigured");
  // Review backup19b H1: "every failure path must record a failure". The first
  // version returned before touching the database, so a misconfigured install
  // never put a single row on the ledger.
  assert.deepEqual(store.names(), ["acquireBackupLock", "policy", "beginAttempt", "failAttempt", "releaseBackupLock"]);
  assert.equal(store.calls.find(entry => entry.name === "failAttempt").code, "updater_backup_root_unconfigured");
});

test("a restore whose shape or rows differ is refused before promote, and recorded with the half that differed", async t => {
  // Review backup19b H3.1: mutation #13 (the comparison deleted) survived the
  // whole lane because no test fed a mismatching restore. Both halves here, on
  // a real private root, with the store double recording what was written.
  const base = await mkdtemp(join(await realpath(tmpdir()), "b19-verify-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 2 }));
  const installRoot = join(base, "Control Room"), backupRoot = join(installRoot, "backups");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const digest = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const ports = mismatch => ({
    dump: async ({ path }) => { await writeFile(path, "DUMP"); return { bytes: 4, sha256: digest("DUMP"),
      evidence: { shapeDigest: digest("shape"), rowCounts: [{ table: "public.t", count: 3 }], ownership: [] } }; },
    restoreVerify: async () => mismatch,
    seal: async () => { throw new Error("seal_must_not_run"); },
    writeManifest: async () => { throw new Error("writeManifest_must_not_run_for_a_refused_verify"); },
  });
  for (const [label, mismatch, code] of [
    ["lost rows", { shapeDigest: digest("shape"), rowCounts: [{ table: "public.t", count: 2 }] },
      "updater_backup_row_counts_mismatch"],
    ["a lost table", { shapeDigest: digest("shape"), rowCounts: [] }, "updater_backup_row_counts_mismatch"],
    ["a different shape", { shapeDigest: digest("other"), rowCounts: [{ table: "public.t", count: 3 }] },
      "updater_backup_shape_digest_mismatch"],
    ["no answer at all", undefined, "updater_backup_shape_digest_mismatch"],
  ]) {
    const store = new RecordingStore();
    const outcome = await new UpdaterBackupV1({ store, ports: ports(mismatch),
      policy: { installRoot, backupRoot, seal: false, freeSpaceFloorBytes: 0 } }).runOnce({ manual: true });
    assert.equal(outcome.status, "failed", label);
    assert.equal(outcome.code, code, label);
    assert.equal(store.calls.find(entry => entry.name === "failAttempt")?.code, code, `${label} is recorded`);
    assert.ok(!store.names().includes("completeAttempt"), `${label}: never completed`);
    assert.deepEqual(await readdir(backupRoot), [], `${label}: nothing promoted, and the partial work removed`);
  }
});

test("a sweep called while this runner's own attempt is in flight is refused, not run under it", async t => {
  // The attempt holds the lock, so the store says "held"; a sweep that trusted
  // that would clear the live attempt's `.inprogress-` directory under it.
  const base = await mkdtemp(join(await realpath(tmpdir()), "b19-sweep-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 2 }));
  const backupRoot = join(base, "Control Room", "backups");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  let release, entered;
  const inDump = new Promise(resolve => { entered = resolve; });
  const store = new RecordingStore();
  const backup = new UpdaterBackupV1({ store, policy: { installRoot: join(base, "Control Room"), backupRoot,
    seal: false, freeSpaceFloorBytes: 0 }, ports: { ...throwingPorts,
    dump: async ({ path }) => { await writeFile(path, "partial"); entered(); await new Promise(resolve => { release = resolve; });
      throw new Error("dump_stopped_by_the_test"); } } });
  const running = backup.runOnce({ manual: true });
  await inDump;
  const swept = await backup.sweep();
  assert.equal(swept.status, "busy", "the sweep refuses while the attempt is live");
  assert.equal((await readdir(backupRoot)).filter(name => name.startsWith(".inprogress-")).length, 1,
    "and the live attempt's work is untouched");
  release();
  assert.equal((await running).status, "failed");
});

test("the badge is plain words and is derived from the freshness predicate", async () => {
  const backup = makeBackup(new RecordingStore());
  assert.deepEqual(await backup.status(), { fresh: false, state: "none", lastSuccessAt: null,
    lastFailureCode: null, lastFailureAt: null, nextDueAt: null, consecutiveFailures: 0,
    badge: "never run" },
  "with nothing ever attempted the badge says so in words rather than showing a number");
});

test("a completion the ledger would refuse is refused BEFORE the promote rename", async t => {
  // Review backup19b H1b: the ledger's refusal used to come from
  // `completeAttempt`, after the rename, so a promoted `gen-` directory sat
  // beside a `failed` row. Each case below is one the store refuses.
  const base = await mkdtemp(join(await realpath(tmpdir()), "b19-complete-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 2 }));
  const installRoot = join(base, "Control Room"), backupRoot = join(installRoot, "backups");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const digest = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  for (const [label, evidence] of [
    ["a negative count", { rowCounts: [{ table: "public.t", count: -1 }] }],
    ["an empty table name", { rowCounts: [{ table: "", count: 1 }] }],
    ["more than 4096 tables", { rowCounts: Array.from({ length: 4097 }, (_, index) => ({ table: `public.t${index}`, count: 0 })) }],
    ["a snapshot id outside the grammar", { snapshotXid: "x'; DROP" }],
  ]) {
    const store = new RecordingStore();
    const source = { shapeDigest: digest("shape"), rowCounts: [{ table: "public.t", count: 1 }], ownership: [], ...evidence };
    const outcome = await new UpdaterBackupV1({ store, policy: { installRoot, backupRoot, seal: false, freeSpaceFloorBytes: 0 },
      ports: { ...throwingPorts,
        dump: async ({ path }) => { await writeFile(path, "DUMP"); return { bytes: 4, sha256: digest("DUMP"), evidence: source }; },
        restoreVerify: async () => ({ shapeDigest: source.shapeDigest, rowCounts: source.rowCounts }),
        writeManifest: async ({ path, manifest }) => { await writeFile(path, JSON.stringify(manifest), { mode: 0o400 }); } },
    }).runOnce({ manual: true });
    assert.equal(outcome.status, "failed", label);
    assert.ok(!store.names().includes("completeAttempt"), `${label}: the ledger is never asked`);
    assert.deepEqual((await readdir(backupRoot)).filter(name => name.startsWith("gen-")), [],
      `${label}: nothing was promoted`);
  }
});
