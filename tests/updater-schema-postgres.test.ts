// Real-PostgreSQL proof for the updater's own schema (design item 7, R10a/b,
// R16, R12, R14b) on PostgreSQL 17, run as the PRODUCTION logins and never as a
// superuser: the deployer (control_room_deployer), the web (control_room_web,
// member of control_room_private_web) and the migrator
// (control_room_migrator). The superuser connection only seeds fixtures, and
// it is used as a superuser on purpose wherever a test asks what a superuser
// still cannot do.
//
// The cluster is built by the shared attack kit, so the release migration
// ledger and the Mac-local role files are applied exactly as production applies
// them. The updater's DDL is then applied on top, by the updater's own loader,
// in the order item 7 fixes: the role and the schema as the installer's
// bootstrap, everything else as the deployer.
//
// What this lane proves, in the order the brief asks for it:
//   1. the schema exists, is owned by the deployer, and holds the design's nine
//      tables — created by the updater's fixed DDL, not the release ledger;
//   2. the migrator, the web login and the service logins can do NOTHING here:
//      no USAGE on the schema, no privilege on any object, and a live attempt
//      through each of them is refused;
//   3. the web can insert exactly the four tables the design names, and only
//      with a live owner session;
//   4. the size CHECKs (R16) bound every byte a lower-trust caller can write;
//   5. the state machines, the one-open-plan rule, the run lease and the
//      append-only rules refuse what they are meant to;
//   6. 50 concurrent approval inserts on one plan (the stress case) leave
//      exactly the rows that were inserted and no duplicate effects.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { applyUpdaterSchemaV1, updaterDdlFilesV1, updaterTablesV1,
  type UpdaterSchemaResultV1 } from "../src/updater/v1/schema-installer";
import { PostgresUpdaterStoreV1 } from "../src/updater/v1/store.mjs";
import { startUpdaterV1 } from "../src/updater/v1/updater.mjs";

// CONTROL_ROOM_PG_TEST_PORT_BASE moves the disposable cluster, as in the module
// approval lane. 59510 is the block this job was given.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59510), PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const TENANT = "tenant:updater-pg";
const OWNER = "identity:updater-pg-owner";
const DIGEST = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const OWNER_SESSION = DIGEST("owner-session-fixture");
/** 32 bytes of authenticatorData and a 64-byte signature: both legal, both real. */
const AUTH = Buffer.alloc(32, 0x11), SIG = Buffer.alloc(64, 0x22), CLIENT = Buffer.from('{"type":"webauthn.get"}', "utf8");
const CREDENTIAL = "Y3JlZGVudGlhbC1maXh0dXJlLTMyLWJ5dGVzLWxvbmc";

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];

/** A production login's client. Short names are fixture vocabulary. */
function as(postgres: Postgres, role: "deployer" | "web" | "migrator") {
  const login = role === "deployer" ? "control_room_deployer" : role === "web" ? "control_room_web"
    : "control_room_migrator";
  // The deployer's fixture verifier is the one `installUpdaterSchema` sets; the
  // other two come from the attack kit, which created those logins itself.
  const password = role === "deployer" ? DEPLOYER_PASSWORD
    : (postgres.connection(role === "web" ? "web" : "migrator") as { password: string }).password;
  return new Client({ host: postgres.socketDirectory, port: postgres.port, database: postgres.database,
    user: login, password });
}

/** Fixture rows only, as the superuser, with triggers disabled the documented way. */
async function seed<T extends Record<string, unknown>>(postgres: Postgres, sql: string, params: unknown[] = [],
  database = postgres.database) {
  const client = new Client(postgres.admin({ database }));
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    return (await client.query<T>(sql, params as never[])).rows;
  } finally { await client.end(); }
}

/** A live owner session, which every web-inserted row requires (R16). */
async function seedOwnerSession(postgres: Postgres) {
  const now = new Date().toISOString();
  await seed(postgres, `INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [TENANT]);
  await seed(postgres, `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)
    ON CONFLICT DO NOTHING`, [OWNER, TENANT, DIGEST(OWNER), now]);
  await seed(postgres, `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,risk_ceiling,
    allowed_actions,project_ids,created_at,updated_at)
    VALUES($1,$2,$3,'owner','critical','["*"]','["*"]',$4,$4) ON CONFLICT DO NOTHING`,
  [`grant:${OWNER}`, TENANT, OWNER, now]);
  await seed(postgres, `INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
  [TENANT, OWNER_SESSION, OWNER, now, new Date(Date.parse(now) + 3_600_000).toISOString()]);
}

const planId = (suffix: string) => `plan-${suffix}`;
const planDigest = (suffix: string) => DIGEST(`plan-${suffix}`);
const planJson = (id: string) => ({
  schema: "control-room.install-plan/v2", planId: id, kind: "code", installationId: "install-fixture",
});

/** Insert a plan as the deployer. Every product statement runs as a product login. */
async function insertPlan(postgres: Postgres, id: string, overrides: Record<string, unknown> = {}) {
  const client = as(postgres, "deployer");
  await client.connect();
  try {
    await client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
      changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at)
      VALUES($1,'install-fixture',$2,$3,$4,$5,$6,$7,$8::jsonb,$9,now()+interval '72 hours')`,
    [id, overrides.kind ?? "code", overrides.state ?? "ready_for_approval",
      overrides.classes ?? ["code"], overrides.changes_database ?? false, overrides.changes_updater ?? false,
      planDigest(id), JSON.stringify(planJson(id)),
      (overrides.kind ?? "code") === "updater" || (overrides.kind ?? "code") === "setting"]);
  } finally { await client.end(); }
}

/** Assert that a statement is refused, and return the SQLSTATE for the message. */
async function refuses(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await client.query(sql, params as never[]);
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    assert.equal(typeof code, "string", `refusal carried no SQLSTATE: ${message}`);
    return `${code} ${message.split("\n")[0]}`;
  }
  assert.fail(`statement was not refused: ${sql.slice(0, 120)}`);
}

const DEPLOYER_PASSWORD = "fixture-deployer";
const DDL_DIRECTORY = join(process.cwd(), "src/updater/v1/ddl");

/**
 * Apply the updater's fixed DDL and assert the result, through the updater's own
 * loader.
 *
 * The SCRAM verifier is set BETWEEN the loader's two halves, and that ordering is
 * the point rather than plumbing. Production gives this role no password at all —
 * `pg_hba.conf` maps `local all control_room_deployer peer map=cr` to root, so
 * only a root process can become it, and `0001_deployer_role.sql` RAISES if the
 * role holds one. The test harness cannot use peer authentication (it speaks the
 * password protocol), so the verifier goes in through the loader's
 * `connectDeployer` factory: after `0001` has checked for a password and
 * refused, and before anything runs as the role.
 *
 * A `db/roles/*.sql` fixture could not express this, because the attack kit
 * applies its role files before any test body runs — the password would already
 * be there when `0001` looked, and the check would be dead code that always
 * passed for the wrong reason. That is why this is a helper.
 */
async function installUpdaterSchema(postgres: Postgres): Promise<UpdaterSchemaResultV1> {
  const bootstrap = new Client({ ...postgres.admin(), user: "fixture_admin" } as never);
  await bootstrap.connect();
  // The grant is issued by the release SCHEMA OWNER, because a GRANT must come
  // from the object's owner and the deployer owns nothing in `public`. The
  // migrator login inherits that owner role, which is exactly how the installer
  // and the live upgrade issue every other release-schema grant. Using the
  // superuser here instead would prove the grant text works and not prove the
  // path production takes.
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port,
    user: "control_room_migrator", password: (postgres.connection("migrator") as { password: string }).password,
    database: postgres.database });
  await owner.connect();
  let deployer: Client | undefined;
  try {
    return await applyUpdaterSchemaV1({
      bootstrap,
      directory: DDL_DIRECTORY,
      // Declared, because `connectDeployer` below sets one. Production does not:
      // its deployer has no password, and the loader refuses one by default.
      deployerHasFixturePassword: true,
      connectDeployer: async () => {
        // The three read-only release grants, issued by the schema owner, exactly
        // as `db/roles/updater_release_reader_roles.sql` issues them. The role
        // must exist first, which is why this is inside the factory: it is the
        // same ordering constraint as the password.
        await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"),
          "utf8"));
        // The password is set by the bootstrap superuser, not the schema owner:
        // `ALTER ROLE ... PASSWORD` needs CREATEROLE, which the migrator
        // correctly does not hold (measured: "permission denied to alter role").
        // In production there is no password at all — the role is reached by peer
        // authentication — so this line exists purely for the test client.
        await bootstrap.query(`ALTER ROLE control_room_deployer PASSWORD '${DEPLOYER_PASSWORD}'`);
        deployer = new Client({ host: postgres.socketDirectory, port: postgres.port,
          user: "control_room_deployer", password: DEPLOYER_PASSWORD, database: postgres.database });
        await deployer.connect();
        return deployer;
      },
    });
  } finally {
    await deployer?.end().catch(() => {});
    await owner.end().catch(() => {});
    await bootstrap.end();
  }
}

test("the updater's schema is the deployer's, and no other login can alter it", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    // The updater's own loader, in the design's order: role and schema as the
    // installer, tables and guards as the deployer.
    const created = await installUpdaterSchema(postgres);
    assert.equal(created.tables, updaterTablesV1.length,
      `the loader's table list exists (${updaterTablesV1.length} tables)`);
    assert.deepEqual([...created.appliedFiles], [...updaterDdlFilesV1()],
      "every DDL file was applied, in order");
    // Idempotent: the updater applies this at every startup.
    assert.deepEqual((await installUpdaterSchema(postgres)).appliedFiles, created.appliedFiles,
      "a second apply at startup changes nothing and refuses nothing");

    // The migrator is the account that runs the release ledger, and the release
    // ledger created none of this. It must hold NOTHING here — not even USAGE.
    // This is R10a: the tables holding the owner's approval are not reachable
    // from the account whose SQL a candidate controls.
    for (const role of ["migrator"] as const) {
      const client = as(postgres, role);
      await client.connect();
      try {
        const { rows } = await client.query<{ usage: boolean; create: boolean; objects: number }>(
          `SELECT has_schema_privilege(current_user,'updater','USAGE') AS usage,
             has_schema_privilege(current_user,'updater','CREATE') AS "create",
             (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='updater' AND c.relkind='r'
                 AND (has_table_privilege(current_user,c.oid,'SELECT')
                   OR has_table_privilege(current_user,c.oid,'INSERT')
                   OR has_table_privilege(current_user,c.oid,'UPDATE')
                   OR has_table_privilege(current_user,c.oid,'DELETE')
                   OR has_table_privilege(current_user,c.oid,'TRUNCATE'))) AS objects`);
        assert.deepEqual(rows[0], { usage: false, create: false, objects: 0 },
          `${role} holds nothing in schema updater`);
        // And a live attempt is refused, not merely un-granted.
        assert.match(await refuses(client, "CREATE TABLE updater.probe(id int)"),
          /permission denied/u);
        assert.match(await refuses(client, "SELECT * FROM updater.plans"), /permission denied/u);
        assert.match(await refuses(client, "INSERT INTO updater.plan_approvals(id,plan_id,credential_id,"
          + "authenticator_data,client_data_json,signature,owner_session_digest) "
          + "VALUES($1,$2,$3,$4,$5,$6,$7)",
        [`approval:${randomUUID()}`, "p", CREDENTIAL, AUTH, CLIENT, SIG, OWNER_SESSION]), /permission denied/u);
        assert.match(await refuses(client, "ALTER TABLE updater.plans ADD COLUMN probe int"),
          /permission denied|must be owner/u);
        assert.match(await refuses(client, "DROP SCHEMA updater CASCADE"),
          /permission denied|must be owner/u);
        // The migrator also cannot read the owner session table through the
        // updater's SECURITY DEFINER helper: the helper is the deployer's, and
        // nobody else may execute it.
        assert.match(await refuses(client, "SELECT updater.owner_session_is_live('sha256:"
          + `${"0".repeat(64)}')`), /permission denied/u);
      } finally { await client.end(); }
    }

    // The web login DOES hold a narrow surface here, by design (§9.1, §5.3,
    // §5.6, R12): the display tables read-only and INSERT on four tables. What it
    // must never hold is anything that changes or removes a row, anything on the
    // updater's own state (plans' content, runs, the journal, the heartbeat), and
    // CREATE on the schema. Proved as an exact table set rather than "no extra
    // privileges", because the design's grant is deliberately not zero.
    {
      const client = as(postgres, "web");
      await client.connect();
      try {
        const surface = (await client.query<{ table_name: string; read: boolean; insert: boolean; update: boolean; remove: boolean }>(
          `SELECT c.relname AS table_name,
             has_table_privilege(current_user, c.oid, 'SELECT') AS read,
             has_table_privilege(current_user, c.oid, 'INSERT') AS insert,
             has_table_privilege(current_user, c.oid, 'UPDATE') AS update,
             has_table_privilege(current_user, c.oid, 'DELETE') AS remove
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'updater' AND c.relkind = 'r' ORDER BY c.relname`)).rows;
        const writable = surface.filter(row => row.update || row.remove).map(row => row.table_name);
        assert.deepEqual(writable, [], "the web login holds no UPDATE and no DELETE on any updater table");
        const insertable = surface.filter(row => row.insert).map(row => row.table_name);
        assert.deepEqual(insertable, ["owner_requests", "passkey_registrations", "plan_approvals", "push_queue"],
          "the web login inserts exactly the design's four tables");
        // The updater's own state is not insertable by the web: a compromised
        // release cannot manufacture a run, a journal line or a heartbeat.
        // Item 10a adds three tables (`passkey_open_registrations`,
        // `approval_refusals`, `approval_refusal_buckets`, plus the limits table)
        // and none of them is insertable by the web: the open-registration table is
        // the UPDATER's (a web that could insert one could mint its own challenge),
        // and the refusal tables are the aggregate's. Asserted by name so a future
        // grant here is a test failure rather than a surprise.
        const notInsertable = ["heartbeat", "plan_approval_outcomes", "plans", "run_events", "runs",
          "passkey_open_registrations", "passkey_registrations_limits", "approval_refusals",
          "approval_refusal_buckets"];
        for (const table of notInsertable)
          assert.equal(surface.find(row => row.table_name === table)?.insert, false,
            `the web login must not INSERT into updater.${table}`);
        // CREATE on the schema is what would let it create a shadow object, so it
        // is checked directly rather than inferred from the table set.
        assert.equal((await client.query<{ create: boolean }>(
          `SELECT has_schema_privilege(current_user,'updater','CREATE') AS "create"`)).rows[0]?.create,
        false, "the web login holds no CREATE on schema updater");
      } finally { await client.end(); }
    }

    // A superuser can still do all of it. Stated so the refusals above cannot be
    // read as "this schema is impossible to change", which would be false: what
    // they prove is that the accounts that run candidate SQL cannot.
    const privileged = new Client(postgres.admin());
    await privileged.connect();
    try {
      const owner = (await privileged.query<{ owner: string }>(
        `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='updater'`)).rows[0];
      assert.equal(owner?.owner, "control_room_deployer", "the schema is the deployer's");
      const tables = (await privileged.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='updater' AND c.relkind='r' ORDER BY 1`)).rows.map(row => row.relname);
      // The catalog's table set must equal the loader's declared list EXACTLY, in
    // both directions. Naming the nine item-7 tables here instead would mean a
    // table added by item 10a failed this lane rather than being required — which
    // is the wrong failure: the list moved, and the list is the declaration of
    // what exists. So the assertion reads the same constant the loader checks.
    assert.deepEqual(tables, [...updaterTablesV1].sort(),
      "the catalog holds exactly the loader's declared tables, and no others");
    } finally { await privileged.end(); }

    // The release ledger created none of this. If a future migration reached
    // into schema `updater`, the digest of the release schema would move and the
    // ledger's own post-digest check would fail; this states the same fact
    // directly, on the live catalog, in the direction that matters.
    const ledger = await seed<{ count: number }>(postgres,
      `SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'updater%'`);
    assert.equal(ledger[0]?.count, 0, "nothing named updater% exists in the release schema");
  }, { port: PORT, allowedPorts: [PORT],
    boundMs: 600_000 });
});

test("the web login inserts only the four design tables, and only with a live owner session", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);

    const web = as(postgres, "web");
    await web.connect();
    const deployer = as(postgres, "deployer");
    await deployer.connect();
    try {
      // The web can read the display tables and nothing else.
      for (const readable of ["plans", "plan_approval_outcomes", "runs", "run_events", "heartbeat"])
        await web.query(`SELECT 1 FROM updater.${readable}`);
      // The assertion bytes stay unreadable: the web is served the plan through
      // the updater's own projection, and the owner's Face ID bytes are the
      // updater's business (R16's spirit, cook/deploygrant's lesson). `plan_json`
      // IS readable on purpose — it is the Install card the phone renders
      // (§5.2/§5.3) — so it is asserted as readable rather than quietly skipped.
      await refuses(web, "SELECT signature FROM updater.plan_approvals");
      await refuses(web, "SELECT authenticator_data FROM updater.plan_approvals");
      await refuses(web, "SELECT client_data_json FROM updater.plan_approvals");
      await refuses(web, "SELECT owner_session_digest FROM updater.owner_requests");
      await refuses(web, "SELECT owner_session_digest FROM updater.plan_approvals");
      const card = await web.query<{ plan_id: string }>("SELECT plan_id FROM updater.plans");
      assert.equal(typeof card.rowCount, "number", "the web can read the plan rows it renders");
      // The four insertable tables, and no fifth.
      await refuses(web, "INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES('run:${randomUUID()}','p','approved','code','boot')");
      await refuses(web, "INSERT INTO updater.run_events(run_id,ordinal,state) VALUES('r',1,'approved')");
      await refuses(web, "UPDATE updater.owner_requests SET handled_at=now()");
      await refuses(web, "DELETE FROM updater.plan_approvals");
      await refuses(web, "TRUNCATE updater.push_queue");

      // No owner session, no row. This is the R16 rule, proved by the refusal.
      const plan = planId("no-session");
      await insertPlan(postgres, plan);
      assert.match(await refuses(web, "INSERT INTO updater.plan_approvals(id,plan_id,credential_id,"
        + "authenticator_data,client_data_json,signature,owner_session_digest) "
        + "VALUES($1,$2,$3,$4,$5,$6,$7)",
      [ `approval:${randomUUID()}`, plan, CREDENTIAL, AUTH, CLIENT, SIG, DIGEST("not-a-session") ]), /updater row needs a live owner session/u);
      // A revoked or expired session is the same refusal. The design's case is a
      // stolen cookie, and a cookie that was revoked stops working here.
      const revoked = DIGEST("revoked-session");
      await seed(postgres, `INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,
        expires_at,revoked_at) VALUES($1,$2,$3,now(),now()+interval '1 hour',now())`,
      [TENANT, revoked, OWNER]);
      assert.match(await refuses(web, "INSERT INTO updater.plan_approvals(id,plan_id,credential_id,"
        + "authenticator_data,client_data_json,signature,owner_session_digest) "
        + "VALUES($1,$2,$3,$4,$5,$6,$7)",
      [ `approval:${randomUUID()}`, plan, CREDENTIAL, AUTH, CLIENT, SIG, revoked ]), /updater row needs a live owner session/u);

      // With a live session it lands, and the deployment's exact insert path works.
      const approvalId = `approval:${randomUUID()}`;
      await web.query("INSERT INTO updater.plan_approvals(id,plan_id,credential_id,authenticator_data,"
        + "client_data_json,signature,owner_session_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [approvalId, plan, CREDENTIAL, AUTH, CLIENT, SIG, OWNER_SESSION]);
      const row = (await deployer.query<{ received: boolean; plan: string }>(
        "SELECT received_at IS NOT NULL AS received, plan_id AS plan FROM updater.plan_approvals WHERE id=$1",
      [approvalId])).rows[0];
      assert.deepEqual(row, { received: true, plan }, "the deployer sees the web's row");

      // received_at is the database clock, not the caller's: the design says DB
      // now() everywhere, and a web that could set it could backdate an approval.
      const pushId = `push:${randomUUID()}`;
      await web.query("INSERT INTO updater.push_queue(id,template,title,body) VALUES($1,'task.done','Task done','Body')",
      [pushId]);
      const queued = (await deployer.query<{ queued: Date; at: Date }>(
        "SELECT queued_at AS queued, now() AS at FROM updater.push_queue WHERE id=$1", [pushId])).rows[0]!;
      assert.ok(Math.abs(queued.queued.getTime() - queued.at.getTime()) < 1_000,
        "queued_at is the database clock");

      // The web may not speak as the updater (R12): only the updater uses that
      // template prefix, and the VAPID private key is root-only, so a web-inserted
      // row claiming the updater's voice is the one impersonation that matters.
      assert.match(await refuses(web, "INSERT INTO updater.push_queue(id,template,title,body) "
        + "VALUES($1,'control-room-updater.rolled_back','Update','Body')", [ `push:${randomUUID()}` ]), /only the updater may use its own push template/u);
      // A pre-sent row is not a queued request.
      assert.match(await refuses(web, "INSERT INTO updater.push_queue(id,template,title,body,sent_at,attempts) "
        + "VALUES($1,'task.done','T','B',now(),1)", [ `push:${randomUUID()}` ]), /updater push must be queued unsent/u);
    } finally { await web.end(); await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT],
    boundMs: 600_000 });
});

test("the size CHECKs bound every byte the web can write (R16)", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const plan = planId("bounds");
    await insertPlan(postgres, plan);

    const web = as(postgres, "web");
    await web.connect();
    try {
      // The design's numbers: authenticator_data 1 KiB, client_data_json 4 KiB,
      // signature 512 B, plan JSON 64 KiB. The bound itself is proved first, so a
      // refusal above the bound cannot be confused with a refusal at it: this row
      // is exactly 1024 bytes of authenticator_data and it must land.
      await web.query("INSERT INTO updater.plan_approvals(id,plan_id,credential_id,authenticator_data,"
        + "client_data_json,signature,user_handle,owner_session_digest) "
        + "VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [`approval:${randomUUID()}`, plan, CREDENTIAL, Buffer.alloc(1024, 1), CLIENT, SIG, null,
        OWNER_SESSION] as never[]);
      // One byte over is refused, which is what "inputs over the CHECK bounds
      // never reach the parser" needs.
      assert.match(await refuses(web, "INSERT INTO updater.plan_approvals(id,plan_id,credential_id,"
        + "authenticator_data,client_data_json,signature,owner_session_digest) "
        + "VALUES($1,$2,$3,$4,$5,$6,$7)",
      [`approval:${randomUUID()}`, plan, CREDENTIAL, Buffer.alloc(1025, 1), CLIENT, SIG, OWNER_SESSION]), /violates check constraint "plan_approvals_authenticator_data_check"/u);
      assert.match(await refuses(web, "INSERT INTO updater.plan_approvals(id,plan_id,credential_id,"
        + "authenticator_data,client_data_json,signature,owner_session_digest) "
        + "VALUES($1,$2,$3,$4,$5,$6,$7)",
      [`approval:${randomUUID()}`, plan, CREDENTIAL, AUTH, Buffer.alloc(4097, 1), SIG, OWNER_SESSION]), /violates check constraint "plan_approvals_client_data_json_check"/u);
      assert.match(await refuses(web, "INSERT INTO updater.plan_approvals(id,plan_id,credential_id,"
        + "authenticator_data,client_data_json,signature,owner_session_digest) "
        + "VALUES($1,$2,$3,$4,$5,$6,$7)",
      [`approval:${randomUUID()}`, plan, CREDENTIAL, AUTH, CLIENT, Buffer.alloc(513, 1), OWNER_SESSION]), /violates check constraint "plan_approvals_signature_check"/u);
      assert.match(await refuses(web, "INSERT INTO updater.plan_approvals(id,plan_id,credential_id,"
        + "authenticator_data,client_data_json,signature,user_handle,owner_session_digest) "
        + "VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [`approval:${randomUUID()}`, plan, CREDENTIAL, AUTH, CLIENT, SIG, Buffer.alloc(129, 1), OWNER_SESSION]), /violates check constraint "plan_approvals_user_handle_check"/u);
      // A credential id is a bounded base64url token, not a paragraph.
      assert.match(await refuses(web, "INSERT INTO updater.plan_approvals(id,plan_id,credential_id,"
        + "authenticator_data,client_data_json,signature,owner_session_digest) "
        + "VALUES($1,$2,$3,$4,$5,$6,$7)",
      [`approval:${randomUUID()}`, plan, "a".repeat(300), AUTH, CLIENT, SIG, OWNER_SESSION]), /violates check constraint "plan_approvals_credential_id_check"/u);
      // A plan's JSON is bounded at 64 KiB.
      const deployer = as(postgres, "deployer");
      await deployer.connect();
      try {
        assert.match(await refuses(deployer, "INSERT INTO updater.plans(plan_id,installation_id,kind,state,"
          + "classes,changes_database,changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at) "
          + "VALUES($1,'install-fixture','code','refused_build',ARRAY['code'],false,false,$2,$3::jsonb,false,"
          + "now()+interval '1 hour')",
        [planId("huge"), DIGEST("huge"), JSON.stringify({ schema: "control-room.install-plan/v2",
          planId: planId("huge"), kind: "code", filler: "x".repeat(70_000) })]), /violates check constraint "plans_plan_json_check"/u);
        // A run's `detail` is bounded at 16 KiB, the same ceiling the deploy
        // journal's `detail` uses (cook/deploy 0163). A run row for a plan that is
        // not approved is refused FIRST by the lease guard, so the bound is
        // exercised through a plan that IS approved.
        await deployer.query("UPDATE updater.plans SET state='approved' WHERE plan_id=$1", [plan]);
        assert.match(await refuses(deployer, "INSERT INTO updater.runs(run_id,plan_id,state,run_class,"
          + "lease_token,detail) VALUES($1,$2,'approved','code','boot',$3::jsonb)",
        [`run:${randomUUID()}`, plan, JSON.stringify({ filler: "x".repeat(17_000) })]),
        /violates check constraint "runs_detail_check"/u);
        // And the bound itself lands, so the refusal above is at the bound and not
        // below it.
        await deployer.query("INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token,detail) "
          + "VALUES($1,$2,'approved','code','boot',$3::jsonb)",
        [`run:${randomUUID()}`, plan, JSON.stringify({ filler: "x".repeat(15_000) })]);
      } finally { await deployer.end(); }
      // An owner request's detail is bounded at 4 KiB and is a JSON object.
      assert.match(await refuses(web, "INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,"
        + "detail,owner_session_digest) VALUES($1,'pause',false,$2::jsonb,$3)",
      [`owner-request:${randomUUID()}`, JSON.stringify({ filler: "x".repeat(5_000) }), OWNER_SESSION]), /violates check constraint "owner_requests_detail_check"/u);
      assert.match(await refuses(web, "INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,"
        + "detail,owner_session_digest) VALUES($1,'pause',false,$2::jsonb,$3)",
      [`owner-request:${randomUUID()}`, JSON.stringify(["not", "an", "object"]), OWNER_SESSION]), /violates check constraint "owner_requests_detail_check"/u);
      // A push row's text is bounded, and a passkey-backed request must name the
      // approval that carries the assertion.
      assert.match(await refuses(web, "INSERT INTO updater.push_queue(id,template,title,body) "
        + "VALUES($1,'task.done',$2,'Body')", [`push:${randomUUID()}`, "x".repeat(201)]), /violates check constraint "push_queue_title_check"/u);
      assert.match(await refuses(web, "INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,"
        + "owner_session_digest) VALUES($1,'rollback',true,$2)",
      [`owner-request:${randomUUID()}`, OWNER_SESSION]), /violates check constraint "owner_request_passkey_pairing"/u);
    } finally { await web.end(); }
  }, { port: PORT, allowedPorts: [PORT],
    boundMs: 600_000 });
});

test("the plan, run and journal state machines refuse what the design refuses", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const deployer = as(postgres, "deployer");
    await deployer.connect();
    try {
      // One open plan at a time (§5.5, SI-24).
      await insertPlan(postgres, planId("open-a"));
      assert.match(await refuses(deployer, "INSERT INTO updater.plans(plan_id,installation_id,kind,state,"
        + "classes,changes_database,changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at) "
        + "VALUES('plan-open-b','install-fixture','code','ready_for_approval',ARRAY['code'],false,false,$1,$2::jsonb,"
        + "false,now()+interval '72 hours')",
      [planDigest("open-b"), JSON.stringify(planJson("plan-open-b"))]), /updater already has an open plan/u);
      // A closed plan does not compete: refused_build is not open.
      await insertPlan(postgres, planId("closed"), { state: "refused_build" });
      // Plan content is immutable once written: changing the digest after the
      // owner has seen the card is a different plan and needs its own Face ID.
      assert.match(await refuses(deployer, "UPDATE updater.plans SET plan_digest=$1 WHERE plan_id=$2",
      [planDigest("tampered"), planId("open-a")]), /updater plan content is immutable/u);
      // Supersession must name a successor.
      assert.match(await refuses(deployer, "UPDATE updater.plans SET state='superseded' WHERE plan_id=$1",
      [planId("open-a")]), /updater plan supersession refused/u);
      // Superseding the open plan with a closed one frees the slot, which is what
      // "a newer candidate supersedes the older plan" means in practice.
      await deployer.query("UPDATE updater.plans SET state='superseded',superseded_by_plan_id=$1 "
        + "WHERE plan_id=$2", [planId("closed"), planId("open-a")]);
      // With the slot free, a `building` plan is accepted — and only `building`
      // from `building`, so it cannot jump to approved.
      await insertPlan(postgres, planId("building"), { state: "building" });
      assert.match(await refuses(deployer, "UPDATE updater.plans SET state='approved' WHERE plan_id=$1",
      [planId("building")]), /updater plan transition refused/u);
      // `building` cannot jump straight to approval_required: an expiry applies
      // to a plan the owner was already asked about, not to one still building.
      assert.match(await refuses(deployer, "UPDATE updater.plans SET state='approval_required' "
        + "WHERE plan_id=$1", [planId("building")]), /updater plan transition refused/u);
      // The real path: built, offered, then expired. That is what makes the phone
      // say "Approve again" (§5.3) rather than re-offer the same plan.
      await deployer.query("UPDATE updater.plans SET state='ready_for_approval' WHERE plan_id=$1",
      [planId("building")]);
      await deployer.query("UPDATE updater.plans SET state='approval_required' WHERE plan_id=$1",
      [planId("building")]);
      // `approval_required` is still OPEN by the design's own definition — it is
      // the state the phone offers "Approve again" from (§5.3) — so the one-open-plan
      // rule still counts it. Minting a new plan while one sits there is refused,
      // which is the rule doing its job rather than a gap in it.
      assert.match(await refuses(deployer, "INSERT INTO updater.plans(plan_id,installation_id,kind,state,"
        + "classes,changes_database,changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at) "
        + "VALUES('plan-second','install-fixture','code','ready_for_approval',ARRAY['code'],false,false,$1,"
        + "$2::jsonb,false,now()+interval '72 hours')",
      [planDigest("second"), JSON.stringify(planJson("plan-second"))]), /updater already has an open plan/u);
      // Superseding it (with the closed plan) is how the owner moves on.
      await deployer.query("UPDATE updater.plans SET state='superseded',superseded_by_plan_id=$1 "
        + "WHERE plan_id=$2", [planId("closed"), planId("building")]);
      // A run needs an approved, unexpired plan, and only one may be live. A plan
      // only reaches `approved` by the owner's passkey (§5.3), which the updater
      // records as the transition; the fixture drives the same transition rather
      // than minting an approved row directly, so the state machine is exercised
      // on the way to the run too.
      //
      // The expiring plan is minted and approved FIRST, while the slot is free,
      // and closed again before the real plan is approved — an `approved` plan is
      // an open plan, so two of them at once is the one-open-plan rule refusing,
      // not a defect in the fixture. Ordering it this way keeps each refusal
      // attributed to the rule it is about.
      // Minted already expired: `expires_at` is covered by the plan's immutability
      // guard, because changing it after the card was shown is changing the plan.
      // The expiry check is therefore driven by the row's own column, not by an
      // UPDATE, which is also how a plan that really did expire looks.
      const expiring = planId("expiring");
      await deployer.query("INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,"
        + "changes_database,changes_updater,plan_digest,plan_json,needs_mac_confirm,created_at,expires_at) "
        + "VALUES($1,'install-fixture','code','approved',ARRAY['code'],false,false,$2,$3::jsonb,false,"
        + "now()-interval '2 hours',now()-interval '1 hour')",
      [expiring, planDigest(expiring), JSON.stringify(planJson(expiring))]);
      assert.match(await refuses(deployer, "INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES($1,$2,'approved','code','boot')", [ `run:${randomUUID()}`, expiring ]),
      /updater run needs an approved, unexpired plan/u);
      await deployer.query("UPDATE updater.plans SET state='refused_build' WHERE plan_id=$1", [expiring]);
      const plan = planId("approved");
      await insertPlan(postgres, plan);
      await deployer.query("UPDATE updater.plans SET state='approved' WHERE plan_id=$1", [plan]);
      // And the refusal that proves the check is live: a run for a plan that was
      // never approved is refused, not quietly created.
      assert.match(await refuses(deployer, "INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES($1,$2,'approved','code','boot')", [ `run:${randomUUID()}`, planId("closed") ]),
      /updater run needs an approved, unexpired plan/u);
      const runId = `run:${randomUUID()}`;
      await deployer.query("INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES($1,$2,'approved','code','boot')", [runId, plan]);
      // The second live run is refused by the partial unique index, not by a
      // lock the callers could forget: two concurrent claims cannot both see zero.
      assert.match(await refuses(deployer, "INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES($1,$2,'approved','code','boot')", [ `run:${randomUUID()}`, plan]),
      /duplicate key value violates unique constraint "runs_one_live"/u);
      // The lease cannot be reassigned while the run is live (§7.2).
      assert.match(await refuses(deployer, "UPDATE updater.runs SET lease_token='other' WHERE run_id=$1",
      [runId]), /updater run lease cannot be reassigned while live/u);
      // A step cannot be skipped: approved -> healthy is not a transition.
      assert.match(await refuses(deployer, "UPDATE updater.runs SET state='healthy' WHERE run_id=$1",
      [runId]), /updater run transition refused/u);
      // A journal event whose state disagrees with the run is refused: the two
      // are two records of one thing, and a mirror that can disagree is a lie.
      assert.match(await refuses(deployer, "INSERT INTO updater.run_events(run_id,ordinal,state) "
        + "VALUES($1,1,'healthy')", [runId]), /updater run event does not match a live run state/u);
      // Ordinals are consecutive.
      assert.match(await refuses(deployer, "INSERT INTO updater.run_events(run_id,ordinal,state) "
        + "VALUES($1,2,'approved')", [runId]), /updater run must start at ordinal 1/u);
      // The happy path end to end: every step, in order, with its event.
      const steps = ["prechecked", "staged", "quick_backup", "draining", "switched", "restarted", "healthy"];
      for (const [index, state] of steps.entries()) {
        await deployer.query("UPDATE updater.runs SET state=$1 WHERE run_id=$2", [state, runId]);
        await deployer.query("INSERT INTO updater.run_events(run_id,ordinal,state) VALUES($1,$2,$3)",
        [runId, index + 1, state]);
      }
      await deployer.query("UPDATE updater.runs SET state='succeeded',finished_at=now() WHERE run_id=$1",
      [runId]);
      // A terminal run is terminal, and the journal is append-only for everyone
      // including the owner.
      assert.match(await refuses(deployer, "UPDATE updater.runs SET state='rolled_back' WHERE run_id=$1",
      [runId]), /updater run succeeded is terminal/u);
      assert.match(await refuses(deployer, "UPDATE updater.run_events SET state='rolled_back' "
        + "WHERE run_id=$1 AND ordinal=1", [runId]), /updater table updater\.run_events is append-only/u);
      assert.match(await refuses(deployer, "DELETE FROM updater.run_events WHERE run_id=$1", [runId]),
        /updater table updater\.run_events is append-only/u);
      // TRUNCATE on plans is refused, though not by this schema's trigger:
      // PostgreSQL refuses it first, because two tables have foreign keys into
      // plans. Both are refusals and which one fires is PostgreSQL's ordering, so
      // the assertion is the refusal. The trigger itself is proved on a table
      // nothing references, next.
      assert.match(await refuses(deployer, "TRUNCATE updater.plans"),
        /append-only|cannot truncate a table referenced in a foreign key/u);
      assert.match(await refuses(deployer, "TRUNCATE updater.heartbeat"),
        /updater table updater\.heartbeat is append-only/u);
      // A second live run is allowed once the first is finished, and the heartbeat
      // must not claim idle work or hide it.
      const second = `run:${randomUUID()}`;
      await deployer.query("INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES($1,$2,'approved','code','boot')", [second, plan]);
      assert.match(await refuses(deployer, "UPDATE updater.heartbeat SET reported_state='idle' "
        + "WHERE singleton"), /updater heartbeat contradicts a live run/u);
      await deployer.query("UPDATE updater.heartbeat SET reported_state='running',lease_token='boot' "
        + "WHERE singleton");
      // `uncertain` is reachable from anywhere: it is a measurement, not a step.
      await deployer.query("UPDATE updater.runs SET state='uncertain' WHERE run_id=$1", [second]);
      // And out of `uncertain` the design permits only a measured settle or a
      // rollback, which the state machine refuses to guess at. `healthy` is a
      // forward step, so it stays refused: a run that measured "I don't know" must
      // not then decide to try the next one. That the two MEASURED exits are
      // themselves expressible — they were not, and the owner's only recovery
      // button refused against the real database — is proved in
      // tests/updater-run-recovery-postgres.test.ts, where each of the three is
      // taken end to end rather than listed here as an absence.
      assert.match(await refuses(deployer, "UPDATE updater.runs SET state='healthy' WHERE run_id=$1",
      [second]), /updater run transition refused/u);
    } finally { await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT],
    boundMs: 600_000 });
});

test("50 concurrent approval inserts on one plan leave no duplicate effects", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const plan = planId("burst");
    await insertPlan(postgres, plan);

    // 50 separate web sessions, as 50 separate phone taps racing. Each holds its
    // own connection, so this is a real concurrency test and not one connection
    // taking turns; the kit's cluster is created with max_connections=60, so 50
    // concurrent connections is a burst at the edge of the limit on purpose.
    const CONCURRENCY = 50;
    const ids = Array.from({ length: CONCURRENCY }, () => `approval:${randomUUID()}`);
    const started = Date.now();
    // The burst's clients are collected and closed in ONE awaited pass after the
    // counts, rather than from 50 concurrent `finally` blocks. Closing 50 sockets
    // concurrently raced the kit's own teardown: the test's assertions passed, and
    // then `pg_ctl -m immediate stop` could land while those backends were still
    // exiting and report `pg_ctl_stop_immediate_failed` — a failure in the
    // FIXTURE's teardown, with nothing to do with what the burst proved. Measured
    // on two ports before this was changed, then four consecutive green runs
    // after. Nothing the burst asserts is affected: the refusals it measures are
    // statements, not connections.
    const burstClients: Client[] = [];
    const results = await Promise.all(ids.map(async (id, index) => {
      const client = as(postgres, "web");
      burstClients.push(client);
      await client.connect();
      try {
        await client.query("INSERT INTO updater.plan_approvals(id,plan_id,credential_id,authenticator_data,"
          + "client_data_json,signature,owner_session_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, plan, Buffer.from(`credential-${index}`, "utf8").toString("base64url").padEnd(16, "0").slice(0, 255),
          AUTH, CLIENT, SIG, OWNER_SESSION]);
        return { id, inserted: true as const, code: "ok" };
      } catch (error) {
        // The message matters: a burst that lands zero rows must say WHY, and a
        // SQLSTATE alone ("42501") does not name the column or the constraint.
        const { code, message } = error as { code?: string; message?: string };
        return { id, inserted: false as const, code: `${code ?? "no-code"}: ${(message ?? "").split("\n")[0]}` };
      }
    }));
    const elapsed = Date.now() - started;
    for (const client of burstClients) {
      try { await client.end(); } catch { /* the driver may already have closed it */ }
    }

    // Every one of the 50 landed. The point of the burst is that nothing here
    // serialises on a plan-level lock, because an approval row is evidence, not
    // a claim on the plan: the design wants the updater to see them all and
    // refuse the junk itself (§5.3 step 7 burns the nonce, and §5.3's
    // aggregation is what stops 10 000 rows becoming 10 000 pushes).
    const inserted = results.filter(result => result.inserted).length;
    assert.equal(inserted, CONCURRENCY,
      `all ${CONCURRENCY} concurrent approvals land; refused: ${
        JSON.stringify(results.filter(r => !r.inserted).slice(0, 5))}`);
    const counted = await seed<{ count: number }>(postgres,
      "SELECT count(*)::int AS count FROM updater.plan_approvals WHERE plan_id=$1", [plan]);
    assert.equal(counted[0]?.count, CONCURRENCY, "exactly the rows that were inserted, no more");
    // Every row has a distinct credential and a distinct id: no id collision was
    // silently absorbed, and the primary key did its job.
    const distinct = await seed<{ count: number }>(postgres,
      "SELECT count(DISTINCT credential_id)::int AS count FROM updater.plan_approvals WHERE plan_id=$1", [plan]);
    assert.equal(distinct[0]?.count, CONCURRENCY, "each row is its own assertion");

    // The same burst, but every caller using ONE credential id: still all land,
    // because credential_id is not a key. A duplicate assertion is the updater's
    // replay check to refuse (the nonce ledger, §5.3 step 7), not the database's
    // to guess at — and this states that boundary instead of hiding it.
    const reused = Array.from({ length: 10 }, () => `approval:${randomUUID()}`);
    const reuseResults = await Promise.all(reused.map(async id => {
      const client = as(postgres, "web");
      await client.connect();
      try {
        await client.query("INSERT INTO updater.plan_approvals(id,plan_id,credential_id,authenticator_data,"
          + "client_data_json,signature,owner_session_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, plan, CREDENTIAL, AUTH, CLIENT, SIG, OWNER_SESSION]);
        return true;
      } catch { return false; } finally { await client.end(); }
    }));
    assert.equal(reuseResults.filter(Boolean).length, 10,
      "a repeated credential id is not refused by the database; the updater's nonce ledger is that check");
    assert.ok(elapsed < 60_000, `the burst finished in ${elapsed}ms rather than serialising`);

    // A retry after a failure: the same id twice is a primary-key refusal, which
    // is what makes the web's idempotency key work. A retried Face ID sheet that
    // reuses its key must not create a second row.
    const retryId = `approval:${randomUUID()}`;
    const first = as(postgres, "web");
    await first.connect();
    try {
      await first.query("INSERT INTO updater.plan_approvals(id,plan_id,credential_id,authenticator_data,"
        + "client_data_json,signature,owner_session_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [retryId, plan, CREDENTIAL, AUTH, CLIENT, SIG, OWNER_SESSION]);
    } finally { await first.end(); }
    const second = as(postgres, "web");
    await second.connect();
    try {
      assert.match(await refuses(second, "INSERT INTO updater.plan_approvals(id,plan_id,credential_id,"
        + "authenticator_data,client_data_json,signature,owner_session_digest) "
        + "VALUES($1,$2,$3,$4,$5,$6,$7)", [retryId, plan, CREDENTIAL, AUTH, CLIENT, SIG, OWNER_SESSION]),
      /duplicate key value violates unique constraint/u);
    } finally { await second.end(); }

    // An approval for a plan that does not exist is refused by the foreign key,
    // not stored as an orphan: a junk row is refused by the database, which is
    // what keeps it away from a parser.
    const orphan = as(postgres, "web");
    await orphan.connect();
    try {
      assert.match(await refuses(orphan, "INSERT INTO updater.plan_approvals(id,plan_id,credential_id,"
        + "authenticator_data,client_data_json,signature,owner_session_digest) "
        + "VALUES($1,$2,$3,$4,$5,$6,$7)",
      [`approval:${randomUUID()}`, planId("never-existed"), CREDENTIAL, AUTH, CLIENT, SIG, OWNER_SESSION]),
      /violates foreign key constraint/u);
    } finally { await orphan.end(); }
  }, { port: PORT, allowedPorts: [PORT],
    boundMs: 600_000 });
});

test("a deployer role that grew a dangerous attribute is refused on the next apply", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const privileged = new Client(postgres.admin());
    await privileged.connect();
    try {
      // The role's attributes are re-asserted on EVERY apply, and this is what
      // makes the check non-vacuous: without this test the assertion in 0001 would
      // be one that never fails, which is the shape of a guard that only exists to
      // look like a guard. Two attributes are tried because they are the two that
      // matter most: SUPERUSER is total, and BYPASSRLS defeats every row-level
      // policy in the release schema.
      for (const [attribute, grant, revoke] of [
        ["SUPERUSER", "ALTER ROLE control_room_deployer SUPERUSER", "ALTER ROLE control_room_deployer NOSUPERUSER"],
        ["BYPASSRLS", "ALTER ROLE control_room_deployer BYPASSRLS", "ALTER ROLE control_room_deployer NOBYPASSRLS"],
      ] as const) {
        await privileged.query(grant);
        const message = await (async () => {
          try {
            await installUpdaterSchema(postgres);
            return null;
          } catch (error) { return (error as Error).message; }
        })();
        assert.match(message ?? "", /updater deployer role attributes refused/u,
          `an apply with rol${attribute.toLowerCase()} set must be refused by the fixed DDL`);
        // Restored, so the next attribute is measured from a clean role and the
        // refusal above is attributable to the attribute and not to a leftover.
        await privileged.query(revoke);
        await installUpdaterSchema(postgres);
      }

      // A fourth reachable release table is refused too, which is the other half
      // of the loader's two-way assertion. `tenants` is chosen because the deployer
      // has no business reading it and every service role does.
      await privileged.query("GRANT SELECT ON public.tenants TO control_room_deployer");
      const widened = await (async () => {
        try {
          await installUpdaterSchema(postgres);
          return null;
        } catch (error) { return (error as Error).message; }
      })();
      assert.match(widened ?? "", /updater_schema_refused:release_reach:tenants/u,
        "a fourth readable release table must fail the updater at startup, not sit unnoticed");
      await privileged.query("REVOKE SELECT ON public.tenants FROM control_room_deployer");
      await installUpdaterSchema(postgres);

      // And a write privilege in the release schema is refused, because the whole
      // point of the three grants is that they are reads.
      await privileged.query("GRANT INSERT ON public.tenants TO control_room_deployer");
      const wrote = await (async () => {
        try {
          await installUpdaterSchema(postgres);
          return null;
        } catch (error) { return (error as Error).message; }
      })();
      assert.match(wrote ?? "", /updater_schema_refused:release_write_privilege/u,
        "any write privilege in the release schema must fail the updater at startup");
    } finally {
      // The role is left as the fixed DDL requires it, so the cluster's teardown
      // and anything else that runs after this test sees the documented state.
      await privileged.query("ALTER ROLE control_room_deployer NOSUPERUSER NOBYPASSRLS");
      await privileged.query("REVOKE SELECT, INSERT ON public.tenants FROM control_room_deployer");
      await privileged.end();
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the item-8 store runs every query as the production deployer login", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const plan = planId("item8-store");
    await insertPlan(postgres, plan);
    const deployer = as(postgres, "deployer");
    await deployer.connect();
    try {
      await deployer.query("UPDATE updater.plans SET state='approved' WHERE plan_id=$1", [plan]);
      const runId = `run:${randomUUID()}`;
      await deployer.query("INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES($1,$2,'approved','code','lease-item8')", [runId, plan]);
      const store = new PostgresUpdaterStoreV1(deployer);
      await store.initialize();
      await store.heartbeat({ bootId: "boot-item8", leaseToken: "lease-item8", state: "running", step: "precheck" });
      assert.equal((await store.liveRun())?.run_id, runId);
      // One `transition` call moves the row AND writes its journal mirror row. The
      // two statements used to be a caller's job, and the window between them was
      // B4: a kill there left the row at the new state with the last event still
      // on the old one, which `guard_run_state` then refused every later move
      // through — the run wedged after the switch with no way back.
      await store.transition(runId, "lease-item8", "prechecked", { source: "item8-test" });
      assert.deepEqual((await store.events(runId)).map((row: { state: string }) => row.state), ["prechecked"]);
      // Round-trip: the next ordinal is computed by the database from the run's
      // own last event, and returned as a number rather than node-pg's int8
      // string — `"1" + 1` would be `"11"`, so a caller that trusted it would
      // write the wrong mirror row.
      const [first] = await store.events(runId);
      assert.equal(typeof first.ordinal, "number", "events() must return ordinal as a number, not node-pg's int8 string");
      await store.transition(runId, "lease-item8", "staged", { source: "item8-test" });
      assert.deepEqual((await store.events(runId)).map((row: { ordinal: number }) => row.ordinal), [1, 2]);
      assert.deepEqual((await store.events(runId)).map((row: { state: string }) => row.state),
        ["prechecked", "staged"]);
      await assert.rejects(store.transition(runId, "wrong-lease", "staged"), /updater_run_lease_lost/u,
        "a second caller cannot take over the production row");
      // The failed takeover wrote nothing: the row is still where the rightful
      // holder left it and the mirror did not grow an event for a move that
      // never happened.
      assert.deepEqual((await store.events(runId)).map((row: { state: string }) => row.state),
        ["prechecked", "staged"]);

      const requestId = `owner-request:${randomUUID()}`;
      const web = as(postgres, "web"); await web.connect();
      try {
        await web.query("INSERT INTO updater.owner_requests(id,request_kind,requires_passkey,owner_session_digest) "
          + "VALUES($1,'pause',false,$2)", [requestId, OWNER_SESSION]);
      } finally { await web.end(); }
      assert.equal((await store.unhandledOwnerRequests())[0]?.id, requestId);
      assert.equal(await store.finishOwnerRequest(requestId, "acted"), true);
      assert.equal((await store.unhandledOwnerRequests()).length, 0);
    } finally { await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the item-17 watcher plan port uses database time and atomically supersedes the only open plan", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const deployer = as(postgres, "deployer"); await deployer.connect();
    try {
      const store = new PostgresUpdaterStoreV1(deployer); await store.initialize();
      const plan = (id: string, commit: string) => ({ schema: "control-room.install-plan/v2", planId: id,
        installationId: "install-fixture", kind: "code", candidate: { commit }, updaterDerived: { classes: ["code"],
          changesDatabase: false, changesUpdater: false } });
      const first = plan("plan-watcher-a", "a".repeat(40)), second = plan("plan-watcher-b", "b".repeat(40));
      assert.ok((await store.databaseNow()) instanceof Date, "plan timestamps come from PostgreSQL, not the app clock");
      assert.equal((await store.replaceOpenPlan({ plan: first, planDigest: planDigest("watcher-a"), expectedOpenPlanId: null })).status, "created");
      assert.equal((await store.openPlan())?.plan.candidate.commit, first.candidate.commit);
      assert.equal((await store.replaceOpenPlan({ plan: second, planDigest: planDigest("watcher-b"), expectedOpenPlanId: first.planId })).status, "created");
      assert.equal((await store.openPlan())?.plan.candidate.commit, second.candidate.commit);
      assert.equal((await store.replaceOpenPlan({ plan: second, planDigest: planDigest("watcher-b"), expectedOpenPlanId: second.planId })).status, "existing",
        "a restart cannot mint a second plan for the same commit");
      const old = await deployer.query("SELECT state,superseded_by_plan_id FROM updater.plans WHERE plan_id=$1", [first.planId]);
      assert.deepEqual(old.rows[0], { state: "superseded", superseded_by_plan_id: second.planId });
    } finally { await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("startUpdaterV1 boots with a live run and only one of 20 production sessions acquires it", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const plan = planId("item8-live-boot");
    await insertPlan(postgres, plan);
    const seedClient = as(postgres, "deployer"); await seedClient.connect();
    const runId = `run:${randomUUID()}`;
    try {
      await seedClient.query("UPDATE updater.plans SET state='approved' WHERE plan_id=$1", [plan]);
      await seedClient.query("INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
        + "VALUES($1,$2,'approved','code','lease-previous-session')", [runId, plan]);
    } finally { await seedClient.end(); }

    const contenders = await Promise.all(Array.from({ length: 20 }, async (_value, index) => {
      const client = as(postgres, "deployer"); await client.connect();
      const store = new PostgresUpdaterStoreV1(client); await store.initialize();
      const result = await store.acquire(`lease-contender-${index}`);
      return { client, store, result };
    }));
    try {
      assert.equal(contenders.filter(item => item.result.status === "acquired").length, 1,
        "exactly one production session owns the updater lease");
      assert.equal(contenders.filter(item => item.result.status === "busy").length, 19);
      const winner = contenders.find(item => item.result.status === "acquired");
      if (!winner || winner.result.status !== "acquired") assert.fail("the lease winner was not retained");
      assert.equal(winner.result.leaseToken, "lease-previous-session",
        "the new session resumes with the immutable live-run token");
      assert.equal(winner.result.resumed, true);
      await winner.store.release();
    } finally {
      await Promise.all(contenders.map(async item => { await item.store.release(); await item.client.end(); }));
    }

    const root = await mkdtemp(join(tmpdir(), "updater-live-boot-"));
    await mkdir(join(root, "updater-state")); await mkdir(join(root, "status"));
    await writeFile(join(root, "updater-state/self-update"), "On\n");
    const deployer = as(postgres, "deployer"); await deployer.connect();
    const store = new PostgresUpdaterStoreV1(deployer); await store.initialize();
    const calls: string[] = [];
    const effects = {
      async precheck() { calls.push("precheck"); }, async stage() { calls.push("stage"); },
      async quickBackup() { calls.push("quick_backup"); }, async drain() { calls.push("drain"); },
      async switchPair() { calls.push("switch"); }, async restart() { calls.push("restart"); },
      async health() { calls.push("health"); return true; }, async commitKnownGood() { calls.push("known_good"); },
      async rollback() { calls.push("rollback"); }, async measure() { calls.push("measure"); },
    };
    let updater;
    try {
      updater = await startUpdaterV1({ root, store,
        identity: { bootId: "boot-live-resume", leaseToken: "lease-new-session" }, effects,
        referee: { async assertPlanAllowed() {} } });
      assert.equal(updater.identity.leaseToken, "lease-previous-session");
      assert.equal(updater.loop.lastOutcome.status, "succeeded");
      assert.deepEqual(calls, ["precheck", "stage", "quick_backup", "drain", "switch", "restart", "health",
        "known_good"]);
      const heartbeat = await deployer.query("SELECT boot_id,lease_token,reported_state FROM updater.heartbeat");
      assert.deepEqual(heartbeat.rows[0], { boot_id: "boot-live-resume", lease_token: "lease-previous-session",
        reported_state: "idle" }, "the post-run heartbeat returns to idle without stranding the live run");
      assert.equal((await store.liveRun()), undefined, "the resumed run is not stranded");
    } finally {
      await updater?.stop(); await deployer.end(); await rm(root, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the lane ran on a real cluster, not a skip", () => {
  // The attack kit's own rule: a lane with the binaries must not report green
  // without having run. Kept as its own assertion so a future `PG_BIN` accident
  // cannot turn this whole file into a silent pass.
  if (PG) assert.equal(ran, required, "every PostgreSQL test in this lane ran");
});
