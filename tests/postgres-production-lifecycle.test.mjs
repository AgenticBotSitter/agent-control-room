// Live-cluster tests for the #63 package on a disposable PostgreSQL 17 cluster.
// Never touches an existing database: initdb into a temp dir, socket-only,
// --auth-host=reject. Needs the PG 17 bin directory (PG_BIN or the Debian default).
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, cp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { applyMigrations, readSchemaDigest } from "../deploy/postgres/apply-migrations.mjs";
import { backupDatabase } from "../deploy/postgres/backup-database.mjs";
import { restoreDatabase } from "../deploy/postgres/restore-database.mjs";
import { collectDatabaseEvidence, digestOf } from "../deploy/postgres/evidence.mjs";
import { computeDatabaseRestoreIdentity, verifyRestoredIdentity } from "../deploy/postgres/restore-identity.mjs";
import { collectLedgerEntries, ledgerDigest } from "../scripts/generate-migration-ledger.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.PG_BIN ?? "/usr/lib/postgresql/17/bin";
// Graceful skip for lanes without PostgreSQL binaries (e.g. the merge-gate
// catch-up entry, which has no PG install step): the tests run wherever the
// components job provisions PG17, and report as skipped elsewhere instead of
// failing the whole lane for an unrelated pull request.
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined : { skip: "needs PostgreSQL 17 binaries (PG_BIN or /usr/lib/postgresql/17/bin)" };
const PORT = 65434;
const exec = promisify(execFile);

let run = "", socket = "", data = "";
const target = (database, user = "fixture_admin") =>
  ({ host: socket, port: PORT, database, user, password: "fixture_only" });
const adminDb = () => target("postgres");
const passwords = { CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24), CONTROL_ROOM_APP_PASSWORD: "a".repeat(24), CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24) };
// Production-correct migrator target: the bootstrap phase creates the
// control_room_migrator login with the password from CONTROL_ROOM_MIGRATOR_PASSWORD,
// then the migrate phase connects as that login (IN ROLE schema_owner) and runs
// each migration under SET ROLE control_room_schema_owner. Tests construct both
// targets up-front and pass them to applyMigrations.
const bootstrapTarget = (database) => target(database, "fixture_admin");
const migrateTarget = (database) => ({ host: socket, port: PORT, database,
  user: "control_room_migrator", password: passwords.CONTROL_ROOM_MIGRATOR_PASSWORD });

// The postmaster refuses to run as root (UID 0). Detect whether the current
// process is root and, if so, de-escalate via setpriv to the postgres
// pseudo-user (UID 102, GID 105 — the same defaults Debian and Ubuntu
// packages use). On a GitHub Actions runner the job runs as the `runner`
// user (UID 1001), so the de-escalation is a no-op. This is the only place
// the test driver hard-codes a UID/GID: any non-root environment (CI, a dev
// box with a non-root shell, a container) needs no special handling.
const ROOT_UID = 0;
const POSTGRES_UID = 102;
const POSTGRES_GID = 105;
const native = (name, args) => {
  const runAsPostgres = process.getuid?.() === ROOT_UID;
  const binaryPath = join(BIN, name);
  const command = runAsPostgres && ["initdb", "pg_ctl", "postgres"].includes(name)
    ? ["setpriv", `--reuid=${POSTGRES_UID}`, `--regid=${POSTGRES_GID}`, "--clear-groups", binaryPath, ...args]
    : [binaryPath, ...args];
  return exec(command[0], command.slice(1),
    { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run, NODE_ENV: "test" }, timeout: 60000, maxBuffer: 1 << 26 });
};

async function query(target, sql, params = []) {
  const { connectTarget } = await import("../deploy/postgres/evidence.mjs");
  const client = connectTarget(target);
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

before(async () => {
  if (!PG_AVAILABLE) return;
  run = await mkdtemp(join(tmpdir(), "cr-pg63-"));
  socket = join(run, "socket");
  data = join(run, "data");
  await mkdir(socket, { mode: 0o700 });
  // On a root dev box, chown the run directory to the postgres pseudo-user
  // so initdb/pg_ctl/postgres (which run with that UID) can write the data
  // directory. Non-root CI runners skip the chown — the test driver already
  // owns the temp dir.
  if (process.getuid?.() === ROOT_UID) {
    await exec("chown", ["-R", `${POSTGRES_UID}:${POSTGRES_GID}`, run]);
  }
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "fixture_admin", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
  await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "30", "-o",
    `-k ${socket} -p ${PORT} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`, "start"]);
});

after(async () => {
  if (!PG_AVAILABLE || !run) return;
  try {
    await native("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

async function freshDatabase(name) {
  await query(adminDb(), `CREATE DATABASE "${name}" OWNER fixture_admin`);
}

async function roleMemberships(conn) {
  return (await query(conn,
    `SELECT m.rolname AS member, r.rolname AS role, am.admin_option FROM pg_auth_members am
     JOIN pg_roles m ON m.oid = am.member JOIN pg_roles r ON r.oid = am.roleid
     WHERE m.rolname LIKE 'control@_room@_%' ESCAPE '@' OR r.rolname LIKE 'control@_room@_%' ESCAPE '@'
     ORDER BY 1, 2`)).rows;
}

async function stageRoot(fileCount) {
  const stage = await mkdtemp(join(tmpdir(), "cr-pg63stage-"));
  await mkdir(join(stage, "deploy/postgres"), { recursive: true });
  await mkdir(join(stage, "db/migrations"), { recursive: true });
  await mkdir(join(stage, "db/roles"), { recursive: true });
  await mkdir(join(stage, "db/setup"), { recursive: true });
  const all = (await readdir(join(ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort().slice(0, fileCount);
  for (const file of all) await cp(join(ROOT, "db/migrations", file), join(stage, "db/migrations", file));
  for (const file of ["production_roles.sql", "production_table_grants.sql", "production_provision.sql"]) {
    await cp(join(ROOT, "db/roles", file), join(stage, "db/roles", file));
  }
  await cp(join(ROOT, "db/setup/production_migration_ledger.sql"), join(stage, "db/setup/production_migration_ledger.sql"));
  const entries = await collectLedgerEntries(stage);
  const ledgerPath = join(stage, "deploy/postgres/migration-ledger.json");
  await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
  return { stage, ledgerPath };
}

test("clean install applies the full ledger, creates logins, then reruns as no-op", needsPg, async () => {
  await freshDatabase("cr_prod_install");
  const first = await applyMigrations({ target: target("cr_prod_install"), bootstrapTarget: bootstrapTarget("cr_prod_install"), migrateTarget: migrateTarget("cr_prod_install"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  assert.equal(first.planned, false);
  assert.equal(first.applied.length, 76);
  assert.equal(first.logins, "applied");
  assert.ok(first.objects > 50);
  assert.match(first.schemaDigest, /^sha256:[a-f0-9]{64}$/);
  const orders = (await query(target("cr_prod_install"), "SELECT ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
  assert.deepEqual(orders.map(row => row.ledger_order), Array.from({ length: 76 }, (_, index) => index + 1));
  const second = await applyMigrations({ target: target("cr_prod_install"), bootstrapTarget: bootstrapTarget("cr_prod_install"), migrateTarget: migrateTarget("cr_prod_install"), rootDir: ROOT });
  assert.equal(second.noOp, true);
  assert.deepEqual(second.applied, []);
  assert.equal(second.schemaDigest, first.schemaDigest);
});

test("ordered upgrade applies a pending suffix in two phases", needsPg, async () => {
  const { stage, ledgerPath } = await stageRoot(5);
  try {
    await freshDatabase("cr_prod_upgrade");
    const phase1 = await applyMigrations({ target: target("cr_prod_upgrade"), bootstrapTarget: bootstrapTarget("cr_prod_upgrade"), migrateTarget: migrateTarget("cr_prod_upgrade"), rootDir: stage, ledgerPath, env: { ...process.env, ...passwords } });
    assert.equal(phase1.applied.length, 5);
    assert.match(phase1.grants, /^deferred_partial_schema:/);
    const all = (await readdir(join(ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort().slice(0, 10);
    for (const file of all.slice(5)) await cp(join(ROOT, "db/migrations", file), join(stage, "db/migrations", file));
    const entries = await collectLedgerEntries(stage);
    await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
    const phase2 = await applyMigrations({ target: target("cr_prod_upgrade"), bootstrapTarget: bootstrapTarget("cr_prod_upgrade"), migrateTarget: migrateTarget("cr_prod_upgrade"), rootDir: stage, ledgerPath });
    assert.equal(phase2.applied.length, 5);
    assert.deepEqual(phase2.applied.map(entry => entry.order), [6, 7, 8, 9, 10]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("tampered history fails closed: altered, deleted-row and forged-digest states", needsPg, async () => {
  await freshDatabase("cr_prod_tamper");
  await applyMigrations({ target: target("cr_prod_tamper"), bootstrapTarget: bootstrapTarget("cr_prod_tamper"), migrateTarget: migrateTarget("cr_prod_tamper"), rootDir: ROOT });
  await query(target("cr_prod_tamper"), "DELETE FROM control_room_schema_migrations WHERE ledger_order = 36");
  await assert.rejects(applyMigrations({ target: target("cr_prod_tamper"), bootstrapTarget: bootstrapTarget("cr_prod_tamper"), migrateTarget: migrateTarget("cr_prod_tamper"), rootDir: ROOT }), /migration_gap:/);
  await freshDatabase("cr_prod_forge");
  await applyMigrations({ target: target("cr_prod_forge"), bootstrapTarget: bootstrapTarget("cr_prod_forge"), migrateTarget: migrateTarget("cr_prod_forge"), rootDir: ROOT });
  await query(target("cr_prod_forge"), "UPDATE control_room_schema_migrations SET digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' WHERE ledger_order = 10");
  await assert.rejects(applyMigrations({ target: target("cr_prod_forge"), bootstrapTarget: bootstrapTarget("cr_prod_forge"), migrateTarget: migrateTarget("cr_prod_forge"), rootDir: ROOT }), /migration_ledger_digest_mismatch:/);
});

test("live schema drift refuses closed before any grants or logins are applied", needsPg, async () => {
  await freshDatabase("cr_prod_drift");
  await applyMigrations({ target: target("cr_prod_drift"), bootstrapTarget: bootstrapTarget("cr_prod_drift"), migrateTarget: migrateTarget("cr_prod_drift"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  // Simulate drift by dropping a table and re-applying. The ledger still
  // claims the schema is intact; the live schema is now missing a table.
  // The next applyMigrations must refuse closed with the drift error before
  // any grants or logins run — proving the no-op rerun path is protected.
  await query(target("cr_prod_drift"), "DROP TABLE tenants CASCADE");
  await assert.rejects(applyMigrations({ target: target("cr_prod_drift"), bootstrapTarget: bootstrapTarget("cr_prod_drift"), migrateTarget: migrateTarget("cr_prod_drift"), rootDir: ROOT }), /migration_live_schema_drift:/);
});

test("altered and missing files fail closed without connecting past validation", needsPg, async () => {
  const { stage, ledgerPath } = await stageRoot(76);
  try {
    await freshDatabase("cr_prod_files");
    await applyMigrations({ target: target("cr_prod_files"), bootstrapTarget: bootstrapTarget("cr_prod_files"), migrateTarget: migrateTarget("cr_prod_files"), rootDir: stage, ledgerPath });
    const all = (await readdir(join(stage, "db/migrations"))).filter(name => name.endsWith(".sql")).sort();
    await writeFile(join(stage, "db/migrations", all[20]), `${await readFile(join(stage, "db/migrations", all[20]), "utf8")}\n-- tampered`);
    await assert.rejects(applyMigrations({ target: target("cr_prod_files"), bootstrapTarget: bootstrapTarget("cr_prod_files"), migrateTarget: migrateTarget("cr_prod_files"), rootDir: stage, ledgerPath }), /migration_altered:/);
    // Restore the tampered file so the missing-file refusal is proven in isolation
    // (validation reports the earliest ledger entry first).
    await cp(join(ROOT, "db/migrations", all[20]), join(stage, "db/migrations", all[20]));
    await rm(join(stage, "db/migrations", all[21]));
    await assert.rejects(applyMigrations({ target: target("cr_prod_files"), bootstrapTarget: bootstrapTarget("cr_prod_files"), migrateTarget: migrateTarget("cr_prod_files"), rootDir: stage, ledgerPath }), /migration_missing:/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("failed migration rolls back with no ledger row and a reusable database", needsPg, async () => {
  const { stage, ledgerPath } = await stageRoot(3);
  try {
    // Phase A: the good prefix applies; record the schema digest the failed
    // file must leave untouched.
    await freshDatabase("cr_prod_broken");
    await applyMigrations({ target: target("cr_prod_broken"), bootstrapTarget: bootstrapTarget("cr_prod_broken"), migrateTarget: migrateTarget("cr_prod_broken"), rootDir: stage, ledgerPath });
    const { connectTarget: connect } = await import("../deploy/postgres/evidence.mjs");
    const digestOf = async () => {
      const client = connect(target("cr_prod_broken"));
      await client.connect();
      try {
        return await readSchemaDigest(client);
      } finally {
        await client.end();
      }
    };
    const before = await digestOf();
    // Phase B: append the broken file and re-apply; only it may fail.
    await writeFile(join(stage, "db/migrations/9999_broken.sql"), "CREATE TABLE broken (id true_false_type;");
    const entries = await collectLedgerEntries(stage);
    await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
    await assert.rejects(applyMigrations({ target: target("cr_prod_broken"), bootstrapTarget: bootstrapTarget("cr_prod_broken"), migrateTarget: migrateTarget("cr_prod_broken"), rootDir: stage, ledgerPath }), /migration_failed:db\/migrations\/9999_broken\.sql/);
    const rows = (await query(target("cr_prod_broken"), "SELECT filename FROM control_room_schema_migrations")).rows;
    assert.ok(!rows.some(row => row.filename.includes("9999_broken")));
    assert.equal(await digestOf(), before);
    const databases = (await query(adminDb(), "SELECT datname FROM pg_database WHERE datname LIKE 'cr\\_prod\\_%' ORDER BY datname")).rows;
    assert.ok(databases.length >= 4);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("least-privilege denial: application login reads and writes exactly its grants", needsPg, async () => {
  await freshDatabase("cr_prod_privs");
  await applyMigrations({ target: target("cr_prod_privs"), bootstrapTarget: bootstrapTarget("cr_prod_privs"), migrateTarget: migrateTarget("cr_prod_privs"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  const app = target("cr_prod_privs", "control_room_app");
  await assert.rejects(query(app, "CREATE TABLE rogue (id int)"), /permission denied|not permitted/);
  await assert.rejects(query(app, "DELETE FROM tenants WHERE true"), /permission denied|not permitted/);
  await query(app, "INSERT INTO tenants(id, display_name) VALUES('tenant:privs', 'privs')");
  const rows = (await query(app, "SELECT id FROM tenants WHERE id = 'tenant:privs'")).rows;
  assert.equal(rows.length, 1);
  await assert.rejects(query(app, "SELECT * FROM control_room_schema_migrations"), /permission denied|not permitted/);
  await query(target("cr_prod_privs"), "DELETE FROM tenants WHERE id = 'tenant:privs'");
});

test("schedule-admission service gets narrow grants on fresh install and upgrade, never the reader", needsPg, async () => {
  await freshDatabase("cr_prod_sched");
  await applyMigrations({ target: target("cr_prod_sched"), bootstrapTarget: bootstrapTarget("cr_prod_sched"), migrateTarget: migrateTarget("cr_prod_sched"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  const db = target("cr_prod_sched");
  const sched = target("cr_prod_sched", "control_room_scheduler");
  const matrix = (await query(db,
    `SELECT has_table_privilege('control_room_scheduler', 'control_scheduled_task_admissions', 'INSERT') AS sched_insert,
            has_table_privilege('control_room_scheduler', 'control_scheduled_task_admissions', 'SELECT') AS sched_select,
            has_table_privilege('control_room_scheduler', 'control_scheduled_task_admissions', 'UPDATE') AS sched_update,
            has_table_privilege('control_room_scheduler', 'control_scheduled_task_admissions', 'DELETE') AS sched_delete,
            has_table_privilege('control_room_scheduler', 'control_requests', 'SELECT') AS sched_ref_select,
            has_table_privilege('control_room_scheduler', 'control_requests', 'INSERT') AS sched_ref_insert,
            has_table_privilege('control_room_reader', 'control_scheduled_task_admissions', 'INSERT') AS reader_insert,
            has_table_privilege('control_room_reader', 'control_scheduled_task_admissions', 'SELECT') AS reader_select`)).rows[0];
  assert.equal(matrix.sched_insert, true);
  assert.equal(matrix.sched_select, true);
  assert.equal(matrix.sched_update, false);
  assert.equal(matrix.sched_delete, false);
  assert.equal(matrix.sched_ref_select, true);
  assert.equal(matrix.sched_ref_insert, false);
  assert.equal(matrix.reader_insert, false);
  assert.equal(matrix.reader_select, true);
  // Privilege-checked before execution: denied even with zero rows matched.
  await assert.rejects(query(sched, "UPDATE control_scheduled_task_admissions SET payload = '{}' WHERE false"), /permission denied|not permitted/);
  // Existing-installation upgrade: strip the grants, re-apply, they converge back.
  await query(db, "REVOKE ALL ON control_scheduled_task_admissions FROM control_room_schedule_admissions");
  const reconverged = await applyMigrations({ target: db, bootstrapTarget: bootstrapTarget("cr_prod_sched"), migrateTarget: migrateTarget("cr_prod_sched"), rootDir: ROOT });
  assert.equal(reconverged.noOp, true);
  const back = (await query(db, "SELECT has_table_privilege('control_room_scheduler', 'control_scheduled_task_admissions', 'INSERT') AS sched_insert")).rows[0];
  assert.equal(back.sched_insert, true);
});

test("backup and disposable restore preserve rows, owners, grants and identity", needsPg, async () => {
  await freshDatabase("cr_prod_source");
  await applyMigrations({ target: target("cr_prod_source"), bootstrapTarget: bootstrapTarget("cr_prod_source"), migrateTarget: migrateTarget("cr_prod_source"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  await query(target("cr_prod_source"), "INSERT INTO tenants(id, display_name) VALUES('tenant:restore', 'restore')");
  const ledger = JSON.parse(await readFile(join(ROOT, "deploy/postgres/migration-ledger.json"), "utf8"));
  const out = join(run, "backup-set");
  const backup = await backupDatabase({ source: target("cr_prod_source"), out, pgBin: BIN, ledgerDigest: `sha256:${ledger.digest}`, requiredTables: ["tenants"] });
  assert.equal(backup.planned, false);
  await freshDatabase("cr_prod_restored");
  const restored = await restoreDatabase({ backup: out, target: target("cr_prod_restored"), confirmTarget: target("cr_prod_restored"), pgBin: BIN, requiredTables: ["tenants"] });
  assert.equal(restored.identityDigest, backup.identityDigest);
  const sourceRows = (await query(target("cr_prod_source"), "SELECT id, display_name FROM tenants ORDER BY id")).rows;
  const restoredRows = (await query(target("cr_prod_restored"), "SELECT id, display_name FROM tenants ORDER BY id")).rows;
  assert.deepEqual(restoredRows, sourceRows);
  const ownerOf = async (conn) => (await query(conn, "SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tenants'")).rows[0].owner;
  assert.equal(await ownerOf(target("cr_prod_restored")), await ownerOf(target("cr_prod_source")));
  // Role model preserved: the reconciled target carries exactly the source's
  // control-room memberships (roles are cluster-global in this fixture, which
  // is why the dedicated reconcile test below revokes first to prove the
  // re-grant path instead of merely observing shared state).
  assert.deepEqual(await roleMemberships(target("cr_prod_restored")), await roleMemberships(target("cr_prod_source")));
});

test("restore refuses unconfirmed and non-empty targets", needsPg, async () => {
  const out = join(run, "backup-set");
  await assert.rejects(restoreDatabase({ backup: out, target: target("cr_prod_restored"), confirmTarget: target("cr_prod_other"), pgBin: BIN }), /restore_refused_unconfirmed_target/);
  await assert.rejects(restoreDatabase({ backup: out, target: target("cr_prod_source"), confirmTarget: target("cr_prod_source"), pgBin: BIN }), /restore_refused_nonempty_target/);
});

test("restore reconciles a revoked membership from the recorded role model", needsPg, async () => {
  const out = join(run, "backup-set");
  // Revoke cluster-wide, then restore into a fresh database: the reconcile
  // step must re-grant the recorded membership or the identity check fails.
  await query(target("cr_prod_source"), "REVOKE control_room_application FROM control_room_app");
  const before = await roleMemberships(target("cr_prod_source"));
  assert.ok(!before.some(entry => entry.member === "control_room_app" && entry.role === "control_room_application"));
  await freshDatabase("cr_prod_reconcile");
  const restored = await restoreDatabase({ backup: out, target: target("cr_prod_reconcile"), confirmTarget: target("cr_prod_reconcile"), pgBin: BIN, requiredTables: ["tenants"] });
  assert.equal(restored.planned, false);
  const after = await roleMemberships(target("cr_prod_reconcile"));
  assert.ok(after.some(entry => entry.member === "control_room_app" && entry.role === "control_room_application" && entry.admin_option === false));
});

test("restore identity fails closed on a flipped sensitive role attribute", needsPg, async () => {
  const meta = JSON.parse(await readFile(join(run, "backup-set/metadata.json"), "utf8"));
  await query(target("cr_prod_restored"), "ALTER ROLE control_room_app WITH REPLICATION");
  try {
    const evidence = await collectDatabaseEvidence(target("cr_prod_restored"), { requiredTables: ["tenants"] });
    assert.ok(evidence.roles.some(role => role.rolname === "control_room_app" && role.rolreplication === true));
    const tampered = computeDatabaseRestoreIdentity({
      ledgerDigest: meta.ledgerDigest, rolesDigest: digestOf(evidence.roles),
      membershipsDigest: digestOf(evidence.memberships), schemaDigest: evidence.schemaDigest,
      rowsDigest: digestOf(evidence.rows), ownersDigest: digestOf(evidence.grants),
      ledgerRowsDigest: digestOf(evidence.ledger), databaseOwnerDigest: digestOf(evidence.databaseOwner),
    });
    assert.throws(() => verifyRestoredIdentity(meta.identity, tampered), /restore_identity_mismatch:rolesDigest/);
  } finally {
    await query(target("cr_prod_restored"), "ALTER ROLE control_room_app WITH NOREPLICATION");
  }
});

test("restore identity fails closed on a revoked membership", needsPg, async () => {
  const meta = JSON.parse(await readFile(join(run, "backup-set/metadata.json"), "utf8"));
  await query(target("cr_prod_restored"), "REVOKE control_room_application FROM control_room_app");
  try {
    const evidence = await collectDatabaseEvidence(target("cr_prod_restored"), { requiredTables: ["tenants"] });
    const tampered = computeDatabaseRestoreIdentity({
      ledgerDigest: meta.ledgerDigest, rolesDigest: digestOf(evidence.roles),
      membershipsDigest: digestOf(evidence.memberships), schemaDigest: evidence.schemaDigest,
      rowsDigest: digestOf(evidence.rows), ownersDigest: digestOf(evidence.grants),
      ledgerRowsDigest: digestOf(evidence.ledger), databaseOwnerDigest: digestOf(evidence.databaseOwner),
    });
    assert.throws(() => verifyRestoredIdentity(meta.identity, tampered), /restore_identity_mismatch:membershipsDigest/);
  } finally {
    await query(target("cr_prod_restored"), "GRANT control_room_application TO control_room_app");
  }
});

test("operator provision script creates logins via psql without exposing passwords", needsPg, async () => {
  await freshDatabase("cr_prod_provision");
  const psqlEnv = {
    PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run,
    PGHOST: socket, PGPORT: String(PORT), PGUSER: "fixture_admin",
    PGPASSWORD: "fixture_only", PGDATABASE: "cr_prod_provision",
  };
  const provision = (vars) => exec(join(BIN, "psql"),
    ["-v", `migrator_password=${vars.migrator}`, "-v", `app_password=${vars.app}`,
     "-v", `scheduler_password=${vars.scheduler}`,
     "-f", join(ROOT, "db/roles/production_provision.sql"), "-X", "-q"],
    { env: psqlEnv, timeout: 60000, maxBuffer: 1 << 26 });
  // Short passwords fail closed before any login is created.
  const short = await provision({ migrator: "x".repeat(23), app: "y".repeat(24), scheduler: "z".repeat(24) }).then(
    () => { throw new Error("provision_accepted_short_password"); },
    (error) => error);
  assert.match(`${short.stderr ?? ""}`, /provision_refused_short_migrator_password/);
  // Full run: genuinely executable through real psql variable substitution.
  const pw = { migrator: "provision-test-migrator-0001", app: "provision-test-app-00001", scheduler: "provision-test-scheduler-0001" };
  const done = await provision(pw);
  for (const secret of Object.values(pw)) {
    assert.ok(!`${done.stdout ?? ""}${done.stderr ?? ""}`.includes(secret), "password leaked into psql output");
  }
  const roles = (await query(target("cr_prod_provision"),
    "SELECT rolname, rolcanlogin, rolpassword FROM pg_roles WHERE rolname LIKE 'control@_room@_%' ESCAPE '@' ORDER BY 1")).rows;
  const byName = new Map(roles.map(role => [role.rolname, role]));
  for (const login of ["control_room_migrator", "control_room_app", "control_room_scheduler"]) {
    assert.equal(byName.get(login)?.rolcanlogin, true, `${login} can login`);
    assert.ok(byName.get(login)?.rolpassword, `${login} has a password set`);
  }
  assert.ok(!byName.get("control_room_migrator").rolpassword.includes(pw.migrator), "password stored hashed, not plaintext");
  const memberships = await roleMemberships(target("cr_prod_provision"));
  for (const [member, role] of [["control_room_migrator", "control_room_schema_owner"],
      ["control_room_app", "control_room_application"],
      ["control_room_scheduler", "control_room_schedule_admissions"]]) {
    assert.ok(memberships.some(entry => entry.member === member && entry.role === role), `${member} in ${role}`);
  }
});

test("documented clean-cluster provision/migrate/backup/restore/verify journey", needsPg, async (t) => {
  // A second disposable cluster: cluster-global roles from earlier tests must
  // not mask a provision script that assumes groups already exist, and the
  // restore target must not inherit shared-cluster role state either. Every
  // step below is the documented operator flow, executed literally.
  const CLEAN_PORT = 65435;
  const cleanSocket = join(run, "clean-socket"), cleanData = join(run, "clean-data");
  const cleanBackup = join(run, "clean-backup-set");
  // The restore target lives in its OWN disposable cluster: roles and
  // memberships are cluster-wide, so a second database in the source cluster
  // would inherit the source's role state before target provisioning.
  const TARGET_PORT = 65436;
  const targetSocket = join(run, "clean-target-socket"), targetData = join(run, "clean-target-data");
  const asPostgres = process.getuid?.() === ROOT_UID;
  const ownDirs = async (...dirs) => {
    if (asPostgres) await exec("chown", ["-R", `${POSTGRES_UID}:${POSTGRES_GID}`, ...dirs]);
  };
  await mkdir(cleanSocket, { mode: 0o700 });
  await mkdir(targetSocket, { mode: 0o700 });
  await ownDirs(cleanSocket, targetSocket, run);
  const startCluster = async (socket, data, port, log) => {
    if (asPostgres) {
      await exec("mkdir", ["-p", data]);
      await ownDirs(data);
    } else {
      await mkdir(data, { recursive: true });
    }
    await native("initdb", ["-D", data, "-U", "fixture_admin", "--auth-local=trust",
      "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
    await native("pg_ctl", ["-D", data, "-l", join(run, log), "-w", "-t", "30", "-o",
      `-k ${socket} -p ${port} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`, "start"]);
  };
  await startCluster(cleanSocket, cleanData, CLEAN_PORT, "clean-server.log");
  await startCluster(targetSocket, targetData, TARGET_PORT, "clean-target-server.log");
  t.after(async () => {
    for (const data of [cleanData, targetData]) {
      try {
        await native("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
      } catch {}
    }
    await rm(cleanSocket, { recursive: true, force: true });
    await rm(cleanData, { recursive: true, force: true });
    await rm(targetSocket, { recursive: true, force: true });
    await rm(targetData, { recursive: true, force: true });
    await rm(cleanBackup, { recursive: true, force: true });
  });
  const pw = { migrator: "clean-install-migrator-0001", app: "clean-install-app-000001", scheduler: "clean-install-scheduler-0001" };
  const psqlFor = (socket, port) => ({
    PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run,
    PGHOST: socket, PGPORT: String(port), PGUSER: "fixture_admin",
    PGPASSWORD: "fixture_only",
  });
  const psqlBase = psqlFor(cleanSocket, CLEAN_PORT);
  const provisionRoles = (database, env = psqlBase) => exec(join(BIN, "psql"),
    ["-v", `migrator_password=${pw.migrator}`, "-v", `app_password=${pw.app}`,
     "-v", `scheduler_password=${pw.scheduler}`,
     "-f", join(ROOT, "db/roles/production_provision.sql"), "-X", "-q"],
    { env: { ...env, PGDATABASE: database }, timeout: 60000, maxBuffer: 1 << 26 });
  const cleanConn = (socket, port, database, user = "fixture_admin", password = "fixture_only") =>
    ({ host: socket, port, database, user, password });
  const sourceConn = (database, user, password) => cleanConn(cleanSocket, CLEAN_PORT, database, user, password);
  const targetConn = (database, user, password) => cleanConn(targetSocket, TARGET_PORT, database, user, password);
  const cleanQuery = async (socket, port, database, sql, params = []) => {
    const client = new Client(cleanConn(socket, port, database));
    await client.connect();
    try {
      return await client.query(sql, params);
    } finally {
      await client.end();
    }
  };
  const sourceQuery = (database, sql, params = []) => cleanQuery(cleanSocket, CLEAN_PORT, database, sql, params);
  // Step 0 of the documented fresh install: the database-creation script. The
  // owner stays the invoking superuser — the schema-owner role does not exist
  // yet on a genuinely empty cluster, so an OWNER clause would be rejected.
  await exec(join(BIN, "psql"),
    ["-v", "dbname=cr_clean_install", "-f", join(ROOT, "deploy/postgres/provision-database.sql"), "-X", "-q"],
    { env: { ...psqlBase, PGDATABASE: "postgres" }, timeout: 60000, maxBuffer: 1 << 26 });
  const preOwner = (await sourceQuery("postgres",
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'cr_clean_install'")).rows[0].owner;
  assert.equal(preOwner, "fixture_admin", "database starts owned by the creating superuser");
  // Step 1: standalone role provisioning on the clean database.
  await provisionRoles("cr_clean_install");
  // Step 2: the documented two-connection migration command, via the real CLI.
  const adminConn = `host=${cleanSocket} port=${CLEAN_PORT} dbname=cr_clean_install user=fixture_admin`;
  const migratorConn = `host=${cleanSocket} port=${CLEAN_PORT} dbname=cr_clean_install user=control_room_migrator password=${pw.migrator}`;
  const migrated = await exec(process.execPath,
    [join(ROOT, "deploy/postgres/apply-migrations.mjs"),
     "--bootstrap-target", adminConn, "--migrate-target", migratorConn],
    { cwd: ROOT, timeout: 300000, maxBuffer: 1 << 26,
      env: { ...process.env, PATH: "/usr/bin:/bin", LC_ALL: "C",
        CONTROL_ROOM_MIGRATOR_PASSWORD: pw.migrator, CONTROL_ROOM_APP_PASSWORD: pw.app,
        CONTROL_ROOM_SCHEDULER_PASSWORD: pw.scheduler } });
  const result = JSON.parse(migrated.stdout);
  assert.ok((result.applied?.length ?? 0) > 0, "migrations applied through the documented CLI");
  // The install is complete and least-privilege: logins, groups, memberships,
  // ledger rows, schema-owner object ownership and database ownership, all on
  // the clean cluster.
  const db = sourceConn("cr_clean_install");
  const cleanTargetQuery = async (sql, params = []) => {
    const client = new Client(db);
    await client.connect();
    try {
      return await client.query(sql, params);
    } finally {
      await client.end();
    }
  };
  const roles = (await cleanTargetQuery(
    "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE 'control@_room@_%' ESCAPE '@' ORDER BY 1")).rows;
  const byName = new Map(roles.map(role => [role.rolname, role]));
  for (const login of ["control_room_migrator", "control_room_app", "control_room_scheduler"]) {
    assert.equal(byName.get(login)?.rolcanlogin, true, `${login} can login`);
  }
  for (const group of ["control_room_schema_owner", "control_room_application", "control_room_schedule_admissions"]) {
    assert.ok(byName.has(group), `${group} exists`);
  }
  const memberships = await roleMemberships(db);
  for (const [member, role] of [["control_room_migrator", "control_room_schema_owner"],
      ["control_room_app", "control_room_application"],
      ["control_room_scheduler", "control_room_schedule_admissions"]]) {
    assert.ok(memberships.some(entry => entry.member === member && entry.role === role), `${member} in ${role}`);
  }
  const owners = (await cleanTargetQuery(
    "SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'")).rows;
  assert.deepEqual(owners.map(row => row.owner), ["control_room_schema_owner"]);
  const dbOwner = (await sourceQuery("postgres",
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'cr_clean_install'")).rows[0].owner;
  assert.equal(dbOwner, "control_room_schema_owner", "bootstrap transfers database ownership after roles exist");
  const ledgerRows = (await cleanTargetQuery("SELECT count(*)::int AS count FROM control_room_schema_migrations")).rows;
  const executable = (await collectLedgerEntries()).filter(entry => (entry.kind ?? "migrate") === "migrate");
  assert.equal(ledgerRows[0].count, executable.length, "every executable ledger entry applied");
  // Step 3: seed a row and back the clean install up (function inputs actually
  // consumed: source/out/pgBin/ledgerDigest/requiredTables).
  await cleanTargetQuery("INSERT INTO tenants(id, display_name) VALUES('tenant:clean', 'clean install')");
  const ledger = JSON.parse(await readFile(join(ROOT, "deploy/postgres/migration-ledger.json"), "utf8"));
  const backup = await backupDatabase({ source: db, out: cleanBackup, pgBin: BIN,
    ledgerDigest: `sha256:${ledger.digest}`, requiredTables: ["tenants"] });
  assert.equal(backup.planned, false);
  // Step 4: the documented recovery order on the SEPARATE target cluster —
  // database script, then role provisioning (restore reconciles memberships
  // but refuses a missing login, so the logins must pre-exist). The absence
  // proof first: the target cluster must carry none of the source's role
  // state before its own provisioning.
  const targetPsq = psqlFor(targetSocket, TARGET_PORT);
  const absent = (await cleanQuery(targetSocket, TARGET_PORT, "postgres",
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'control@_room@_%' ESCAPE '@'")).rows;
  assert.deepEqual(absent, [], "target cluster starts with no control-room roles");
  await exec(join(BIN, "psql"),
    ["-v", "dbname=cr_clean_restored", "-f", join(ROOT, "deploy/postgres/provision-database.sql"), "-X", "-q"],
    { env: { ...targetPsq, PGDATABASE: "postgres" }, timeout: 60000, maxBuffer: 1 << 26 });
  await provisionRoles("cr_clean_restored", targetPsq);
  // Step 5: restore into the provisioned empty target and verify the restored
  // identity field by field (restoreDatabase verifies internally, including
  // the new databaseOwnerDigest; the digest equality pins the same identity
  // the backup recorded). Only consumed inputs are passed — no unused
  // bootstrap/migrate descriptors.
  const cleanTarget = targetConn("cr_clean_restored");
  const restored = await restoreDatabase({ backup: cleanBackup, target: cleanTarget,
    confirmTarget: targetConn("cr_clean_restored"), pgBin: BIN, requiredTables: ["tenants"] });
  assert.equal(restored.identityDigest, backup.identityDigest, "restored identity matches the backup identity");
  const sourceRows = (await cleanTargetQuery("SELECT id, display_name FROM tenants ORDER BY id")).rows;
  const restoredClient = new Client(cleanTarget);
  await restoredClient.connect();
  try {
    const restoredRows = (await restoredClient.query("SELECT id, display_name FROM tenants ORDER BY id")).rows;
    assert.deepEqual(restoredRows, sourceRows, "seed row survives the clean-cluster round trip");
  } finally {
    await restoredClient.end();
  }
  assert.deepEqual(await roleMemberships(cleanTarget), memberships, "restored target carries the clean install memberships");
  const restoredOwners = (await cleanQuery(targetSocket, TARGET_PORT, "cr_clean_restored",
    "SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'")).rows;
  assert.deepEqual(restoredOwners.map(row => row.owner), ["control_room_schema_owner"]);
  // Database ownership matches the source: the recorded owner is re-applied,
  // not the invoking administrator.
  const targetDbOwner = (await cleanQuery(targetSocket, TARGET_PORT, "postgres",
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'cr_clean_restored'")).rows[0].owner;
  assert.equal(targetDbOwner, dbOwner, "restored database owner matches the source database owner");
  assert.equal(targetDbOwner, "control_room_schema_owner");
});
