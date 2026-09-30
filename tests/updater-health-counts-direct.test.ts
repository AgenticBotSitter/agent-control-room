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

async function seed<T extends Record<string, unknown>>(postgres: Postgres, sql: string,
  params: unknown[] = []) {
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

/** Drop any copy the ledger already made, then apply the file exactly as it is on
 * disk. This is the point of the file: the bytes under mutation are what runs. */
async function applyMigrationDirectly(postgres: Postgres): Promise<Client> {
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port,
    user: "control_room_migrator",
    password: (postgres.connection("migrator") as { password: string }).password, database: postgres.database });
  await owner.connect();
  await owner.query(`DROP FUNCTION IF EXISTS ${FUNCTION} CASCADE`);
  await owner.query(await readFile(MIGRATION, "utf8"));
  return owner;
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

test("the health count function's boundary, against the migration applied from disk", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const owner = await applyMigrationDirectly(postgres);
    try {
      await seedScope(postgres);

      // The function exists and is shaped as the boundary claims.
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

      // PUBLIC holds no EXECUTE. Without this the whole boundary is decorative.
      assert.equal((await owner.query<{ allowed: boolean }>(
        `SELECT has_function_privilege('public','${FUNCTION}','EXECUTE') AS allowed`)).rows[0]!.allowed,
        false, "PUBLIC holds no EXECUTE");
      // And the EXECUTE is never grantable onward.
      assert.equal((await owner.query<{ onward: number }>(`
        SELECT count(*)::int AS onward FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = '${FUNCTION}'::regprocedure AND a.privilege_type = 'EXECUTE' AND a.is_grantable`))
        .rows[0]!.onward, 0, "the EXECUTE grant is not grantable onward");

      // It calls, and it returns three integers and nothing else.
      const counts = (await owner.query(`SELECT * FROM ${FUNCTION}`)).rows[0];
      assert.deepEqual(Object.keys(counts!).sort(),
        ["home_summary_count", "project_count", "updates_panel_count"]);

      // The scope is pre-bound: there is no argument to point it anywhere else.
      assert.match(await refuses(owner, `SELECT * FROM ${FUNCTION}('tenant:elsewhere')`), /42601|42883/u);
    } finally { await owner.end().catch(() => {}); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the lane ran on a real cluster, not a skip", () => {
  assert.equal(ran, 1, "the direct-apply phase executed");
});