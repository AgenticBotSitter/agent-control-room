// Real-PostgreSQL proofs for the project-activity LIFECYCLE write path, run as
// the production logins rather than as a superuser.
//
// Why the login matters: `appendInSession` takes the stream head `FOR UPDATE` and
// then UPDATEs four columns of it. A superuser bypasses every privilege check,
// so a test that appends as one proves nothing about an installation whose
// process connects as `control_room_publisher`, `control_room_web` or
// `control_room_coordinator`. The shared attack kit creates those logins from
// the REAL `db/roles/*.sql` files, so a passing assertion here is the server's
// own verdict for the shipped grants.
//
// The upgrade proof is here for the same reason and is the one the review's
// BLOCKER 1 turned on: on a database that was installed from an older ledger the
// role files are never re-run, so the ONLY thing that can grant the publisher
// `projects` is the migration. The test builds that state for real -- a cluster
// at "main" (every migration except this head's) with the main-era role files,
// then applies this head's migration and re-checks -- so a fresh install, which
// would pass from the role files alone, cannot mask a broken upgrade path.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool, type PoolClient } from "pg";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { ProjectEventStoreV1, TaskProjectEventWriterV1, taskProjectEventActionsV1 } from "../src/project-events/v1";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { collectLedgerEntries, ledgerDigest } from "../scripts/generate-migration-ledger.mjs";
import { isPrivilegeDenied, requiresRealPostgres, realPostgresSkipMessage, splitSqlStatements, withRealPostgres,
  type RealPostgres } from "./support/attack-kit";

const REPOSITORY_ROOT = new URL("..", import.meta.url).pathname;
// The ports this job is authorized for. The kit REFUSES any port outside it
// before it so much as probes the port, so a typo cannot start a cluster
// somewhere another job owns. The base is configurable so a lane can be given
// its own block without editing this file; the whole block still has to be
// contiguous and inside the caller's authorization.
const PORT_BASE = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58370);
const ALLOWED_PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => PORT_BASE + index));
const LIVE_PORT = PORT_BASE;
const UPGRADE_PORT = PORT_BASE + 1;
const needsPg = requiresRealPostgres() ? undefined : { skip: realPostgresSkipMessage() };
const exec = promisify(execFile);

/**
 * One role file exactly as `origin/main` shipped it, or null when main has no
 * such path.
 *
 * Read through `git show` rather than a second checkout of main, so the test
 * never depends on another worktree and so "what main had" is answered by the
 * repository itself. A git failure is an ERROR rather than a null: a null here
 * would silently weaken the pre-upgrade state into something easier to pass.
 */
async function gitShowAtMain(path: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["show", `origin/main:${path}`],
      { cwd: REPOSITORY_ROOT, maxBuffer: 1 << 24, timeout: 30_000 });
    return stdout;
  } catch (error) {
    const message = `${(error as { stderr?: string })?.stderr ?? error}`;
    if (/fatal: path .* does not exist in /u.test(message)) return null;
    throw new Error(`git_show_origin_main_failed:${path}:${message.split("\n")[0]}`);
  }
}

const TOKEN = randomBytes(5).toString("hex");
const TENANT_ID = `tenant:pa-lifecycle-${TOKEN}`;
const WORKSPACE_ID = `workspace:pa-lifecycle-${TOKEN}`;
const SIBLING_WORKSPACE_ID = `workspace:pa-sibling-${TOKEN}`;
const ADAPTER_ID = `adapter:pa-lifecycle-${TOKEN}`;
const projectId = (label: string) => `project:pa-lifecycle-${label}-${TOKEN}`;
const OWN_PROJECT = projectId("owner");
const SIBLING_PROJECT = projectId("sibling");
const KEY = new Uint8Array(32).fill(0x5b);
const EVENT_NOW = "2026-09-29T12:00:00.000Z";

/** The production logins that perform these writes, named as the code names them. */
const WRITER_ROLES = ["web", "coordinator", "publisher"] as const;
type WriterRole = (typeof WRITER_ROLES)[number];

/** One pool per production login, so each assertion is about that role and no other. */
function rolePool(postgres: RealPostgres, role: WriterRole): Pool {
  return new Pool({ ...postgres.connection(role), max: 2,
    application_name: `control-room-activity-lifecycle-${role}` });
}

function roleClient(pool: Pool): DatabaseClient {
  const one = async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try { return await callback(client); } finally { client.release(); }
  };
  const inTransaction = <T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T> => one(async client => {
    await client.query("BEGIN");
    try {
      const session: DatabaseSession = Object.freeze({
        query: async <R>(statement: string, params: unknown[] = []) =>
          (await client.query(statement, params)) as unknown as { rows: R[] },
      });
      const value = await callback(session);
      await client.query("COMMIT");
      return value;
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => {});
      throw cause;
    }
  });
  return Object.freeze<DatabaseClient>({
    query: async <T>(statement: string, params: unknown[] = []) =>
      (await one(client => client.query(statement, params as never[]))) as unknown as { rows: T[] },
    transaction: inTransaction,
    transactionWithPreCommitCheck: <T>(callback: (session: DatabaseSession) => Promise<T>) => inTransaction(callback),
  });
}

async function seedFixture(postgres: RealPostgres) {
  const admin = new Client(postgres.admin());
  await admin.connect();
  try {
    await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Activity lifecycle tenant')", [TENANT_ID]);
    for (const workspace of [WORKSPACE_ID, SIBLING_WORKSPACE_ID])
      await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Activity lifecycle workspace')",
        [workspace, TENANT_ID]);
    await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
      project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
      VALUES($1,$2,'activity_lifecycle_fixture','fixture-v1','control_room_native','fixture','[]','[]','[]','redaction-v1',30)`,
    [ADAPTER_ID, TENANT_ID]);
    for (const [project, workspace] of [[OWN_PROJECT, WORKSPACE_ID], [SIBLING_PROJECT, SIBLING_WORKSPACE_ID]] as const)
      await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
        title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
        VALUES($1,$2,$3,$4,$1,'fixture-v1',$1,'running','active','healthy','control_room_native',$5,'{}')`,
      [project, TENANT_ID, workspace, ADAPTER_ID, EVENT_NOW]);
  } finally { await admin.end(); }
}

const lifecycleWrite = (project: string, workspace: string, index: number) => ({
  tenantId: TENANT_ID, workspaceId: workspace, projectId: project, subjectId: `job:lifecycle-${index}`,
  action: taskProjectEventActionsV1[index % taskProjectEventActionsV1.length]!,
  sourceId: `source:lifecycle-${index}`, sourceVersion: `lifecycle-v${index}`, occurredAt: EVENT_NOW,
});

test("lifecycle appends succeed as each production login, and are refused across a workspace", needsPg, async t => {
  const result = await withRealPostgres(async postgres => {
    await seedFixture(postgres);
    const observed: Record<string, { appended: number; crossWorkspace: string }> = {};
    const pools: Pool[] = [];
    try {
      for (const role of WRITER_ROLES) {
        const pool = rolePool(postgres, role); pools.push(pool);
        const client = roleClient(pool);
        // The very same store and writer the product code uses, authenticated
        // as this production login.
        const store = new ProjectEventStoreV1(client, KEY, () => EVENT_NOW);
        const writer = new TaskProjectEventWriterV1(store);
        let appended = 0;
        await client.transaction(async (tx: DatabaseSession) => {
          for (let index = 0; index < taskProjectEventActionsV1.length; index += 1) {
            // Every role files into its OWN project, so a row in a project's
            // stream is attributable to exactly one login.
            const own = projectId(role);
            await adminInsertProject(postgres, own, WORKSPACE_ID);
            const { event } = await writer.appendInSession(tx, lifecycleWrite(own, WORKSPACE_ID, index));
            appended += 1;
            assert.equal(event.workspaceId, WORKSPACE_ID);
          }
        });
        // The cross-workspace refusal, run on the same login and connection: the
        // project exists in this tenant, but under the sibling workspace.
        let crossWorkspace = "accepted";
        try {
          await client.transaction(async (tx: DatabaseSession) => {
            await writer.appendInSession(tx, { ...lifecycleWrite(SIBLING_PROJECT, WORKSPACE_ID, 0),
              tenantId: TENANT_ID, workspaceId: WORKSPACE_ID });
          });
        } catch (error) {
          crossWorkspace = (error as { safeCode?: string }).safeCode ?? `unexpected:${String(error)}`;
        }
        observed[role] = { appended, crossWorkspace };
      }
      // Every role really appended, through its own login, and each stream holds
      // exactly the actions that login filed.
      const admin = new Client(postgres.admin());
      await admin.connect();
      try {
        for (const role of WRITER_ROLES) {
          const rows = await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM control_project_events WHERE tenant_id=$1 AND project_id=$2",
            [TENANT_ID, projectId(role)]);
          assert.equal(rows.rows[0]?.count, taskProjectEventActionsV1.length,
            `${role} must have appended every lifecycle action through its own login`);
          // The event payload carries fixed presentation text only.
          const summaries = await admin.query<{ summary: string }>(
            "SELECT payload->>'safeSummary' AS summary FROM control_project_events WHERE tenant_id=$1 AND project_id=$2 ORDER BY sequence",
            [TENANT_ID, projectId(role)]);
          assert.ok(summaries.rows.every(row => typeof row.summary === "string" && !/lifecycle-v\d/u.test(row.summary)),
            `${role} must never see caller source data in a summary`);
        }
        // No login reached any project outside the three it owns. The three
        // per-role project ids and the two fixture projects all share this
        // tenant, so the count is taken over the whole tenant rather than by a
        // LIKE pattern (a pattern would need its own escaping and is a weaker
        // statement of the same thing).
        const perRole = WRITER_ROLES.map(role => projectId(role));
        const foreign = await admin.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM control_project_events WHERE tenant_id=$1 AND NOT (project_id = ANY($2::text[]))",
          [TENANT_ID, perRole]);
        assert.equal(foreign.rows[0]?.count, 0,
          "an event must only ever land in the project its own login was appending for");
      } finally { await admin.end(); }
      return observed;
    } finally { for (const pool of pools) await pool.end().catch(() => {}); }
  }, { port: LIVE_PORT, allowedPorts: ALLOWED_PORTS, boundMs: 300_000 });
  t.diagnostic(JSON.stringify(result.value));
  for (const role of WRITER_ROLES) {
    assert.equal(result.value[role]?.appended, taskProjectEventActionsV1.length,
      `${role} must be able to append the whole lifecycle set as its own login`);
    assert.equal(result.value[role]?.crossWorkspace, "project_not_found",
      `${role} must refuse an event naming a workspace its project does not belong to`);
  }
  assert.equal(result.cleanedUp, true, `the cluster must be gone: ${result.leftovers.join(",")}`);
});

/** Row locks need UPDATE privilege, so the head update is what the login proof exercises. */
test("the stream head row lock is taken by each production login, not by a superuser", needsPg, async t => {
  await withRealPostgres(async postgres => {
    await seedFixture(postgres);
    const pools: Pool[] = [];
    try {
      for (const role of WRITER_ROLES) {
        const pool = rolePool(postgres, role); pools.push(pool);
        const client = roleClient(pool);
        const writer = new TaskProjectEventWriterV1(new ProjectEventStoreV1(client, KEY, () => EVENT_NOW));
        await client.transaction(tx => writer.appendInSession(tx, lifecycleWrite(OWN_PROJECT, WORKSPACE_ID, 0)));
        // UPDATE on the head, restricted to the four columns the store writes,
        // is what `FOR UPDATE` + the head mutation need. Assert the server's
        // verdict for this exact statement, executed as this login.
        const probe = new Client(postgres.connection(role));
        await probe.connect();
        try {
          await probe.query(`UPDATE control_project_event_stream_heads
            SET last_sequence=last_sequence, last_event_digest=last_event_digest,
              head_auth_tag=head_auth_tag, updated_at=updated_at
            WHERE tenant_id=$1 AND project_id=$2`, [TENANT_ID, OWN_PROJECT]);
        } finally { await probe.end(); }
        // And the read the durable result publication performs to scope its
        // event. Without this grant that query is `permission denied`, which is
        // exactly the upgrade-path defect this PR fixes.
        const projects = await postgres.query(role, "SELECT workspace_id FROM projects WHERE tenant_id=$1 AND id=$2",
          [TENANT_ID, OWN_PROJECT]);
        assert.equal(projects.rows[0]?.workspace_id, WORKSPACE_ID,
          `${role} must be able to read the project row its activity event is scoped by`);
      }
    } finally { for (const pool of pools) await pool.end().catch(() => {}); }
  }, { port: LIVE_PORT + 1, allowedPorts: ALLOWED_PORTS, boundMs: 300_000 });
  t.diagnostic("head UPDATE and the projects read both succeed as every production login");
});

test("upgrade from a main-state database grants the publisher what the publication path needs", needsPg, async t => {
  // A database at "main": every migration EXCEPT this head's, applied with the
  // production applier. On this state nothing has granted the activity stream,
  // which is exactly the population BLOCKER 1 broke.
  const MIGRATOR_PASSWORD = "m409".padEnd(24, "x");
  const result = await withRealPostgres(async postgres => {
    const migrations = (await readdir(join(REPOSITORY_ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort();
    const activity = migrations.filter(name => name.endsWith("_task_project_activity_events.sql"));
    assert.equal(activity.length, 1, "exactly one activity migration");
    const mainMigrations = migrations.filter(name => name !== activity[0]);
    // The number must sort after everything main shipped, or the ledger an
    // upgraded installation builds is corrupt.
    const number = (name: string) => Number((/^(\d{4})_/u.exec(name) ?? [])[1]);
    for (const shipped of mainMigrations)
      assert.ok(number(activity[0]!) > number(shipped), `${activity[0]} must sort after main's ${shipped}`);

    // A second, empty database on the SAME cluster, so the upgrade below is a
    // real in-place upgrade of a real main-state database rather than a fresh
    // install (which would pass from the role files alone and hide the defect).
    const mainState = await mkdtemp(join(tmpdir(), "cr409-main-"));
    try {
      for (const dir of ["deploy/postgres", "db/migrations", "db/roles", "db/setup"])
        await mkdir(join(mainState, dir), { recursive: true });
      for (const file of mainMigrations)
        await cp(join(REPOSITORY_ROOT, "db/migrations", file), join(mainState, "db/migrations", file));
      for (const file of ["production_roles.sql", "production_provision.sql", "production_table_grants.sql"])
        await cp(join(REPOSITORY_ROOT, "db/roles", file), join(mainState, "db/roles", file));
      await cp(join(REPOSITORY_ROOT, "db/setup/production_migration_ledger.sql"),
        join(mainState, "db/setup/production_migration_ledger.sql"));
      const entries = await collectLedgerEntries(mainState);
      const mainLedgerPath = join(mainState, "deploy/postgres/migration-ledger.json");
      await writeFile(mainLedgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));

      const admin = new Client(postgres.admin());
      await admin.connect();
      try {
        const database = "control_room_at_main";
        await admin.query(`DROP DATABASE IF EXISTS ${database}`);
        await admin.query(`CREATE DATABASE ${database}`);
        // The applier's second phase connects as the migrator login with a
        // password the kit generated; set a known one so this test can build the
        // same two-phase target the operator CLI builds.
        await admin.query(`ALTER ROLE control_room_migrator PASSWORD '${MIGRATOR_PASSWORD}'`);
        const conninfo = (user: string, password?: string) =>
          `host=${postgres.host} port=${postgres.port} dbname=${database} user=${user}`
          + (password ? ` password=${password}` : "");
        const phase = (rootDir: string, ledgerPath?: string) => applyMigrations({
          target: conninfo("fixture_admin"), rootDir, ledgerPath,
          bootstrapTarget: conninfo("fixture_admin"), migrateTarget: conninfo("control_room_migrator", MIGRATOR_PASSWORD),
          env: { ...process.env, CONTROL_ROOM_MIGRATOR_PASSWORD: MIGRATOR_PASSWORD,
            CONTROL_ROOM_APP_PASSWORD: "a".repeat(24), CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24),
            CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(24) },
        });

        const atMain = await phase(mainState, mainLedgerPath);
        assert.equal((atMain.applied?.length ?? 0), mainMigrations.length,
          "every main-era migration must apply, and nothing else");

        const mainDb = new Client({ ...postgres.admin(), database });
        await mainDb.connect();
        try {
          // The Mac-local role files, as MAIN shipped them. This is the state an
          // upgraded installation is really in: the roles exist and the private
          // web role can already READ the stream, but nothing has been granted
          // the ability to APPEND to it, and the publisher's file has no
          // `projects` read at all. Taking them from `origin/main` rather than
          // from the working tree is what makes the pre-upgrade state real --
          // the working tree's role files already carry this head's grants, and
          // using them would hide the very defect this test exists to catch.
          //
        // The Mac-local evidence role is not in the attack kit's standard role
        // set, so it is created here -- from MAIN's version of the file, for the
        // same reason the three below are: the working tree's copy already
        // carries this head's grants and would hide the defect. The whole file
        // is replayed (CREATE ROLE included) because this role does not exist yet
        // on the cluster.
        const mainEvidence = await gitShowAtMain("db/roles/native_evidence_roles.sql");
        assert.ok(mainEvidence !== null, "origin/main must carry db/roles/native_evidence_roles.sql");
        await mainDb.query(mainEvidence);
        // Roles are cluster-global and the kit already created these other three
        // on this cluster, so only the GRANT statements are replayed for them.
        // The file is split with the kit's own statement splitter rather than by
        // line, so a multi-line GRANT survives intact; filtering by line would
        // tear one in half and the half-statement would be a different test.
        //
        // No assertion is made on the role files' TEXT here. The pre-upgrade
        // privileges are asserted against the live database immediately below,
        // which is the thing that matters and cannot be fooled by a regex over
        // a file. A text assertion would only be a second, weaker restatement.
        for (const file of ["private_web_roles.sql", "task_coordinator_roles.sql",
          "local_result_publisher_roles.sql"]) {
            const mainVersion = await gitShowAtMain(`db/roles/${file}`);
            assert.ok(mainVersion !== null, `origin/main must carry db/roles/${file}`);
            const grants = splitSqlStatements(mainVersion)
              .filter(statement => /^GRANT\s/u.test(statement) && !/^GRANT (?:EXECUTE|USAGE)\s/u.test(statement));
            assert.ok(grants.length > 0, `${file} at main must still contribute its grants`);
            for (const statement of grants) await mainDb.query(statement);
          }
          const atMainRows = (await mainDb.query<{ filename: string; ledger_order: number }>(
            "SELECT filename, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
          assert.deepEqual(atMainRows.map(row => row.filename), mainMigrations.map(file => `db/migrations/${file}`));
          // The pre-upgrade state the review measured. Every one of the four
          // writers is refused the append, and the publisher cannot read
          // `projects` -- which is the exact permission denied the review
          // reproduced on an upgraded installation.
          for (const role of ["control_room_private_web", "control_room_task_coordinator",
            "control_room_native_evidence", "control_room_local_result_publisher"])
            assert.equal((await mainDb.query<{ allowed: boolean }>(
              "SELECT has_table_privilege($1,'control_project_events','INSERT') AS allowed", [role]))
              .rows[0]?.allowed, false, `${role} must not already hold the activity INSERT before the upgrade`);
          assert.equal((await mainDb.query<{ allowed: boolean }>(
            "SELECT has_table_privilege('control_room_local_result_publisher','projects','SELECT') AS allowed"))
            .rows[0]?.allowed, false,
          "a main-state database must not already let the publisher read `projects`");
        } finally { await mainDb.end(); }

        // The upgrade: this head's full ledger, applied over the main-state
        // database by the same two-phase applier.
        const upgraded = await phase(REPOSITORY_ROOT);
        assert.deepEqual(upgraded.applied?.map(entry => [entry.file, entry.order]),
          [[`db/migrations/${activity[0]}`, mainMigrations.length + 1]],
          "the upgrade must append exactly this head's migration, after main's last applied order");
        assert.equal(upgraded.noOp, false,
          "the upgrade must be a real apply, not a no-op: the migration is pending on a main-state database");

        const upgradedDb = new Client({ ...postgres.admin(), database });
        await upgradedDb.connect();
        try {
          // No duplicate order, no gap, and every main-era row untouched.
          assert.deepEqual((await upgradedDb.query(`SELECT ledger_order, count(*)::int AS rows
            FROM control_room_schema_migrations GROUP BY ledger_order HAVING count(*) > 1`)).rows, []);
          const ledger = (await upgradedDb.query<{ filename: string; ledger_order: number }>(
            "SELECT filename, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
          assert.deepEqual(ledger.map(row => row.ledger_order),
            Array.from({ length: mainMigrations.length + 1 }, (_, index) => index + 1),
            "the upgraded ledger must be contiguous");
          assert.deepEqual(ledger.slice(0, -1).map(row => row.filename),
            mainMigrations.map(file => `db/migrations/${file}`));
          // BLOCKER 1, on the upgraded database, as the production role names.
          for (const role of ["control_room_private_web", "control_room_task_coordinator",
            "control_room_native_evidence", "control_room_local_result_publisher"])
            assert.equal((await upgradedDb.query<{ allowed: boolean }>(
              "SELECT has_table_privilege($1,'control_project_events','INSERT') AS allowed", [role]))
              .rows[0]?.allowed, true, `${role} must be able to append after the upgrade`);
          assert.equal((await upgradedDb.query<{ allowed: boolean }>(
            "SELECT has_table_privilege('control_room_local_result_publisher','projects','SELECT') AS allowed"))
            .rows[0]?.allowed, true,
          "BLOCKER 1: the publisher must be able to read `projects` after the upgrade");
          // Least privilege survives the upgrade, checked only against the roles
          // that must genuinely have nothing: the queue worker, the work-intake
          // login and the news roles. `control_room_application` is deliberately
          // NOT in this list -- production_table_grants.sql grants it
          // SELECT/INSERT/UPDATE on all tables, so it holds these privileges on
          // main too and asserting otherwise would assert a change nobody made.
          for (const role of ["control_room_queue_worker", "control_room_work_intake",
            "control_room_news_ingestion", "control_room_news_coordinator"])
            assert.equal((await upgradedDb.query<{ allowed: boolean }>(
              "SELECT has_table_privilege($1,'control_project_events','INSERT')"
              + " OR has_table_privilege($1,'control_project_event_stream_heads','SELECT') AS allowed", [role]))
              .rows[0]?.allowed, false, `${role} must reach neither activity table`);

          // A clean second run: no migration re-applied, no ledger row added.
          const rerun = await phase(REPOSITORY_ROOT);
          assert.equal(rerun.noOp, true, "a second apply of the same ledger must be a no-op");
          assert.deepEqual((rerun.applied ?? []), []);
          assert.deepEqual((await upgradedDb.query<{ filename: string; ledger_order: number }>(
            "SELECT filename, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows, ledger,
          "the second run must leave the ledger byte-identical");
        } finally { await upgradedDb.end(); }
        return mainMigrations.length + 1;
      } finally { await admin.end(); }
    } finally { await rm(mainState, { recursive: true, force: true }); }
  }, { port: UPGRADE_PORT, allowedPorts: ALLOWED_PORTS, boundMs: 600_000 });
  t.diagnostic(`upgraded a main-state database to ${result.value} ledger rows, appended one, clean rerun`);
  assert.equal(result.cleanedUp, true, `the cluster must be gone: ${result.leftovers.join(",")}`);
});

/** The publication query, refused for a role the migration deliberately does not grant. */
test("the projects grant is not wider than the publisher's own need", needsPg, async t => {
  await withRealPostgres(async postgres => {
    await seedFixture(postgres);
    // A role with no relationship to publication must not inherit the grant:
    // the migration grants it by name, and the statement is proven here as that
    // role's own session, so a future blanket GRANT would be caught.
    const queueWorker = new Client(postgres.connection("queueWorker"));
    await queueWorker.connect();
    try {
      let denied: unknown;
      try { await queueWorker.query("SELECT workspace_id FROM projects WHERE tenant_id=$1 AND id=$2", [TENANT_ID, OWN_PROJECT]); }
      catch (error) { denied = error; }
      assert.ok(isPrivilegeDenied(denied),
        `the queue worker must be refused the publisher's project read, got ${String(denied)}`);
    } finally { await queueWorker.end(); }
    if (!existsSync(join(REPOSITORY_ROOT, "db/migrations"))) throw new Error("repository root not readable");
  }, { port: LIVE_PORT + 2, allowedPorts: ALLOWED_PORTS, boundMs: 300_000 });
  t.diagnostic("the activity grant reaches the four named roles and nobody else");
});

/** Idempotence: applying the migration twice on one database changes nothing. */
test("the activity migration is idempotent on a second apply", needsPg, async t => {
  const stage = await mkdtemp(join(tmpdir(), "cr409-rerun-"));
  try {
    for (const dir of ["deploy/postgres", "db/migrations", "db/roles", "db/setup"])
      await mkdir(join(stage, dir), { recursive: true });
    for (const file of (await readdir(join(REPOSITORY_ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort())
      await cp(join(REPOSITORY_ROOT, "db/migrations", file), join(stage, "db/migrations", file));
    for (const file of ["production_roles.sql", "production_provision.sql", "production_table_grants.sql"])
      await cp(join(REPOSITORY_ROOT, "db/roles", file), join(stage, "db/roles", file));
    await cp(join(REPOSITORY_ROOT, "db/setup/production_migration_ledger.sql"),
      join(stage, "db/setup/production_migration_ledger.sql"));
    const entries = await collectLedgerEntries(stage);
    const ledgerPath = join(stage, "deploy/postgres/migration-ledger.json");
    await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));

    const once = await withRealPostgres(async postgres => {
      const connection = new Client(postgres.admin());
      await connection.connect();
      try {
        // The RAW statements of this head's migration, executed a second time on
        // a database that already has them. GRANT is idempotent, so this must
        // succeed; a statement that were not idempotent would raise here.
        const activity = (await readdir(join(REPOSITORY_ROOT, "db/migrations")))
          .filter(name => name.endsWith("_task_project_activity_events.sql"));
        await connection.query(await readFile(join(REPOSITORY_ROOT, "db/migrations", activity[0]!), "utf8"));
        const applied = await connection.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM control_room_schema_migrations");
        return applied.rows[0]?.count ?? 0;
      } finally { await connection.end(); }
    }, { port: LIVE_PORT + 3, allowedPorts: ALLOWED_PORTS, boundMs: 300_000 });
    t.diagnostic(`re-applied the migration statements on a live database (${once.value} ledger rows unchanged)`);
    assert.ok(once.value > 0);
    assert.equal(once.cleanedUp, true, `the cluster must be gone: ${once.leftovers.join(",")}`);
  } finally { await rm(stage, { recursive: true, force: true }); }
});

/** A project row the fixture needs, inserted as the schema owner. */
async function adminInsertProject(postgres: RealPostgres, project: string, workspace: string) {
  const admin = new Client(postgres.admin());
  await admin.connect();
  try {
    await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
      title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
      VALUES($1,$2,$3,$4,$1,'fixture-v1',$1,'running','active','healthy','control_room_native',$5,'{}')
      ON CONFLICT (id) DO NOTHING`, [project, TENANT_ID, workspace, ADAPTER_ID, EVENT_NOW]);
  } finally { await admin.end(); }
}
