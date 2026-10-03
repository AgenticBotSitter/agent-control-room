// A SECOND CONCURRENT UPGRADE MUST BE REFUSED IN PLAIN WORDS (mdbup M8).
//
// WHY THIS FILE EXISTS. The Mac-local upgrade takes a plan, checks it against
// the live database, applies migrations, then converges roles and grants. Two
// upgrades started together both read a plan, then both apply. What the
// operator saw was not "you started two": it was one of four unrelated-looking
// failures deep inside the second run -- `upgrade_convergence_refused`, a grant
// that no longer matched, or a migration refusing its ledger prefix because the
// first upgrade was midway through rewriting it. Each of those reads as a bug in
// the schema or the ledger, and sends the operator looking in the wrong place.
//
// WHAT IS PROVED HERE, on a real disposable PostgreSQL 17, through the real
// upgrade entry point as the real operator (the local `postgres` peer login):
//   1. while one upgrade holds the lock, a second one on its OWN session is
//      refused with `upgrade_already_running_refused` and changes nothing --
//      not the ledger, not the roles, not the grants;
//   2. the refusal reads as the thing that happened, in plain words, with no
//      SQLSTATE and no internal code;
//   3. it is the LOCK that refuses: a second upgrade is accepted the moment the
//      first releases, so the refusal is not "this database cannot be upgraded"
//      or a stale plan digest;
//   4. the lock is released on the FAILING path too, so one failed upgrade does
//      not wedge the database against every later attempt;
//   5. the lock is session-scoped: an upgrade whose session dies without
//      releasing releases the lock with it, because the server drops it. A
//      killed upgrade must not require an operator to clear a lock by hand;
//   6. the lock key is one constant, so two callers cannot hold different locks.
//
// The default path is exercised with NO injected port, tool, runner or fake for
// anything this fix added: the lock is taken by the real
// `applyMacDatabaseUpgradeV1` against a real cluster, over real sessions.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../deploy/postgres/evidence.mjs";
import { MAC_DATABASE_UPGRADE_LOCK_V1, applyMacDatabaseUpgradeV1, plainMacDatabaseUpgradeRefusalV1,
  releaseMacDatabaseUpgradeLockV1, sanitizedMacDatabaseUpgradeFailureV1,
  tryMacDatabaseUpgradeLockV1 } from "../scripts/mac-local/database-upgrade-remote.mjs";
import { databaseRoleManifestV1 } from "../scripts/mac-local/database-role-manifest.mjs";
import { postgresScramVerifierV1 } from "../scripts/mac-local/database-upgrade-scram.mjs";
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";
import { PG_BIN, findFreePort, needsPg, requestedPort } from "./helpers/disposable-postgres-cluster.ts";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const mainCommit = "c".repeat(40);
const git = params => params[0] === "status" ? "" : mainCommit;
const state = {};

const exec = (file, args) => execFileSync(join(PG_BIN ?? "", file), args, { encoding: "utf8", timeout: 120_000,
  env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
const operator = () => `host=${state.socket} port=${state.port} dbname=control_room user=postgres`;
const tcp = (user, secret) => `host=127.0.0.1 port=${state.port} dbname=control_room user=${user} password=${secret}`;

/** Everything a concurrent upgrade could disturb, in one comparable value. */
async function catalog(client) {
  const query = async (sql, values) => (await client.query(sql, values)).rows;
  return {
    ledger: await query("SELECT filename, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order"),
    roles: await query(`SELECT rolname, rolcanlogin, rolsuper FROM pg_roles
      WHERE rolname LIKE 'control_room%' ORDER BY rolname`),
    memberships: await query(`SELECT member.rolname AS member, parent.rolname AS parent
      FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid
        JOIN pg_roles member ON member.oid = m.member
      WHERE member.rolname LIKE 'control_room%' ORDER BY 1, 2`),
    tables: await query(`SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'control_room_queue') ORDER BY 1, 2`),
  };
}

/** A second, independent operator session, as a second upgrade would have. */
async function secondOperatorSession() {
  const client = connectTarget(operator());
  await client.connect();
  return client;
}

/**
 * A login code for every login the plan creates. Read from the manifest rather
 * than listed by hand, so a slice that adds a login does not make this file fail
 * earlier than the lock. Synthetic values: a SCRAM verifier of a synthetic
 * secret, never a real credential, and never printed.
 */
const loginVerifiers = Object.fromEntries(
  Object.entries(databaseRoleManifestV1.logins).filter(([, entry]) => entry.newLogin)
    .map(([login]) => [login, postgresScramVerifierV1(`${login.slice("control_room_".length)}-probe`.padEnd(40, "z"))]));

before(async () => {
  if (needsPg) return;
  state.root = await mkdtemp(join(tmpdir(), "acr-upgrade-lock-"));
  state.port = requestedPort() ?? await findFreePort();
  const data = join(state.root, "pg");
  state.socket = join(state.root, "s");
  await mkdir(state.socket, { mode: 0o700 });
  state.teardown = createClusterTeardown({ dataDirectory: data, runDirectory: state.root,
    socketDirectory: state.socket, port: state.port, pgBin: PG_BIN, removeDirectories: false });
  exec("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  await writeFile(join(data, "pg_hba.conf"), "local all postgres trust\nhost all postgres 127.0.0.1/32 trust\n"
    + "host all all 127.0.0.1/32 scram-sha-256\n");
  exec("pg_ctl", ["-D", data, "-l", join(state.root, "pg.log"), "-w", "-o",
    `-p ${state.port} -k '${state.socket}' -c listen_addresses=127.0.0.1`, "start"]);
  await state.teardown.capturePostmasterPid();
  exec("psql", ["-h", "127.0.0.1", "-p", String(state.port), "-U", "postgres", "-d", "postgres",
    "-v", "dbname=control_room", "-v", "ON_ERROR_STOP=1", "-f", join(repoRoot, "deploy/postgres/provision-database.sql")]);
  // An older ledger, so the upgrade has real work to plan: every migration up to
  // 0090, the file the live database last applied.
  const ledger = JSON.parse(await readFile(join(repoRoot, "deploy/postgres/migration-ledger.json"), "utf8"));
  ledger.entries = ledger.entries.filter(entry => entry.kind !== undefined && entry.kind !== "migrate"
    || entry.file < "db/migrations/0091");
  const ledgerPath = join(state.root, "ledger-0090.json");
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const migratorPassword = "m".repeat(40);
  await applyMigrations({ rootDir: repoRoot, ledgerPath, bootstrapTarget: tcp("postgres", "unused"),
    migrateTarget: tcp("control_room_migrator", migratorPassword),
    env: { CONTROL_ROOM_MIGRATOR_PASSWORD: migratorPassword, CONTROL_ROOM_APP_PASSWORD: "a".repeat(40),
      CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(40), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "i".repeat(40) } });
  state.client = connectTarget(operator());
  await state.client.connect();
  // That ledger predates the Mac logins the role manifest requires. Without them
  // the upgrade refuses during its plan -- before the lock is ever exercised --
  // and these cases would pass without ever reaching the lock.
  for (const login of ["control_room_web", "control_room_coordinator", "control_room_results",
    "control_room_queue_worker"]) {
    await state.client.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS PASSWORD ${state.client.escapeLiteral(`p${login.replaceAll("_", "")}`.padEnd(40, "x"))}`);
    await state.client.query(`GRANT control_room_application TO ${login}`);
  }
});

after(async () => {
  if (needsPg) return;
  try { await state.client?.end(); } catch {}
  try { await state.teardown?.stop(); } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("a second concurrent upgrade is refused in plain words, changes nothing, and is accepted once the first finishes", {
  skip: needsPg,
}, async () => {
  // The first upgrade holds the lock while it runs. Rather than racing two real
  // upgrades -- which would be timing-dependent -- the lock is taken on one real
  // session exactly as the first upgrade takes it, and the SECOND upgrade is
  // then attempted on its own real session while it is held.
  const holder = await secondOperatorSession();
  const interloper = await secondOperatorSession();
  const observer = state.client;
  try {
    const before = await catalog(observer);

    // (1) The lock is taken for real, by the real function the applier uses.
    assert.equal(await tryMacDatabaseUpgradeLockV1(holder), true,
      "the first upgrade takes the upgrade lock");

    // (2) The second upgrade, on its own session, is refused -- and refused at
    // the very first step, before any plan is read or any role is created.
    let started = false;
    await assert.rejects(applyMacDatabaseUpgradeV1({
      client: interloper, loginVerifiers,
      applyPending: async () => { started = true; },
    }), /^Error: upgrade_already_running_refused$/u);
    assert.equal(started, false, "a refused upgrade must not start migrating");

    // (3) Nothing changed: the refusal is a refusal, not a partial upgrade.
    assert.deepEqual(await catalog(observer), before,
      "a refused concurrent upgrade must change no ledger row, role, membership or table");

    // (4) The refusal reads as the thing that happened. Plain words, no
    // SQLSTATE, no internal stage noise, and no secret.
    const plain = plainMacDatabaseUpgradeRefusalV1(new Error("upgrade_already_running_refused"));
    assert.equal(typeof plain, "string");
    assert.match(plain, /another Control Room database upgrade is already running/u, plain);
    assert.match(plain, /changed nothing/u, plain);
    assert.doesNotMatch(plain, /55P03|sqlstate|control_room_[a-z_]+\b/u,
      "the operator-facing refusal carries no SQLSTATE and no internal role names");
    // The sanitized line names this exact code rather than the generic fallback,
    // so the log says what happened instead of `remote_refused`.
    assert.match(sanitizedMacDatabaseUpgradeFailureV1(new Error("upgrade_already_running_refused"), "plan"),
      /^upgrade_error:upgrade_already_running_refused /u);

    // (5) Releasing the lock is what makes the next attempt work, so the
    // refusal is "one at a time", not "not now, ever".
    await releaseMacDatabaseUpgradeLockV1(holder);
    assert.equal(await tryMacDatabaseUpgradeLockV1(interloper), true,
      "once the first upgrade finishes, the second takes the lock immediately");

    // (6) A refused attempt must not have left the interloper holding anything,
    // so a retry on that same session is not refused by its own earlier attempt.
    await releaseMacDatabaseUpgradeLockV1(interloper);
    assert.equal((await interloper.query(
      "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory'")).rows[0].count, 0,
      "no advisory lock may be left behind by a refused or finished upgrade");
  } finally {
    await holder.end().catch(() => {});
    await interloper.end().catch(() => {});
  }
});

test("the lock is released when the upgrade fails, so one failure does not wedge the database", {
  skip: needsPg,
}, async () => {
  const session = await secondOperatorSession();
  try {
    // A failure INSIDE the upgrade body, after the lock is taken and after the
    // plan has been read. `applyPending` is the applier's own seam for the
    // migration step, so throwing from it is a failure at exactly the point a
    // real upgrade can fail, rather than a fixture problem discovered earlier.
    let reached = false;
    await assert.rejects(applyMacDatabaseUpgradeV1({
      client: session, loginVerifiers,
      applyPending: async () => { reached = true; throw new Error("simulated migration failure"); },
    }), /simulated migration failure/u);
    assert.equal(reached, true, "the failure must happen AFTER the lock is taken, or this proves nothing");

    assert.equal((await session.query(
      "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory'")).rows[0].count, 0,
      "a failed upgrade must release its lock, or every later attempt is refused forever");
    // And the next attempt gets PAST the lock. Anything else it refuses with is
    // fine -- the fixture may still be short of something else -- but the busy
    // refusal would mean the lock leaked, which is the thing under test. Asserted
    // by what it must NOT be, so this cannot pass on the busy refusal.
    const retry = await applyMacDatabaseUpgradeV1({ client: session, loginVerifiers,
      applyPending: async () => { throw new Error("simulated migration failure"); } })
      .then(() => undefined, (error) => error.message);
    assert.notEqual(retry, "upgrade_already_running_refused",
      "a failed upgrade must not wedge the database against every later attempt");
  } finally { await session.end().catch(() => {}); }
});

test("a session that dies releases the lock with it: the server, not the caller, owns the lock", {
  skip: needsPg,
}, async () => {
  const doomed = await secondOperatorSession();
  const survivor = await secondOperatorSession();
  try {
    assert.equal(await tryMacDatabaseUpgradeLockV1(doomed), true, "the doomed session takes the lock");
    // A hard close, with no unlock: what a killed upgrade leaves behind.
    await doomed.end();
    // The server drops a session-scoped advisory lock when the session goes, so
    // the next caller is admitted. Polled briefly because the server notices on
    // its own schedule rather than instantly.
    const deadline = Date.now() + 30_000;
    let admitted = false;
    while (Date.now() < deadline && !admitted) {
      admitted = await tryMacDatabaseUpgradeLockV1(survivor);
      if (!admitted) await new Promise(done => { setTimeout(done, 250); });
    }
    assert.equal(admitted, true,
      "a crashed upgrade must not require an operator to clear the lock by hand");
  } finally {
    await survivor.end().catch(() => {});
  }
});

test("the lock key is one constant both callers share, inside PostgreSQL's advisory range", { skip: needsPg },
  async () => {
    assert.equal(typeof MAC_DATABASE_UPGRADE_LOCK_V1, "bigint");
    assert.ok(MAC_DATABASE_UPGRADE_LOCK_V1 >= 0n && MAC_DATABASE_UPGRADE_LOCK_V1 < (1n << 63n),
      "the key must fit PostgreSQL's signed bigint advisory-lock range");
    // Re-importing must not produce a different key: two literals in two files
    // would each hold a different lock, and both upgrades would proceed.
    const again = await import("../scripts/mac-local/database-upgrade-remote.mjs");
    assert.equal(again.MAC_DATABASE_UPGRADE_LOCK_V1, MAC_DATABASE_UPGRADE_LOCK_V1,
      "the key must be derived from one constant, so every caller acquires the same lock");

    // And the key is what is actually sent: a lock taken under this key blocks a
    // second caller, and nothing else on the cluster is touched.
    const a = await secondOperatorSession();
    const b = await secondOperatorSession();
    try {
      assert.equal(await tryMacDatabaseUpgradeLockV1(a), true);
      assert.equal(await tryMacDatabaseUpgradeLockV1(b), false, "the second caller is refused the same key");
      assert.equal((await b.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory'")).rows[0].count, 1,
        "exactly the one advisory lock is held");
      await releaseMacDatabaseUpgradeLockV1(a);
      assert.equal(await tryMacDatabaseUpgradeLockV1(b), true);
    } finally {
      await a.end().catch(() => {});
      await b.end().catch(() => {});
    }
  });