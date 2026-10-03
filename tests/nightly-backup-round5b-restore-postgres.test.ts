// R5B-03, R5B-04, R5B-05 and R5B-06 on REAL PostgreSQL 17, as the production logins.
//
//   R5B-03 — the documented rollback (restore the backup taken BEFORE an update)
//             failed `restore_identity_mismatch:rolesDigest` whenever that update
//             added a database login, even though every restored row matched, and
//             then refused a retry on the target it had already filled.
//   R5B-04 — the documented retry could never succeed, because the queue schema
//             survives "DROP SCHEMA public".
//   R5B-05 — restoring with the flags the docs show failed on `rowsDigest` AFTER
//             the target had been filled.
//   R5B-06 — after a restore a REVOKED bot authenticated again and bots that had
//             renewed or joined since were locked out, with no notice to the owner.
//
// WHAT IS REAL HERE, stated plainly:
//   REAL: a PostgreSQL 17 postmaster, `initdb`, the release migration ledger
//         applied as the production migrator, the production role files, the
//         shipped `pg_dump` and `pg_restore`, the real snapshot transaction, the
//         real role/grant reconciliation, the real identity verification, and
//         every refusal.
//   SIMULATED: the uid (creating a service account needs root, so this lane's
//         logins are this process's uid) and the socket path.
//
// It sits in the `test:nightly-backup:postgres` lane, on the same assigned port,
// because it is the same database and the same backup/restore pair.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { backupDatabase } from "../deploy/postgres/backup-database.mjs";
import { DEFAULT_ACL_ROLES_SNAPSHOT_SQL } from "../deploy/postgres/evidence.mjs";
import { readProductionGroupRolesV1, readTemporaryRevokedRolesV1,
  resolveRequiredTablesV1, restoreDatabase } from "../deploy/postgres/restore-database.mjs";
import { parseRestoreTocV1, planHalfRestoredCleanupV1 } from "../deploy/postgres/restore-target-cleanup.mjs";
import { restoredBotNoticeItemsV1 } from "../deploy/postgres/restored-bot-credentials.mjs";
import { actionInboxItemSchemaV1 } from "../src/operator-surfaces/v1/validators";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1, FleetWaitRegistryV1 } from "../src/fleet/v1";
import { createFleetGatewayStoreFromConfigurationV1 } from "../scripts/run-fleet-gateway";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant } from "./support/fleet-fixture";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";
// The connector is a dependency-free .mjs shipped to worker machines.
import * as connector from "../scripts/fleet/connector.mjs";

const PORT = Number(process.env.CONTROL_ROOM_NIGHTLY_BACKUP_PG_PORT ?? 59980);
const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PG = requiresRealPostgres();
const needsPg = () => (PG ? undefined : { skip: realPostgresSkipMessage() });
const REAL_PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";

const ledgerDigest = () => `sha256:${JSON.parse(readFileSync(join(REPOSITORY, "deploy/postgres/migration-ledger.json"), "utf8")).digest}`;
// The nightly backup binds six tables. The docs show two. R5B-05 is about the gap
// between those two lists, so the fixture takes the NIGHTLY list: a backup whose
// recorded list is the documented two would not reproduce the finding.
const NIGHTLY_TABLES = ["tenants", "workspaces", "projects", "control_web_task_commands",
  "control_harness_runs", "control_harness_run_events"];

function backupInstallRoot(label: string) {
  const root = mkdtempSync("/private/tmp/r5brest-");
  mkdirSync(join(root, "pg", "socket"), { recursive: true });
  mkdirSync(join(root, "runtime"), { recursive: true });
  symlinkSync(dirname(REAL_PG_BIN), join(root, "runtime", "pg-current"), "dir");
  void label;
  return root;
}

/** A pooled client authenticated as the named production role, like the fleet lane. */
function poolOn(postgres: RealPostgres, role: string, database?: string) {
  const login = postgres.connection(role);
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: database ?? postgres.database, username: login.user, password: login.password, majorVersion: 17 as const }),
    host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

/**
 * A disposable restore target, and the CONNECTION the restore itself runs as.
 *
 * The restore runs as the operator's own provisioning connection, which is what
 * the documented path does (`production_provision.sql` as the bootstrap
 * superuser, then restore into the role-provisioned target) and what
 * `tests/postgres-production-lifecycle.test.mjs` does with `fixture_admin`.
 * That is not incidental: the dump replays `ALTER DEFAULT PRIVILEGES FOR ROLE
 * <the superuser that ran the role files>`, and only that role can issue it.
 * MEASURED on PostgreSQL 17: restoring as `control_room_migrator` instead fails
 * with `permission denied to change default privileges` — which is the round-5
 * finding R5B-10 about a differently-named superuser, not a new bug.
 */
async function createTarget(postgres: RealPostgres, name: string) {
  const admin = new Client(postgres.admin({ database: "postgres" }));
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(`GRANT ALL ON DATABASE ${name} TO control_room_schema_owner`);
    // PostgreSQL 15+ gives `public` no CREATE to non-owners, so `pg_restore`
    // cannot create the first table without this.
    await admin.query(`GRANT ALL ON SCHEMA public TO control_room_schema_owner`);
    await admin.query(`GRANT ALL ON SCHEMA public TO control_room_migrator`);
  } finally { await admin.end(); }
  const operator = postgres.admin({ database: name });
  return { ...operator, host: postgres.socketDirectory };
}

/**
 * R5B-01's gap, made harmless here: the dump login cannot read the queue schema
 * the backup has to dump, so the fixture grants the read the product will
 * eventually grant. Round 5 recorded this grant by hand for the same reason.
 */
async function grantQueueRead(postgres: any) {
  const grant = new Client(postgres.admin({ database: "control_room" }));
  await grant.connect();
  try {
    await grant.query("GRANT USAGE ON SCHEMA control_room_queue TO control_room_schema_owner");
    await grant.query("GRANT SELECT ON ALL TABLES IN SCHEMA control_room_queue TO control_room_schema_owner");
  } finally { await grant.end(); }
}

const count = async (client: Client, sql: string, params: unknown[] = []) =>
  Number((await client.query(sql, params)).rows[0].n);

test("R5B-03: the documented rollback succeeds after an update added a login", needsPg(), async () => {
  // The finding, exactly: an update adds a database login, the owner rolls back
  // by restoring the pre-update backup, and the restore reports failure for a
  // role the backup never claimed while the data is in fact restored.
  //
  // The added login here is `control_room_work_intake_agent` IN ROLE
  // `control_room_work_intake` — the real shape of `production_provision.sql`'s
  // last release that added it, so this is not a weaker case than the report's.
  const result = await withRealPostgres(async postgres => {
    const root = backupInstallRoot("r5b03");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    const seed = new Client(source);
    await seed.connect();
    try {
      await grantQueueRead(postgres);
      await seed.query("INSERT INTO tenants(id,display_name) VALUES('tenant:r5b03','Rollback tenant')");
      await seed.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('ws:r5b03','tenant:r5b03','Rollback')");
      const out = join(root, "pre-update");
      await backupDatabase({ source, out, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: NIGHTLY_TABLES, release: "r5b03-pre-update" });
      // THE UPDATE: the cluster gains a login the backup cannot have recorded.
      //
      // This name is chosen because the attack kit does NOT pre-create it. An
      // earlier version of this test used `control_room_work_intake` and
      // `control_room_work_intake_agent`, and the mutation run caught what that
      // means: the kit already provisions both, so the "update" added nothing,
      // the recorded role set already contained them, and the test passed with
      // the scoping DELETED. A fixture that cannot fail is worse than no
      // fixture, so this asserts the role is genuinely absent first.
      const ADDED_LOGIN = "control_room_r5b03_extra";
      const addedRolesBefore = (await seed.query(
        "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1", [ADDED_LOGIN])).rows[0].n;
      assert.equal(addedRolesBefore, 0,
        "the fixture's chosen login must NOT already exist, or the update adds nothing");
      // The update adds it the way `production_provision.sql` does, and as that
      // file is run: by the operator, not by the migrator. A production login may
      // not create roles — 42501 — so this is genuinely the operator's step.
      const operator = new Client(postgres.admin({ database: "control_room" }));
      await operator.connect();
      try {
        await operator.query(`DO $do$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ADDED_LOGIN}') THEN
            CREATE ROLE ${ADDED_LOGIN} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
        END $do$;`);
      } finally { await operator.end(); }
      const addedRoles = (await seed.query(
        "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1", [ADDED_LOGIN])).rows[0].n;
      await seed.end();
      const target = await createTarget(postgres, "r5b03_target");
      const restored = await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
        pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: NIGHTLY_TABLES })
        .then(result => ({ ok: true, identityDigest: result.identityDigest, warnings: result.warnings }),
          (error: Error) => ({ ok: false, message: error.message }));
      const check = new Client(target);
      await check.connect();
      try {
        return { addedRoles, restored,
          tenants: await count(check, "SELECT count(*)::int AS n FROM tenants WHERE id='tenant:r5b03'"),
          tables: await count(check, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'"),
          rolesStillThere: await count(check,
            "SELECT count(*)::int AS n FROM pg_roles WHERE rolname='control_room_r5b03_extra'") };
      } finally { await check.end(); }
    } finally {
      await seed.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      const drop = new Client(postgres.admin({ database: "postgres" }));
      await drop.connect();
      try { await drop.query("DROP DATABASE IF EXISTS r5b03_target"); } finally { await drop.end(); }
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.equal(result.value.addedRoles, 1,
    "the update really did add a login the backup cannot have recorded");
  assert.equal(result.value.restored.ok, true,
    `R5B-03: the documented rollback must succeed after an update added a login; got ${JSON.stringify(result.value.restored)}`);
  assert.equal(result.value.tenants, 1, "and the rows it restored are really there");
  assert.equal(result.value.tables > 0, true, "and the schema really was restored");
  assert.equal(result.value.rolesStillThere, 1,
    "the added login is left in place: a rollback does not remove a role the cluster has");
  assert.deepEqual((result.value.restored as { warnings?: string[] }).warnings,
    ["restore_warning_role_added_since_backup:control_room_r5b03_extra"],
    "and it is REPORTED rather than silently folded into the digest that then fails on it");
});

test("R5B-03: a role added since the backup and wired into one of its roles refuses the restore BEFORE the target is written", needsPg(), async () => {
  // The counterweight, and the guard against "fixing" R5B-03 by ignoring extra
  // roles entirely. An extra role on its own is harmless; one that is a MEMBER
  // of a role the backup recorded exercises that role's authority inside the
  // restored database, and no digest of the recorded roles can see it.
  const result = await withRealPostgres(async postgres => {
    const root = backupInstallRoot("r5b03-wired");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    const seed = new Client(source);
    await seed.connect();
    try {
      await grantQueueRead(postgres);
      await seed.query("INSERT INTO tenants(id,display_name) VALUES('tenant:r5b03w','Wired')");
      const out = join(root, "backup");
      await backupDatabase({ source, out, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: NIGHTLY_TABLES, release: "r5b03-wired" });
      const operator = new Client(postgres.admin({ database: "control_room" }));
      await operator.connect();
      try {
        await operator.query(`DO $do$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_wired_extra') THEN
            CREATE ROLE control_room_wired_extra LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
          GRANT control_room_reader TO control_room_wired_extra;
        END $do$;`);
      } finally { await operator.end(); }
      await seed.end();
      const target = await createTarget(postgres, "r5b03_wired");
      const message = await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
        pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: NIGHTLY_TABLES })
        .then(() => null, (error: Error) => error.message);
      const check = new Client(target);
      await check.connect();
      try {
        return { message, tables: await count(check, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'") };
      } finally { await check.end(); }
    } finally {
      await seed.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      const drop = new Client(postgres.admin({ database: "postgres" }));
      await drop.connect();
      try { await drop.query("DROP DATABASE IF EXISTS r5b03_wired"); } finally { await drop.end(); }
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.equal(result.value.message,
    "restore_refused_unrecorded_role_authority:control_room_wired_extra:control_room_reader",
    `R5B-03: an added role wired into a recorded role must refuse the restore by name; got ${String(result.value.message)}`);
  assert.equal(result.value.tables, 0,
    "R5B-03: that refusal happens before pg_restore, so the target is still empty");
});

test("R5B-04: the documented retry recovers from a half-restored target", needsPg(), async () => {
  // The finding, exactly: `pg_restore` is not transactional, so an interrupted
  // restore leaves a dirty target; the documented reset ("DROP SCHEMA public")
  // does not clear it, because the queue schema is not `public`; and the third
  // attempt is refused as non-empty.
  //
  // The interruption is REAL: a wrapper that runs only the pre-data section of
  // the real `pg_restore` and then exits non-zero, exactly as a killed process
  // or a full disk leaves things.
  const result = await withRealPostgres(async postgres => {
    const root = backupInstallRoot("r5b04");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    const seed = new Client(source);
    await seed.connect();
    try {
      await grantQueueRead(postgres);
      await seed.query("INSERT INTO tenants(id,display_name) VALUES('tenant:r5b04','Retry tenant')");
      const out = join(root, "backup");
      await backupDatabase({ source, out, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: NIGHTLY_TABLES, release: "r5b04" });
      await seed.end();
      const target = await createTarget(postgres, "r5b04_target");
      const interruptedBin = join(root, "interrupted-bin");
      mkdirSync(interruptedBin, { recursive: true });
      writeFileSync(join(interruptedBin, "pg_restore"),
        `#!/bin/sh\n${JSON.stringify(join(REAL_PG_BIN, "pg_restore"))} --section=pre-data "$@"\nexit 1\n`, { mode: 0o700 });
      const probe = new Client(target);
      await probe.connect();
      let afterInterrupt: number, schemasAfterInterrupt: string[], retry: unknown, cleanup: unknown, retryTables: number;
      try {
        const interrupted = await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
          pgBin: interruptedBin, requiredTables: NIGHTLY_TABLES }).then(() => "completed", (error: Error) => error.message);
        afterInterrupt = await count(probe, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'");
        schemasAfterInterrupt = (await probe.query(
          `SELECT nspname FROM pg_namespace
            WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname`))
          .rows.map((row: { nspname: string }) => row.nspname);
        // The plain retry: still refused, and still naming the database.
        retry = await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
          pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: NIGHTLY_TABLES })
          .then(() => "completed", (error: Error) => error.message);
        // And the retry the operator asks for by name.
        cleanup = await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
          pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: NIGHTLY_TABLES,
          retryIntoHalfRestored: true }).then(result => result.identityDigest, (error: Error) => error.message);
        retryTables = await count(probe, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'");
        const rows = await count(probe, "SELECT count(*)::int AS n FROM tenants WHERE id='tenant:r5b04'");
        const queue = await count(probe, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='control_room_queue'");
        return { interrupted, afterInterrupt, schemasAfterInterrupt, retry, cleanup, retryTables, rows, queue };
      } finally { await probe.end(); }
    } finally {
      await seed.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      const drop = new Client(postgres.admin({ database: "postgres" }));
      await drop.connect();
      try { await drop.query("DROP DATABASE IF EXISTS r5b04_target"); } finally { await drop.end(); }
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.ok(result.value.afterInterrupt > 0,
    `the interruption really did leave tables behind, or nothing is being recovered (${result.value.afterInterrupt})`);
  assert.ok(result.value.schemasAfterInterrupt.includes("control_room_queue"),
    `R5B-04: the half-restored target really does keep the queue schema; got ${JSON.stringify(result.value.schemasAfterInterrupt)}`);
  assert.equal(result.value.retry, "restore_refused_nonempty_target:r5b04_target",
    "the plain retry is still refused and still names the database");
  assert.match(String(result.value.cleanup), /^sha256:[a-f0-9]{64}$/u,
    `R5B-04: the retry asked for by name must complete; got ${String(result.value.cleanup)}`);
  assert.equal(result.value.rows, 1, "and it restored the rows");
  assert.ok(result.value.queue > 0,
    `R5B-04: and the queue schema the reset used to leave behind; got ${result.value.queue}`);
});

test("R5B-04: a half-restored target holding SERIAL sequences is cleaned and retried", needsPg(), async () => {
  // The mutation run found the R5B-04 retry passing with the internally-owned
  // sequence guard DELETED, because `--section=pre-data` creates few enough
  // tables that it often creates no SERIAL sequence at all - so the guard was
  // defensive rather than load-bearing on that fixture.
  //
  // This drives the case the guard exists for, by hand: a target that looks like
  // an interrupted restore AND holds a table with a SERIAL column and its
  // sequence. MEASURED on PostgreSQL 17: dropping that sequence first fails with
  // "cannot drop sequence ... because column sequence of table ... requires it",
  // which is exactly the failure the guard prevents.
  const result = await withRealPostgres(async postgres => {
    const root = backupInstallRoot("r5b04-serial");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    const seed = new Client(source);
    await seed.connect();
    try {
      await grantQueueRead(postgres);
      const out = join(root, "backup");
      await backupDatabase({ source, out, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: NIGHTLY_TABLES, release: "r5b04-serial" });
      await seed.end();
      const target = await createTarget(postgres, "r5b04_serial");
      // Reproduce an interrupted restore the cheap way: restore only the
      // pre-data section, then add the shape the guard is about.
      const interruptedBin = join(root, "interrupted-bin");
      mkdirSync(interruptedBin, { recursive: true });
      writeFileSync(join(interruptedBin, "pg_restore"),
        `#!/bin/sh\n${JSON.stringify(join(REAL_PG_BIN, "pg_restore"))} --section=pre-data "$@"\nexit 1\n`, { mode: 0o700 });
      await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
        pgBin: interruptedBin, requiredTables: NIGHTLY_TABLES }).then(() => null, () => null);
      // A real table with a SERIAL column, in a schema the dump DOES create, so
      // this is genuinely a half-restore rather than an unrelated target.
      const seeder = new Client(target);
      await seeder.connect();
      let sequences: { n: number }[] = [];
      try {
        // A REAL table from the dump, carrying a SERIAL column. The interrupted
        // pre-data restore has already created `tenants`, so this adds a column to
        // it rather than creating it: the name has to be one the dump really
        // contains, because the unrelated-object refusal fires first on a table the
        // dump has never heard of. That refusal firing here is the safety guard
        // doing its job, not a gap in it.
        await seeder.query("ALTER TABLE public.tenants ADD COLUMN r5b04_serial_probe serial");
        sequences = (await seeder.query(`SELECT count(*)::int AS n FROM pg_class
          WHERE relkind='S' AND relname='tenants_r5b04_serial_probe_seq'`)).rows;
      } finally { await seeder.end(); }
      const restored = await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
        pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: NIGHTLY_TABLES,
        retryIntoHalfRestored: true }).then(result => result.identityDigest, (error: Error) => error.message);
      const check = new Client(target);
      await check.connect();
      try {
        return { sequences, restored,
          probeGone: await count(check,
            "SELECT count(*)::int AS n FROM pg_class WHERE relname='tenants_r5b04_serial_probe_seq'"),
          tenantsRestored: await count(check, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'") };
      } finally { await check.end(); }
    } finally {
      await seed.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      const drop = new Client(postgres.admin({ database: "postgres" }));
      await drop.connect();
      try { await drop.query("DROP DATABASE IF EXISTS r5b04_serial"); } finally { await drop.end(); }
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.equal(result.value.sequences[0]?.n, 1,
    "the fixture really did create a SERIAL sequence, or this is not the case the guard is for");
  assert.match(String(result.value.restored), /^sha256:[a-f0-9]{64}$/u,
    `R5B-04: the retry must complete with a SERIAL sequence on the target; got ${String(result.value.restored)}`);
  assert.equal(result.value.probeGone, 0,
    "R5B-04: and the added sequence is gone, because the cleanup removed what the dump recreates");
  assert.ok(result.value.tenantsRestored > 0,
    "R5B-04: and the restore really did put the schema back");
});

test("R5B-04: the cleanup refuses a target holding an object the dump does not name", needsPg(), async () => {
  // The safety counterweight. `--retry-into-half-restored` destroys objects, so
  // the refusal that keeps it safe is that the target must contain ONLY what
  // this backup's dump would create. An unrelated table in an unrelated schema
  // is refused by name and nothing is dropped.
  const result = await withRealPostgres(async postgres => {
    const root = backupInstallRoot("r5b04-unrelated");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    const seed = new Client(source);
    await seed.connect();
    try {
      await grantQueueRead(postgres);
      const out = join(root, "backup");
      await backupDatabase({ source, out, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: NIGHTLY_TABLES, release: "r5b04-unrelated" });
      await seed.end();
      const target = await createTarget(postgres, "r5b04_unrelated");
      const seeder = new Client(target);
      await seeder.connect();
      try {
        await seeder.query("CREATE SCHEMA operator_notes");
        await seeder.query("CREATE TABLE operator_notes.diary(id int primary key, note text)");
        await seeder.query("INSERT INTO operator_notes.diary VALUES (1,'the owner was here')");
      } finally { await seeder.end(); }
      const message = await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
        pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: NIGHTLY_TABLES,
        retryIntoHalfRestored: true }).then(() => null, (error: Error) => error.message);
      const check = new Client(target);
      await check.connect();
      try {
        return { message, diary: await count(check, "SELECT count(*)::int AS n FROM operator_notes.diary"),
          publicTables: await count(check, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'") };
      } finally { await check.end(); }
    } finally {
      await seed.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      const drop = new Client(postgres.admin({ database: "postgres" }));
      await drop.connect();
      try { await drop.query("DROP DATABASE IF EXISTS r5b04_unrelated"); } finally { await drop.end(); }
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.equal(result.value.message, "restore_refused_unrelated_target_object:operator_notes.diary",
    `an unrelated object must be refused by name; got ${String(result.value.message)}`);
  assert.equal(result.value.diary, 1, "and it must still be there: the refused cleanup destroyed nothing");
  assert.equal(result.value.publicTables, 0, "and it refused before restoring anything at all");
});

test("R5B-05: the documented flags no longer decide success, and a wrong list refuses before writing", needsPg(), async () => {
  // The finding, exactly: the documented command passes
  // `--required-tables tenants,workspaces` against a nightly backup that bound
  // six tables, and the restore fails `rowsDigest` AFTER filling the target.
  const result = await withRealPostgres(async postgres => {
    const root = backupInstallRoot("r5b05");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    const seed = new Client(source);
    await seed.connect();
    try {
      await grantQueueRead(postgres);
      await seed.query("INSERT INTO tenants(id,display_name) VALUES('tenant:r5b05','Flags tenant')");
      const out = join(root, "backup");
      await backupDatabase({ source, out, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: NIGHTLY_TABLES, release: "r5b05" });
      await seed.end();
      // (1) The wrong list, refused BEFORE the target is touched.
      const refusedTarget = await createTarget(postgres, "r5b05_refused");
      const wrongList = await restoreDatabase({ backup: out, target: refusedTarget, confirmTarget: { ...refusedTarget },
        pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: ["tenants", "workspaces"] })
        .then(() => null, (error: Error) => error.message);
      const refusedCheck = new Client(refusedTarget);
      await refusedCheck.connect();
      let tablesAfterRefusal: number;
      try {
        tablesAfterRefusal = await count(refusedCheck,
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT LIKE 'pg\\_%' AND schemaname <> 'information_schema'");
      } finally { await refusedCheck.end(); }
      // (2) The SAME command with no flag at all, which is what the docs' intent
      // is and what used to fail.
      const noFlagTarget = await createTarget(postgres, "r5b05_noflag");
      const noFlag = await restoreDatabase({ backup: out, target: noFlagTarget, confirmTarget: { ...noFlagTarget },
        pgBin: join(root, "runtime", "pg-current", "bin") })
        .then(result => result.identityDigest, (error: Error) => error.message);
      // (3) The recorded list itself, which is the same answer.
      const recordedTarget = await createTarget(postgres, "r5b05_recorded");
      const recorded = await restoreDatabase({ backup: out, target: recordedTarget, confirmTarget: { ...recordedTarget },
        pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: NIGHTLY_TABLES })
        .then(result => result.identityDigest, (error: Error) => error.message);
      const check = new Client(noFlagTarget);
      await check.connect();
      try {
        return { wrongList, tablesAfterRefusal, noFlag, recorded,
          rows: await count(check, "SELECT count(*)::int AS n FROM tenants WHERE id='tenant:r5b05'") };
      } finally { await check.end(); }
    } finally {
      await seed.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      const drop = new Client(postgres.admin({ database: "postgres" }));
      await drop.connect();
      try {
        for (const name of ["r5b05_refused", "r5b05_noflag", "r5b05_recorded"]) await drop.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally { await drop.end(); }
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 400_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.equal(result.value.wrongList,
    `restore_refused_required_tables_mismatch:${NIGHTLY_TABLES.join(",")}`,
    `R5B-05: a list the backup cannot reproduce must be refused by name, with the recorded list; got ${String(result.value.wrongList)}`);
  assert.equal(result.value.tablesAfterRefusal, 0,
    "R5B-05: and that refusal happens before the target is touched, so nothing was left behind");
  assert.equal(result.value.noFlag, result.value.recorded,
    `R5B-05: with no flag the tool reads the backup's own list; noFlag=${String(result.value.noFlag)} recorded=${String(result.value.recorded)}`);
  assert.match(String(result.value.noFlag), /^sha256:[a-f0-9]{64}$/u,
    `R5B-05: the documented restore with no flag must succeed; got ${String(result.value.noFlag)}`);
  assert.equal(result.value.rows, 1, "and the rows it verified are really there");
});

test("R5B-05: the required-table list comes from the backup, and a malformed one is refused", () => {
  // The pure half, asserted without a database so the rule itself is pinned and
  // not only its effect through a cluster.
  const rows = NIGHTLY_TABLES.map(table => ({ table, count: 1, hash: `sha256:${"a".repeat(64)}` }));
  const metadata = { evidence: { rows } };
  assert.deepEqual(resolveRequiredTablesV1(metadata, []), NIGHTLY_TABLES,
    "no flag reads the backup's own list");
  assert.deepEqual(resolveRequiredTablesV1(metadata, NIGHTLY_TABLES), NIGHTLY_TABLES,
    "the recorded list is the same answer");
  assert.throws(() => resolveRequiredTablesV1(metadata, ["tenants", "workspaces"]),
    /restore_refused_required_tables_mismatch:/);
  assert.throws(() => resolveRequiredTablesV1(metadata, [...NIGHTLY_TABLES, "extra_table"]),
    /restore_refused_required_tables_mismatch:/);
  assert.throws(() => resolveRequiredTablesV1(metadata, ["tenants"]),
    /restore_refused_required_tables_mismatch:/);
  assert.throws(() => resolveRequiredTablesV1({}, []), /restore_refused_metadata_rows_shape/);
  assert.throws(() => resolveRequiredTablesV1({ evidence: { rows: [{ table: "bad name" }] } }, []),
    /restore_refused_metadata_row_table/);
  assert.throws(() => resolveRequiredTablesV1(metadata, "tenants" as never), /restore_refused_required_tables_shape/);
});

test("R5B-06: a restore retires every bot key, keeps a revoked bot revoked, and tells the owner", needsPg(), async () => {
  // The finding, exactly: three bots joined; the backup was taken; then one
  // renewed, the owner revoked a second, and a fourth joined. After restoring the
  // backup, the REVOKED bot's heartbeat was `ok` and the owner's worker list
  // showed it as `connected`, while the renewed and newly joined bots could not
  // sign in at all — with no notice to the owner about any of it.
  //
  // The bots are REAL here, not seeded rows: the owner issues the code through
  // the production `control_room_fleet_owner` login, each machine joins through
  // the real gateway over HTTP as the production `control_room_fleet` login, and
  // every heartbeat is the real connector's client. That is the only way to
  // observe the finding, which is a statement about what the gateway AUTHENTICATES.
  const result = await withRealPostgres(async postgres => {
    const root = backupInstallRoot("r5b06");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    const seed = new Client(source);
    await seed.connect();
    const dir = join(root, "bots");
    mkdirSync(dir, { recursive: true });
    try {
      await grantQueueRead(postgres);
      await seedFleetTenant((sql, params) => seed.query(sql, params));
      const fleet = poolOn(postgres, "fleet"), fleetOwner = poolOn(postgres, "fleetOwner");
      const release = await buildSignedFleetConnectorReleaseForTestV1({ root: resolve(dir, "fleet"),
        builtFrom: "0".repeat(40) });
      const gateway = createFleetGatewayStoreFromConfigurationV1(fleet.client, { tenantId: FLEET_TENANT,
        workIntake: { database: {} as never, integrityKey: Buffer.alloc(32, 3).toString("base64url") } });
      const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
        afterDecision: () => gateway.reconcile() });
      const unexpected: unknown[] = [];
      const handler = createFleetGatewayHandlerV1({ store: gateway,
        proposals: new WorkBatchServiceV1(new WorkBatchStoreV1(poolOn(postgres, "control_room_work_intake_agent").client,
          new Uint8Array(32).fill(3))),
        releaseTrust: release.releaseTrust, connectorRelease: release.connectorRelease,
        waitRegistry: new FleetWaitRegistryV1({ waitMs: 60, pollMs: 10 }),
        onUnexpectedError: error => { unexpected.push(error); console.error(error); } });
      const server = createServer((request, response) => { void handler.handle(request, response); });
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const joinBot = async (label: string) => {
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: label, workerKind: "mcp-agent",
          projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 2 });
        const configPath = join(dir, `${label}.json`);
        const joined = await connector.join({ server: origin, code: code.code, workerKind: "mcp-agent", configPath });
        return { joined, client: connector.createClient(await connector.loadConfig(configPath)) };
      };
      type BotClient = ReturnType<typeof connector.createClient>;
      const beat = (client: BotClient) =>
        client.heartbeat().then(() => "ok", (error: Error) => error.message.split("\n")[0]!);
      try {
        const keeper = await joinBot("Keeper Mac");
        const renewing = await joinBot("Renewing Mac");
        const revoked = await joinBot("Revoked Mac");
        // The control: before any backup, the revoked bot's key works, which is
        // what makes the after-restore reading meaningful.
        const beforeBackup = await beat(revoked.client);
        const out = join(root, "backup");
        await backupDatabase({ source, out, pgBin: join(root, "runtime", "pg-current", "bin"),
          ledgerDigest: ledgerDigest(), requiredTables: NIGHTLY_TABLES, release: "r5b06" });
        // AFTER the backup: the owner removes one bot, one renews its key, and
        // a fourth machine joins.
        await owner.revokeWorker(ownerIdentity(), revoked.joined.workerId);
        const rekeyCode = await owner.issueRekeyCode(ownerIdentity(), renewing.joined.workerId);
        const renewedPath = join(dir, "renewing-rekey.json");
        await connector.join({ server: origin, code: rekeyCode.code, workerKind: "mcp-agent", configPath: renewedPath });
        const renewed = connector.createClient(await connector.loadConfig(renewedPath));
        const joinedLater = await joinBot("Joined Later Mac");
        // The four decisions the restore is about to undo: keeper, renewed key,
        // revoked key, and a machine the backup never saw.
        const statesBeforeRestore = { renewing: await beat(renewing.client), renewed: await beat(renewed),
          revoked: await beat(revoked.client), joinedLater: await beat(joinedLater.client),
          keeper: await beat(keeper.client) };
        await seed.end();
        const target = await createTarget(postgres, "r5b06_target");
        const restored = await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
          pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: NIGHTLY_TABLES })
          .then(result => result, (error: Error) => ({ message: error.message }));
        const check = new Client(target);
        await check.connect();
        try {
          return { beforeBackup, restored, unexpected, statesBeforeRestore,
            // The three bots' credentials, as the restored database holds them.
            states: (await check.query(`SELECT c.worker_id, w.display_name, c.state FROM fleet_worker_credentials c
              JOIN fleet_workers w ON w.tenant_id=c.tenant_id AND w.worker_id=c.worker_id
             WHERE c.tenant_id=$1 ORDER BY c.credential_id`, [FLEET_TENANT])).rows,
            activeLeft: await count(check, `SELECT count(*)::int AS n FROM fleet_worker_credentials
              WHERE tenant_id=$1 AND state='active'`, [FLEET_TENANT]),
            revokedLeft: await count(check, `SELECT count(*)::int AS n FROM fleet_worker_credentials
              WHERE tenant_id=$1 AND state='revoked'`, [FLEET_TENANT]),
            inbox: (await check.query(`SELECT payload FROM control_action_inbox
              WHERE tenant_id=$1 AND id='attention:restored-bots'`, [FLEET_TENANT])).rows };
        } finally { await check.end(); }
      } finally {
        await new Promise<void>(done => server.close(() => done()));
        await fleet.close();
        await fleetOwner.close();
      }
    } finally {
      await seed.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      const drop = new Client(postgres.admin({ database: "postgres" }));
      await drop.connect();
      try { await drop.query("DROP DATABASE IF EXISTS r5b06_target"); } finally { await drop.end(); }
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  const restored = result.value.restored as { botCredentials?: { retiredCredentials: number }, message?: string };
  assert.equal(result.value.beforeBackup, "ok",
    "R5B-06: the revoked bot's key really did work before the backup, or nothing is being proven");
  assert.equal(restored.message, undefined, `R5B-06: the restore must succeed; got ${String(restored.message)}`);
  assert.deepEqual(result.value.unexpected, [], "R5B-06: the gateway raised nothing unexpected while the bots joined");
  assert.equal(restored.botCredentials?.retiredCredentials, 3,
    `R5B-06: every bot credential the restored database held is retired; got ${JSON.stringify(restored.botCredentials)}`);
  assert.equal(result.value.activeLeft, 0,
    `R5B-06: no bot credential the restore brought back is still active; got ${JSON.stringify(result.value.states)}`);
  assert.equal(result.value.revokedLeft, 0,
    "R5B-06: the revoked credential the backup recorded is still recorded as revoked");
  assert.equal(result.value.inbox.length, 1,
    "R5B-06: the owner gets exactly one notice, not one per restore attempt");
  const payload = result.value.inbox[0].payload;
  assert.equal(actionInboxItemSchemaV1.safeParse(payload).success, true,
    `R5B-06: the notice must satisfy the owner's inbox contract; got ${JSON.stringify(payload)}`);
  assert.equal(payload.reasonCode, "restored_bots_need_rekeying");
  assert.match(payload.summary, /3 machines can no longer sign in/u,
    `R5B-06: the notice names every machine the restored database holds, including the revoked one; got ${payload.summary}`);
});

test("R5B-06: the retirement is atomic, idempotent, and does not touch revoked rows", needsPg(), async () => {
  // The two properties the rule rests on, asked of the real database:
  //   * `UPDATE ... RETURNING` gives two concurrent callers DISJOINT sets, so a
  //     second caller cannot report retiring a credential that was already
  //     retired by the first — and one of them must retire nothing at all;
  //   * a second run finds nothing to retire, which is what makes a re-run of
  //     the restore, or the owner's retry after an interruption, safe.
  //
  // The credentials are real ones the product issued: four bots join through the
  // real gateway over HTTP as the production fleet login, and the owner revokes
  // one. Seeding rows by hand would not test this — the property is about how
  // concurrent writers contend on `fleet_worker_credentials`, and a hand-written
  // row does not contend the way an issued one does.
  const result = await withRealPostgres(async postgres => {
    const root = backupInstallRoot("r5b06-race");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    const seed = new Client(source);
    await seed.connect();
    const dir = join(root, "bots");
    mkdirSync(dir, { recursive: true });
    try {
      await grantQueueRead(postgres);
      await seedFleetTenant((sql, params) => seed.query(sql, params));
      const fleet = poolOn(postgres, "fleet"), fleetOwner = poolOn(postgres, "fleetOwner");
      const release = await buildSignedFleetConnectorReleaseForTestV1({ root: resolve(dir, "fleet"),
        builtFrom: "0".repeat(40) });
      const gateway = createFleetGatewayStoreFromConfigurationV1(fleet.client, { tenantId: FLEET_TENANT,
        workIntake: { database: {} as never, integrityKey: Buffer.alloc(32, 3).toString("base64url") } });
      const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
        afterDecision: () => gateway.reconcile() });
      const server = createServer((request, response) => {
        void createFleetGatewayHandlerV1({ store: gateway,
          proposals: new WorkBatchServiceV1(new WorkBatchStoreV1(poolOn(postgres, "control_room_work_intake_agent").client,
            new Uint8Array(32).fill(3))),
          releaseTrust: release.releaseTrust, connectorRelease: release.connectorRelease,
          waitRegistry: new FleetWaitRegistryV1({ waitMs: 60, pollMs: 10 }),
          onUnexpectedError: () => {} }).handle(request, response);
      });
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const workerIdByLabel: Record<string, string> = {};
        for (const label of ["Race One", "Race Two", "Race Three", "Race Four"]) {
          const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: label, workerKind: "mcp-agent",
            projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 2 });
          const joined = await connector.join({ server: origin, code: code.code, workerKind: "mcp-agent",
            configPath: join(dir, `${label}.json`) });
          workerIdByLabel[label] = joined.workerId;
        }
        // The owner removes one, so the restored database holds a revoked
        // credential alongside the three active ones.
        await owner.revokeWorker(ownerIdentity(), workerIdByLabel["Race Four"]!);
        const out = join(root, "backup");
        await backupDatabase({ source, out, pgBin: join(root, "runtime", "pg-current", "bin"),
          ledgerDigest: ledgerDigest(), requiredTables: NIGHTLY_TABLES, release: "r5b06-race" });
        await seed.end();
        const target = await createTarget(postgres, "r5b06_race");
        // The race is asked of a REAL RESTORED database, not of an empty one:
        // the property is about two callers contending on restored credential
        // rows, so the rows have to have been restored for it to mean anything.
        const { retireRestoredBotCredentialsV1 } = await import("../deploy/postgres/restored-bot-credentials.mjs");
        const { restoreDatabase } = await import("../deploy/postgres/restore-database.mjs");
        const restoreError = await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
          pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: NIGHTLY_TABLES })
          .then(() => null, (error: Error) => error.message);
        // The restore retires every credential it brings back, which is the rule
        // under test elsewhere. Here the bots have to be able to carry on, so
        // they re-key through the REAL gateway on the restored database — which is
        // the recovery the owner's notice tells them to do, exercised once.
        const targetFleet = poolOn(postgres, "fleet", "r5b06_race");
        const targetOwner = poolOn(postgres, "fleetOwner", "r5b06_race");
        const targetGateway = createFleetGatewayStoreFromConfigurationV1(targetFleet.client, { tenantId: FLEET_TENANT,
          workIntake: { database: {} as never, integrityKey: Buffer.alloc(32, 3).toString("base64url") } });
        const targetOwnerService = new FleetOwnerServiceV1(targetOwner.client, { tenantId: FLEET_TENANT,
          workspaceId: FLEET_WORKSPACE, afterDecision: () => targetGateway.reconcile() });
        const targetServer = createServer((request, response) => {
          void createFleetGatewayHandlerV1({ store: targetGateway,
            proposals: new WorkBatchServiceV1(new WorkBatchStoreV1(poolOn(postgres, "control_room_work_intake_agent", "r5b06_race").client,
              new Uint8Array(32).fill(3))),
            releaseTrust: release.releaseTrust, connectorRelease: release.connectorRelease,
            waitRegistry: new FleetWaitRegistryV1({ waitMs: 60, pollMs: 10 }),
            onUnexpectedError: () => {} }).handle(request, response);
        });
        await new Promise<void>(done => targetServer.listen(0, "127.0.0.1", done));
        const targetOrigin = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}`;
        try {
          // Three of the four re-key through the restored database. The fourth
          // was revoked by the owner and stays unusable — a revoked worker cannot
          // be re-keyed, which is the point.
          for (const label of ["Race One", "Race Two", "Race Three"]) {
            const rekey = await targetOwnerService.issueRekeyCode(ownerIdentity(), workerIdByLabel[label]!);
            await connector.join({ server: targetOrigin, code: rekey.code, workerKind: "mcp-agent",
              configPath: join(dir, `rekey-${label}.json`) });
          }
          const revokedBeat = await connector.createClient(await connector.loadConfig(join(dir, "Race Four.json")))
            .heartbeat().then(() => "ok", (error: Error) => error.message.split("\n")[0]!);
          const [first, second] = await Promise.all([
            retireRestoredBotCredentialsV1(target), retireRestoredBotCredentialsV1(target)]);
          const again = await retireRestoredBotCredentialsV1(target);
          const check = new Client(target);
          await check.connect();
          try {
            return { restoreError, revokedBeat,
              first: first.retired.length, second: second.retired.length, again: again.retired.length,
              revokedReported: first.revokedByBackup.length + second.revokedByBackup.length,
              states: (await check.query(`SELECT state, count(*)::int AS n FROM fleet_worker_credentials
                WHERE tenant_id=$1 GROUP BY state ORDER BY state`, [FLEET_TENANT])).rows };
          } finally { await check.end(); }
        } finally {
          await new Promise<void>(done => targetServer.close(() => done()));
          await targetFleet.close();
          await targetOwner.close();
        }
      } finally {
        await new Promise<void>(done => server.close(() => done()));
        await fleet.close();
        await fleetOwner.close();
      }
    } finally {
      await seed.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      const drop = new Client(postgres.admin({ database: "postgres" }));
      await drop.connect();
      try { await drop.query("DROP DATABASE IF EXISTS r5b06_race"); } finally { await drop.end(); }
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.equal(result.value.restoreError, null,
    `R5B-06: the restore into the race target must succeed; got ${String(result.value.restoreError)}`);
  assert.notEqual(result.value.revokedBeat, "ok",
    `R5B-06: the owner-revoked machine cannot sign in on the restored database either; got ${result.value.revokedBeat}`);
  // Three bots re-keyed on the restored database, so the retirement has three
  // rows to contend over — one from each credential's own update.
  assert.equal(result.value.first + result.value.second, 3,
    `R5B-06: two concurrent callers must retire three credentials BETWEEN them, not six; got ${result.value.first}+${result.value.second}`);
  assert.ok(Math.min(result.value.first, result.value.second) === 0,
    `R5B-06: and they must be disjoint, so one of them retires nothing; got ${result.value.first}+${result.value.second}`);
  assert.equal(result.value.again, 0, "R5B-06: a second run finds nothing to retire, so a re-run is safe");
  assert.equal(result.value.revokedReported, 2,
    "R5B-06: the revoked credential is reported by both callers, because both observe it as revoked — reporting is not claiming");
  // Six retired, not three, and that is the correct history rather than a leak:
  // the restore retired the three the backup held, and then each bot's REAL
  // re-key through the restored gateway retired its own predecessor — which is
  // `gateway-store`'s re-key path doing exactly what it always does. The revoked
  // row is untouched by both.
  assert.deepEqual(result.value.states, [{ state: "retired", n: 6 }, { state: "revoked", n: 1 }],
    `R5B-06: every superseded credential is retired and the revoked one untouched; got ${JSON.stringify(result.value.states)}`);
});

test("R5B-06: the notice is built from what changed, and refuses malformed input", () => {
  // The pure half. The wording and the shape are the owner's whole experience of
  // this rule, so they are pinned here rather than only through a cluster.
  const digest = `sha256:${"a".repeat(64)}`;
  const retired = [
    { tenantId: "tenant:a", workerId: "fleet-worker:a", displayName: "Studio Mac" },
    { tenantId: "tenant:a", workerId: "fleet-worker:b", displayName: "Office Mac" }];
  const revoked = [{ tenantId: "tenant:a", workerId: "fleet-worker:c", displayName: "Old iMac" }];
  const [item] = restoredBotNoticeItemsV1(retired, revoked, digest);
  assert.equal(item.tenantId, "tenant:a");
  assert.equal(item.kind, "incident", "the owner sees it as an incident, not a question");
  assert.equal(item.state, "open");
  assert.equal(item.requestedAction, "Re-key your bots after the restore");
  assert.match(item.summary, /3 machines can no longer sign in/u);
  assert.match(item.summary, /1 of them you had already removed, and stay removed/u);
  assert.deepEqual([...item.machines], ["Office Mac", "Old iMac", "Studio Mac"]);
  assert.equal(actionInboxItemSchemaV1.safeParse(item).success, true,
    "and it is exactly what the owner's inbox accepts");
  assert.deepEqual(restoredBotNoticeItemsV1([], [], digest), [],
    "a restore that changed no bot writes no notice");
  assert.equal(restoredBotNoticeItemsV1([], revoked, digest).length, 1,
    "a restored revoked credential alone is still worth one notice");
  const [single] = restoredBotNoticeItemsV1([retired[0]!], [], digest);
  assert.match(single.summary, /^1 machine can no longer sign in/u, "the singular case reads correctly");
  assert.throws(() => restoredBotNoticeItemsV1(retired, revoked, "not-a-digest"), /restore_bot_notice_input_refused/);
  assert.throws(() => restoredBotNoticeItemsV1(retired, revoked, undefined as never), /restore_bot_notice_input_refused/);
  assert.throws(() => restoredBotNoticeItemsV1([{ tenantId: 1 } as never], [], digest), /restore_bot_notice_input_refused/);
});

test("R5B-03: the pre-check does not refuse the roles the restore creates itself", async () => {
  // The regression this file exists to pin, found by running the REAL
  // lifecycle lane rather than by reading the code: a restore into a properly
  // provisioned target failed `restore_refused_missing_recorded_role:
  // control_room_backup`, because the operator provisions the LOGINS and the
  // TOOL creates its own group roles one step after the pre-check runs. The
  // check refused a role the restore was about to create.
  //
  // What is asserted here is the SHAPE of the exception — a login is not
  // self-created and must still be refused when genuinely missing. The
  // behaviour is proven on a real cluster by the first test in this file, which
  // restores into a target that has the logins but none of the tool's own group
  // roles, and by `tests/postgres-production-lifecycle.test.mjs`, which restores
  // into a fully provisioned target. Both fail if the exception is dropped.
  const { readUnrecordedRoleAuthorityV1 } = await import("../deploy/postgres/scoped-role-evidence.mjs");
  const toolGroupRoles = ["control_room_migrator", "control_room_application", "control_room_reader",
    "control_room_backup", "control_room_schedule_admissions", "control_room_github_broker",
    "control_room_work_intake"];
  const selfCreated = new Set(toolGroupRoles);
  const recorded = new Set([...toolGroupRoles, "control_room_app", "control_room_schema_owner",
    "control_room_work_intake_agent"]);
  const genuinelyMissing = [...recorded].filter(name => !selfCreated.has(name));
  assert.deepEqual(genuinelyMissing,
    ["control_room_app", "control_room_schema_owner", "control_room_work_intake_agent"],
    "every login is still required to exist on the cluster: the operator provisions those, not the tool");
  assert.ok(selfCreated.has("control_room_backup") && selfCreated.has("control_room_reader"),
    "R5B-03: the tool's own group roles are the ones exempt from the missing-role refusal");
  // The guard still fails closed on an unreachable target rather than quietly
  // returning an empty projection, which would report "no extra roles".
  const unreachable = () => (readUnrecordedRoleAuthorityV1 as unknown as (
    ...args: unknown[]) => Promise<unknown>)({ host: "/nonexistent-socket", port: 1, database: "control_room",
      user: "nobody", password: "x", connectionTimeoutMillis: 300 }, recorded, selfCreated);
  await assert.rejects(unreachable, /refused|ECONNREFUSED|EINVAL|ECONNRESET|ENOENT/u,
    "an unreadable target must refuse rather than report a clean projection");
});

test("R5B-04: the cleanup plan is driven by the dump and refuses what it does not name", () => {
  // The pure half: the TOC parser and the planner, with no database at all.
  const toc = parseRestoreTocV1([
    "; Archive created at 2026-10-02 04:45:19 MDT",
    ";     TOC Entries: 5",
    "4; 2615 23844 SCHEMA - control_room_queue postgres",
    "221; 1259 16436 TABLE public tenants control_room_schema_owner",
    "229; 1259 16682 TABLE public workspaces control_room_schema_owner",
    "476; 1259 23917 TABLE control_room_queue job postgres",
    "8960; 0 0 ACL - SCHEMA control_room_queue postgres",
    "1995; 1247 23846 TYPE control_room_queue job_state postgres",
  ].join("\n"));
  assert.deepEqual(toc.schemas, ["control_room_queue", "public"],
    "the SCHEMA line and every object's own schema both name restorable schemas");
  // An ACL line names `SCHEMA` where a TABLE line names its schema, so the
  // parser's kind filter is what keeps `control_room_queue.job` from being read
  // as a relation named `SCHEMA` in a schema named `control_room_queue`.
  assert.deepEqual(toc.relations.map(relation => `${relation.schema}.${relation.name}`),
    ["public.tenants", "public.workspaces", "control_room_queue.job"]);
  assert.deepEqual(toc.types, [{ schema: "control_room_queue", name: "job_state" }]);
  assert.deepEqual(toc.routines, [], "an ACL line is not a function");
  // System schemas are never restorable, so they can never be dropped.
  assert.deepEqual(parseRestoreTocV1("4; 2615 1 SCHEMA - pg_catalog postgres").schemas, []);
  assert.deepEqual(parseRestoreTocV1("4; 2615 1 SCHEMA - pg_temp_7 postgres").schemas, []);

  const target = {
    schemas: [{ name: "public", owner: "fixture_admin", droppable: true },
      { name: "control_room_queue", owner: "postgres", droppable: false }],
    relations: [{ schema: "public", name: "tenants", droppable: true },
      { schema: "public", name: "workspaces", droppable: true }],
    routines: [], types: [] };
  const refused = planHalfRestoredCleanupV1(toc, target);
  assert.equal(refused.refusal, "restore_refused_target_object_not_owned:control_room_queue",
    "a schema this role may not drop is refused, and named — because dropping the public objects first would already have destroyed them");
  const unrelated = planHalfRestoredCleanupV1(toc,
    { ...target, relations: [...target.relations, { schema: "operator_notes", name: "diary", droppable: true }] });
  assert.equal(unrelated.refusal, "restore_refused_unrelated_target_object:operator_notes.diary");
  const plan = planHalfRestoredCleanupV1(toc, { ...target, schemas: [{ name: "public", owner: "fixture_admin", droppable: true },
    { name: "control_room_queue", owner: "fixture_admin", droppable: true }] });
  assert.equal(plan.refusal, undefined);
  assert.deepEqual(plan.dropSchemas, ["control_room_queue"]);
  assert.deepEqual(plan.relations.map(relation => `${relation.schema}.${relation.name}`),
    ["public.tenants", "public.workspaces"],
    "each recorded relation appears exactly once, never twice");
  assert.ok(!plan.dropSchemas.includes("public"), "public is emptied, never dropped");
  // A relation the dump names but this login may NOT drop refuses rather than
  // being dropped or silently skipped: a partial cleanup is the worst outcome,
  // because it leaves the retry failing on a different object each attempt.
  // The fixture replaces the row rather than adding a duplicate, because the
  // planner looks the ownership up by name and a duplicate would just shadow it.
  const owned = { schemas: [{ name: "public", owner: "fixture_admin", droppable: true },
    { name: "control_room_queue", owner: "fixture_admin", droppable: true }] };
  const notOwned = planHalfRestoredCleanupV1(toc, { ...target, ...owned, relations: [
    { schema: "public", name: "tenants", droppable: false },
    { schema: "public", name: "workspaces", droppable: true }] });
  assert.equal(notOwned.refusal, "restore_refused_target_object_not_owned:public.tenants");
  assert.deepEqual(notOwned.dropSchemas, [],
    "and a refused cleanup plans nothing to drop, so nothing has been destroyed on the way to being refused");
  assert.deepEqual(planHalfRestoredCleanupV1(toc, { schemas: [], relations: [], routines: [], types: [] }),
    { dropSchemas: [], relations: [], routines: [], types: [], unknownRelations: [] });
  // A sequence the dump does not name is part of the restore when it belongs to a
  // table the dump DOES name, because PostgreSQL will not drop it on its own.
  const withOwnedSequence = planHalfRestoredCleanupV1(toc, { ...target, ...owned, relations: [
    { schema: "public", name: "tenants", droppable: true },
    { schema: "public", name: "tenants_id_seq", droppable: true }],
  ownedRelations: [{ schema: "public", name: "tenants_id_seq", owner: "public.tenants" }] });
  assert.equal(withOwnedSequence.refusal, undefined,
    "R5B-04: a SERIAL sequence belonging to a dumped table is not an unrelated object");
  assert.deepEqual(withOwnedSequence.relations.map(relation => relation.name).sort(), ["tenants", "tenants_id_seq"],
    "and it is cleaned with its table");
  // The same sequence with NO owning table the dump names is still refused.
  assert.equal(planHalfRestoredCleanupV1(toc, { ...target, ...owned, relations: [
    { schema: "public", name: "tenants", droppable: true },
    { schema: "public", name: "stray_seq", droppable: true }],
  ownedRelations: [{ schema: "public", name: "stray_seq", owner: "public.something_else" }] }).refusal,
  "restore_refused_unrelated_target_object:public.stray_seq");
  assert.throws(() => planHalfRestoredCleanupV1(null as never, target), /restore_cleanup_shape/);
  assert.throws(() => planHalfRestoredCleanupV1(toc, { schemas: [], relations: null } as never), /restore_cleanup_shape/);
  assert.throws(() => parseRestoreTocV1(7 as never), /restore_toc_shape/);
});
test("R5B-10: a backup restores onto a cluster whose superuser has another name", needsPg(), async () => {
  // The finding, measured rather than quoted. A default ACL is a per-ROLE
  // setting, so the role that ISSUED `ALTER DEFAULT PRIVILEGES` owns it — and the
  // release's privilege files are applied as the BOOTSTRAP SUPERUSER. So the
  // SUPERUSER'S OWN NAME is recorded in the dump, and `pg_restore` replays it as
  // `ALTER DEFAULT PRIVILEGES FOR ROLE <that name>`.
  //
  // On the Mac install both sides are `postgres`, so this never fires there. The
  // planned managed-VPS move has a superuser with whatever name the provider
  // chose, and there the documented restore fails outright, after pg_restore has
  // already filled the target — so the retry is refused as non-empty.
  //
  // MEASURED on PostgreSQL 17 before this change (the mutation recorded in the
  // report removes exactly the loop under test):
  //
  //   pg_restore: error: could not execute query: ERROR:  role "fixture_admin"
  //   does not exist
  //   Command was: ALTER DEFAULT PRIVILEGES FOR ROLE fixture_admin REVOKE ALL ON
  //   FUNCTIONS FROM PUBLIC;
  //   pg_restore: warning: errors ignored on restore: 1
  //   ... 243 tables left behind on the target.
  //
  // The kit's cluster is created with `fixture_admin` as its superuser, which is
  // already the "differently named" side, so the fixture's job is to make the
  // RECORDED name something the target genuinely lacks and prove the restore
  // still completes. Dropping the recorded role first is what makes this a test
  // rather than a coincidence.
  const result = await withRealPostgres(async postgres => {
    const root = backupInstallRoot("r5b10");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    const seed = new Client(source);
    await seed.connect();
    try {
      await grantQueueRead(postgres);
      await seed.query("INSERT INTO tenants(id,display_name) VALUES('tenant:r5b10','Default ACL tenant')");
      // The statement production's role files issue as the bootstrap superuser.
      // Run as the kit's `fixture_admin`, which records THAT role as the owner.
      await seed.query("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
      const owners = await seed.query(DEFAULT_ACL_ROLES_SNAPSHOT_SQL);
      assert.ok(owners.rows.some((row: { owner: string }) => row.owner === "fixture_admin"),
        `R5B-10: the fixture must really record the superuser as a default-ACL owner: ${JSON.stringify(owners.rows)}`);
      const out = join(root, "backup");
      const backup = await backupDatabase({ source, out, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: NIGHTLY_TABLES, release: "r5b10" });
      // THE EVIDENCE: the backup records who owns the default ACLs, so the restore
      // has something to act on. Without this the restore has no way to know
      // which name the dump will ask for.
      const metadata = JSON.parse(readFileSync(join(out, "metadata.json"), "utf8"));
      assert.ok(Array.isArray(metadata.evidence.defaultAclOwners), "the backup records its default-ACL owners");
      assert.ok(metadata.evidence.defaultAclOwners.some((row: { owner: string }) => row.owner === "fixture_admin"),
        `and fixture_admin is among them: ${JSON.stringify(metadata.evidence.defaultAclOwners)}`);
      assert.ok(metadata.evidence.defaultAclOwners.every((row: { owner: unknown }) =>
        typeof row.owner === "string" && /^[a-z0-9_]+$/u.test(row.owner)),
        "every recorded owner is a plain identifier, so the restore can create it safely");
      // A backup taken before this change recorded nothing, and restores exactly
      // as it did. The restore treats an absent list as "no roles to create"
      // rather than as a refusal, because refusing would remove the owner's way
      // back for every existing generation.
      const older = { ...metadata, evidence: { ...metadata.evidence, defaultAclOwners: undefined } };
      assert.equal((await resolveRequiredTablesV1(older, [])).length, NIGHTLY_TABLES.length,
        "an older backup with no such record is still readable");

      const targetName = "r5b10_restore_target";
      const target = await createTarget(postgres, targetName);
      // The role the dump will ask for is ABSENT from the target cluster: that is
      // the whole condition. If the kit happened to have created it, this test
      // would pass with the fix deleted.
      const admin = new Client(postgres.admin({ database: "postgres" }));
      await admin.connect();
      try {
        const existing = await admin.query(
          "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'fixture_admin'");
        assert.equal(existing.rows[0].n, 1, "the fixture's own superuser exists on the cluster");
      } finally { await admin.end(); }

      const restored = await restoreDatabase({ backup: out, target, confirmTarget: { ...target },
        pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: NIGHTLY_TABLES });
      assert.equal(restored.identityDigest, backup.identityDigest,
        "a differently-named superuser restores the backup's own identity");

      // THE ROLE UNDER TEST IS NOT THE FIXTURE'S OWN SUPERUSER.
      //
      // The kit's cluster superuser is `fixture_admin`, so asserting "not a
      // superuser" about that name would be measuring the fixture rather than
      // the fix — and it did: the first version of this test failed here, because
      // `fixture_admin` was already `rolsuper = true` before the restore touched
      // it. A role the restore CREATES is the only thing this assertion is about.
      //
      // So the recorded owner is renamed to a name the cluster has never had, the
      // backup is taken with THAT as its default-ACL owner, and the restore has to
      // create it from nothing. Everything the restore does is then observable:
      // the name appears, it carries no privilege, and the dump's `FOR ROLE`
      // statement replays against it.
      const restoreRead = new Client(target);
      await restoreRead.connect();
      try {
        assert.equal(await count(restoreRead,
          "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'fixture_admin'"), 1,
          "the restore runs on the kit's own superuser cluster");
      } finally { await restoreRead.end(); }

      // A SECOND backup, recorded against a role the cluster does not have.
      //
      // `ALTER DEFAULT PRIVILEGES FOR ROLE <name>` only replays if a default ACL
      // exists, and a default ACL is keyed on the role that issued it. So the
      // fixture creates the role, issues the statement as THAT role, backs up,
      // and then DROPS the role on the source — leaving the dump still naming a
      // role no cluster has, which is exactly the reported condition.
      const FOREIGN_OWNER = "r5b10_foreign_super";
      const owner = new Client(postgres.admin({ database: postgres.database }));
      await owner.connect();
      try {
        await owner.query(`CREATE ROLE ${FOREIGN_OWNER} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        await owner.query(`GRANT ${FOREIGN_OWNER} TO fixture_admin`);
        await owner.query(`SET ROLE ${FOREIGN_OWNER}`);
        await owner.query("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
        await owner.query("RESET ROLE");
        const recorded = await owner.query(DEFAULT_ACL_ROLES_SNAPSHOT_SQL);
        assert.ok(recorded.rows.some(row => row.owner === FOREIGN_OWNER),
          `the fixture must record the foreign role as a default-ACL owner: ${JSON.stringify(recorded.rows)}`);
        const foreignOut = join(root, "foreign-owner-backup");
        const foreignBackup = await backupDatabase({ source, out: foreignOut,
          pgBin: join(root, "runtime", "pg-current", "bin"), ledgerDigest: ledgerDigest(),
          requiredTables: NIGHTLY_TABLES, release: "r5b10-foreign" });
        const foreignMetadata = JSON.parse(readFileSync(join(foreignOut, "metadata.json"), "utf8"));
        assert.ok(foreignMetadata.evidence.defaultAclOwners.some((row: { owner: string }) => row.owner === FOREIGN_OWNER),
          "and the backup records it");
        // The source no longer has the role, so the dump names one that exists
        // NOWHERE: not on the source and not on the target.
        //
        // `DROP OWNED BY` first, because the role OWNS the default ACL and a
        // bare `DROP ROLE` refuses with 2BP01 "cannot be dropped because some
        // objects depend on it" — MEASURED, and worth recording because it is the
        // same dependency that makes the dump name the role at all. Dropping the
        // ownership first is what makes the fixture's absence real rather than
        // nominal; the ROLE membership has to go too or the GRANT below holds it.
        await owner.query(`REASSIGN OWNED BY ${FOREIGN_OWNER} TO fixture_admin`);
        await owner.query(`DROP OWNED BY ${FOREIGN_OWNER}`);
        await owner.query("SELECT 1");
        await owner.query(`DROP ROLE ${FOREIGN_OWNER}`);
        const gone = await owner.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1", [FOREIGN_OWNER]);
        assert.equal(gone.rows[0].n, 0, "the source no longer has it");

        const foreignTargetName = "r5b10_foreign_target";
        const foreignTarget = await createTarget(postgres, foreignTargetName);
        const foreignRestored = await restoreDatabase({ backup: foreignOut, target: foreignTarget,
          confirmTarget: { ...foreignTarget }, pgBin: join(root, "runtime", "pg-current", "bin"),
          requiredTables: NIGHTLY_TABLES });
        assert.equal(foreignRestored.identityDigest, foreignBackup.identityDigest,
          "R5B-10: the restore creates the role the dump names and completes the restore");

        const check = new Client(postgres.admin({ database: foreignTargetName }));
        await check.connect();
        try {
          const role = await check.query(
            "SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = $1", [FOREIGN_OWNER]);
          assert.equal(role.rows.length, 1, "the recorded owner now exists on the target");
          assert.equal(role.rows[0].rolsuper, false,
            "created WITHOUT superuser: the dump needs the name, not the authority");
          assert.equal(role.rows[0].rolcanlogin, false, "and without LOGIN");
          const rows = await check.query("SELECT id FROM tenants ORDER BY id");
          assert.deepEqual(rows.rows.map(row => row.id), ["tenant:r5b10"],
            "and the data really restored");
        } finally { await check.end(); }
      } finally { await owner.end(); }
      return { restored: restored.identityDigest, expected: backup.identityDigest };
    } finally { await seed.end(); rmSync(root, { recursive: true, force: true }); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
  assert.equal(result.cleanedUp, true, `no cluster leaked: ${result.leftovers.join(",")}`);
  assert.equal(result.value.restored, result.value.expected);
});

test("R5B-03/STEP-1: the restore's group-role lists are read from the SQL file, not restated", () => {
  // WHY THIS TEST EXISTS. STEP 1 of this round reported the documented clean-cluster
  // journey failing `restore_refused_missing_recorded_role:control_room_backup`.
  // The refusal itself was CORRECT — the check exists so the operator is told which
  // role to provision — but its input was a hand-kept copy of
  // `db/roles/production_roles.sql`'s role list, in `restore-database.mjs`. Two
  // spellings of one fact, kept in agreement by hand, is the defect: the moment the
  // SQL file gained or lost a role, the restore either created a role the backup
  // never recorded or refused one it was about to create.
  //
  // So the lists are derived from the file, and THIS test is what makes the
  // derivation honest: it compares the readers against the shipped SQL, so a role
  // added to that file without the readers understanding it fails HERE rather
  // than on the documented journey.
  const sql = readFileSync(join(REPOSITORY, "db", "roles", "production_roles.sql"), "utf8");
  const groupRoles = readProductionGroupRolesV1(sql);
  // The roles production_roles.sql creates today, by name. A new group role must
  // be added HERE as well as to the SQL file, which is the point: the two are
  // asserted equal, so neither can move alone.
  assert.deepEqual([...groupRoles].sort(), [
    "control_room_application", "control_room_backup", "control_room_github_broker",
    "control_room_migrator", "control_room_reader", "control_room_schedule_admissions",
    "control_room_work_intake",
  ], "every group role the SQL file creates is derived, in the same set");
  assert.equal(new Set(groupRoles).size, groupRoles.length, "and none is listed twice");

  // The revoke list is the OTHER hand-kept copy of the same file, and its failure
  // mode is quieter: an empty list stops the restore revoking database TEMPORARY
  // at all, with nothing to announce it. MEASURED during this change: two earlier
  // patterns each returned an empty list, and neither raised anything.
  const revoked = readTemporaryRevokedRolesV1(sql);
  assert.deepEqual([...revoked].sort(), [
    "control_room_application", "control_room_backup", "control_room_github_broker",
    "control_room_reader", "control_room_schedule_admissions", "control_room_work_intake",
  ], "every role the SQL file revokes database TEMPORARY from is derived");
  assert.ok(revoked.length >= 6,
    `a parse that finds fewer revokes than the file states is a silent regression: ${JSON.stringify(revoked)}`);
  assert.ok(!revoked.includes("PUBLIC"),
    "PUBLIC is excluded because the restore revokes it from PUBLIC by hand, unconditionally");
  assert.ok(groupRoles.every(role => /^control_room_[a-z0-9_]+$/u.test(role)),
    "every derived role name is an identifier the restore can quote safely");

  // A file with NO role creation is a REFUSAL, not an empty list. An empty list
  // would let the restore proceed on a role set nobody wrote down, which is the
  // exact class of bug the derivation exists to remove.
  assert.throws(() => readProductionGroupRolesV1("-- no roles here"), /restore_refused_no_production_group_roles/,
    "an unreadable role file must refuse rather than yield an empty list");
  assert.throws(() => readProductionGroupRolesV1(""), /restore_refused_no_production_group_roles/);
  // Both readers must be pure functions of their input: a restore must not get a
  // different answer for the same file, or the digest it verified means nothing.
  assert.deepEqual([...readProductionGroupRolesV1(sql)], [...groupRoles]);
  assert.deepEqual([...readTemporaryRevokedRolesV1(sql)], [...revoked]);
  // And a role name that is not a plain identifier is never returned, so nothing
  // this file contained can reach a CREATE ROLE statement as raw text.
  assert.throws(() => readProductionGroupRolesV1("CREATE ROLE \"Mixed-Case\" NOLOGIN;"),
    /restore_refused_no_production_group_roles/,
    "a role name this restore cannot quote safely is not read as a role");

  // THE DERIVATION IS ACTUALLY USED, not merely available.
  //
  // MEASURED: with the module's constant put back to a hand-kept list — and
  // deliberately missing `control_room_work_intake`, the exact drift that broke
  // the documented journey — every assertion above still passed, because they all
  // exercise the READERS rather than the module. A guard that only proves its own
  // helper works is not a guard.
  //
  // So the module's OWN effective lists are compared against the file. Reading a
  // module-level constant is not possible (they are not exported), and the
  // behaviour that matters is observable instead: with the constant in place the
  // restore would create a role set that differs from the file's. This asserts
  // the source itself, which is the one thing a reviewer reads.
  const source = readFileSync(join(REPOSITORY, "deploy", "postgres", "restore-database.mjs"), "utf8");
  assert.doesNotMatch(source,
    /const\s+PRODUCTION_GROUP_ROLES\s*=\s*Object\.freeze\s*\(\s*\[/u,
    "the restore must not carry a hand-kept copy of the group-role list");
  assert.doesNotMatch(source,
    /const\s+TEMPORARY_REVOKED_ROLES\s*=\s*Object\.freeze\s*\(\s*\[/u,
    "and it must not carry a hand-kept copy of the revoke list either");
  assert.match(source,
    /const\s+PRODUCTION_GROUP_ROLES\s*=\s*readProductionGroupRolesV1\(/u,
    "the group-role list is derived from db/roles/production_roles.sql");
  assert.match(source,
    /const\s+TEMPORARY_REVOKED_ROLES\s*=\s*Object\.freeze\(readTemporaryRevokedRolesV1\(/u,
    "and so is the revoke list, from the same file");
  // The role the pre-check's exception is built from is this list, so the two
  // must be the same value rather than a filtered copy: the check refuses a
  // recorded role the cluster lacks EXCEPT the ones this restore creates, and a
  // filtered copy is how a role becomes exempt from its own missing-role refusal.
  assert.match(source,
    /readUnrecordedRoleAuthorityV1\(target,\s*recordedRoleNames,\s*\n?\s*new Set\(PRODUCTION_GROUP_ROLES\.filter\(/u,
    "the pre-check is told exactly which roles the restore creates, from the same list it creates them from");
});
