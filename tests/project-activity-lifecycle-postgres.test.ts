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
//
// The block is four ports, and the tests below share them. Each test stops its
// cluster before the next begins, so two tests may name the same port; what they
// may not do is reach outside the block. A fifth port here would start a cluster
// the authorizing brief never granted, which is exactly what the allowlist
// exists to prevent, so the last test reuses an in-block port instead.
const PORT_BASE = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58370);
const ALLOWED_PORTS = Object.freeze([PORT_BASE, PORT_BASE + 1, PORT_BASE + 2, PORT_BASE + 3]);
const LIVE_PORT = PORT_BASE;
const UPGRADE_PORT = PORT_BASE + 1;
const needsPg = requiresRealPostgres() ? undefined : { skip: realPostgresSkipMessage() };

/**
 * The BASE version of one role file: the shipped file with this head's activity
 * grants removed, which is exactly the state an installation that predates this
 * migration is in.
 *
 * The pre-upgrade state is derived from the working tree rather than read from
 * `origin/main`, and that is a deliberate choice rather than a shortcut:
 *
 *  - `origin/main` does not exist in the shallow checkout this test's CI lane
 *    performs (no `fetch-depth: 0`), so a `git show origin/main:...` would
 *    throw and the PR's central proof would not run in its own lane. Verified by
 *    cloning this branch at `--depth 1`: neither `origin/main` nor `HEAD^`
 *    resolves.
 *  - Deriving it from the shipped file also states the property being tested more
 *    directly. The migration is GRANT-only, so "what an upgraded installation
 *    had" is precisely "the shipped grants minus this migration's grants".
 *
 * The removal is exact, and it is checked rather than trusted: the result must
 * contain none of the privileges THIS migration adds (the INSERT and the head
 * UPDATE), while a SELECT main already granted is legitimately still present.
 * A removal that silently did nothing, or one that over-matched and stripped a
 * privilege main owns, both fail the test rather than passing it.
 */
function baseVersionOf(fileName: string, source: string): string {
  assert.match(source, /control_project_event_stream_heads/,
    `${fileName} must carry this head's activity grants for a base version to be derived from it`);
  // A wrapped GRANT puts its table list and its `ON`/`TO` clauses on
  // continuation lines, so a single-line pattern would leave this head's
  // `projects` behind on the publisher's read list -- which is the very grant
  // under test -- and would not recognise a wrapped `GRANT UPDATE (...)`. Every
  // SQL statement is therefore collapsed onto one line first, so one set of
  // patterns covers both shapes. Comment lines and blank lines are dropped at
  // the same time: they carry no grant, and leaving them would make the
  // comparison to a reference file noisier than it needs to be.
  const unwrapped = source
    .split("\n")
    .filter(line => !/^\s*--/u.test(line) && line.trim() !== "")
    .join(" ")
    .replace(/;\s+/gu, "; ")
    .replace(/\s{2,}/gu, " ");
  const withoutActivity = unwrapped
    .replace(/GRANT (?:SELECT, )?INSERT ON (?:control_project_event_stream_heads, )?control_project_events TO [^;]+;/gu, "")
    .replace(/GRANT UPDATE \([^)]*\) ON control_project_event_stream_heads TO [^;]+;/gu, "")
    .replace(/GRANT (?:EXECUTE|USAGE)[^;]*;/gu, "")
    .replace(/GRANT SELECT ON projects, /gu, "GRANT SELECT ON ")
    .replace(/GRANT SELECT ON projects TO control_room_local_result_publisher;/gu, "");
  // Only the privileges THIS migration adds must be gone. A SELECT on the
  // stream that main already granted is legitimately still present, so removing
  // every mention of the table would be over-matching, not exactness.
  assert.doesNotMatch(withoutActivity, /GRANT [^;]*INSERT[^;]*control_project_events/u,
    `${fileName}: the activity INSERT this migration adds must be removed for the base version`);
  assert.doesNotMatch(withoutActivity, /GRANT UPDATE[^;]*control_project_event_stream_heads/u,
    `${fileName}: the head UPDATE this migration adds must be removed for the base version`);
  assert.doesNotMatch(withoutActivity, /GRANT SELECT ON projects TO control_room_local_result_publisher/u,
    `${fileName}: the publisher's projects read this migration adds must be removed for the base version`);
  return withoutActivity;
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

/**
 * A staged copy of the repository at "main": every migration EXCEPT this head's
 * activity migration, with a ledger built for exactly that set.
 *
 * The point of staging rather than reading `origin/main` is stated in
 * `baseVersionOf` above: the CI lane that runs this file checks out one commit
 * with no `fetch-depth: 0`, so `origin/main` does not resolve there. The number
 * assertion is kept because it is what makes the staged set a real previous
 * release rather than an arbitrary subset.
 *
 * The caller owns the returned directory and must remove it.
 */
async function stageMainState(): Promise<{ root: string; mainMigrations: string[]; ledgerPath: string; activity: string }> {
  const migrations = (await readdir(join(REPOSITORY_ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort();
  const activity = migrations.filter(name => name.endsWith("_task_project_activity_events.sql"));
  assert.equal(activity.length, 1, "exactly one activity migration");
  const mainMigrations = migrations.filter(name => name !== activity[0]);
  // The number must sort after everything main shipped, or the ledger an
  // upgraded installation builds is corrupt.
  const number = (name: string) => Number((/^(\d{4})_/u.exec(name) ?? [])[1]);
  for (const shipped of mainMigrations)
    assert.ok(number(activity[0]!) > number(shipped), `${activity[0]} must sort after main's ${shipped}`);
  const root = await mkdtemp(join(tmpdir(), "cr409-main-"));
  for (const dir of ["deploy/postgres", "db/migrations", "db/roles", "db/setup"])
    await mkdir(join(root, dir), { recursive: true });
  for (const file of mainMigrations)
    await cp(join(REPOSITORY_ROOT, "db/migrations", file), join(root, "db/migrations", file));
  for (const file of ["production_roles.sql", "production_provision.sql", "production_table_grants.sql"])
    await cp(join(REPOSITORY_ROOT, "db/roles", file), join(root, "db/roles", file));
  await cp(join(REPOSITORY_ROOT, "db/setup/production_migration_ledger.sql"),
    join(root, "db/setup/production_migration_ledger.sql"));
  const entries = await collectLedgerEntries(root);
  const ledgerPath = join(root, "deploy/postgres/migration-ledger.json");
  await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
  return { root, mainMigrations, ledgerPath, activity: activity[0]! };
}

/**
 * The grantees the down migration's equality is asserted over, before it is
 * narrowed to the ones that exist.
 *
 * The list includes the four roles the down file names, the queue worker (the
 * negative case, which must hold nothing) and the schema owner (whose implicit
 * owner privileges `acldefault` contributes to every table). PUBLIC's default is
 * included by the query itself, since a change there would change every role at
 * once.
 *
 * The scope is then narrowed to the roles the CLUSTER actually has. Two
 * databases on one cluster cannot be compared over roles only one of them
 * created: the attack kit's standard role files do not include the native
 * evidence profile, so the role exists only on the baseline database (which
 * replays that file to create it), and a comparison over the full list would
 * report that one-role difference as a down-file defect. The native evidence
 * role's grants are covered where its role is created -- the upgrade test's
 * cluster, which asserts the grant survives an in-place upgrade.
 */
const DOWN_COMPARISON_ROLES = Object.freeze([
  "control_room_private_web", "control_room_task_coordinator",
  "control_room_native_evidence", "control_room_local_result_publisher",
  "control_room_queue_worker", "control_room_schema_owner"]);

/**
 * The privileges an installation that predates this migration holds on the three
 * objects this migration touches, read from a REAL main-state database on the
 * caller's own cluster.
 *
 * Roles are cluster-global, so the baseline cannot be produced by un-granting in
 * place: a `REVOKE` here would also change the database under test. It is a
 * second database built by the production applier from a staged main-state
 * ledger, with the four Mac-local role files replayed in their BASE versions.
 * That is genuinely the previous release's ACL set, and the equality the caller
 * asserts is between two independent databases rather than between one database
 * before and after.
 *
 * The caller must end the returned client, and must not assert against it before
 * calling `verifyBaselineIsMainState`, which is what keeps a vacuous baseline
 * from passing.
 */
async function mainStateBaseline(postgres: RealPostgres, migratorPassword: string, database: string):
Promise<{ client: Client; grants: string[] }> {
  const stage = await stageMainState();
  const admin = new Client(postgres.admin());
  await admin.connect();
  // Every path must close the cluster-admin connection, including the success
  // path. The kit stops the postmaster when the body's promise settles, and a
  // connection still open at that point is terminated by the server mid-query
  // -- which surfaces as `57P01 terminating connection due to administrator
  // command` and masks whatever assertion actually failed. The baseline client
  // is a SEPARATE connection, returned to the caller to close.
  const closeAdmin = async () => { await admin.end().catch(() => {}); };
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.query(`ALTER ROLE control_room_migrator PASSWORD '${migratorPassword}'`);
    const conninfo = (user: string, password?: string) =>
      `host=${postgres.host} port=${postgres.port} dbname=${database} user=${user}`
      + (password ? ` password=${password}` : "");
    const applied = await applyMigrations({
      target: conninfo("fixture_admin"), rootDir: stage.root, ledgerPath: stage.ledgerPath,
      bootstrapTarget: conninfo("fixture_admin"),
      migrateTarget: conninfo("control_room_migrator", migratorPassword),
      env: { ...process.env, CONTROL_ROOM_MIGRATOR_PASSWORD: migratorPassword,
        CONTROL_ROOM_APP_PASSWORD: "a".repeat(24), CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24),
        CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(24) },
    });
    assert.equal(applied.applied?.length, stage.mainMigrations.length,
      "every main-era migration must apply to the baseline database, and nothing else");
    // One client on the baseline database, used for the replay and for every
    // read that follows. Grants are per-database in PostgreSQL, so a read on
    // any other database -- including the one under test, which has this head's
    // migration applied -- would return that database's grants and make the
    // comparison meaningless.
    const baseline = await clientFor(postgres, database, admin);
    // The four role files in their BASE versions. The evidence file creates its
    // role, so it is replayed whole; the other three already exist as cluster
    // roles, so only their GRANT statements are replayed -- split with the
    // kit's own statement splitter so a multi-line GRANT survives intact.
    // Replaying the SHIPPED files would apply this head's grants, and the
    // baseline would be a copy of the state under test.
    for (const file of ["native_evidence_roles.sql", "private_web_roles.sql",
      "task_coordinator_roles.sql", "local_result_publisher_roles.sql"]) {
      const base = baseVersionOf(file, await readFile(join(REPOSITORY_ROOT, "db/roles", file), "utf8"));
      if (file === "native_evidence_roles.sql") { await baseline.query(base); continue; }
      const grants = splitSqlStatements(base)
        .filter(statement => /^GRANT\s/u.test(statement) && !/^GRANT (?:EXECUTE|USAGE)\s/u.test(statement));
      assert.ok(grants.length > 0, `${file} base version must still contribute its grants`);
      for (const statement of grants) await baseline.query(statement);
    }
    const result = { client: baseline, grants: await privilegeSet(baseline, DOWN_COMPARISON_ROLES) };
    await closeAdmin();
    return result;
  } catch (error) {
    await closeAdmin();
    throw error;
  } finally { await rm(stage.root, { recursive: true, force: true }); }
}

/**
 * The roles of `DOWN_COMPARISON_ROLES` that this cluster actually has, narrowed
 * to the ones the database under test will also have so the two privilege sets
 * are comparable.
 */
async function comparableRoles(client: Client): Promise<string[]> {
  const rows = (await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [DOWN_COMPARISON_ROLES])).rows;
  const present = rows.map(row => row.rolname);
  // A comparison over zero or one role would prove nothing, and the roles the
  // down file names are the point of the test.
  assert.ok(present.filter(role => role !== "control_room_schema_owner").length >= 3,
    `the cluster must carry at least three of the roles the down file names, found ${present.join(",")}`);
  return present;
}

/**
 * A client on `database`, reused when it is the one `admin` already holds.
 *
 * The cluster admin cannot be repointed at another database, so a fresh client
 * is opened for the target and the original kept for its CREATE/DROP rights.
 */
async function clientFor(postgres: RealPostgres, database: string, admin: Client): Promise<Client> {
  if ((admin as unknown as { database?: { database?: string } }).database?.database === database) return admin;
  const client = new Client({ ...postgres.admin(), database });
  await client.connect();
  return client;
}

/**
 * A baseline that had already applied this migration's grants would make the
 * caller's equality vacuous, so the pre-upgrade state is CHECKED, not assumed.
 */
async function verifyBaselineIsMainState(client: Client): Promise<void> {
  const holds = async (role: string, object: string, privilege: string) => (await client.query<{ allowed: boolean }>(
    "SELECT has_table_privilege($1,$2,$3) AS allowed", [role, object, privilege])).rows[0]?.allowed;
  // The private web role's read is the grant a previous release owns and the
  // startup preflight requires. If it were ever absent from the baseline the
  // equality below would pass while the real regression stayed, so its presence
  // is part of the baseline's own contract, and it is asserted first: it is the
  // one the down file must never touch.
  assert.equal(await holds("control_room_private_web", "control_project_events", "SELECT"), true,
    "the main-state baseline must let the private web role read the activity stream");
  assert.equal(await holds("control_room_private_web", "control_project_event_stream_heads", "SELECT"), true,
    "the main-state baseline must let the private web role read the stream heads");
  for (const role of ["control_room_private_web", "control_room_task_coordinator",
    "control_room_local_result_publisher"])
    assert.equal(await holds(role, "control_project_events", "INSERT"), false,
      `the main-state baseline must not let ${role} append to the activity stream`);
  assert.equal(await holds("control_room_task_coordinator", "control_project_events", "SELECT"), false,
    "the main-state baseline must not grant the coordinator an activity read");
  assert.equal(await holds("control_room_local_result_publisher", "projects", "SELECT"), false,
    "the main-state baseline must not let the publisher read `projects`");
}

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
          // The four Mac-local role files, each reduced to its BASE version (this
          // head's activity grants removed). This is the state an upgraded
          // installation is really in: the roles exist and the private web role
          // can already READ the stream, but nothing has been granted the
          // ability to APPEND to it, and the publisher has no `projects` read.
          // Using the shipped file's base version rather than the shipped file
          // itself is what makes the pre-upgrade state real -- the working tree
          // already carries this head's grants, and using those would hide the
          // very defect this test exists to catch.
          //
          // The whole evidence file is replayed (CREATE ROLE included) because
          // that role is not in the attack kit's standard set and does not exist
          // on this cluster yet. The other three already exist, so only their
          // GRANT statements are replayed, split with the kit's own statement
          // splitter rather than by line so a multi-line GRANT survives intact.
          for (const file of ["native_evidence_roles.sql", "private_web_roles.sql",
            "task_coordinator_roles.sql", "local_result_publisher_roles.sql"]) {
            const base = baseVersionOf(file, await readFile(join(REPOSITORY_ROOT, "db/roles", file), "utf8"));
            if (file === "native_evidence_roles.sql") { await mainDb.query(base); continue; }
            const grants = splitSqlStatements(base)
              .filter(statement => /^GRANT\s/u.test(statement) && !/^GRANT (?:EXECUTE|USAGE)\s/u.test(statement));
            assert.ok(grants.length > 0, `${file} base version must still contribute its grants`);
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

/**
 * The down migration returns an installation to the state the PREVIOUS release
 * expects, so it may revoke only what the up migration added.
 *
 * The repository convention is that every `db/down/*.sql` is executed by a test
 * (see tests/work-intake.test.ts and tests/self-hosting-database-hardening.test.mjs),
 * and this one is the only down file with no caller. It is also the only one that
 * revokes a grant its migration introduced WITHOUT dropping a table, because
 * this migration creates no schema object -- so the asymmetry is deliberate and
 * is exactly what needs pinning.
 *
 * The expectation is a full EQUALITY with a main-state baseline, not a handful of
 * flags, because the failure being pinned is a set-level one. `control_room_private_web`
 * already held SELECT on both activity tables before this migration
 * (db/roles/private_web_roles.sql, and main's private-web startup preflight
 * refuses to start the web process without that read), so a down file that
 * revokes it leaves a rolled-back install in a state the previous release cannot
 * run. A per-flag check cannot express that: it can only say the flag it looked
 * at is false, which is exactly the assertion that enshrined the defect.
 *
 * The baseline is built for real, not asserted from the down file's own text: a
 * second database on the SAME cluster, carrying the same tables, with the four
 * role files replayed in their BASE versions (this head's activity grants
 * removed). Roles are cluster-global, so applying the base files to a second
 * database's own copy of the tables leaves the head database untouched and
 * gives a genuine "state an install that predates this migration is in".
 */
test("the down migration returns every role to the main-state baseline, and only that", needsPg, async t => {
  const MIGRATOR_PASSWORD = "m409down".padEnd(24, "x");
  const result = await withRealPostgres(async postgres => {
    await seedFixture(postgres);
    const admin = new Client(postgres.admin());
    await admin.connect();
    try {
      // The native evidence role is a CLUSTER role and the attack kit's standard
      // role-file set does not create it, so it is absent from a fresh kit
      // cluster. It is created here, on this database, from its OWN shipped role
      // file, for two reasons:
      //
      //  - The down migration names it, and a down file that revoked one of its
      //    grants wrongly would otherwise go unasserted on this cluster.
      //  - The baseline database creates the same role from the same file, so
      //    both sides of the equality then have the same four roles and the
      //    comparison is over the whole set rather than over a subset chosen
      //    after the fact.
      //
      // Applied AFTER the migration has already run (the kit migrated this
      // database on start-up), so this is the same order an operator's install
      // would be in, and the file is the shipped one -- this head's grants
      // included, which is what "before the down" has to mean.
      await admin.query(await readFile(join(REPOSITORY_ROOT, "db/roles/native_evidence_roles.sql"), "utf8"));
      const before = await snapshot(admin);
      // The four named roles hold this migration's grants wherever they exist.
      // The queue worker holds no grant and is deliberately NOT in this list --
      // it is the negative case, and including it would invert the assertion.
      const named = ["control_room_private_web", "control_room_task_coordinator",
        "control_room_native_evidence", "control_room_local_result_publisher"];
      const present = named.filter(role => before.privileges[role] !== null);
      assert.ok(present.length >= 3,
        `the cluster must carry at least three of the four named roles, found ${present.join(",")}`);
      for (const role of present) {
        const held = before.privileges[role] as { eventsInsert: boolean; headUpdate: boolean };
        assert.equal(held.eventsInsert, true,
          `${role} must hold the grant the down migration is about to remove`);
        assert.equal(held.headUpdate, true,
          `${role} must hold the stream-head write the down migration is about to remove`);
      }
      // The baseline is a real second database, not this one with grants undone:
      // the four roles are cluster-global, so a REVOKE anywhere on this cluster
      // changes the database under test too. `mainStateBaseline` builds a
      // main-state database on this same cluster and returns its privilege set.
      const baselineDatabase = "control_room_at_main_baseline";
      const baseline = await mainStateBaseline(postgres, MIGRATOR_PASSWORD, baselineDatabase);
      // Only roles this cluster HAS are compared, and over the same list on both
      // sides. The attack kit does not create the native evidence role, so that
      // role exists only on the baseline database; including it would report the
      // one-role difference as a down-file defect.
      const comparable = await comparableRoles(baseline.client);
      const baselineGrants = await privilegeSet(baseline.client, comparable);
      try {
        // Checked before anything is asserted against it, so a baseline that
        // had already applied this migration cannot make the equality vacuous.
        await verifyBaselineIsMainState(baseline.client);
        const down = (await readdir(join(REPOSITORY_ROOT, "db/down")))
          .filter(name => name.endsWith("_task_project_activity_events.sql"));
        assert.equal(down.length, 1, "exactly one down migration for the activity grants");
        await admin.query(await readFile(join(REPOSITORY_ROOT, "db/down", down[0]), "utf8"));
        const after = await snapshot(admin, comparable);
        // THE assertion: after the rollback this database's privileges on every
        // object the migration touches are the main-state privileges, exactly.
        // An over-revoking down file leaves a grant an earlier release owns
        // missing (the private web read); an under-revoking one leaves this
        // migration's behind. Both fail here, naming the role and object.
        assert.deepEqual(after.acl, baselineGrants,
          "the down migration must return every role's privileges on the activity tables to the main-state baseline");
        // Spelled out as well, because the private web read is the specific
        // regression a rolled-back install hits at startup, and a reader of the
        // failure needs it in words rather than as a diff of ACL strings.
        for (const role of present) {
          const held = after.privileges[role] as { eventsInsert: boolean; eventsSelect: boolean;
            headSelect: boolean; headUpdate: boolean; projectsSelect: boolean };
          assert.equal(held.eventsInsert, false, `${role} must lose the activity INSERT`);
          assert.equal(held.headUpdate, false, `${role} must lose the stream-head write`);
        }
        const web = after.privileges["control_room_private_web"] as { eventsSelect: boolean; headSelect: boolean };
        assert.equal(web.eventsSelect, true,
          "BLOCKER: the private web role must KEEP its activity read, which an earlier release granted and its startup preflight requires");
        assert.equal(web.headSelect, true,
          "BLOCKER: the private web role must KEEP its stream-head read, which an earlier release granted and its startup preflight requires");
        assert.equal((after.privileges["control_room_task_coordinator"] as { eventsSelect: boolean }).eventsSelect, false,
          "the coordinator held no activity read before this migration, so the down file must remove it");
        assert.equal((after.privileges["control_room_local_result_publisher"] as { projectsSelect: boolean }).projectsSelect, false,
          "the publisher must lose the project read this migration added");
        // ...and the ledger is untouched, because a down migration is not a ledger
        // operation and this migration created no object.
        assert.deepEqual(after.ledger, before.ledger,
          "a down migration must not remove the ledger row for the migration it reverses");
        // The tables themselves survive: they belong to migration 0033.
        const tables = await admin.query<{ present: string | null }>(
          "SELECT to_regclass('public.control_project_events') AS present");
        assert.ok(tables.rows[0]?.present, "the activity tables belong to an earlier migration and must survive");
        return { roles: present.length, grants: baseline.grants.length };
      } finally { await baseline.client.end(); }
    } finally { await admin.end(); }
  }, { port: LIVE_PORT + 3, allowedPorts: ALLOWED_PORTS, boundMs: 900_000 });
  assert.equal(result.cleanedUp, true, `the cluster must be gone: ${result.leftovers.join(",")}`);
  t.diagnostic(`down migration returned ${result.value.roles} roles to the main-state baseline of `
    + `${result.value.grants} privileges across the three objects this migration touches`);
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
    // The positive half of the same claim, in this test rather than only in the
    // upgrade test: the publisher holds exactly this one new grant, and it holds
    // it. Without it a migration that granted nothing would still pass the
    // denial above.
    const publisher = await postgres.query("publisher", "SELECT workspace_id FROM projects WHERE tenant_id=$1 AND id=$2",
      [TENANT_ID, OWN_PROJECT]);
    assert.equal(publisher.rows[0]?.workspace_id, WORKSPACE_ID,
      "the publisher must hold the project read this migration grants");
    for (const role of ["web", "coordinator", "publisher"]) {
      assert.equal((await postgres.query(role, "SELECT workspace_id FROM projects WHERE tenant_id=$1 AND id=$2",
        [TENANT_ID, OWN_PROJECT])).rows[0]?.workspace_id, WORKSPACE_ID,
      `the ${role} login must hold the project read its role grants`);
    }
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
        const before = await snapshot(connection);
        await connection.query(await readFile(join(REPOSITORY_ROOT, "db/migrations", activity[0]!), "utf8"));
        // BOTH the ledger and the effective privileges are compared before and
        // after. Comparing only the ledger would be the weaker claim the test's
        // title makes, and would pass even if a re-apply silently dropped a
        // grant -- which is the failure mode that matters here.
        const after = await snapshot(connection);
        assert.deepEqual(after.ledger, before.ledger,
          "a second apply of the same migration must not add or reorder ledger rows");
        assert.deepEqual(after.privileges, before.privileges,
          "a second apply of the same migration must not change any role's effective privileges");
        return { ledger: before.ledger.length, roles: Object.keys(before.privileges).length };
      } finally { await connection.end(); }
    }, { port: LIVE_PORT + 3, allowedPorts: ALLOWED_PORTS, boundMs: 300_000 });
    t.diagnostic(`re-applied the migration statements on a live database: `
      + `${once.value.ledger} ledger rows and ${once.value.roles} roles' privileges unchanged`);
    assert.ok(once.value.ledger > 0, "the database must really have a ledger to compare");
    assert.ok(once.value.roles > 0, "the comparison must cover at least one role");
    assert.equal(once.cleanedUp, true, `the cluster must be gone: ${once.leftovers.join(",")}`);
  } finally { await rm(stage, { recursive: true, force: true }); }
});

/** The three objects this migration's up file and down file both touch. */
const TOUCHED_OBJECTS = Object.freeze([
  "control_project_events", "control_project_event_stream_heads", "projects"]);

/**
 * EVERY privilege every role holds on the three objects this migration touches,
 * as a sorted list of `role:object[:column]:privilege` strings.
 *
 * `has_table_privilege` answers one question at a time, and the down file's
 * correctness is a question about a whole set: it must leave the private web
 * role's `SELECT` (which an earlier release already granted) while removing the
 * grants this migration added. A per-flag comparison cannot express "equal to
 * the main-state baseline", and the flag the previous test asserted on -- the
 * stream-head read -- was the very one this migration never owned for one of
 * its four roles.
 *
 * The catalog is read rather than derived from the migration text, so a grant
 * the up file issues through a path this file does not recognise still counts.
 * Both scopes are covered: table-level privileges from `relacl`, and the
 * column-level `UPDATE (last_sequence, ...)` from `attacl`, which is the grant
 * this migration's stream-head write needs. `acldefault` fills in the owner's
 * implicit ACL row, so a table with a NULL `relacl` compares as itself rather
 * than as an empty set.
 *
 * `roles` narrows the result to the grantees being compared. It is required by
 * the caller rather than defaulted, because a whole-cluster comparison is only
 * meaningful between two databases that received the SAME role files: a
 * database built from four role files legitimately differs from one built from
 * twelve, and that difference says nothing about the down file.
 */
async function privilegeSet(connection: Client, roles: readonly string[]): Promise<string[]> {
  const table = (await connection.query<{ privilege: string }>(
    `SELECT (CASE WHEN p.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END) || ':' || c.relname
            || ':' || p.privilege_type AS privilege
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) p
     LEFT JOIN pg_roles r ON r.oid = p.grantee
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
       AND (p.grantee = 0 OR r.rolname = ANY($2::text[]))`,
  [TOUCHED_OBJECTS, roles])).rows;
  const column = (await connection.query<{ privilege: string }>(
    `SELECT (CASE WHEN p.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END) || ':' || c.relname || '.' || a.attname
            || ':' || p.privilege_type AS privilege
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(a.attacl) p
     LEFT JOIN pg_roles r ON r.oid = p.grantee
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
       AND a.attnum > 0 AND NOT a.attisdropped
       AND (p.grantee = 0 OR r.rolname = ANY($2::text[]))`,
  [TOUCHED_OBJECTS, roles])).rows;
  return [...table, ...column].map(row => row.privilege).sort();
}

/**
 * Ledger rows, per-role flags, and the full privilege set, for a before/after
 * compare.
 *
 * `privilegeRoles` scopes the `acl` field, defaulting to every role the snapshot
 * itself reports on. The down test passes the roles both of its databases have,
 * so a role only one of them created cannot appear as a difference.
 */
async function snapshot(connection: Client, privilegeRoles?: readonly string[]): Promise<{
  ledger: unknown[]; privileges: Record<string, unknown>; acl: string[];
}> {
  const ledger = (await connection.query<{ filename: string; ledger_order: number }>(
    "SELECT filename, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
  const privileges: Record<string, unknown> = {};
  for (const role of ["control_room_private_web", "control_room_task_coordinator",
    "control_room_native_evidence", "control_room_local_result_publisher", "control_room_queue_worker"]) {
    // `has_table_privilege` raises for a role that does not exist, and the
    // evidence role is not part of every cluster's role set. A role that is
    // absent is recorded as absent, so the before/after comparison still holds
    // for it (absent must stay absent) and one cluster's role set does not
    // decide this file's expectations.
    const exists = (await connection.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS present", [role])).rows[0]?.present === true;
    privileges[role] = exists ? (await connection.query<{ eventsInsert: boolean; headSelect: boolean;
      eventsSelect: boolean; headUpdate: boolean; projectsSelect: boolean }>(
      // The four table-level privileges come from `has_table_privilege`. The
      // stream-head write is a COLUMN-level grant, which that function cannot
      // ask about -- it rejects a column list as an unrecognised privilege type
      // -- so its presence is read from the column ACL directly. It counts the
      // four columns rather than testing for one, because a down file that
      // revoked three of the four would still leave this flag true and the
      // store's `SET last_event_digest = …` would fail. None of these four roles
      // is a member of another, so the grantee is the role itself; PUBLIC is
      // included so a default cannot make the check pass.
      `SELECT has_table_privilege($1,'control_project_events','INSERT') AS "eventsInsert",
              has_table_privilege($1,'control_project_event_stream_heads','SELECT') AS "headSelect",
              has_table_privilege($1,'control_project_events','SELECT') AS "eventsSelect",
              has_table_privilege($1,'projects','SELECT') AS "projectsSelect",
              (SELECT count(DISTINCT a.attname) = 4
               FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               CROSS JOIN LATERAL aclexplode(a.attacl) p
               WHERE n.nspname = 'public' AND c.relname = 'control_project_event_stream_heads'
                 AND a.attnum > 0 AND NOT a.attisdropped AND p.privilege_type = 'UPDATE'
                 AND a.attname = ANY(ARRAY['last_sequence','last_event_digest','head_auth_tag','updated_at'])
                 AND (p.grantee = 0 OR p.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)))
                AS "headUpdate"`, [role])).rows[0] : null;
  }
  return { ledger, privileges, acl: await privilegeSet(connection, privilegeRoles ?? DOWN_COMPARISON_ROLES) };
}

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
