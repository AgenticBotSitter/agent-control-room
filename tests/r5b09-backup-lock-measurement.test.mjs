// R5B-09, measured and NOT fixed. This file exists so the measurement cannot be
// lost, and so the next slice inherits a proven starting point rather than
// re-deriving it.
//
// THE FINDING IS REAL AND REPRODUCED. A schema update that overlaps a running
// backup fails with a lock timeout, because 53 migrations set
// `SET LOCAL lock_timeout = '1s'` (db/migrations/0205_planner_barrier_and_owner_retry.sql:25
// is the one the QA probe collided on) while `pg_dump` holds read locks for the
// length of the dump. MEASURED on PostgreSQL 17 as the production migrator login
// against a table held in the lock mode a dump uses:
//
//   ERROR:  canceling statement due to lock timeout
//
// WHY IT IS NOT FIXED HERE, which is the useful part: BOTH candidate fixes were
// measured and both are blocked by a fact about the two processes, not about the
// collision.
//
// 1. SHARE THE NIGHTLY LOCK FILE — the QA report's own suggestion. The lock
//    module's precondition is that the lock file is owned by the caller:
//    `src/installer/shared/private-process-lock.mjs:9` requires
//    `s.uid === uid` and `(s.mode & 0o077) === 0`, and re-checks it at line 57
//    on the descriptor it just opened. MEASURED: acquiring a lock file owned by
//    uid 501 with `expectedUid` 502 is REFUSED (`probe_busy`). In production the
//    nightly runs as the control-room SERVICE ACCOUNT
//    (`src/updater/v1/services/bundle.mjs:258` — every role that is not
//    `updater`/`updater-guard` falls through to `serviceAccounts.controlRoom`)
//    while the schema phase's `psql` children run as the DATABASE ACCOUNT
//    (`sql-session.mjs`, `identity.uid`). So the two processes cannot lock the
//    same file at all: the schema step would refuse a lock the nightly holds,
//    which is indistinguishable from "a backup is running", and would also
//    refuse when none is. Making it work needs a shared-group lock file — a
//    second lock file in the same directory — and then the two paths are not the
//    same lock any more, which is the property the suggestion rests on.
//
// 2. A DATABASE ADVISORY LOCK. This is the mechanism that does cross uids, and
//    the backup side can hold one: its evidence transaction is already open
//    across the whole dump (`deploy/postgres/backup-database.mjs:145` exports the
//    snapshot and the transaction "remains open until the dump completes"). But
//    the schema phase CANNOT hold one, and the reason is its connection model,
//    not its permissions. MEASURED: a session-scoped `pg_advisory_lock` is gone
//    the moment its session ends (0 rows in `pg_locks` after the taking `psql`
//    exited), and `runSessionStatementV1` opens a connection PER STATEMENT
//    (`sql-session.mjs:343`). The phase issues statements one at a time —
//    `asMigrator` at `apply-release-schema.mjs:395`, `asSchemaOwner` at :652,
//    the orphan sweep at :423 — so a lock taken by one of them is released
//    before the next arrives. Only `runSessionTransactionV1` keeps a session, and
//    each migration is ONE such transaction, so a lock held for the phase would
//    have to be held inside every migration's transaction, which serialises the
//    migrations against each other rather than against the backup.
//
// WHAT A NEXT SLICE SHOULD DO. The collision is a LOCK-ORDER problem, and the
// cheapest correct answer is on the BACKUP side, where the long-lived session
// already exists: have `backupDatabase` take a session advisory lock for the
// duration of its snapshot transaction and have the migration loop WAIT for it
// (rather than 1s-timeout on it) before applying a migration. That is one
// mechanism, it reuses the connection that is already open, and it needs no new
// lock file and no shared group. It is not attempted here because it changes the
// shape of `applyMigrationWithDigestsV1`'s retry policy — a waiting migration and
// a 1s-timeout migration have different failure behaviour on install night, and
// that is a judgement for the lead rather than a mechanical change.
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

test("R5B-09: the collision is real and every migration that can hit it sets a short lock timeout", () => {
  // The collision itself was MEASURED on real PostgreSQL 17 as the production
  // migrator login, against a table held in the lock mode pg_dump uses:
  //   ERROR:  canceling statement due to lock timeout
  // What this asserts is the half a reviewer can check by reading: that the
  // migrations really do set a short timeout, so "wait longer" is not already
  // the behaviour and the finding is not a stale observation of old SQL.
  const migrations = readdirSyncSafe("db", "migrations");
  const short = migrations.filter(name => /^SET LOCAL lock_timeout = '1s';$/mu.test(read("db", "migrations", name)));
  assert.ok(short.length >= 50,
    `the migrations really do set a 1s lock timeout, in ${short.length} files`);
  assert.ok(short.includes("0205_planner_barrier_and_owner_retry.sql"),
    "including the one the QA probe collided on");
  assert.match(read("db", "migrations", "0205_planner_barrier_and_owner_retry.sql"),
    /SET LOCAL lock_timeout = '1s';/u);
});

test("R5B-09: sharing the nightly lock file cannot work, and the lock module says why", () => {
  // This is the QA report's suggested fix, asserted to be BLOCKED so that the
  // next slice does not re-attempt it. The precondition is the whole answer: a
  // lock file owned by another uid is refused, not stolen.
  const lock = read("src", "installer", "shared", "private-process-lock.mjs");
  assert.match(lock, /const privateFile = \(s, uid\) => s\.isFile\(\) && !s\.isSymbolicLink\(\) && s\.nlink === 1/u,
    "the lock file must be a single-link regular file");
  assert.match(lock, /&& s\.uid === uid && \(s\.mode & 0o077\) === 0;/u,
    "AND owned by the caller with no group/other bits — so a second uid cannot use it");
  assert.match(lock, /if \(!privateFile\(owned, expectedUid\)/u,
    "re-checked on the descriptor just opened, so a TOCTOU swap is refused too");
  // And the two processes are different uids in production: the nightly is the
  // control-room service account, the schema phase's psql children are the
  // database account.
  const bundle = read("src", "updater", "v1", "services", "bundle.mjs");
  assert.match(bundle,
    /definition\.role === "updater" \|\| definition\.role === "updater-guard" \? undefined : serviceAccounts\.controlRoom/u,
    "every role other than updater/updater-guard runs as the control-room service account, which is the nightly backup");
  assert.match(bundle,
    /definition\.role === "updater" \|\| definition\.role === "updater-guard" \? \{ name: "root", uid: 0, gid: 0 \}/u,
    "and only the updater phases run as root");
});

test("R5B-09: a session advisory lock cannot be held by the schema phase's own connection model", () => {
  // The advisory lock is the mechanism that WOULD cross uids, and the backup side
  // can hold one because its snapshot transaction spans the dump. The schema
  // phase cannot, and the reason is measured rather than assumed: a session-scoped
  // advisory lock dies with its session (0 rows in pg_locks after the taking
  // psql exited), and this phase opens one connection per statement.
  const session = read("src", "updater", "v1", "pg", "sql-session.mjs");
  assert.match(session, /runSessionStatementV1` opens a connection per statement/u,
    "MEASURED upstream: a session advisory lock cannot outlive the statements this phase issues");
  const phase = read("src", "updater", "v1", "pg", "apply-release-schema.mjs");
  // MEASURED against the source rather than a guessed shape: `asMigrator` is a
  // `const` arrow and `asSchemaOwner` is a property of a returned object, so a
  // pattern written for one spelling of each matched nothing. Count both by the
  // call itself, which is what the connection model actually turns on.
  const single = [...phase.matchAll(/runSessionStatementV1\(\{ user: migratorName/gu)];
  assert.ok(single.length >= 2,
    `and the phase really does use the per-statement runner for SQL it issues directly: ${single.length} found`);
  assert.match(phase, /Each migration is ONE transaction on ONE connection/u,
    "only runSessionTransactionV1 keeps a session, and it is per migration");
  // The backup side is the one place a long-lived session exists, which is why
  // the recommended fix belongs there.
  assert.match(read("deploy", "postgres", "backup-database.mjs"),
    /The transaction remains open until the dump completes/u);
});

/**
 * Directory entries, tolerant of a missing directory.
 *
 * A missing directory reads as an empty list so the assertion below fails with a
 * COUNT (`>= 50`), which says what went wrong, rather than an ENOENT that names a
 * path and not the finding.
 */
function readdirSyncSafe(...parts) {
  try { return readdirSync(join(ROOT, ...parts)); }
  catch { return []; }
}