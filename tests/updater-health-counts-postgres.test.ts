// Real-PostgreSQL proof for the updater's health counts: design §8.4 item 2's
// "counts are compared with the updater's own reads", on PostgreSQL 17, run as
// the PRODUCTION logins and never as a superuser for anything under test.
//
// WHAT IS PROVEN, in order:
//
//   1. `public.updater_health_counts()` exists, is SECURITY DEFINER / STABLE /
//      zero-argument, is owned by the release schema owner, pins its
//      search_path, and has exactly ONE non-owner EXECUTE grantee: the updater's
//      login. (db/migrations/0238)
//   2. The updater's login can call it and gets three counts -- and can read
//      NOTHING else. This is the load-bearing claim: granting the deployer SELECT
//      on the release tables would both fail the updater's own startup assertion
//      and hand candidate-controlled rows to the approval authority (R10a).
//   3. The counts match the three real UI reads exactly, seeded through the same
//      predicates those reads use.
//   4. The web login holds INSERT on updater.plan_approvals -- the privilege
//      §8.4 requires reported as `planApprovalInsertAllowed` -- and `false` on a
//      login that does not, so the boolean is a measurement and not a constant.
//   5. Nothing leaks: no name, id, path, payload or row crosses the boundary.
//   6. The unhappy paths: no binding row, a second tenant's rows, a second
//      workspace, a hostile caller with a different search_path, and the down
//      migration.
//   7. Load: 50 concurrent callers, plus a burst against a single connection
//      pool, agree on the same counts and leak no connections.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { applyUpdaterSchemaV1 } from "../src/updater/v1/schema-installer";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59510), PG = requiresRealPostgres();
let ran = 0;
const needsPg = () => PG ? undefined : { skip: realPostgresSkipMessage() };

const TENANT = "tenant:health-counts", OTHER_TENANT = "tenant:health-counts-other";
const WORKSPACE = "workspace:health-counts", OTHER_WORKSPACE = "workspace:health-counts-other";
const OWNER = "identity:health-counts-owner";
const DIGEST = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
/** The adapter id the web derives for this scope, computed the way the code does. */
const manualAdapter = (tenantId: string, workspaceId: string) =>
  `adapter:manual:${createHash("sha256").update(
    `{"tenantId":"${tenantId}","workspaceId":"${workspaceId}"}`, "utf8").digest("hex").slice(0, 32)}`;
const ADAPTER = manualAdapter(TENANT, WORKSPACE);
const DEPLOYER_PASSWORD = "fixture-health-deployer";
const MIGRATION = join(process.cwd(), "db/migrations/0238_updater_health_counts.sql");
const DOWN = join(process.cwd(), "db/down/0238_updater_health_counts.sql");

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];

/** Fixture rows only, as the superuser, with triggers disabled the documented way. */
async function seed<T extends Record<string, unknown>>(postgres: Postgres, sql: string, params: unknown[] = []) {
  const client = new Client(postgres.admin() as never);
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    return (await client.query<T>(sql, params as never[])).rows;
  } finally { await client.end(); }
}

async function refuses(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  try { await client.query(sql, params as never[]); }
  catch (error) {
    const { code, message } = error as { code?: string; message: string };
    assert.equal(typeof code, "string", `refusal carried no SQLSTATE: ${message}`);
    return `${code} ${message.split("\n")[0]}`;
  }
  assert.fail(`statement was not refused: ${sql.slice(0, 120)}`);
}

/** The tenant, its workspace, the singleton binding row, and the manual adapter
 * row `projects.adapter_id` must reference. Every column name here is read from
 * db/migrations/0001_control_room_core.sql and 0003_canonical_domain_delivery.sql,
 * not from memory: an invented column name here would make the lane fail for a
 * reason that has nothing to do with the boundary under test. */
async function seedScope(postgres: Postgres, tenantId: string, workspaceId: string, bind: boolean) {
  const now = new Date().toISOString();
  await seed(postgres, `INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [tenantId]);
  await seed(postgres, `INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Count fixture')
    ON CONFLICT DO NOTHING`, [workspaceId, tenantId]);
  await seed(postgres, `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)
    ON CONFLICT DO NOTHING`, [`identity:${tenantId}`, tenantId, DIGEST(tenantId), now]);
  if (bind) await seed(postgres, `INSERT INTO work_intake_tenant_binding(singleton,tenant_id)
    VALUES(true,$1) ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id`, [tenantId]);
  await seed(postgres, `INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,
    redaction_policy_version,cursor_retention_days,created_at,updated_at)
    VALUES($1,$2,'manual','v1','control_room_native','v1',30,$3,$3) ON CONFLICT DO NOTHING`,
  [manualAdapter(tenantId, workspaceId), tenantId, now]);
}

/** One manual project, wired so every read above can see it. */
async function seedProject(postgres: Postgres, id: string, tenantId: string, workspaceId: string) {
  const now = new Date().toISOString();
  await seed(postgres, `INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
    title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$5,'ready','manual_project_ready','healthy','control_room_native',$6,'{}'::jsonb,$6)`,
  [id, tenantId, workspaceId, manualAdapter(tenantId, workspaceId), id, now]);
  await seed(postgres, `INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,
    created_at,updated_at) VALUES($1,$2,'active',1,$3,$3) ON CONFLICT DO NOTHING`, [tenantId, id, now]);
}

/** One request, its workflow, and one job in the given state -- the lineage the
 * UI's three-table join requires. */
async function seedActiveJob(postgres: Postgres, id: string, tenantId: string, projectId: string, state: string) {
  const now = new Date().toISOString();
  await seed(postgres, `INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,
    created_at,updated_at) VALUES($1,$2,$3,'submitted',1,$4,'{}'::jsonb,$5,$5) ON CONFLICT DO NOTHING`,
  [`request:${id}`, tenantId, projectId, `idem:${id}`, now]);
  await seed(postgres, `INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,
    version,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',1,'{}'::jsonb,$6,$6) ON CONFLICT DO NOTHING`,
  [`workflow:${id}`, tenantId, `request:${id}`, projectId, DIGEST(`workflow:${id}`), now]);
  await seed(postgres, `INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
    required_capability,authority_digest,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,1,50,'general',$6,'{}'::jsonb,$7,$7) ON CONFLICT DO NOTHING`,
  [id, tenantId, `workflow:${id}`, projectId, state, DIGEST(`authority:${id}`), now]);
}

/** One ready update candidate -- the Updates panel's row. The pipeline lineage
 * is seeded because `session_replication_role = replica` disables TRIGGERS but
 * not foreign keys, and every one of these is RESTRICT. */
async function seedCandidate(postgres: Postgres, id: string, tenantId: string, projectId: string) {
  const now = new Date().toISOString(), requestId = `request:${id}`;
  await seed(postgres, `INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,
    created_at,updated_at) VALUES($1,$2,$3,'submitted',1,$4,'{}'::jsonb,$5,$5) ON CONFLICT DO NOTHING`,
  [requestId, tenantId, projectId, `idem:${id}`, now]);
  await seed(postgres, `INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,
    version,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',1,'{}'::jsonb,$6,$6) ON CONFLICT DO NOTHING`,
  [`workflow:${id}`, tenantId, requestId, projectId, DIGEST(`workflow:${id}`), now]);
  await seed(postgres, `INSERT INTO pipeline_templates(id,tenant_id,project_id,name,description,stages,max_stages,
    max_total_loops,max_duration_seconds,record_digest,auth_tag,version,created_at)
    VALUES($1,$2,$3,'fixture','fixture','[]'::jsonb,1,0,600,$4,$5,1,$6) ON CONFLICT DO NOTHING`,
  [`template:${id}`, tenantId, projectId, DIGEST(`template:${id}`), `hmac-sha256:${"d".repeat(64)}`, now]);
  await seed(postgres, `INSERT INTO pipeline_runs(id,tenant_id,project_id,request_id,template_id,template_version,
    template_digest,workflow_id,title,state,updated_at,record_digest,auth_tag,version)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,'fixture','succeeded',$8,$9,$10,1) ON CONFLICT DO NOTHING`,
  [`run:${id}`, tenantId, projectId, requestId, `template:${id}`, DIGEST(`template:${id}`), `workflow:${id}`, now,
    DIGEST(`run:${id}`), `hmac-sha256:${"e".repeat(64)}`]);
  await seed(postgres, `INSERT INTO control_improvement_requests(tenant_id,id,project_id,description,
    pipeline_template_id,pipeline_template_version,pipeline_template_digest,selected_worker_ids,lead_worker_id,
    pipeline_run_id,owner_identity_id,idempotency_key,request_digest,record_digest,auth_tag,created_at)
    VALUES($1,$2,$3,'fixture',$4,1,$5,'[]'::jsonb,'worker:fixture',$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT DO NOTHING`, [tenantId, `improvement:${id}`, projectId, `template:${id}`, DIGEST(`template:${id}`),
    `run:${id}`, `identity:${tenantId}`, `idem:${id}`, DIGEST(`request:${id}`), DIGEST(`record:${id}`),
    `hmac-sha256:${"f".repeat(64)}`, now]);
  await seed(postgres, `INSERT INTO control_update_candidates(tenant_id,id,project_id,improvement_request_id,
    pipeline_run_id,base_revision,candidate_revision,summary,changed_areas,test_results,database_changes,
    lead_worker_id,state,version,record_digest,auth_tag,created_at)
    VALUES($1,$2,$3,$4,$5,repeat('a',40),repeat('b',40),'fixture','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,
      'worker:fixture','ready',1,$6,$7,$8) ON CONFLICT DO NOTHING`, [tenantId, id, projectId,
    `improvement:${id}`, `run:${id}`, DIGEST(`candidate:${id}`), `hmac-sha256:${"c".repeat(64)}`, now]);
}

/** Install the updater's own schema, then apply this job's migration as the schema owner. */
async function installUpdaterSchema(postgres: Postgres) {
  const bootstrap = new Client({ ...postgres.admin(), user: "fixture_admin" } as never);
  await bootstrap.connect();
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port, user: "control_room_migrator",
    password: (postgres.connection("migrator") as { password: string }).password, database: postgres.database });
  await owner.connect();
  let deployer: Client | undefined;
  try {
    const result = await applyUpdaterSchemaV1({ bootstrap, directory: join(process.cwd(), "src/updater/v1/ddl"),
      deployerHasFixturePassword: true, connectDeployer: async () => {
        await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8"));
        await bootstrap.query(`ALTER ROLE control_room_deployer PASSWORD '${DEPLOYER_PASSWORD}'`);
        deployer = new Client({ host: postgres.socketDirectory, port: postgres.port,
          user: "control_room_deployer", password: DEPLOYER_PASSWORD, database: postgres.database });
        await deployer.connect();
        return deployer;
      } });
    // The migration is a RELEASE migration: it is applied by the schema owner,
    // which is the migrator login the installer and the live upgrade use.
    await owner.query(await readFile(MIGRATION, "utf8"));
    return result;
  } finally {
    await deployer?.end().catch(() => {});
    await owner.end().catch(() => {});
    await bootstrap.end();
  }
}

/** The updater's login. Everything it can do is what §8.4 gives it. */
async function asUpdater(postgres: Postgres): Promise<Client> {
  const client = new Client({ host: postgres.socketDirectory, port: postgres.port, user: "control_room_deployer",
    password: DEPLOYER_PASSWORD, database: postgres.database });
  await client.connect();
  return client;
}

/** The production web login, which §8.4's privilege boolean is about. */
async function asWeb(postgres: Postgres): Promise<Client> {
  const client = new Client({ host: postgres.socketDirectory, port: postgres.port, user: "control_room_web",
    password: (postgres.connection("web") as { password: string }).password, database: postgres.database });
  await client.connect();
  return client;
}

test("the updater's health counts are the updater's ONLY new reach, and it reads no row", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await seedScope(postgres, TENANT, WORKSPACE, true);
    await seedScope(postgres, OTHER_TENANT, OTHER_WORKSPACE, false);
    await installUpdaterSchema(postgres);

    // (1) The function's shape, read from the catalog rather than from the SQL text.
    const owner = new Client(postgres.admin() as never);
    await owner.connect();
    const shape = await owner.query<{ prosecdef: boolean; provolatile: string; pronargs: number; owner: string;
      search_path: string[]; column_names: string[] }>(`
      SELECT p.prosecdef, p.provolatile, p.pronargs, pg_get_userbyid(p.proowner) AS owner,
        p.proconfig AS search_path,
        (SELECT array_agg(a.attname ORDER BY a.attnum) FROM pg_attribute a
          WHERE a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped) AS column_names
      FROM pg_proc p WHERE p.oid = 'public.updater_health_counts()'::regprocedure`);
    const fn = shape.rows[0]!;
    assert.equal(fn.prosecdef, true, "it must run as the schema owner");
    assert.equal(fn.provolatile, "s", "it must be STABLE");
    assert.equal(fn.pronargs, 0, "no caller-chosen scope exists at all");
    assert.equal(fn.owner, "control_room_schema_owner");
    assert.deepEqual(fn.search_path, ["search_path=pg_catalog, public, pg_temp"]);
    assert.deepEqual(fn.column_names, ["home_summary_count", "project_count", "updates_panel_count"],
      "three counts, nothing else: no name, id, path or payload column exists");

    // Exactly one non-owner grantee, and it is the updater.
    const grantees = await owner.query<{ grantee: string; grantable: boolean }>(`
      SELECT pg_get_userbyid(a.grantee) AS grantee, a.is_grantable AS grantable
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = 'public.updater_health_counts()'::regprocedure AND a.privilege_type = 'EXECUTE'
        AND a.grantee <> p.proowner`);
    assert.deepEqual(grantees.rows, [{ grantee: "control_room_deployer", grantable: false }],
      "the updater's login is the only caller, and cannot pass EXECUTE on");
    assert.equal((await owner.query<{ allowed: boolean }>(
      `SELECT has_function_privilege('public','public.updater_health_counts()','EXECUTE') AS allowed`)).rows[0]!.allowed,
      false, "PUBLIC holds no EXECUTE");
    await owner.end();

    // (2) The updater can call it...
    const updater = await asUpdater(postgres);
    try {
      const counts = (await updater.query<{ home_summary_count: string; project_count: string;
        updates_panel_count: string }>("SELECT * FROM public.updater_health_counts()")).rows[0]!;
      assert.deepEqual(Object.keys(counts).sort(), ["home_summary_count", "project_count", "updates_panel_count"]);
      for (const value of Object.values(counts)) assert.match(String(value), /^\d+$/u);

      // ...and can read NOTHING else in `public`. This is the claim that makes a
      // function the right shape here: a grant on the tables would both fail the
      // updater's own startup assertion (schema-installer.ts) and hand
      // candidate-controlled rows to the approval authority.
      const reach = await updater.query<{ tables: string[] }>(`
        SELECT coalesce(array_agg(DISTINCT c.relname) FILTER (WHERE c.relname <> 'control_web_sessions'
          AND c.relname <> 'control_identities' AND c.relname <> 'control_role_grants'), ARRAY[]::text[]) AS tables
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                 AND (has_column_privilege(current_user, c.oid, a.attname, 'SELECT')
                   OR has_column_privilege(current_user, c.oid, a.attname, 'INSERT')
                   OR has_column_privilege(current_user, c.oid, a.attname, 'UPDATE')))
            OR has_table_privilege(current_user, c.oid, 'DELETE')
            OR has_table_privilege(current_user, c.oid, 'TRUNCATE'))`);
      assert.deepEqual(reach.rows[0]!.tables, [],
        "the updater reaches no release table beyond the three the guard needs");

      // And a direct read of each counted table is refused, not merely un-granted.
      for (const statement of ["SELECT count(*) FROM projects", "SELECT count(*) FROM control_update_candidates",
        "SELECT count(*) FROM control_jobs", "SELECT count(*) FROM control_web_sessions"]) {
        assert.match(await refuses(updater, statement), /42501/u, `refused: ${statement}`);
      }
      // Nor can it reach the counted content through the function by asking for
      // something else: the return type has three columns and no arguments.
      assert.match(await refuses(updater, "SELECT * FROM public.updater_health_counts('tenant:other')"), /42883/u);
    } finally { await updater.end(); }

    // (4) The privilege boolean §8.4 asks for, measured on the real web login.
    const web = await asWeb(postgres);
    try {
      const allowed = await web.query<{ allowed: boolean }>(
        `SELECT has_table_privilege(current_user,'updater.plan_approvals','INSERT') AS allowed`);
      assert.equal(allowed.rows[0]!.allowed, true, "the production web login holds INSERT on plan_approvals");
      // And it is a MEASUREMENT: the deployer holds no such privilege, so a
      // composite that returned a constant `true` would still be wrong here.
      const updater = await asUpdater(postgres);
      try {
        assert.match(await refuses(updater, "SELECT has_table_privilege(current_user,'updater.plan_approvals','INSERT')"),
          /0 rows|42501/u);
      } finally { await updater.end(); }
    } finally { await web.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the three counts equal the three real UI reads, and nothing crosses the boundary", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await seedScope(postgres, TENANT, WORKSPACE, true);
    await seedScope(postgres, OTHER_TENANT, OTHER_WORKSPACE, false);
    await installUpdaterSchema(postgres);

    // Three manual projects, two of them listed; three jobs in Home's listed
    // states and one in a state Home does NOT list; two ready candidates.
    await seedProject(postgres, "project:listed-1", TENANT, WORKSPACE);
    await seedProject(postgres, "project:listed-2", TENANT, WORKSPACE);
    await seedProject(postgres, "project:other-tenant", OTHER_TENANT, OTHER_WORKSPACE);
    await seedActiveJob(postgres, "job:leased", TENANT, "project:listed-1", "leased");
    await seedActiveJob(postgres, "job:running", TENANT, "project:listed-1", "running");
    await seedActiveJob(postgres, "job:waiting", TENANT, "project:listed-2", "waiting_approval");
    // A succeeded job is NOT one of Home's three states, so it must not count.
    await seedActiveJob(postgres, "job:succeeded", TENANT, "project:listed-1", "succeeded");
    await seedCandidate(postgres, "candidate:1", TENANT, "project:listed-1");
    await seedCandidate(postgres, "candidate:2", TENANT, "project:listed-2");

    const updater = await asUpdater(postgres);
    try {
      const counts = (await updater.query<{ home_summary_count: string; project_count: string;
        updates_panel_count: string }>("SELECT * FROM public.updater_health_counts()")).rows[0]!;
      assert.equal(Number(counts.project_count), 2, "only the two listed projects, not another tenant's");
      assert.equal(Number(counts.home_summary_count), 3, "the three Home states, not the succeeded one");
      assert.equal(Number(counts.updates_panel_count), 2);

      // (5) Nothing leaks. The whole result is three integers; no identifier from
      // any fixture can appear anywhere in the row.
      const raw = await updater.query("SELECT row_to_json(c) AS row FROM public.updater_health_counts() c");
      const text = JSON.stringify(raw.rows);
      for (const secret of [TENANT, WORKSPACE, OTHER_TENANT, OTHER_WORKSPACE, ADAPTER, "project:listed-1",
        "candidate:1", "job:leased", "fixture", "Owner"]) {
        assert.equal(text.includes(secret), false, `the boundary leaked ${secret}`);
      }
    } finally { await updater.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the count function refuses to be pointed anywhere, and survives a hostile session", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    // (6) No binding row at all: zero rows, closed, not an error and not a guess.
    await seedScope(postgres, TENANT, WORKSPACE, false);
    await installUpdaterSchema(postgres);
    let updater = await asUpdater(postgres);
    try {
      assert.equal((await updater.query("SELECT * FROM public.updater_health_counts()")).rows.length, 0,
        "no binding row means no counts, so §8.4's comparison fails closed");

      await seed(postgres, `INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)
        ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id`, [TENANT]);
      // A SECOND workspace for the bound tenant: the shape is not one row, so the
      // function yields nothing rather than multiplying every count.
      await seed(postgres, `INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Second')
        ON CONFLICT DO NOTHING`, ["workspace:health-counts-second", TENANT]);
      assert.equal((await updater.query("SELECT * FROM public.updater_health_counts()")).rows.length, 0,
        "an ambiguous workspace fails closed instead of doubling the counts");
      await seed(postgres, "DELETE FROM workspaces WHERE id = 'workspace:health-counts-second'");

      // A hostile session: a search_path pointing at a schema the caller controls
      // must not change what the function does, because the function pins its own.
      await updater.query("CREATE SCHEMA attacker");
      await updater.query("CREATE TABLE attacker.updater_health_counts() RETURNS TABLE(home_summary_count bigint,"
        + "project_count bigint,updates_panel_count bigint) LANGUAGE sql AS $$ SELECT 999,999,999 $$");
      await updater.query("SET search_path = attacker, public");
      const shadowed = (await updater.query<{ home_summary_count: string }>(
        "SELECT home_summary_count FROM public.updater_health_counts()")).rows[0]!;
      assert.equal(Number(shadowed.home_summary_count), 0,
        "an attacker-visible name in a later search_path cannot shadow the pinned body");
      await updater.query("RESET search_path");
      await updater.query("DROP SCHEMA attacker CASCADE");
    } finally { await updater.end(); }

    // (6b) The down migration reverses exactly what the up migration granted.
    updater = await asUpdater(postgres);
    try {
      assert.match(await refuses(updater, "SELECT * FROM public.updater_health_counts()"), /42883/u);
      const owner = new Client({ host: postgres.socketDirectory, port: postgres.port,
        user: "control_room_migrator", password: (postgres.connection("migrator") as { password: string }).password,
        database: postgres.database });
      await owner.connect();
      try {
        await owner.query(await readFile(DOWN, "utf8"));
        assert.equal((await owner.query("SELECT to_regprocedure('public.updater_health_counts()') IS NULL AS gone"))
          .rows[0]!.gone, true, "the function is gone from the catalog");
        // And the up file can be re-applied afterwards: the ledger replays.
        await owner.query(await readFile(MIGRATION, "utf8"));
        assert.ok((await owner.query("SELECT * FROM public.updater_health_counts()")).rows.length >= 0);
      } finally { await owner.end(); }
    } finally { await updater.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("50 concurrent updater callers agree, and a single connection under a burst leaks nothing", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await seedScope(postgres, TENANT, WORKSPACE, true);
    await installUpdaterSchema(postgres);
    for (const index of [1, 2, 3]) await seedProject(postgres, `project:load-${index}`, TENANT, WORKSPACE);
    for (const index of [1, 2]) await seedCandidate(postgres, `candidate:load-${index}`, TENANT, "project:load-1");
    await seedActiveJob(postgres, "job:load", TENANT, "project:load-1", "running");

    // (7) 50 concurrent CALLERS, each with its own connection, at the same instant.
    const callers = await Promise.all(Array.from({ length: 50 }, async () => {
      const client = await asUpdater(postgres);
      try { return (await client.query("SELECT * FROM public.updater_health_counts()")).rows[0]; }
      finally { await client.end(); }
    }));
    const expected = JSON.stringify({ home_summary_count: "1", project_count: "3", updates_panel_count: "2" });
    for (const [index, rows] of callers.entries())
      assert.equal(JSON.stringify(rows), expected, `caller ${index} saw a different count`);

    // (7b) A burst down ONE connection, which is how a single updater actually
    // reads: serial on the wire, so this catches a leaked cursor or a function
    // that only works on a fresh backend.
    const single = await asUpdater(postgres);
    try {
      for (let round = 0; round < 100; round += 1) {
        const rows = (await single.query("SELECT * FROM public.updater_health_counts()")).rows;
        assert.equal(JSON.stringify(rows[0]), expected, `burst round ${round} drifted`);
      }
      assert.equal((await single.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()"
        + " AND usename = current_user")).rows[0]!.n, 1, "the burst left exactly this one backend");
    } finally { await single.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the lane ran on a real cluster, not a skip", async t => {
  assert.equal(ran, 4, "all four real-PostgreSQL tests executed");
});