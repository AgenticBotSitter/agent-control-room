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
import { provisionMacLocalNarrowRolesV1 } from "../scripts/mac-local/narrow-role-provision.mjs";
import { createMacLocalDatabaseBackupV1 } from "../scripts/ops/backup-database.mjs";
import { verifyMacLocalDatabaseBackupV1 } from "../scripts/ops/verify-database-backup.mjs";
import { AuditStore } from "../src/audit/audit-store.ts";
import { WorkBatchStoreV1 } from "../src/work-intake/v1/store.ts";
import { WorkBatchOwnerServiceV1 } from "../src/work-intake/v1/owner-service.ts";
import { workBatchProposalDigestV1 } from "../src/work-intake/v1/digest.ts";
import { sha256Digest } from "../src/security/canonical-digest.ts";
import { SecurityStore } from "../src/security/security-store.ts";
import { WebProjectService } from "../src/web/v1/project-service.ts";
import { WebTaskService } from "../src/web/v1/task-service.ts";
import { createAccessVerifier } from "../src/web/v1/access-verifier.ts";
import { now as webNow, request as webRequest, trust as webTrust } from "./helpers/web-foundation.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.PG_BIN ?? "/usr/lib/postgresql/17/bin";
// Graceful skip for lanes without PostgreSQL binaries (e.g. the merge-gate
// catch-up entry, which has no PG install step): the tests run wherever the
// components job provisions PG17, and report as skipped elsewhere instead of
// failing the whole lane for an unrelated pull request.
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined : { skip: "needs PostgreSQL 17 binaries (PG_BIN or /usr/lib/postgresql/17/bin)" };
const PORT = 15630;
const exec = promisify(execFile);

let run = "", socket = "", data = "";
const target = (database, user = "fixture_admin") =>
  ({ host: socket, port: PORT, database, user, password: "fixture_only" });
const adminDb = () => target("postgres");
const passwords = { CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24), CONTROL_ROOM_APP_PASSWORD: "a".repeat(24),
  CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(24) };
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

function postgresDatabase(target) {
  const one = async (callback) => {
    const client=new Client(target); await client.connect();
    try { return await callback(client); } finally { await client.end(); }
  };
  const database={
    query:(sql,params=[])=>one(client=>client.query(sql,params)),
    transaction:(callback)=>one(async client=>{ await client.query("BEGIN");
      try { const result=await callback({query:(sql,params=[])=>client.query(sql,params)});
        await client.query("COMMIT"); return result; }
      catch(error){ await client.query("ROLLBACK"); throw error; } }),
    transactionWithPreCommitCheck:(callback,check)=>one(async client=>{ await client.query("BEGIN");
      try { const result=await callback({query:(sql,params=[])=>client.query(sql,params)});
        await check(); await client.query("COMMIT"); return result; }
      catch(error){ await client.query("ROLLBACK"); throw error; } }),
  };
  return Object.freeze(database);
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
  const expectedMigrations = (await collectLedgerEntries(ROOT)).filter(entry => (entry.kind ?? "migrate") === "migrate");
  const first = await applyMigrations({ target: target("cr_prod_install"), bootstrapTarget: bootstrapTarget("cr_prod_install"), migrateTarget: migrateTarget("cr_prod_install"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  assert.equal(first.planned, false);
  assert.equal(first.applied.length, expectedMigrations.length);
  assert.equal(first.logins, "applied");
  assert.ok(first.objects > 50);
  assert.match(first.schemaDigest, /^sha256:[a-f0-9]{64}$/);
  const orders = (await query(target("cr_prod_install"), "SELECT ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
  assert.deepEqual(orders.map(row => row.ledger_order), Array.from({ length: expectedMigrations.length }, (_, index) => index + 1));
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

// A database already at main applied 0100 at ledger order 94, before the
// owner-approval migration existed. Upgrading it must append the new
// migration after that row, never slot it in before an applied order.
test("upgrade from main's applied ledger appends only the owner-approval migration", needsPg, async () => {
  const stage = await mkdtemp(join(tmpdir(), "cr-pg63main-"));
  try {
    for (const dir of ["deploy/postgres", "db/migrations", "db/roles", "db/setup"])
      await mkdir(join(stage, dir), { recursive: true });
    const migrations = (await readdir(join(ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort();
    const ownerApproval = migrations.filter(name => name.endsWith("_work_batch_owner_approval.sql"));
    assert.equal(ownerApproval.length, 1);
    for (const file of migrations.filter(name => name !== ownerApproval[0]))
      await cp(join(ROOT, "db/migrations", file), join(stage, "db/migrations", file));
    for (const file of ["production_roles.sql", "production_provision.sql"])
      await cp(join(ROOT, "db/roles", file), join(stage, "db/roles", file));
    // main's grants: this head's file without the owner-approval additions.
    const grants = await readFile(join(ROOT, "db/roles/production_table_grants.sql"), "utf8");
    const mainGrants = grants.replaceAll(", work_batch_items", "")
      .replace("GRANT INSERT ON control_action_inbox TO control_room_work_intake;\n", "");
    assert.notEqual(mainGrants, grants);
    await writeFile(join(stage, "db/roles/production_table_grants.sql"), mainGrants);
    await cp(join(ROOT, "db/setup/production_migration_ledger.sql"), join(stage, "db/setup/production_migration_ledger.sql"));
    const entries = await collectLedgerEntries(stage);
    const ledgerPath = join(stage, "deploy/postgres/migration-ledger.json");
    await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));

    await freshDatabase("cr_prod_upgrade_main");
    const db = target("cr_prod_upgrade_main");
    const atMain = await applyMigrations({ target: db, bootstrapTarget: bootstrapTarget("cr_prod_upgrade_main"),
      migrateTarget: migrateTarget("cr_prod_upgrade_main"), rootDir: stage, ledgerPath, env: { ...process.env, ...passwords } });
    assert.equal(atMain.grants, "applied");
    assert.deepEqual((await query(db, `SELECT filename, ledger_order FROM control_room_schema_migrations
      ORDER BY ledger_order DESC LIMIT 1`)).rows,
    [{ filename: "db/migrations/0100_ownership_lease_collision_guard.sql", ledger_order: 94 }]);
    assert.equal((await query(db, "SELECT to_regclass('public.work_batch_items') AS present")).rows[0].present, null);

    const upgraded = await applyMigrations({ target: db, bootstrapTarget: bootstrapTarget("cr_prod_upgrade_main"),
      migrateTarget: migrateTarget("cr_prod_upgrade_main"), rootDir: ROOT });
    assert.deepEqual(upgraded.applied.map(entry => [entry.file, entry.order]),
      [[`db/migrations/${ownerApproval[0]}`, 95]]);
    assert.equal(upgraded.grants, "applied");
    assert.deepEqual((await query(db, `SELECT ledger_order, count(*)::int AS rows FROM control_room_schema_migrations
      GROUP BY ledger_order HAVING count(*) > 1`)).rows, []);
    const ledger = (await query(db, "SELECT filename, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
    assert.deepEqual(ledger.map(row => row.ledger_order), ledger.map((_, index) => index + 1));
    assert.deepEqual(ledger.slice(-2), [
      { filename: "db/migrations/0100_ownership_lease_collision_guard.sql", ledger_order: 94 },
      { filename: `db/migrations/${ownerApproval[0]}`, ledger_order: 95 }]);
    // Grants converged on the new objects in the same run.
    assert.deepEqual((await query(db, `SELECT
      has_table_privilege('control_room_work_intake','work_batch_items','SELECT') AS intake_items,
      has_table_privilege('control_room_work_intake','control_action_inbox','INSERT') AS intake_inbox,
      has_table_privilege('control_room_reader','work_batch_items','SELECT') AS reader_items`)).rows[0],
    { intake_items: true, intake_inbox: true, reader_items: false });

    const rerun = await applyMigrations({ target: db, bootstrapTarget: bootstrapTarget("cr_prod_upgrade_main"),
      migrateTarget: migrateTarget("cr_prod_upgrade_main"), rootDir: ROOT });
    assert.equal(rerun.noOp, true);
    assert.equal(rerun.grants, "applied");
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

test("work-intake login cannot read or forge another subsystem's shared-ledger records", needsPg, async () => {
  await freshDatabase("cr_prod_intake_guard");
  const db=target("cr_prod_intake_guard");
  await applyMigrations({ target:db, bootstrapTarget:bootstrapTarget("cr_prod_intake_guard"),
    migrateTarget:migrateTarget("cr_prod_intake_guard"), rootDir:ROOT, env:{...process.env,...passwords} });
  await query(db,"INSERT INTO tenants(id,display_name) VALUES('tenant:intake-guard','intake guard')");
  await query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:intake-guard')");
  await query(db,"INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:intake-guard','tenant:intake-guard','workspace')");
  await query(db,`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES('adapter:intake-guard','tenant:intake-guard','manual','1',
    'control_room_native','fixture','v1',1)`);
  for(const projectId of ["project:intake-guard","project:intake-other"])
    await query(db,`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload) VALUES($1,'tenant:intake-guard',
      'workspace:intake-guard','adapter:intake-guard',$1,'1','Project','ready','ready','healthy',
      'control_room_native','2026-09-27T12:00:00.000Z','{}')`,[projectId]);
  await query(db,`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:intake-guard','tenant:intake-guard','agent',
    'Intake agent','work-intake',$1,'active','2026-09-27T12:00:00.000Z','2026-09-27T12:00:00.000Z')`,
    [`sha256:${"6".repeat(64)}`]);
  await query(db,`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES('grant:intake-guard',
    'tenant:intake-guard','identity:intake-guard','work_batch_proposer','["work_batches.propose"]',
    '["project:intake-guard"]','low',false,false,'2026-09-27T12:00:00.000Z','2026-09-27T12:00:00.000Z')`);
  await query(db,`INSERT INTO control_idempotency
    (tenant_id,operation_scope,idempotency_key,request_digest,status)
    VALUES('tenant:intake-guard','other.operation/v1','other-key-0001',$1,'processing')`,[`sha256:${"1".repeat(64)}`]);
  await query(db,`INSERT INTO audit_events
    (id,tenant_id,actor_id,actor_type,action,target_type,target_id,safe_metadata,occurred_at)
    VALUES('audit:other:1','tenant:intake-guard','identity:other','service','other.action','tenant',
      'tenant:intake-guard','{}'::jsonb,'2026-09-27T12:00:00.000Z')`);
  await query(db,`INSERT INTO control_audit_chain_heads
    (tenant_id,chain_partition,head_hash,event_count,updated_at)
    VALUES('tenant:intake-guard','month:2026-09',$1,0,'2026-09-27T12:00:00.000Z')`,[`sha256:${"0".repeat(64)}`]);
  const intake={...target("cr_prod_intake_guard","control_room_work_intake_agent"),
    password:passwords.CONTROL_ROOM_WORK_INTAKE_PASSWORD};
  assert.deepEqual((await query(intake,"SELECT operation_scope FROM control_idempotency")).rows,[]);
  assert.deepEqual((await query(intake,"SELECT id FROM audit_events")).rows,[]);
  await assert.rejects(query(intake,`INSERT INTO control_idempotency
    (tenant_id,operation_scope,idempotency_key,request_digest,status)
    VALUES('tenant:intake-guard','other.operation/v1','attack-key-0001',$1,'processing')`,
    [`sha256:${"2".repeat(64)}`]),/work intake idempotency insert rejected/u);
  await assert.rejects(query(intake,`INSERT INTO audit_events
    (id,tenant_id,actor_id,actor_type,action,target_type,target_id,safe_metadata,occurred_at,
      chain_version,chain_partition,chain_sequence,event_digest,prev_hash,event_hash)
    VALUES('audit:work-intake:forged','tenant:intake-guard','identity:other','agent','other.action',
      'project','project:other','{}'::jsonb,'2026-09-27T12:00:00.000Z',1,'month:2026-09',1,$1,$2,$3)`,
    [`sha256:${"3".repeat(64)}`,`sha256:${"0".repeat(64)}`,`sha256:${"4".repeat(64)}`]),
    /work intake audit event insert rejected/u);
  await assert.rejects(query(intake,`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
    VALUES('attention:not-a-batch','tenant:intake-guard','project:intake-guard','other','approval','open',
      'delivered','2026-09-27T12:00:00.000Z','{}'::jsonb)`),/work batch notification insert rejected/u);
  await assert.rejects(query(intake,`UPDATE control_audit_chain_heads SET head_hash=$1,event_count=1
    WHERE tenant_id='tenant:intake-guard' AND chain_partition='month:2026-09'`,[`sha256:${"5".repeat(64)}`]),
    /work intake audit head update rejected/u);

  // Grants and the binding retain the group OID across a rename. Every guard
  // and restrictive policy must therefore remain active without matching the
  // group's original display name.
  await query(db,"ALTER ROLE control_room_work_intake RENAME TO control_room_work_intake_renamed");
  try {
    assert.deepEqual((await query(intake,"SELECT operation_scope FROM control_idempotency")).rows,[]);
    await assert.rejects(query(intake,`INSERT INTO control_idempotency
      (tenant_id,operation_scope,idempotency_key,request_digest,status)
      VALUES('tenant:intake-guard','other.operation/v1','renamed-key-0001',$1,'processing')`,
      [`sha256:${"a".repeat(64)}`]),/work intake idempotency insert rejected/u);
  } finally {
    await query(db,"ALTER ROLE control_room_work_intake_renamed RENAME TO control_room_work_intake");
  }

  await query(db,"GRANT control_room_work_intake TO control_room_scheduler");
  try {
    const alternate={...target("cr_prod_intake_guard","control_room_scheduler"),
      password:passwords.CONTROL_ROOM_SCHEDULER_PASSWORD};
    await assert.rejects(query(alternate,`INSERT INTO control_idempotency
      (tenant_id,operation_scope,idempotency_key,request_digest,status)
      VALUES('tenant:intake-guard','other.operation/v1','alternate-key-0001',$1,'processing')`,
      [`sha256:${"7".repeat(64)}`]),/work intake idempotency insert rejected/u);
  } finally { await query(db,"REVOKE control_room_work_intake FROM control_room_scheduler"); }

  const intakeDb=postgresDatabase(intake), store=new WorkBatchStoreV1(intakeDb,new Uint8Array(32).fill(8));
  const lockPrivileges=(await query(db,`SELECT
    has_column_privilege('control_room_work_intake','control_identities','web_lock','UPDATE') AS identity_lock,
    has_column_privilege('control_room_work_intake','control_role_grants','web_lock','UPDATE') AS grant_lock,
    has_column_privilege('control_room_work_intake','projects','coordinator_lock','UPDATE') AS project_lock,
    has_column_privilege('control_room_work_intake','control_identities','state','UPDATE') AS identity_state,
    has_column_privilege('control_room_work_intake','projects','domain_state','UPDATE') AS project_state`)).rows[0];
  assert.deepEqual(lockPrivileges,{identity_lock:true,grant_lock:true,project_lock:true,identity_state:false,project_state:false});
  const principal={tenantId:"tenant:intake-guard",identityId:"identity:intake-guard",actorType:"agent",
    authenticatedAt:"2026-09-27T11:00:00.000Z",expiresAt:"2027-09-27T12:00:00.000Z"};
  const positiveClient=new Client(intake); await positiveClient.connect();
  try {
    await positiveClient.query("BEGIN");
    const statements=[];
    const session={query:(sql,params=[])=>{statements.push(sql);return positiveClient.query(sql,params);}};
    const transactionalDb={query:session.query,transaction:callback=>callback(session),
      transactionWithPreCommitCheck:async(callback,check)=>{const value=await callback(session);await check();return value;}};
    const positiveStore=new WorkBatchStoreV1(transactionalDb,new Uint8Array(32).fill(8));
    const positiveProposal={schema:"control-room.work-batch-proposal/v1",projectId:"project:intake-guard",tasks:[{
      localId:"build",title:"Build",instructions:"Build the bounded change.",requiredCapability:"code.change",
      role:"builder",acceptanceCriteria:"The change is bounded.",acceptanceTests:"Run focused tests."}],edges:[]};
    const receipt=await positiveStore.create({principal,proposal:positiveProposal,
      proposalDigest:workBatchProposalDigestV1(positiveProposal),idempotencyKey:"positive-notification-0001",
      now:"2026-09-27T12:00:15.000Z",queueDepthLimit:10});
    assert.match(receipt.batchId,/^batch:/u);
    assert.equal(statements.filter(sql=>/^INSERT INTO control_action_inbox/iu.test(sql.trim())).length,1,
      "the successful real-PostgreSQL transaction issued one canonical notification insert");
  } finally {
    await positiveClient.query("ROLLBACK").catch(()=>{}); await positiveClient.end();
  }
  const auditCountBeforeNonAgent=(await query(intake,"SELECT count(*)::int AS count FROM audit_events")).rows[0].count;
  assert.deepEqual(await store.authorize({...principal,actorType:"human"},"project:intake-guard",
    "2026-09-27T12:00:30.000Z"),{allowed:false,safeReasonCode:"credential_inactive"});
  assert.equal((await query(intake,"SELECT count(*)::int AS count FROM audit_events")).rows[0].count,
    auditCountBeforeNonAgent,"non-agent refusal is not misattributed as intake-agent activity");
  assert.equal((await store.authorizeAction(principal,"project:intake-other","work_batches.propose",
    "2026-09-27T12:01:00.000Z")).allowed,false,"wrong-project refusal is recorded");
  await query(db,"UPDATE control_role_grants SET revoked_at='2026-09-27T12:01:30.000Z' WHERE id='grant:intake-guard'");
  assert.equal((await store.authorizeAction(principal,"project:intake-guard","work_batches.propose",
    "2026-09-27T12:02:00.000Z")).allowed,false,"revoked-grant refusal is recorded");
  await query(db,"UPDATE control_role_grants SET revoked_at=NULL,expires_at='2026-09-27T12:02:30.000Z' WHERE id='grant:intake-guard'");
  assert.equal((await store.authorizeAction(principal,"project:intake-guard","work_batches.propose",
    "2026-09-27T12:03:00.000Z")).allowed,false,"expired-grant refusal is recorded");
  await query(db,"UPDATE control_role_grants SET expires_at=NULL WHERE id='grant:intake-guard'; UPDATE control_identities SET state='suspended' WHERE id='identity:intake-guard'");
  assert.equal((await store.authorizeAction(principal,"project:intake-guard","work_batches.propose",
    "2026-09-27T12:04:00.000Z")).allowed,false,"inactive-identity refusal is recorded");
  const verified=await new AuditStore(intakeDb).verify("tenant:intake-guard","month:2026-09");
  assert.equal(verified.valid,true); assert.equal(verified.checkedEvents,4);

  await query(db,`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
    VALUES('attention:ordinary','tenant:intake-guard','project:intake-guard','ordinary','question','open',
      'delivered','2026-09-27T12:04:30.000Z','{"state":"open"}'::jsonb)`);
  const privateWebClient=new Client(db);
  await privateWebClient.connect();
  try {
    // Role definitions are cluster-global. Install this probe transactionally so
    // the later role-matrix attack test observes a clean cluster.
    await privateWebClient.query("BEGIN");
    await privateWebClient.query((await readFile(join(ROOT,"db/roles/private_web_roles.sql"),"utf8"))
      .replace(/^(?:BEGIN|COMMIT);$/gmu,""));
    await privateWebClient.query("SET LOCAL ROLE control_room_private_web");
    await assert.rejects(privateWebClient.query(`UPDATE control_action_inbox
      SET state='resolved',payload='{"state":"resolved"}'::jsonb
      WHERE tenant_id='tenant:intake-guard' AND id='attention:ordinary'`),
    /work batch notification update rejected/u);
  } finally {
    await privateWebClient.query("ROLLBACK").catch(()=>{});
    await privateWebClient.end();
  }
  assert.equal((await query(db,`SELECT state FROM control_action_inbox
    WHERE tenant_id='tenant:intake-guard' AND id='attention:ordinary'`)).rows[0].state,"open");
  await query(db,"DELETE FROM control_action_inbox WHERE tenant_id='tenant:intake-guard' AND id='attention:ordinary'");

  const head=(await query(intake,`SELECT head_hash,event_count::int FROM control_audit_chain_heads
    WHERE tenant_id='tenant:intake-guard' AND chain_partition='month:2026-09'`)).rows[0];
  const orphanMaterial={id:"audit:work-intake-refusal:orphan",tenantId:"tenant:intake-guard",workspaceId:null,
    projectId:"project:intake-guard",actorId:"identity:intake-guard",actorType:"agent",
    action:"work_batches.propose.refused",targetType:"project",targetId:"project:intake-guard",
    correlationId:null,idempotencyKey:null,safeMetadata:{reasonCode:"no_matching_grant"},
    occurredAt:"2026-09-27T12:05:00.000Z"};
  const orphanDigest=sha256Digest(orphanMaterial), orphanSequence=head.event_count+1;
  const orphanHash=sha256Digest({chainVersion:1,partition:"month:2026-09",sequence:orphanSequence,
    previousHash:head.head_hash,eventDigest:orphanDigest});
  await assert.rejects(query(intake,`INSERT INTO audit_events
    (id,tenant_id,project_id,actor_id,actor_type,action,target_type,target_id,safe_metadata,occurred_at,
      chain_version,chain_partition,chain_sequence,event_digest,prev_hash,event_hash)
    VALUES($1,'tenant:intake-guard','project:intake-guard','identity:intake-guard','agent',
      'work_batches.propose.refused','project','project:intake-guard',$2::jsonb,
      '2026-09-27T12:05:00.000Z',1,'month:2026-09',$3,$4,$5,$6)`,
    [orphanMaterial.id,JSON.stringify(orphanMaterial.safeMetadata),orphanSequence,
      `sha256:${"8".repeat(64)}`,head.head_hash,`sha256:${"9".repeat(64)}`]),/work intake audit hash rejected/u);
  await assert.rejects(query(intake,`INSERT INTO audit_events
    (id,tenant_id,project_id,actor_id,actor_type,action,target_type,target_id,safe_metadata,occurred_at,
      chain_version,chain_partition,chain_sequence,event_digest,prev_hash,event_hash)
    SELECT 'audit:work-intake-refusal:orphan','tenant:intake-guard','project:intake-guard',
      'identity:intake-guard','agent','work_batches.propose.refused','project','project:intake-guard',$1::jsonb,
      '2026-09-27T12:05:00.000Z',1,'month:2026-09',$2,$3,$4,$5`,
    [JSON.stringify(orphanMaterial.safeMetadata),orphanSequence,orphanDigest,head.head_hash,orphanHash]),
    /committed without head advance/u);

  const ownerDown=await readFile(join(ROOT,"db/down/0102_work_batch_owner_approval.sql"),"utf8");
  const down=await readFile(join(ROOT,"db/down/0093_work_batch_intake.sql"),"utf8");
  await query(db,"CREATE POLICY test_dependent_policy ON audit_events AS RESTRICTIVE USING (true)");
  await assert.rejects(query(db,down),/shared-ledger RLS policies depend on it/u);
  const retained=(await query(db,`SELECT
    has_column_privilege('control_room_work_intake','control_idempotency','status','UPDATE') AS column_update,
    (SELECT count(*)::int FROM pg_trigger WHERE tgname='control_idempotency_work_intake_guard' AND NOT tgisinternal) AS guard_count,
    (SELECT count(*)::int FROM pg_policies WHERE policyname='audit_events_work_intake_scope') AS policy_count`)).rows[0];
  assert.deepEqual(retained,{column_update:true,guard_count:1,policy_count:1});
  await query(db,"DROP POLICY test_dependent_policy ON audit_events");
  // The owner-approval slice depends on the intake tables. Exercise the
  // reviewed recovery order before removing the proposal-only base slice.
  await query(db,ownerDown);
  const restoredSearchPath=(await query(db,`SELECT proconfig FROM pg_proc
    WHERE oid='public.guard_initial_work_batch_revision_insert()'::regprocedure`)).rows[0]?.proconfig;
  assert.deepEqual(restoredSearchPath,["search_path=pg_catalog, public, pg_temp"]);
  await query(db,down);
  const remaining=(await query(db,`SELECT
    has_table_privilege('control_room_work_intake','control_idempotency','SELECT') AS table_select,
    has_column_privilege('control_room_work_intake','control_idempotency','status','UPDATE') AS column_update,
    has_column_privilege('control_room_work_intake','control_audit_chain_heads','head_hash','UPDATE') AS head_update,
    has_column_privilege('control_room_work_intake','control_identities','web_lock','UPDATE') AS identity_lock,
    has_column_privilege('control_room_work_intake','projects','coordinator_lock','UPDATE') AS project_lock`)).rows[0];
  assert.deepEqual(remaining,{table_select:false,column_update:false,head_update:false,identity_lock:false,project_lock:false});
  await assert.rejects(query(intake,"SELECT * FROM control_idempotency"),/permission denied/u);
});

// Two tenants, each registered for work intake exactly as the owner bootstraps
// register agents (auth_provider='work-intake' plus a valid proposer grant).
// A directly registered agent in the own tenant is not registered for intake.
const seededBatchAt = "2026-09-27T12:00:00.000Z";
const seededBatchProposal = JSON.stringify({ title: "Seeded proposal" });
const seededBatchDigest = `sha256:${"b".repeat(64)}`;
const seededBatchTag = `hmac-sha256:${"c".repeat(64)}`;
const seededBatches = [
  // [tenant, proposer, auth provider, batch, has revision]
  ["tenant:batch-own", "identity:work-intake:own", "work-intake", "batch:own", true],
  ["tenant:batch-own", "identity:batch-own-direct", "agent-key", "batch:own-direct", true],
  ["tenant:batch-other", "identity:work-intake:other", "work-intake", "batch:other", true],
  ["tenant:batch-other", "identity:work-intake:other", "work-intake", "batch:other-open", false],
];
const intakeScope = identityId => `work-batches.propose/v1:${identityId}`;
const intakeLedgerTables = ["work_batches", "work_batch_revisions", "work_batch_items", "control_idempotency", "audit_events"];
// Decided proposal content. Rejected items need no job, so each seeded batch
// can carry one while it is still proposed.
const seededItems = [["tenant:batch-own", "batch:own"], ["tenant:batch-own", "batch:own-direct"],
  ["tenant:batch-other", "batch:other"]];
const insertSeededItem = `INSERT INTO work_batch_items(id,tenant_id,batch_id,batch_revision,project_id,local_id,ordinal,
  role,required_capability,depends_on_local_ids,acceptance_criteria,acceptance_tests,decision_state,decision_reason_code,
  item_digest,auth_tag,created_at) VALUES($1,$2,$3,1,$4,'build',0,'builder','code.change','{}',$5,'Run the tests.',
  'rejected','not_selected',$6,$7,$8)`;
const seededProject = tenantId => `project:${tenantId.slice("tenant:".length)}`;
const insertSeededBatch = `INSERT INTO work_batches(id,tenant_id,project_id,proposed_by_identity_id,
  proposed_by_actor_type,proposed_at,state,proposal,queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at)
  VALUES($1,$2,$3,$4,'agent',$5,'proposed',$6::jsonb,5,$7,$8,1,$5,$5)`;
const insertSeededRevision = `INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,
  edited_at,reason_code,proposal,revision_digest,auth_tag) VALUES($1,$2,$3,1,$4,$5,'submitted',$6::jsonb,$7,$8)`;

async function seedWorkBatchTenants(db) {
  for (const tenantId of ["tenant:batch-own", "tenant:batch-other"]) {
    const suffix = tenantId.slice("tenant:".length);
    await query(db, "INSERT INTO tenants(id,display_name) VALUES($1,$1)", [tenantId]);
    await query(db, "INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'workspace')",
      [`workspace:${suffix}`, tenantId]);
    await query(db, `INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
      redaction_policy_version,cursor_retention_days) VALUES($1,$2,'manual','1','control_room_native','fixture','v1',1)`,
    [`adapter:${suffix}`, tenantId]);
    await query(db, `INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload) VALUES($1,$2,$3,$4,$1,'1','Project',
      'ready','ready','healthy','control_room_native',$5,'{}')`,
    [seededProject(tenantId), tenantId, `workspace:${suffix}`, `adapter:${suffix}`, seededBatchAt]);
  }
  const identities = new Map(seededBatches.map(([tenantId, identityId, provider]) =>
    [`${tenantId}|${identityId}`, { tenantId, identityId, provider }]));
  let index = 0;
  for (const { tenantId, identityId, provider } of identities.values()) {
    index += 1;
    await query(db, `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent','Proposing agent',$3,$4,'active',$5,$5)`,
    [identityId, tenantId, provider, `sha256:${String(index).repeat(64)}`, seededBatchAt]);
    await query(db, `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES($1,$2,$3,
      'work_batch_proposer','["work_batches.propose"]',$4::jsonb,'low',false,false,$5,$5)`,
    [`grant:seeded-${index}`, tenantId, identityId, JSON.stringify([seededProject(tenantId)]), seededBatchAt]);
  }
  for (const [tenantId, identityId, , batchId, hasRevision] of seededBatches) {
    await query(db, insertSeededBatch, [batchId, tenantId, seededProject(tenantId), identityId, seededBatchAt,
      seededBatchProposal, seededBatchDigest, seededBatchTag]);
    if (hasRevision) await query(db, insertSeededRevision, [`${batchId}:revision:1`, tenantId, batchId, identityId,
      seededBatchAt, seededBatchProposal, seededBatchDigest, seededBatchTag]);
  }
  for (const [tenantId, batchId] of seededItems)
    await query(db, insertSeededItem, [`${batchId}:item:build`, tenantId, batchId, seededProject(tenantId),
      `SECRET criteria for ${batchId}`, seededBatchDigest, seededBatchTag, seededBatchAt]);
  // Each tenant's intake ledger rows, in the namespace the intake login may use.
  for (const [tenantId, identityId, batchId] of [["tenant:batch-own","identity:work-intake:own","batch:own"],
    ["tenant:batch-other","identity:work-intake:other","batch:other"]]) {
    const suffix = tenantId.slice("tenant:batch-".length);
    await query(db, `INSERT INTO control_idempotency(tenant_id,operation_scope,idempotency_key,request_digest,status,
      result,completed_at) VALUES($1,$2,$3,$4,'completed',$5::jsonb,$6)`, [tenantId, intakeScope(identityId),
      `${suffix}-intake-key-0001`, `sha256:${"d".repeat(64)}`, JSON.stringify({ batchId }), seededBatchAt]);
    await query(db, `INSERT INTO audit_events(id,tenant_id,project_id,actor_id,actor_type,action,target_type,target_id,
      safe_metadata,occurred_at) VALUES($1,$2,$3,$4,'agent','work_batches.propose','work_batch',$5,'{}'::jsonb,$6)`,
    [`audit:work-intake:${suffix}-1`, tenantId, seededProject(tenantId), identityId, batchId, seededBatchAt]);
  }
}

test("work-intake login reads and writes only its bound tenant's registered work batches", needsPg, async () => {
  await freshDatabase("cr_prod_intake_batches");
  const db=target("cr_prod_intake_batches");
  await applyMigrations({ target:db, bootstrapTarget:bootstrapTarget("cr_prod_intake_batches"),
    migrateTarget:migrateTarget("cr_prod_intake_batches"), rootDir:ROOT, env:{...process.env,...passwords} });
  await seedWorkBatchTenants(db);
  const intake={...target("cr_prod_intake_batches","control_room_work_intake_agent"),
    password:passwords.CONTROL_ROOM_WORK_INTAKE_PASSWORD};
  const intakeRows=async()=>Object.fromEntries(await Promise.all(intakeLedgerTables.map(async table=>
    [table,(await query(intake,`SELECT tenant_id FROM ${table} ORDER BY tenant_id`)).rows.map(row=>row.tenant_id)])));
  const nothing=Object.fromEntries(intakeLedgerTables.map(table=>[table,[]]));

  // Fail closed: with no binding row the intake login sees and writes nothing,
  // not even its own tenant's proposals.
  assert.deepEqual(await intakeRows(),nothing);
  await assert.rejects(query(intake,insertSeededBatch,["batch:unbound","tenant:batch-own",seededProject("tenant:batch-own"),
    "identity:work-intake:own",seededBatchAt,seededBatchProposal,seededBatchDigest,seededBatchTag]),/row-level security/u);
  await query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:batch-own')");
  // One binding per cluster database, readable but never writable by the intake login.
  await assert.rejects(query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:batch-other')"),
    /duplicate key/u);
  await assert.rejects(query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(false,'tenant:batch-other')"),
    /check constraint/u);
  await assert.rejects(query(intake,"UPDATE work_intake_tenant_binding SET tenant_id='tenant:batch-other'"),/permission denied/u);
  await assert.rejects(query(intake,"DELETE FROM work_intake_tenant_binding"),/permission denied/u);
  await assert.rejects(query(intake,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:batch-other')"),
    /permission denied/u);
  assert.deepEqual(await intakeRows(),{work_batches:["tenant:batch-own"],work_batch_revisions:["tenant:batch-own"],
    work_batch_items:["tenant:batch-own"],control_idempotency:["tenant:batch-own"],audit_events:["tenant:batch-own"]});

  assert.deepEqual((await query(intake,"SELECT tenant_id,id FROM work_batches ORDER BY tenant_id,id")).rows,
    [{tenant_id:"tenant:batch-own",id:"batch:own"}]);
  assert.deepEqual((await query(intake,
    "SELECT tenant_id,batch_id FROM work_batch_revisions ORDER BY tenant_id,batch_id")).rows,
  [{tenant_id:"tenant:batch-own",batch_id:"batch:own"}]);
  assert.deepEqual((await query(intake,"SELECT proposal FROM work_batches WHERE tenant_id='tenant:batch-other'")).rows,[]);
  assert.deepEqual((await query(intake,
    "SELECT proposal FROM work_batch_revisions WHERE tenant_id='tenant:batch-other'")).rows,[]);
  assert.deepEqual((await query(intake,
    "SELECT operation_scope,result FROM control_idempotency WHERE tenant_id='tenant:batch-other'")).rows,[]);
  assert.deepEqual((await query(intake,"SELECT id FROM audit_events WHERE tenant_id='tenant:batch-other'")).rows,[]);
  // Items follow their batch: none from the other tenant, and none for a batch
  // whose proposer the owner did not register for intake.
  assert.deepEqual((await query(intake,"SELECT tenant_id,batch_id FROM work_batch_items ORDER BY batch_id")).rows,
    [{tenant_id:"tenant:batch-own",batch_id:"batch:own"}]);
  assert.deepEqual((await query(intake,
    "SELECT acceptance_criteria FROM work_batch_items WHERE tenant_id='tenant:batch-other'")).rows,[]);

  // Each forged proposer holds a valid proposer grant, so only the policy refuses it.
  for (const [tenantId, identityId] of [["tenant:batch-other","identity:work-intake:other"],
    ["tenant:batch-own","identity:batch-own-direct"]])
    await assert.rejects(query(intake,insertSeededBatch,[`batch:forged-${identityId.slice(9)}`,tenantId,
      seededProject(tenantId),identityId,seededBatchAt,seededBatchProposal,seededBatchDigest,seededBatchTag]),
    /row-level security/u, `${tenantId} ${identityId}`);
  // The registered identity named under the other tenant has no grant there either.
  await assert.rejects(query(intake,insertSeededBatch,["batch:forged-own-elsewhere","tenant:batch-other",
    seededProject("tenant:batch-other"),"identity:work-intake:own",seededBatchAt,seededBatchProposal,
    seededBatchDigest,seededBatchTag]),/row-level security|proposal-only work batch insert rejected/u);
  await assert.rejects(query(intake,insertSeededRevision,["batch:other-open:revision:1","tenant:batch-other",
    "batch:other-open","identity:work-intake:other",seededBatchAt,seededBatchProposal,seededBatchDigest,seededBatchTag]),
  /row-level security|(?:initial )?work batch revision insert rejected/u);
  // The other tenant's agent holds a valid grant, so the ledger guard admits the
  // row and only the tenant binding refuses it.
  await assert.rejects(query(intake,`INSERT INTO control_idempotency
    (tenant_id,operation_scope,idempotency_key,request_digest,status)
    VALUES('tenant:batch-other',$1,'forged-other-key-0001',$2,'processing')`,
  [intakeScope("identity:work-intake:other"),`sha256:${"e".repeat(64)}`]),/row-level security/u);
  await assert.rejects(query(intake,
    "UPDATE work_batches SET proposal='{}'::jsonb WHERE tenant_id='tenant:batch-other'"),/permission denied/u);
  await assert.rejects(query(intake,
    "UPDATE work_batch_revisions SET proposal='{}'::jsonb WHERE tenant_id='tenant:batch-other'"),/permission denied/u);
  assert.deepEqual((await query(db,`SELECT (SELECT count(*)::int FROM work_batches) AS batches,
    (SELECT count(*)::int FROM work_batch_revisions) AS revisions,
    (SELECT count(*)::int FROM work_batch_items) AS items`)).rows[0],{batches:4,revisions:3,items:3});

  // The registered identity still proposes and reads back through the real store.
  const store=new WorkBatchStoreV1(postgresDatabase(intake),new Uint8Array(32).fill(9));
  const principal={tenantId:"tenant:batch-own",identityId:"identity:work-intake:own",actorType:"agent",
    authenticatedAt:"2026-09-27T11:00:00.000Z",expiresAt:"2027-09-27T12:00:00.000Z"};
  const proposal={schema:"control-room.work-batch-proposal/v1",projectId:"project:batch-own",
    tasks:[{localId:"build",title:"Build",instructions:"Implement the bounded change.",
      requiredCapability:"code.change",role:"builder",requestedWorkerKind:"worker:code",
      requestedModelKey:"model:allowed",acceptanceCriteria:"The focused checks pass.",
      acceptanceTests:"Run the focused test lane."}],edges:[]};
  const receipt=await store.create({principal,proposal,proposalDigest:sha256Digest(proposal),
    idempotencyKey:"intake-batches-key-0001",now:"2026-09-27T12:10:00.000Z",queueDepthLimit:5});
  assert.equal(receipt.replayed,false);
  const status=await store.status(principal,"project:batch-own",receipt.batchId,"2026-09-27T12:11:00.000Z");
  assert.equal(status.batchId,receipt.batchId);
  assert.deepEqual((await query(intake,"SELECT id FROM work_batches ORDER BY id")).rows.map(row=>row.id).sort(),
    ["batch:own",receipt.batchId].sort());

  // Removing the binding closes the login again, including its own new rows.
  await query(db,"DELETE FROM work_intake_tenant_binding");
  assert.deepEqual(await intakeRows(),nothing);
  await assert.rejects(store.status(principal,"project:batch-own",receipt.batchId,"2026-09-27T12:12:00.000Z"),
    {safeCode:"batch_not_found"});
});

test("non-intake roles keep exactly their work-batch access", needsPg, async () => {
  await freshDatabase("cr_prod_batch_roles");
  const db=target("cr_prod_batch_roles");
  await applyMigrations({ target:db, bootstrapTarget:bootstrapTarget("cr_prod_batch_roles"),
    migrateTarget:migrateTarget("cr_prod_batch_roles"), rootDir:ROOT, env:{...process.env,...passwords} });
  await seedWorkBatchTenants(db);
  const allBatches=seededBatches.map(([tenantId,,,batchId])=>`${tenantId}|${batchId}`).sort();
  const allRevisions=seededBatches.filter(row=>row[4]).map(([tenantId,,,batchId])=>`${tenantId}|${batchId}`).sort();
  const allItems=seededItems.map(([tenantId,batchId])=>`${tenantId}|${batchId}`).sort();
  const client=new Client(db);
  await client.connect();
  try {
    // Role files are cluster-global; install the owner-web and coordinator groups
    // only inside this transaction so no other test observes them.
    await client.query("BEGIN");
    for (const file of ["private_web_roles.sql","task_coordinator_roles.sql"])
      await client.query((await readFile(join(ROOT,"db/roles",file),"utf8")).replace(/^(?:BEGIN|COMMIT);$/gmu,""));
    const observe=async role=>{
      const seen={};
      for (const [table,column] of [["work_batches","id"],["work_batch_revisions","batch_id"],["work_batch_items","batch_id"]]) {
        await client.query("SAVEPOINT probe");
        try {
          await client.query(`SET LOCAL ROLE ${role}`);
          seen[table]=(await client.query(`SELECT tenant_id || '|' || ${column} AS row FROM ${table}`)).rows
            .map(row=>row.row).sort();
        } catch (error) { seen[table]=error.code==="42501" ? "permission denied" : error.message; }
        finally { await client.query("ROLLBACK TO SAVEPOINT probe"); }
      }
      return seen;
    };
    const denied={work_batches:"permission denied",work_batch_revisions:"permission denied",
      work_batch_items:"permission denied"};
    const all={work_batches:allBatches,work_batch_revisions:allRevisions,work_batch_items:allItems};
    const expected={
      control_room_schema_owner:all,
      control_room_backup:all,
      control_room_reader:denied, control_room_application:denied, control_room_schedule_admissions:denied,
      control_room_github_broker:denied,
      control_room_private_web:all,
      control_room_task_coordinator:denied,
    };
    const observed={};
    for (const role of Object.keys(expected)) observed[role]=await observe(role);
    assert.deepEqual(observed,expected);
    const privileges=(await client.query(`SELECT r.role,t.table_name,
      has_table_privilege(r.role,t.table_name,'INSERT') AS insert,
      has_table_privilege(r.role,t.table_name,'UPDATE') AS update,
      has_table_privilege(r.role,t.table_name,'DELETE') AS delete
      FROM unnest($1::text[]) r(role) CROSS JOIN unnest(ARRAY['work_batches','work_batch_revisions']) t(table_name)
      WHERE has_table_privilege(r.role,t.table_name,'INSERT') OR has_table_privilege(r.role,t.table_name,'UPDATE')
        OR has_table_privilege(r.role,t.table_name,'DELETE') ORDER BY 1,2`,[Object.keys(expected)])).rows;
    assert.deepEqual(privileges,[
      {role:"control_room_private_web",table_name:"work_batch_revisions",insert:true,update:false,delete:false},
      {role:"control_room_schema_owner",table_name:"work_batch_revisions",insert:true,update:true,delete:true},
      {role:"control_room_schema_owner",table_name:"work_batches",insert:true,update:true,delete:true}]);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});

// The owner revises and decides through the real owner service; the proposing
// agent then reads status and list over the production intake login, where
// the tenant-binding policies apply (the owner fixture's connection bypasses them).
test("intake status and list stay readable on the production login after owner revision and decision", needsPg, async () => {
  await freshDatabase("cr_prod_intake_owner");
  const db=target("cr_prod_intake_owner");
  await applyMigrations({ target:db, bootstrapTarget:bootstrapTarget("cr_prod_intake_owner"),
    migrateTarget:migrateTarget("cr_prod_intake_owner"), rootDir:ROOT, env:{...process.env,...passwords} });
  const scope={tenantId:"tenant:web",workspaceId:"workspace:web"}, clock=()=>webNow;
  const at=new Date(webNow).toISOString();
  await query(db,"INSERT INTO tenants(id,display_name) VALUES('tenant:web','Test tenant')");
  await query(db,"INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:web','tenant:web','Test workspace')");
  const admin=postgresDatabase(db);
  await new SecurityStore(admin).bootstrapOwner({ tenantId:"tenant:web", provider:webTrust.issuer, subject:"test-owner",
    identityId:"identity:web", grantId:"grant:web", displayName:"Test owner", verifiedAt:new Date(webNow-60_000).toISOString(),
    expiresAt:new Date(webNow+300_000).toISOString(), now:at });
  const identity=createAccessVerifier(webTrust)(webRequest(),webNow);
  const { project }=await new WebProjectService(admin,scope,clock).create(identity,
    { title:"Batch project", summary:"Real PostgreSQL owner review" },"intake-owner-project-0001");
  const projectId=project.projectId;
  await query(db,`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:batch-agent','tenant:web','agent','Batch agent',
    'work-intake',$1,'active',$2,$2)`,[sha256Digest("batch-agent"),at]);
  await query(db,`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES('grant:batch-agent','tenant:web',
    'identity:batch-agent','work_batch_proposer','["work_batches.propose"]',$1::jsonb,'low',false,false,$2,$2)`,
  [JSON.stringify([projectId]),at]);
  await query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:web')");

  const key=new Uint8Array(32).fill(7);
  const intake={...target("cr_prod_intake_owner","control_room_work_intake_agent"),
    password:passwords.CONTROL_ROOM_WORK_INTAKE_PASSWORD};
  const store=new WorkBatchStoreV1(postgresDatabase(intake),key);
  const owner=new WorkBatchOwnerServiceV1(admin,new WebTaskService(admin,scope,clock),scope,key,clock);
  const principal={tenantId:"tenant:web",identityId:"identity:batch-agent",actorType:"agent",
    authenticatedAt:"2026-09-04T11:59:00.000Z",expiresAt:"2026-09-04T13:00:00.000Z"};
  const task=(localId,role,capability)=>({localId,title:`${localId} the change`,instructions:`${localId} the bounded change.`,
    requiredCapability:capability,role,acceptanceCriteria:`The ${localId} step is bounded.`,
    acceptanceTests:`Run the focused ${localId} tests.`});
  const proposalOf=(tasks,edges=[])=>({schema:"control-room.work-batch-proposal/v1",projectId,tasks,edges});
  const submit=async (value,keySuffix)=>store.create({principal,proposal:value,proposalDigest:workBatchProposalDigestV1(value),
    idempotencyKey:`intake-owner-submit-${keySuffix}`,now:at,queueDepthLimit:10});
  const batch=await submit(proposalOf([task("build","builder","code.change")]),"0001");
  const untouched=await submit(proposalOf([task("draft","builder","code.change")]),"0002");
  assert.equal((await store.status(principal,projectId,batch.batchId,at)).taskCount,1);

  const revised=proposalOf([task("build","builder","code.change"),task("check","checker","code.review"),
    task("validate","validator","code.validate")],[{fromLocalId:"build",toLocalId:"check"}]);
  await owner.command(identity,projectId,{ operation:"revise", batchId:batch.batchId, expectedRevision:1,
    reasonCode:"owner_edit", proposal:revised },"intake-owner-revise-0001");
  const afterRevision=await store.status(principal,projectId,batch.batchId,at);
  assert.equal(afterRevision.state,"proposed");
  assert.equal(afterRevision.taskCount,3);
  assert.equal(afterRevision.proposalDigest,workBatchProposalDigestV1(revised));
  // The intake login reads the owner's current revision, not only its own.
  assert.deepEqual((await query(intake,`SELECT revision::int,edited_by_identity_id FROM work_batch_revisions
    WHERE batch_id=$1 ORDER BY revision`,[batch.batchId])).rows,
  [{revision:1,edited_by_identity_id:"identity:batch-agent"},{revision:2,edited_by_identity_id:"identity:web"}]);
  assert.deepEqual((await store.list(principal,projectId,at)).map(row=>[row.batchId,row.state]).sort(),
    [[batch.batchId,"proposed"],[untouched.batchId,"proposed"]].sort());
  // Reading owner revisions never lets the intake login write one.
  await assert.rejects(query(intake,`INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,
    edited_at,reason_code,proposal,revision_digest,auth_tag) VALUES($1,'tenant:web',$2,3,'identity:web',$3,'owner_edit',
    $4::jsonb,$5,$6)`,[`${batch.batchId}:revision:3`,batch.batchId,at,JSON.stringify(revised),
    workBatchProposalDigestV1(revised),`hmac-sha256:${"a".repeat(64)}`]),/row-level security/u);

  const decided=await owner.command(identity,projectId,{ operation:"decide", batchId:batch.batchId, expectedRevision:2,
    items:[{localId:"build",decision:"approve"},{localId:"check",decision:"approve"},
      {localId:"validate",decision:"reject",reasonCode:"not_selected"}] },"intake-owner-decide-0001");
  assert.equal(decided.state,"partially_approved");
  const afterDecision=await store.status(principal,projectId,batch.batchId,at);
  assert.equal(afterDecision.state,"partially_approved");
  assert.equal(afterDecision.taskCount,3);
  assert.equal(afterDecision.proposalDigest,workBatchProposalDigestV1(revised));
  assert.deepEqual((await store.list(principal,projectId,at)).map(row=>[row.batchId,row.state]).sort(),
    [[batch.batchId,"partially_approved"],[untouched.batchId,"proposed"]].sort());
  assert.equal((await query(intake,"SELECT count(*)::int AS items FROM work_batch_items WHERE batch_id=$1",
    [batch.batchId])).rows[0].items,3);
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
     "-v", `work_intake_password=${vars.workIntake}`,
     "-f", join(ROOT, "db/roles/production_provision.sql"), "-X", "-q"],
    { env: psqlEnv, timeout: 60000, maxBuffer: 1 << 26 });
  // Short passwords fail closed before any login is created.
  const short = await provision({ migrator: "x".repeat(23), app: "y".repeat(24), scheduler: "z".repeat(24),
    workIntake: "w".repeat(24) }).then(
    () => { throw new Error("provision_accepted_short_password"); },
    (error) => error);
  assert.match(`${short.stderr ?? ""}`, /provision_refused_short_migrator_password/);
  // Full run: genuinely executable through real psql variable substitution.
  const pw = { migrator: "provision-test-migrator-0001", app: "provision-test-app-00001",
    scheduler: "provision-test-scheduler-0001", workIntake: "provision-test-work-intake-001" };
  const done = await provision(pw);
  for (const secret of Object.values(pw)) {
    assert.ok(!`${done.stdout ?? ""}${done.stderr ?? ""}`.includes(secret), "password leaked into psql output");
  }
  const roles = (await query(target("cr_prod_provision"),
    "SELECT rolname, rolcanlogin, rolpassword FROM pg_roles WHERE rolname LIKE 'control@_room@_%' ESCAPE '@' ORDER BY 1")).rows;
  const byName = new Map(roles.map(role => [role.rolname, role]));
  for (const login of ["control_room_migrator", "control_room_app", "control_room_scheduler",
      "control_room_work_intake_agent"]) {
    assert.equal(byName.get(login)?.rolcanlogin, true, `${login} can login`);
    assert.ok(byName.get(login)?.rolpassword, `${login} has a password set`);
  }
  assert.ok(!byName.get("control_room_migrator").rolpassword.includes(pw.migrator), "password stored hashed, not plaintext");
  const memberships = await roleMemberships(target("cr_prod_provision"));
  for (const [member, role] of [["control_room_migrator", "control_room_schema_owner"],
      ["control_room_app", "control_room_application"],
      ["control_room_scheduler", "control_room_schedule_admissions"],
      ["control_room_work_intake_agent", "control_room_work_intake"]]) {
    assert.ok(memberships.some(entry => entry.member === member && entry.role === role), `${member} in ${role}`);
  }
});

test("documented clean-cluster provision/migrate/backup/restore/verify journey", needsPg, async (t) => {
  // A second disposable cluster: cluster-global roles from earlier tests must
  // not mask a provision script that assumes groups already exist, and the
  // restore target must not inherit shared-cluster role state either. Every
  // step below is the documented operator flow, executed literally.
  const CLEAN_PORT = 15631;
  const cleanSocket = join(run, "clean-socket"), cleanData = join(run, "clean-data");
  const cleanBackup = join(run, "clean-backup-set");
  // The restore target lives in its OWN disposable cluster: roles and
  // memberships are cluster-wide, so a second database in the source cluster
  // would inherit the source's role state before target provisioning.
  const TARGET_PORT = 15632;
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
    await native("initdb", ["-D", data, "-U", "postgres", "--auth-local=trust",
      "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
    await native("pg_ctl", ["-D", data, "-l", join(run, log), "-w", "-t", "30", "-o",
      `-k ${socket} -p ${port} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`, "start"]);
  };
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
  await startCluster(cleanSocket, cleanData, CLEAN_PORT, "clean-server.log");
  await startCluster(targetSocket, targetData, TARGET_PORT, "clean-target-server.log");
  const pw = { migrator: "clean-install-migrator-0001", app: "clean-install-app-000001",
    scheduler: "clean-install-scheduler-0001", workIntake: "clean-install-work-intake-001" };
  const psqlFor = (socket, port) => ({
    PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run,
    PGHOST: socket, PGPORT: String(port), PGUSER: "postgres",
    PGPASSWORD: "fixture_only",
  });
  const psqlBase = psqlFor(cleanSocket, CLEAN_PORT);
  const provisionRoles = (database, env = psqlBase) => exec(join(BIN, "psql"),
    ["-v", `migrator_password=${pw.migrator}`, "-v", `app_password=${pw.app}`,
     "-v", `scheduler_password=${pw.scheduler}`,
     "-v", `work_intake_password=${pw.workIntake}`,
     "-f", join(ROOT, "db/roles/production_provision.sql"), "-X", "-q"],
    { env: { ...env, PGDATABASE: database }, timeout: 60000, maxBuffer: 1 << 26 });
  const cleanConn = (socket, port, database, user = "postgres", password = "fixture_only") =>
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
  assert.equal(preOwner, "postgres", "database starts owned by the creating superuser");
  // Step 1: standalone role provisioning on the clean database.
  await provisionRoles("cr_clean_install");
  // Step 2: the documented two-connection migration command, via the real CLI.
  const adminConn = `host=${cleanSocket} port=${CLEAN_PORT} dbname=cr_clean_install user=postgres`;
  const migratorConn = `host=${cleanSocket} port=${CLEAN_PORT} dbname=cr_clean_install user=control_room_migrator password=${pw.migrator}`;
  const migrated = await exec(process.execPath,
    [join(ROOT, "deploy/postgres/apply-migrations.mjs"),
     "--bootstrap-target", adminConn, "--migrate-target", migratorConn],
    { cwd: ROOT, timeout: 300000, maxBuffer: 1 << 26,
      env: { ...process.env, PATH: "/usr/bin:/bin", LC_ALL: "C",
        CONTROL_ROOM_MIGRATOR_PASSWORD: pw.migrator, CONTROL_ROOM_APP_PASSWORD: pw.app,
        CONTROL_ROOM_SCHEDULER_PASSWORD: pw.scheduler,
        CONTROL_ROOM_WORK_INTAKE_PASSWORD: pw.workIntake } });
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
  for (const login of ["control_room_migrator", "control_room_app", "control_room_scheduler",
      "control_room_work_intake_agent"]) {
    assert.equal(byName.get(login)?.rolcanlogin, true, `${login} can login`);
  }
  for (const group of ["control_room_schema_owner", "control_room_application", "control_room_schedule_admissions"]) {
    assert.ok(byName.has(group), `${group} exists`);
  }
  const memberships = await roleMemberships(db);
  for (const [member, role] of [["control_room_migrator", "control_room_schema_owner"],
      ["control_room_app", "control_room_application"],
      ["control_room_scheduler", "control_room_schedule_admissions"],
      ["control_room_work_intake_agent", "control_room_work_intake"]]) {
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

  // The Mac-local wrapper adds the five exact restricted roles, hashes the
  // dump+metadata manifest, and proves the result in its own fresh cluster.
  // Queue construction and its guarded cleanup both contain transactions, so
  // provisioning must keep every statement on this one PostgreSQL session.
  const narrowRoleClient = new Client(db);
  await narrowRoleClient.connect();
  try {
    await provisionMacLocalNarrowRolesV1(narrowRoleClient, Object.fromEntries([
      "control_room_web", "control_room_coordinator", "control_room_results",
      "control_room_publisher", "control_room_queue_worker",
    ].map((name, index) => [name, `${index}`.repeat(40)])));
  } finally {
    await narrowRoleClient.end();
  }
  const macBackup = join(run, "mac-local-backup-set");
  const manifest = await createMacLocalDatabaseBackupV1({ source: db, out: macBackup, pgBin: BIN,
    now: () => "2026-09-27T00:00:00.000Z" });
  assert.match(manifest.dumpDigest, /^sha256:[a-f0-9]{64}$/u);
  const verified = await verifyMacLocalDatabaseBackupV1({ backup: macBackup, port: 15633, pgBin: BIN });
  assert.equal(verified.verified, true);
  assert.equal(verified.identityDigest, manifest.restoreIdentityDigest);
  const dumpPath = join(macBackup, "database.dump"), altered = await readFile(dumpPath);
  altered[0] ^= 0xff;
  await writeFile(dumpPath, altered);
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup: macBackup, port: 15634, pgBin: BIN }),
    /database_backup_digest_refused/u);
});
