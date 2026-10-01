// The mutation lane for db/migrations/0238_updater_health_counts.sql.
//
// WHY A SEPARATE FILE, AND WHY IT APPLIES THE MIGRATION ITSELF.
//
// deploy/postgres/migration-ledger.json records a SHA-256 of every migration's exact
// bytes, and the attack kit REFUSES to start a cluster whose ledger does not match
// (`migration_altered:<file>`). That is a good property for production and a
// problem for a mutation harness: verify-mutation-checks.mjs proves a guard is
// load-bearing by (a) mutating the file and (b) first proving the test is
// sensitive by appending a single newline. On a ledger-checksummed migration that
// newline alone is a checksum change, so the cluster never starts and every
// mutation reads as "the test fails on a whitespace-only edit".
//
// So this file builds its cluster with `withoutMigrations`-style independence: it
// applies 0238 DIRECTLY, from disk, after the ledger has run. A mutated 0238 is
// therefore applied exactly as written, and a whitespace-only edit is genuinely
// semantically neutral to PostgreSQL, which is the property the harness is
// checking for.
//
// The coverage is the same as tests/updater-health-counts-postgres.test.ts -- the
// boundary itself -- expressed against a directly-applied function.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59510), PG = requiresRealPostgres();
let ran = 0;
const needsPg = () => PG ? undefined : { skip: realPostgresSkipMessage() };

const TENANT = "tenant:health-direct", WORKSPACE = "workspace:health-direct";
const DIGEST = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const manualAdapter = (tenantId: string, workspaceId: string) =>
  `adapter:manual:${createHash("sha256").update(
    `{"tenantId":"${tenantId}","workspaceId":"${workspaceId}"}`, "utf8").digest("hex").slice(0, 32)}`;
const MIGRATION = join(process.cwd(), "db/migrations/0238_updater_health_counts.sql");
const FUNCTION = "public.updater_health_counts()";

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];

/** Every client a phase opens, closed together before the cluster stops. A client
 * left open is killed by the cluster's own stop and surfaces as an asynchronous
 * error after the test has already reported -- which is a leak in the test, not a
 * finding about the boundary, and it looks like neither. */
class Sessions {
  #open: Client[] = [];
  track<T extends Client>(client: T): T { this.#open.push(client); return client; }
  async close(): Promise<void> {
    await Promise.all(this.#open.splice(0).map(client => client.end().catch(() => {})));
  }
}

/** Drops EVERY signature named updater_health_counts, not only the zero-argument
 * one. PostgreSQL treats each argument list as a distinct function, so
 * `DROP FUNCTION updater_health_counts()` resolves to the zero-arg form alone and an
 * overload created by an earlier case survives into the next apply. */
const dropEverySignature = async (client: Client) => {
  await client.query("DO $q$ DECLARE signature record; BEGIN"
    + " FOR signature IN SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args"
    + " FROM pg_catalog.pg_proc p WHERE p.proname = 'updater_health_counts' LOOP"
    + " EXECUTE 'DROP FUNCTION public.updater_health_counts(' || signature.args || ') CASCADE';"
    + " END LOOP; END $q$");
};

async function seed<T extends Record<string, unknown>>(postgres: Postgres, sql: string, params: unknown[] = []) {
  const client = new Client(postgres.admin() as never);
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    return (await client.query<T>(sql, params as never[])).rows;
  } finally { await client.end(); }
}

async function refuses(client: Client, sql: string): Promise<string> {
  try { await client.query(sql); }
  catch (error) {
    const { code, message } = error as { code?: string; message: string };
    assert.equal(typeof code, "string", `refusal carried no SQLSTATE: ${message}`);
    return `${code} ${message.split("\n")[0]}`;
  }
  assert.fail(`statement was not refused: ${sql}`);
}

async function seedScope(postgres: Postgres) {
  const now = new Date().toISOString();
  await seed(postgres, `INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [TENANT]);
  await seed(postgres, `INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Direct fixture')
    ON CONFLICT DO NOTHING`, [WORKSPACE, TENANT]);
  await seed(postgres, `INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,
    redaction_policy_version,cursor_retention_days,created_at,updated_at)
    VALUES($1,$2,'manual','v1','control_room_native','v1',30,$3,$3) ON CONFLICT DO NOTHING`,
  [manualAdapter(TENANT, WORKSPACE), TENANT, now]);
  await seed(postgres, `INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)
    ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id`, [TENANT]);
}

const schemaOwner = (postgres: Postgres, sessions: Sessions) => sessions.track(new Client({
  host: postgres.socketDirectory, port: postgres.port, user: "control_room_migrator",
  password: (postgres.connection("migrator") as { password: string }).password, database: postgres.database }));

test("the health count function's boundary, against the migration applied from disk", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const sessions = new Sessions();
    const owner = schemaOwner(postgres, sessions);
    await owner.connect();
    try {
      await dropEverySignature(owner);
      await owner.query(await readFile(MIGRATION, "utf8"));
      await seedScope(postgres);

      const shape = (await owner.query<{ prosecdef: boolean; provolatile: string; pronargs: number;
        search_path: string[]; columns: string }>(`
        SELECT p.prosecdef, p.provolatile, p.pronargs, p.proconfig AS search_path,
          (SELECT string_agg(n.attname, ',' ORDER BY n.ord) FROM unnest(p.proargnames, p.proallargtypes)
            WITH ORDINALITY AS n(attname, atttypid, ord)) AS columns
        FROM pg_proc p WHERE p.oid = '${FUNCTION}'::regprocedure`)).rows[0]!;
      assert.equal(shape.prosecdef, true, "SECURITY DEFINER: it must run as the schema owner");
      assert.equal(shape.provolatile, "s", "STABLE");
      assert.equal(shape.pronargs, 0, "no caller-chosen scope");
      assert.deepEqual(shape.search_path, ["search_path=pg_catalog, public, pg_temp"], "pinned search_path");
      assert.equal(shape.columns, "home_summary_count,project_count,updates_panel_count");

      assert.equal((await owner.query<{ allowed: boolean }>(
        `SELECT has_function_privilege('public','${FUNCTION}','EXECUTE') AS allowed`)).rows[0]!.allowed,
        false, "PUBLIC holds no EXECUTE");
      assert.equal((await owner.query<{ onward: number }>(`
        SELECT count(*)::int AS onward FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = '${FUNCTION}'::regprocedure AND a.privilege_type = 'EXECUTE' AND a.is_grantable`))
        .rows[0]!.onward, 0, "the EXECUTE grant is not grantable onward");

      const counts = (await owner.query(`SELECT * FROM ${FUNCTION}`)).rows[0];
      assert.deepEqual(Object.keys(counts!).sort(),
        ["home_summary_count", "project_count", "updates_panel_count"]);
      assert.match(await refuses(owner, `SELECT * FROM ${FUNCTION}('tenant:elsewhere')`), /42601|42883/u);
    } finally { await sessions.close(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the migration REFUSES a boundary that is already wrong, at apply time", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const sessions = new Sessions();
    const owner = schemaOwner(postgres, sessions);
    await owner.connect();
    try {
      // Two fixture roles are created by the FIXTURE SUPERUSER, because the migrator
      // correctly cannot create roles (measured: "permission denied to create role").
      const admin = sessions.track(new Client(postgres.admin() as never));
      await admin.connect();
      await admin.query("DO $q$ BEGIN"
        + " IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'health_counts_extra_grantee') THEN"
        + " CREATE ROLE health_counts_extra_grantee NOLOGIN; END IF;"
        + " IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_deployer') THEN"
        + " CREATE ROLE control_room_deployer LOGIN; END IF; END $q$");

      // The file starts with plain CREATE FUNCTION, so applying it twice is refused
      // with 42723 -- which would mask the boundary checks and make this a test that
      // passes for the wrong reason. Re-applying as CREATE OR REPLACE removes that
      // confound: the only statement left that can refuse is its own guard.
      const migration = (await readFile(MIGRATION, "utf8"))
        .replace("CREATE FUNCTION updater_health_counts()", "CREATE OR REPLACE FUNCTION updater_health_counts()");
      const refusesBoundary = async (why: string, expected?: RegExp) => {
        await assert.rejects(
          async () => { await owner.query(migration); },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            // When a specific guard is named, ONLY that guard's message counts.
            // Without this the ACL cases pass for the wrong reason: with the ACL
            // check removed, the pre-CREATE same-signature guard refuses first and
            // the test is satisfied by a different guard doing the work.
            if (expected) assert.match(message, expected,
              `refused by the named guard, not another one: ${message}`);
            // 42723's message is `function "..." already exists with same argument
            // types` -- distinguished from the guard's own wording by the trailing
            // "with same argument types", since the guard's text also says "already
            // exists".
            assert.doesNotMatch(message, /with same argument types/u,
              "a 42723 would mask the guard");
            return true;
          },
          `the migration must refuse when there is ${why}`);
      };

      // The pre-CREATE guards decide whether a displaced boundary is installed at
      // all, so they are the ones this phase can isolate: the file refuses to create
      // anything while a same-signature or overloaded function already exists.
      // The post-CREATE ACL checks CANNOT be isolated here -- the pre-CREATE guard
      // fires first in exactly the state they would need -- so they are not claimed
      // by this lane. They are covered on the full cluster lane instead, where the
      // function is created by the ledger and then examined directly.
      await dropEverySignature(owner);
      await owner.query("CREATE FUNCTION updater_health_counts() RETURNS TABLE(home_summary_count bigint,"
        + " project_count bigint, updates_panel_count bigint) LANGUAGE sql STABLE SECURITY DEFINER"
        + " SET search_path = pg_catalog, public, pg_temp"
        + " AS $b$ SELECT 0::bigint, 0::bigint, 0::bigint $b$");
      await owner.query(`GRANT EXECUTE ON FUNCTION ${FUNCTION} TO health_counts_extra_grantee`);
      await assert.rejects(
        async () => { await owner.query(await readFile(MIGRATION, "utf8")); },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /updater_health_counts already exists/u, `refused by name: ${message}`);
          assert.doesNotMatch(message, /with same argument types/u, "a bare 42723 would mask the guard");
          return true;
        },
        "the migration must refuse to install over a same-signature impostor, whatever its ACL");

      // The SAME NAME, the SAME signature, but not SECURITY DEFINER: this is the case
      // the shape check exists for and the only one that isolates it. An OVERLOAD
      // (the next case) is refused by the competing-signature guard FIRST, so with
      // the shape check removed the overload still refused and this test stayed
      // green -- a test that cannot fail for the reason it was written.
      await dropEverySignature(owner);
      // The return type is spelled EXACTLY as the migration's, because a different
      // one is refused by PostgreSQL itself ("cannot change return type of existing
      // function") -- which would make this case refuse for a reason that has nothing
      // to do with SECURITY DEFINER.
      await owner.query("CREATE FUNCTION updater_health_counts() RETURNS TABLE(home_summary_count bigint,"
        + " project_count bigint, updates_panel_count bigint) LANGUAGE sql STABLE"
        + " SET search_path = pg_catalog, public, pg_temp"
        + " AS $b$ SELECT 0::bigint, 0::bigint, 0::bigint $b$");
      // The migration refuses a pre-existing same-signature object before it ever
      // creates anything, so this case is checked against the file AS WRITTEN -- not
      // the CREATE-OR-REPLACE form, which would have replaced the impostor and
      // tested nothing.
      await assert.rejects(
        async () => { await owner.query(await readFile(MIGRATION, "utf8")); },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /updater_health_counts already exists/u, `refused by name: ${message}`);
          assert.doesNotMatch(message, /with same argument types/u, "a bare 42723 would mask the guard");
          return true;
        },
        "the migration must refuse a pre-existing same-signature impostor");

      // A competing OVERLOAD. PostgreSQL installs the zero-argument form alongside a
      // one-argument one rather than replacing it (measured on PostgreSQL 17), so
      // every check below -- all of which resolve the zero-argument signature --
      // would inspect the wrong function. This is the case that is invisible without
      // building one deliberately.
      await dropEverySignature(owner);
      await owner.query("CREATE FUNCTION updater_health_counts(p_tenant text)"
        + " RETURNS TABLE(out_home bigint, out_projects bigint, out_panel bigint)"
        + " LANGUAGE sql STABLE AS $b$ SELECT 0::bigint, 0::bigint, 0::bigint $b$");
      await refusesBoundary("a competing overload that could displace the boundary",
        /another signature of updater_health_counts/u);

      // LEFT IN PLACE FOR NOTHING FURTHER: the boundary exactly as it should be, and
      // re-applying it proves the refusals above were the boundary's own doing.
      await dropEverySignature(owner);
      await owner.query(migration);
      const clean = (await owner.query<{ allowed: boolean; onward: number; overloads: number }>(`
        SELECT has_function_privilege('public','${FUNCTION}','EXECUTE') AS allowed,
          (SELECT count(*)::int FROM pg_proc p
             CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
           WHERE p.oid = '${FUNCTION}'::regprocedure AND a.is_grantable) AS onward,
          (SELECT count(*)::int FROM pg_proc p WHERE p.proname = 'updater_health_counts') AS overloads`))
        .rows[0]!;
      assert.equal(clean.allowed, false, "PUBLIC holds no EXECUTE");
      assert.equal(clean.onward, 0, "and nothing is grantable onward");
      assert.equal(clean.overloads, 1, "and exactly one signature exists");
    } finally { await sessions.close(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the lane ran on a real cluster, not a skip", () => {
  assert.equal(ran, 2, "both direct-apply phases executed");
});
