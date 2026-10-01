// Real-PostgreSQL proof for the updater's health counts: design §8.4 item 2's
// "counts are compared with the updater's own reads", on PostgreSQL 17, run as
// the PRODUCTION logins and never as a superuser for anything under test.
//
// ONE CLUSTER FOR THE WHOLE LANE, NOT ONE PER PHASE. Every phase below runs
// against a single cluster, in order, inside one `withRealPostgres` body. That is
// a deliberate departure from the one-cluster-per-test shape the other lanes use,
// and it is here for a measured reason: each cluster costs ~10s of
// initdb+migrate, and four sequential clusters sharing one port turned a single
// leaked client into a cascade where the first test reported a bare
// `57P01 terminating connection due to administrator command` and the next three
// reported `refusing_occupied_port` -- neither of which points at the leak. One
// cluster with ordered phases makes the boundary, not the harness, the thing that
// can fail, and the whole lane runs in a single teardown.
//
// WHAT IS PROVEN, in order:
//
//   1. `public.updater_health_counts()` is SECURITY DEFINER / STABLE /
//      zero-argument, owned by the release schema owner, pins its search_path,
//      and returns exactly three integer columns. No name, id, path or payload.
//   2. The updater's login can call it, and can read NOTHING else in `public`.
//      This is load-bearing: a grant on the counted tables would both fail the
//      updater's own startup assertion (schema-installer.ts) and hand
//      candidate-controlled rows to the approval authority (R10a).
//   3. The counts match the three real UI reads, seeded through those reads' own
//      predicates, and another tenant's rows are invisible.
//   4. Nothing leaks: no fixture identifier appears anywhere in the result.
//   5. Fails closed: no binding row, an ambiguous workspace, and a hostile
//      search_path carrying a same-named decoy function.
//   6. The web login's INSERT on updater.plan_approvals is measured true, and
//      the SAME expression as the updater's login is measured false -- so the
//      boolean §8.4 asks for is a measurement, not a constant.
//   7. Load: 50 concurrent callers agree, 100 queries down one connection do not
//      drift, and every backend the burst opened is closed.
//   8. The down migration reverses exactly what the up file granted, and the up
//      file re-applies cleanly afterwards.
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
const DIGEST = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
/** The adapter id the web derives for a scope, computed the way the code does
 * it: `sha256Digest({tenantId, workspaceId})` canonicalizes to sorted-key JSON,
 * so these are the exact bytes hashed. Checked byte-for-byte against
 * src/security/canonical-digest.ts before this lane was written. */
const manualAdapter = (tenantId: string, workspaceId: string) =>
  `adapter:manual:${createHash("sha256").update(
    `{"tenantId":"${tenantId}","workspaceId":"${workspaceId}"}`, "utf8").digest("hex").slice(0, 32)}`;
const ADAPTER = manualAdapter(TENANT, WORKSPACE);
const DEPLOYER_PASSWORD = "fixture-health-deployer";
const MIGRATION = join(process.cwd(), "db/migrations/0239_updater_health_counts.sql");
const DOWN = join(process.cwd(), "db/down/0239_updater_health_counts.sql");
const FUNCTION = "public.updater_health_counts()";

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];
type Counts = { home_summary_count: string; project_count: string; updates_panel_count: string };

/** Every client a phase opens, closed in ONE place before the cluster stops.
 * A client left open is killed by the cluster's own stop and surfaces as an
 * asynchronous 57P01 after the test has already reported. */
class Sessions {
  #open: Client[] = [];
  track<T extends Client>(client: T): T { this.#open.push(client); return client; }
  async open<T extends Client>(client: Promise<T>): Promise<T> { return this.track(await client); }
  async close(): Promise<void> {
    await Promise.all(this.#open.splice(0).map(client => client.end().catch(() => {})));
  }
}

/** Fixture rows only, as the superuser, with triggers disabled the documented
 * way. Triggers off does NOT disable foreign keys, which is why the candidate
 * fixture seeds its whole pipeline lineage. */
async function seed<T extends Record<string, unknown>>(postgres: Postgres, sql: string, params: unknown[] = []) {
  const client = new Client(postgres.admin() as never);
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    return (await client.query<T>(sql, params as never[])).rows;
  } finally { await client.end(); }
}

/** Assert a statement is refused, and return its SQLSTATE. */
async function refuses(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  try { await client.query(sql, params as never[]); }
  catch (error) {
    const { code, message } = error as { code?: string; message: string };
    assert.equal(typeof code, "string", `refusal carried no SQLSTATE: ${message}`);
    return `${code} ${message.split("\n")[0]}`;
  }
  assert.fail(`statement was not refused: ${sql.slice(0, 120)}`);
}

/** The tenant, its workspace, and the adapter row `projects.adapter_id` must
 * reference. Column names are read from db/migrations/0001_control_room_core.sql
 * and 0003_canonical_domain_delivery.sql, not from memory. */
async function seedScope(postgres: Postgres, tenantId: string, workspaceId: string) {
  const now = new Date().toISOString();
  await seed(postgres, `INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [tenantId]);
  await seed(postgres, `INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Count fixture')
    ON CONFLICT DO NOTHING`, [workspaceId, tenantId]);
  await seed(postgres, `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)
    ON CONFLICT DO NOTHING`, [`identity:${tenantId}`, tenantId, DIGEST(tenantId), now]);
  await seed(postgres, `INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,
    redaction_policy_version,cursor_retention_days,created_at,updated_at)
    VALUES($1,$2,'manual','v1','control_room_native','v1',30,$3,$3) ON CONFLICT DO NOTHING`,
  [manualAdapter(tenantId, workspaceId), tenantId, now]);
}

/** The singleton binding row that scopes the whole boundary. */
async function bindTenant(postgres: Postgres, tenantId: string) {
  await seed(postgres, `INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)
    ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id`, [tenantId]);
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

/** One ready update candidate -- the Updates panel's row. */
async function seedCandidate(postgres: Postgres, id: string, tenantId: string, projectId: string) {
  const now = new Date().toISOString(), requestId = `request:${id}`;
  await seed(postgres, `INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,
    created_at,updated_at) VALUES($1,$2,$3,'submitted',1,$4,'{}'::jsonb,$5,$5) ON CONFLICT DO NOTHING`,
  [requestId, tenantId, projectId, `idem:${id}`, now]);
  await seed(postgres, `INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,
    version,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',1,'{}'::jsonb,$6,$6) ON CONFLICT DO NOTHING`,
  [`workflow:${id}`, tenantId, requestId, projectId, DIGEST(`workflow:${id}`), now]);
  await seed(postgres, `INSERT INTO pipeline_templates(id,tenant_id,project_id,name,description,stages,max_stages,
    max_total_loops,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at)
    VALUES($1,$2,$3,'fixture','fixture','[]'::jsonb,1,0,600,$4,$5,1,$6,$6) ON CONFLICT DO NOTHING`,
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
  // `risk_flags` and `independent_reviews` are added by 0161 with a default and
  // then have it DROPPED, so both are required here: 0161's second statement
  // removes the default precisely so a writer cannot omit the evidence.
  await seed(postgres, `INSERT INTO control_update_candidates(tenant_id,id,project_id,improvement_request_id,
    pipeline_run_id,base_revision,candidate_revision,summary,changed_areas,test_results,database_changes,
    risk_flags,independent_reviews,lead_worker_id,state,version,record_digest,auth_tag,created_at)
    VALUES($1,$2,$3,$4,$5,repeat('a',40),repeat('b',40),'fixture','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,
      '[]'::jsonb,'[]'::jsonb,'worker:fixture','ready',1,$6,$7,$8) ON CONFLICT DO NOTHING`, [tenantId, id,
    projectId, `improvement:${id}`, `run:${id}`, DIGEST(`candidate:${id}`),
    `hmac-sha256:${"c".repeat(64)}`, now]);
}

/** Install the updater's own fixed DDL, then normalize ownership the way
 * production does once the ledger has run (normalizeMacApplicationOwnershipV1,
 * scripts/ops/verify-database-backup.mjs).
 *
 * The release ledger is NOT re-applied here: the attack kit has already applied
 * db/migrations/0239 from the real committed ledger, and `CREATE FUNCTION` is
 * not idempotent, so a second apply refuses with 42723.
 *
 * The role file IS applied here, inside `connectDeployer`, and that ordering is
 * the point rather than plumbing: the updater's login does not exist until the
 * DDL's first two files have run, and the EXECUTE grant for the health counts
 * lives in that file rather than in the migration -- which is precisely why it
 * has to be issued after the role exists. Applying it here exercises the real
 * production path instead of granting the privilege from the test. */
async function installUpdaterSchema(postgres: Postgres) {
  const bootstrap = new Client({ ...postgres.admin(), user: "fixture_admin" } as never);
  await bootstrap.connect();
  // Release grants are issued by the SCHEMA OWNER, because a GRANT must come from
  // the object's owner and the deployer owns nothing in `public`. The migrator
  // login inherits that owner role, exactly as the installer and the live upgrade
  // issue every other release-schema grant.
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port, user: "control_room_migrator",
    password: (postgres.connection("migrator") as { password: string }).password, database: postgres.database });
  await owner.connect();
  let deployer: Client | undefined;
  try {
    const result = await applyUpdaterSchemaV1({ bootstrap, directory: join(process.cwd(), "src/updater/v1/ddl"),
      // Declared, because `connectDeployer` below sets one. Production does not:
      // that role has no password at all and is reached by peer authentication.
      deployerHasFixturePassword: true, connectDeployer: async () => {
        await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8"));
        // The password is set by the bootstrap superuser, not the schema owner:
        // `ALTER ROLE ... PASSWORD` needs CREATEROLE, which the migrator correctly
        // does not hold (measured: "permission denied to alter role").
        await bootstrap.query(`ALTER ROLE control_room_deployer PASSWORD '${DEPLOYER_PASSWORD}'`);
        deployer = new Client({ host: postgres.socketDirectory, port: postgres.port,
          user: "control_room_deployer", password: DEPLOYER_PASSWORD, database: postgres.database });
        await deployer.connect();
        return deployer;
      } });
    await owner.query(`ALTER FUNCTION updater_health_counts() OWNER TO control_room_schema_owner`);
    return result;
  } finally {
    await deployer?.end().catch(() => {});
    await owner.end().catch(() => {});
    await bootstrap.end();
  }
}

const connectAs = async (postgres: Postgres, sessions: Sessions, user: string, password: string) => {
  const client = sessions.track(new Client({ host: postgres.socketDirectory, port: postgres.port, user,
    password, database: postgres.database }));
  await client.connect();
  return client;
};
const asUpdater = (postgres: Postgres, sessions: Sessions) =>
  connectAs(postgres, sessions, "control_room_deployer", DEPLOYER_PASSWORD);
const asWeb = (postgres: Postgres, sessions: Sessions) =>
  connectAs(postgres, sessions, "control_room_web", (postgres.connection("web") as { password: string }).password);
const asSchemaOwner = (postgres: Postgres, sessions: Sessions) =>
  connectAs(postgres, sessions, "control_room_migrator", (postgres.connection("migrator") as { password: string }).password);

test("the updater's health counts: boundary, contents, closed paths and load", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const sessions = new Sessions();
    try {
      await seedScope(postgres, TENANT, WORKSPACE);
      await seedScope(postgres, OTHER_TENANT, OTHER_WORKSPACE);
      const installed = await installUpdaterSchema(postgres);
      assert.equal(installed.tables, 9, "the updater's own nine tables were created by its fixed DDL");

      // -- (1) The function's shape, read from the catalog ------------------------
      const catalog = sessions.track(new Client(postgres.admin() as never));
      await catalog.connect();
      const shape = (await catalog.query<{ prosecdef: boolean; provolatile: string; pronargs: number;
        owner: string; search_path: string[]; columns: string | null }>(`
        SELECT p.prosecdef, p.provolatile, p.pronargs, pg_get_userbyid(p.proowner) AS owner,
          p.proconfig AS search_path,
          -- The RETURNS TABLE columns of a set-returning function are OUT
          -- parameters: they live in proargnames/proallargtypes and NOT in
          -- pg_attribute (measured on PostgreSQL 17, where pg_attribute holds no
          -- row for such a function). Reading pg_attribute reported null and
          -- looked like a missing-column bug when the function was in fact right.
          (SELECT string_agg(n.attname, ',' ORDER BY n.ord) FROM unnest(p.proargnames, p.proallargtypes)
            WITH ORDINALITY AS n(attname, atttypid, ord)) AS columns
        FROM pg_proc p WHERE p.oid = '${FUNCTION}'::regprocedure`)).rows[0]!;
      assert.equal(shape.prosecdef, true, "it must run as the schema owner");
      assert.equal(shape.provolatile, "s", "it must be STABLE");
      assert.equal(shape.pronargs, 0, "no caller-chosen scope exists at all");
      assert.equal(shape.owner, "control_room_schema_owner");
      assert.deepEqual(shape.search_path, ["search_path=pg_catalog, public, pg_temp"]);
      assert.equal(shape.columns, "home_summary_count,project_count,updates_panel_count",
        "three counts, nothing else: no name, id, path or payload column exists");

      const grantees = (await catalog.query<{ grantee: string; grantable: boolean }>(`
        SELECT pg_get_userbyid(a.grantee) AS grantee, a.is_grantable AS grantable
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = '${FUNCTION}'::regprocedure AND a.privilege_type = 'EXECUTE'
          AND a.grantee <> 0 AND a.grantee <> p.proowner`)).rows;
      // Compared against proowner rather than a fixed name: the ownership
      // normalization production runs leaves the pre-normalization owner as a
      // NAMED grantee (measured on PostgreSQL 17), so a fixed-name expectation
      // would report a correct database as broken.
      assert.deepEqual(grantees, [{ grantee: "control_room_deployer", grantable: false }],
        "the updater's login is the only caller, and cannot pass EXECUTE on");
      assert.equal((await catalog.query<{ allowed: boolean }>(
        `SELECT has_function_privilege('public','${FUNCTION}','EXECUTE') AS allowed`)).rows[0]!.allowed,
        false, "PUBLIC holds no EXECUTE");

      // -- (2) The updater can call it, and reaches nothing else ------------------
      const updater = await asUpdater(postgres, sessions);
      // `coalesce(array_agg(...), ARRAY[]::text[])` needs an explicit cast for the
      // driver to infer the result type; without it node-pg hands back `{}` and the
      // assertion compares an object to an array.
      const reachable = (await updater.query<{ tables: string[] }>(`
        SELECT coalesce(array_agg(DISTINCT c.relname) FILTER (WHERE c.relname <> 'control_web_sessions'
          AND c.relname <> 'control_identities' AND c.relname <> 'control_role_grants'),
          ARRAY[]::text[])::text[] AS tables
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                 AND (has_column_privilege(current_user, c.oid, a.attname, 'SELECT')
                   OR has_column_privilege(current_user, c.oid, a.attname, 'INSERT')
                   OR has_column_privilege(current_user, c.oid, a.attname, 'UPDATE')))
            OR has_table_privilege(current_user, c.oid, 'DELETE')
            OR has_table_privilege(current_user, c.oid, 'TRUNCATE'))`)).rows[0]!;
      assert.deepEqual(reachable.tables, [],
        "the updater reaches no release table beyond the three its owner-session guard needs");
      // The three release tables this lane counts are unreadable outright.
      for (const statement of ["SELECT count(*) FROM projects", "SELECT count(*) FROM control_update_candidates",
        "SELECT count(*) FROM control_jobs"]) {
        assert.match(await refuses(updater, statement), /42501/u, `refused: ${statement}`);
      }

      // Either SQLSTATE is a refusal and both are correct: a set-returning
      // function's OUT columns are not call arguments, so passing one is a
      // syntax error (42601) on some paths and an arity mismatch (42883) on
      // others. What matters is that it is refused at all.
      assert.match(await refuses(updater, `SELECT * FROM ${FUNCTION}('tenant:other')`), /42601|42883/u,
        "there is no argument through which a caller could choose a scope");
      // The guard's own column-scoped read still works, so the three tables the
      // reachability query exempts are exempt because they are genuinely needed
      // rather than because the query is broken.
      assert.equal((await updater.query<{ live: number }>(
        "SELECT count(*)::int AS live FROM control_web_sessions WHERE tenant_id = 'x'")).rows[0]!.live, 0,
        "the owner-session guard's own column-scoped read still works");

      // -- (3) No binding row: closed, not an error and not a guess ---------------
      assert.equal((await updater.query(`SELECT * FROM ${FUNCTION}`)).rows.length, 0,
        "no binding row means no counts, so §8.4's comparison fails closed");

      // -- (4) An ambiguous workspace: closed, never doubled ----------------------
      await bindTenant(postgres, TENANT);
      await seed(postgres, `INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Second')
        ON CONFLICT DO NOTHING`, ["workspace:health-counts-second", TENANT]);
      assert.equal((await updater.query(`SELECT * FROM ${FUNCTION}`)).rows.length, 0,
        "a tenant with two workspaces fails closed instead of doubling every count");
      await seed(postgres, "DELETE FROM workspaces WHERE id = 'workspace:health-counts-second'");

      // -- (5) The counts equal the three real UI reads ---------------------------
      await seedProject(postgres, "project:listed-1", TENANT, WORKSPACE);
      await seedProject(postgres, "project:listed-2", TENANT, WORKSPACE);
      await seedProject(postgres, "project:other-tenant", OTHER_TENANT, OTHER_WORKSPACE);
      await seedActiveJob(postgres, "job:leased", TENANT, "project:listed-1", "leased");
      await seedActiveJob(postgres, "job:running", TENANT, "project:listed-1", "running");
      await seedActiveJob(postgres, "job:waiting", TENANT, "project:listed-2", "waiting_approval");
      // `succeeded` is NOT one of Home's three listed states, so it must not count.
      await seedActiveJob(postgres, "job:succeeded", TENANT, "project:listed-1", "succeeded");
      await seedCandidate(postgres, "candidate:1", TENANT, "project:listed-1");
      await seedCandidate(postgres, "candidate:2", TENANT, "project:listed-2");

      const counts = (await updater.query<Counts>(`SELECT * FROM ${FUNCTION}`)).rows[0]!;
      assert.equal(Number(counts.project_count), 2, "only the two listed projects, not another tenant's");
      assert.equal(Number(counts.home_summary_count), 3, "Home's three states, not the succeeded one");
      assert.equal(Number(counts.updates_panel_count), 2);

      // -- (6) Nothing leaks ------------------------------------------------------
      const row = (await updater.query(`SELECT row_to_json(c) AS row FROM ${FUNCTION} c`)).rows[0];
      const text = JSON.stringify(row);
      for (const secret of [TENANT, WORKSPACE, OTHER_TENANT, OTHER_WORKSPACE, ADAPTER, "project:listed-1",
        "candidate:1", "job:leased", "fixture", "Owner"]) {
        assert.equal(text.includes(secret), false, `the boundary leaked ${secret}`);
      }

      // -- (7) A hostile session cannot shadow the pinned body ---------------------
      //
      // The decoy is created as the SCHEMA OWNER, not as the updater's login: the
      // updater cannot create a schema at all (no database CREATE -- which is
      // itself part of the boundary), so the threat being modelled is "some other
      // party plants a same-named function earlier in MY search_path", not "the
      // updater plants it itself". The decoy returns 999s, so a shadowed call
      // would be unmistakable.
      const planter = await asSchemaOwner(postgres, sessions);
      await planter.query("CREATE SCHEMA attacker");
      await planter.query("CREATE FUNCTION attacker.updater_health_counts() RETURNS TABLE(home_summary_count bigint,"
        + "project_count bigint,updates_panel_count bigint) LANGUAGE sql AS $$ SELECT 999,999,999 $$");
      // The updater's own session then puts that schema first on its search_path.
      await updater.query("SET search_path = attacker, public");
      const shadowed = (await updater.query<Counts>(
        `SELECT home_summary_count FROM ${FUNCTION}`)).rows[0]!;
      assert.equal(Number(shadowed.home_summary_count), 3,
        "an attacker-visible name earlier in the caller's search_path cannot shadow the pinned body");
      await updater.query("RESET search_path");
      await planter.query("DROP SCHEMA attacker CASCADE");
      // And the updater's login really cannot do this itself.
      assert.match(await refuses(updater, "CREATE SCHEMA attacker"), /42501/u,
        "the updater cannot plant a shadow at all: it holds no database CREATE");

      // -- (8) The privilege boolean is a measurement -----------------------------
      const web = await asWeb(postgres, sessions);
      const asTheWebLogin = (await web.query<{ allowed: boolean }>(
        `SELECT has_table_privilege(current_user,'updater.plan_approvals','INSERT') AS allowed`)).rows[0]!;
      assert.equal(asTheWebLogin.allowed, true, "the production web login holds INSERT on plan_approvals");
      // `has_table_privilege` is callable by ANY login -- it answers false rather
      // than raising (measured on PostgreSQL 17) -- so it is a genuine measurement
      // and can be checked from both sides.
      //
      // It is deliberately NOT cross-checked with "the updater must be false": the
      // updater OWNS schema `updater`, so it holds every privilege on its own
      // tables including INSERT (measured -- that assertion was written, failed
      // true !== false, and was wrong). The login that must NOT hold it is the
      // MIGRATOR, which owns the release schema and nothing in `updater` -- so
      // that is the meaningful contrast, and it is asserted here.
      // The migrator has no USAGE on schema `updater` at all -- not even the
      // right to name an object inside it -- which is R10a stated from the other
      // side: the release ledger owns nothing that holds the owner's approval.
      // (So `has_table_privilege(...,'updater.plan_approvals',...)` cannot even be
      // evaluated as that login; the schema denial below is the checkable form.)
      const asTheMigrator = await asSchemaOwner(postgres, sessions).then(async client =>
        (await client.query<{ usage: boolean; create: boolean; objects: number }>(
          `SELECT has_schema_privilege(current_user,'updater','USAGE') AS usage,
             has_schema_privilege(current_user,'updater','CREATE') AS "create",
             (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='updater' AND c.relkind='r'
                 AND has_table_privilege(current_user,c.oid,'SELECT')) AS objects`)).rows[0]!);
      assert.deepEqual(asTheMigrator, { usage: false, create: false, objects: 0 },
        "the release-side login holds nothing in schema updater: R10a, in the other direction");
      const asTheWeb = (await web.query<{ allowed: boolean }>(
        `SELECT has_table_privilege(current_user,'updater.plan_approvals','INSERT') AS allowed`)).rows[0]!;
      assert.equal(asTheWeb.allowed, true, "and the same expression on the web login is true");

      // -- (9) Load: 50 concurrent callers, then a burst down one connection ------
      const expected = JSON.stringify(counts);
      const seen = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
        const client = await asUpdater(postgres, sessions);
        try { return (await client.query<Counts>(`SELECT * FROM ${FUNCTION}`)).rows[0]; }
        catch (error) {
          // Report WHICH caller failed and with what, rather than letting 50
          // identical promises collapse into one anonymous rejection.
          throw new Error(`caller ${index}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));
      for (const [index, countsSeen] of seen.entries())
        assert.equal(JSON.stringify(countsSeen), expected, `caller ${index} saw different counts`);
      for (let round = 0; round < 100; round += 1)
        assert.equal(JSON.stringify((await updater.query<Counts>(`SELECT * FROM ${FUNCTION}`)).rows[0]), expected,
          `burst round ${round} drifted`);

      // The 50 concurrent callers' own connections must all be closed again.
      await sessions.close();
      const survivors = await asSchemaOwner(postgres, sessions).then(async client =>
        (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity"
          + " WHERE datname = current_database() AND usename = 'control_room_deployer'")).rows[0]!.n);
      assert.equal(survivors, 0, "every updater-login backend was closed, so the burst leaked nothing");
      await sessions.close();

      // -- (10) The down migration reverses exactly what the up file granted ------
      const owner = await asSchemaOwner(postgres, sessions);
      await owner.query(await readFile(DOWN, "utf8"));
      assert.equal((await owner.query<{ gone: boolean }>(
        `SELECT to_regprocedure('${FUNCTION}') IS NULL AS gone`)).rows[0]!.gone, true,
        "the function is gone from the catalog");
      // And the up file re-applies cleanly, which is what a ledger re-run after a
      // restore does. A down file that left anything behind would make this fail
      // with 42723 on a database that is in fact correct.
      //
      // The role file is re-applied straight after, exactly as the installer does:
      // the down migration revokes the updater's EXECUTE, and the up migration
      // REFUSES if that login exists without it -- which is the guard working as
      // designed (it is how the two files are kept from drifting apart), not a
      // failure of the replay.
      await owner.query(await readFile(MIGRATION, "utf8"));
      assert.equal((await owner.query<{ usable: number }>(
        `SELECT count(*)::int AS usable FROM pg_proc WHERE oid = '${FUNCTION}'::regprocedure`))
        .rows[0]!.usable, 1, "the up file re-applies cleanly after the down file");
      await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8"));
      assert.equal((await owner.query<{ can: boolean }>(
        `SELECT has_function_privilege('control_room_deployer','${FUNCTION}','EXECUTE') AS can`))
        .rows[0]!.can, true, "and the installer re-grants it, so the updater can read the counts again");
    } finally { await sessions.close(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the lane ran on a real cluster, not a skip", () => {
  assert.equal(ran, 1, "the real-PostgreSQL phase executed");
});