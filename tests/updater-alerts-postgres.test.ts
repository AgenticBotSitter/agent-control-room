// Real-PostgreSQL proof for item 21's alert path, run on PostgreSQL 17 as the
// PRODUCTION logins and never as a superuser: the deployer
// (control_room_deployer) and the web (control_room_web, a member of
// control_room_private_web). The superuser connection only seeds fixtures.
//
// What this lane proves, in the order the review blockers ask for it:
//
//   1. BLOCKER 2, the half the old guard got backwards. `updater.guard_push_insert`
//      refused the `control-room-updater%` template prefix for EVERY role,
//      including the updater's own deployer login, so the updater could never
//      queue a single one of its own alerts. Measured here as the two halves
//      that the original test was missing: the WEB is still refused the prefix,
//      and the DEPLOYER is accepted — the same statement, both logins.
//
//   2. The passkey rules the merge brought in COMPOSE with that prefix rule. The
//      web is refused a push idempotency key and a scheduled `not_before`; the
//      deployer may set both (its own cooling-off notices need them). The prefix
//      exemption is the updater's only, and it does not become a licence to
//      schedule a web row.
//
//   3. The alert path end to end on a real cluster: a CONDITION OCCURS, the
//      updater queues a row through the real `PostgresUpdaterStoreV1.queue()`,
//      and the real `UpdaterAlertSenderV1` sends EXACTLY ONE payload for it. The
//      send is a fake endpoint function, so no real push service is contacted;
//      the queue, the trigger, the accounting and the rate limit are all real.
//
//   4. `store.subscriptions()` is reachable by the DEPLOYER login at all. This
//      is asserted because the column grant and the query have to agree: the
//      role file grants `SELECT (tenant_id, id, expires_at)` on
//      `owner_web_push_subscriptions`, and the sender's query asks for
//      `endpoint, p256dh, auth` as well. A mismatch is a refusal at runtime, in
//      the one process that is supposed to be able to alert.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { UpdaterAlertSenderV1 } from "../src/updater/v1/alerts.mjs";
import { PostgresUpdaterStoreV1 } from "../src/updater/v1/store.mjs";
import { applyUpdaterSchemaV1, updaterDdlFilesV1, type UpdaterSchemaResultV1 } from "../src/updater/v1/schema-installer";

// The lane owns the port: this file runs inside `test:updater-schema`, which
// passes `CONTROL_ROOM_PG_TEST_PORT_BASE`, so it takes the same cluster slot
// rather than hardcoding one of its own and racing a sibling lane for it.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59830), PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const DEPLOYER_PASSWORD = "fixture-deployer";
const DDL_DIRECTORY = join(process.cwd(), "src/updater/v1/ddl");
const TENANT = "tenant:alerts-pg";
const SUBSCRIPTION_ID = `push:${"b".repeat(64)}`;
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/fixture-endpoint";
const VAPID = Object.freeze({ schema: "control-room.updater-vapid/v1", subject: "mailto:owner@example.invalid",
  publicKey: "A".repeat(88), privateKey: "b".repeat(48) });

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];

/** A production login's client. Short names are fixture vocabulary. */
function as(postgres: Postgres, role: "deployer" | "web") {
  const login = role === "deployer" ? "control_room_deployer" : "control_room_web";
  const password = role === "deployer" ? DEPLOYER_PASSWORD
    : (postgres.connection("web") as { password: string }).password;
  return new Client({ host: postgres.socketDirectory, port: postgres.port, database: postgres.database,
    user: login, password });
}

/** Fixture rows only, as the superuser, with triggers disabled the documented way. */
async function seed(sql: string, params: unknown[] = [], postgres: Postgres) {
  const client = new Client(postgres.admin());
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    return (await client.query(sql, params as never[])).rows;
  } finally { await client.end(); }
}

/** Assert that a statement is refused, and return the SQLSTATE and message. */
async function refuses(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await client.query(sql, params as never[]);
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    assert.equal(typeof code, "string", `refusal carried no SQLSTATE: ${message}`);
    return `${code} ${message.split("\n")[0]}`;
  }
  assert.fail(`statement was not refused: ${sql.slice(0, 140)}`);
}

/** The updater's own loader, with the one test-only concession item 7 fixes. */
async function installUpdaterSchema(postgres: Postgres): Promise<UpdaterSchemaResultV1> {
  const bootstrap = new Client({ ...postgres.admin(), user: "fixture_admin" } as never);
  await bootstrap.connect();
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port,
    user: "control_room_migrator", password: (postgres.connection("migrator") as { password: string }).password,
    database: postgres.database });
  await owner.connect();
  let deployer: Client | undefined;
  try {
    return await applyUpdaterSchemaV1({
      bootstrap,
      directory: DDL_DIRECTORY,
      deployerHasFixturePassword: true,
      connectDeployer: async () => {
        await owner.query(await import("node:fs/promises").then(fs =>
          fs.readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8")));
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

/** One live owner subscription, seeded as the superuser with triggers disabled. */
async function seedSubscription(postgres: Postgres) {
  const now = new Date().toISOString();
  await seed("INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING", [TENANT], postgres);
  await seed(`INSERT INTO owner_web_push_subscriptions(id,tenant_id,endpoint,p256dh,auth,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT DO NOTHING`,
  [SUBSCRIPTION_ID, TENANT, ENDPOINT, "p256dh-fixture-value", "auth-fixture-value", now], postgres);
}

/** A temp root holding a root-shaped VAPID key, for the sender's custody seam. */
async function vapidRoot(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "updater-alerts-pg-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "updater-state"), { recursive: true });
  await writeFile(join(root, "updater-state/vapid.json"), `${JSON.stringify(VAPID)}\n`, { mode: 0o600 });
  return root;
}

test("the web cannot forge the updater's voice, and the updater can queue its own alerts", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedSubscription(postgres);

    const web = as(postgres, "web"), deployer = as(postgres, "deployer");
    await web.connect(); await deployer.connect();
    try {
      // ---- BLOCKER 2, half one: the web is still refused. -------------------
      // `guard_push_insert` reserves `control-room-updater%` for the updater.
      // This is the impersonation R12's key change exists to stop: a web row
      // that renders as the updater speaking.
      for (const template of ["control-room-updater.needs-owner", "control-room-updater.web-down",
        "control-room-updater"]) {
        assert.match(await refuses(web, "INSERT INTO updater.push_queue(id,template,title,body) "
          + "VALUES($1,$2,'Update','Body')", [`push:${randomUUID()}`, template]),
        /only the updater may use its own push template/u,
        `the web must not queue ${template}`);
      }
      // And the boundary is exact: a template that merely CONTAINS the words is
      // not the prefix, so this is a different rule, not a broken prefix rule.
      await web.query("INSERT INTO updater.push_queue(id,template,title,body) "
        + "VALUES($1,'web.control-room-updater','Update','Body')", [`push:${randomUUID()}`]);

      // ---- BLOCKER 2, half two: the deployer is ACCEPTED. ------------------
      // This is the half the old test never measured, and the half the whole
      // item depends on: `store.queue()` runs on this login, so if the prefix
      // rule refused it, no updater alert could ever reach the phone.
      const updaterRow = `push:${randomUUID()}`;
      await deployer.query("INSERT INTO updater.push_queue(id,template,title,body,link_path) "
        + "VALUES($1,'control-room-updater.needs-owner','Control Room updater','Control Room needs you',"
        + " '/needs-me')", [updaterRow]);
      const landed = await deployer.query<{ template: string; body: string; sent_at: Date | null; attempts: number }>(
        "SELECT template, body, sent_at, attempts FROM updater.push_queue WHERE id=$1", [updaterRow]);
      assert.equal(landed.rows[0]?.template, "control-room-updater.needs-owner",
        "the updater's own template lands unsent, which is the row the sender then picks up");
      assert.equal(landed.rows[0]?.body, "Control Room needs you",
        "`body` is NOT NULL and CHECKed to 1..400 characters: an empty body is refused by the schema");
      assert.equal(landed.rows[0]?.sent_at, null);
      assert.equal(landed.rows[0]?.attempts, 0);

      // ---- the passkey rules COMPOSE with the prefix rule. ------------------
      // The web is refused a push idempotency key (item 8's DB-1: a web that
      // could set one could pre-claim the updater's predictable key and its
      // warning would silently never be queued) and refused a scheduled row.
      assert.match(await refuses(web, "INSERT INTO updater.push_queue(id,template,title,body,idempotency_key) "
        + "VALUES($1,'task.done','T','B','task:web-key')", [`push:${randomUUID()}`]),
      /only the updater may set a push idempotency key/u);
      assert.match(await refuses(web, "INSERT INTO updater.push_queue(id,template,title,body,not_before) "
        + "VALUES($1,'task.done','T','B',now()+interval '1 day')", [`push:${randomUUID()}`]),
      /only the updater may schedule a push/u);
      assert.match(await refuses(web, "INSERT INTO updater.push_queue(id,template,title,body,queued_at) "
        + "VALUES($1,'task.done','T','B',now()-interval '1 day')", [`push:${randomUUID()}`]),
      /only the updater may schedule a push/u);
      // The deployer MAY set both: its own cooling-off notices are keyed and
      // scheduled, and `enqueue_cooling_off_notices` would be refused otherwise.
      const keyed = `push:${randomUUID()}`;
      await deployer.query("INSERT INTO updater.push_queue(id,template,title,body,idempotency_key,not_before) "
        + "VALUES($1,'control-room-updater.uncertain','U','Control Room needs a check',"
        + "'passkey-refusal:plan-one:bucket',now()+interval '2 hours')", [keyed]);
      // And the key is genuinely unique, so a re-drive cannot double-notify.
      assert.match(await refuses(deployer, "INSERT INTO updater.push_queue(id,template,title,body,idempotency_key) "
        + "VALUES($1,'control-room-updater.uncertain','U','Control Room needs a check',"
        + "'passkey-refusal:plan-one:bucket')",
      [`push:${randomUUID()}`]), /duplicate key value violates unique constraint/u);
      // The prefix exemption did not become a licence to skip the shared rules.
      assert.match(await refuses(deployer, "INSERT INTO updater.push_queue(id,template,title,body,sent_at,attempts) "
        + "VALUES($1,'control-room-updater.needs-owner','U','Control Room needs you',now(),1)", [`push:${randomUUID()}`]),
      /updater push must be queued unsent/u);

      // ---- the deployer can read the subscriptions the sender needs. -------
      // Asserted as a live query, not as a privilege lookup: the grant is
      // column-scoped in `db/roles/updater_release_reader_roles.sql` and the
      // sender's query names four columns, so the two have to agree or the one
      // process that must alert is refused at runtime.
      const store = new PostgresUpdaterStoreV1(deployer);
      const subscriptions: { id: string; endpoint: string }[] = await store.subscriptions();
      assert.deepEqual(subscriptions.map((row: { id: string; endpoint: string }) => ({ id: row.id, endpoint: row.endpoint })),
        [{ id: SUBSCRIPTION_ID, endpoint: ENDPOINT }],
        "the deployer reads the owner's live subscription, endpoint and keys included");
    } finally { await web.end(); await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("a condition occurs, the updater queues exactly one alert, and one alert is sent", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedSubscription(postgres);
    const root = await vapidRoot(t);

    const deployer = as(postgres, "deployer");
    await deployer.connect();
    try {
      const store = new PostgresUpdaterStoreV1(deployer);
      const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
      let now = 1_000_000;
      // The REAL sender and the REAL store. Only the network call is a fake
      // function, because a real push service is not something this test may
      // contact; the endpoint it is handed still went through the shared
      // allow-list policy, and every queue row is a real row in a real table
      // that really fired the real trigger.
      // The REAL `loadUpdaterVapidV1` and the REAL key file — only the process
      // identity it reads is simulated, because this test is not root and
      // production is. Everything else here is the production default path: the
      // shared endpoint allow-list, the queue, the accounting, the rate limit.
      const sender = new UpdaterAlertSenderV1({ root, store, now: () => now, timeoutMs: 2_000,
        getuid: () => 0,
        lstat: async (path: string) => Object.assign(await lstat(path), { uid: 0 }),
        readFile,
        send: async (_key: unknown, subscription: { endpoint: string }, payload: unknown) => {
          sent.push({ endpoint: subscription.endpoint, payload: payload as Record<string, unknown> });
        } });

      // A CONDITION OCCURS. `webDown` is one of the eight R12 conditions, and it
      // is an EDGE, so a health loop that reports it every 30 seconds queues one
      // row and not eight hundred.
      await sender.reconcile({ webDown: true });
      const queued = await deployer.query<{ template: string; body: string; attempts: number }>(
        "SELECT template, body, attempts FROM updater.push_queue WHERE sent_at IS NULL ORDER BY queued_at,id");
      assert.deepEqual(queued.rows.map(row => row.template), ["control-room-updater.web-down"],
        "one condition edge queues exactly one row, on the updater's own template prefix");
      assert.deepEqual(queued.rows.map(row => row.body), ["Control Room is not responding"],
        "the queued body is the fixed template text, which the schema requires to be non-empty");
      // The same condition reported again queues nothing more.
      await sender.reconcile({ webDown: true });
      await sender.reconcile({ webDown: true });
      assert.equal((await deployer.query("SELECT count(*)::int AS n FROM updater.push_queue")).rows[0]?.n, 1,
        "a repeated condition is not a repeated push");

      // The tick drains it: one send, to the one allowed endpoint, with a fixed
      // payload carrying no path, no secret and no free-form text.
      const result = await sender.tick();
      assert.equal(result.sent, 1);
      assert.equal(sent.length, 1, "exactly one alert reached the fake push endpoint");
      assert.equal(sent[0]?.endpoint, ENDPOINT, "and it went to the owner's own subscription");
      assert.deepEqual(sent[0]?.payload, { title: "Control Room updater",
        body: "Control Room is not responding", link: "/needs-me", tag: "control-room-updater.web-down" });
      // The row is settled in the database, not just in the sender's memory.
      const settled = await deployer.query<{ sent_at: Date | null; attempts: number; last_error_code: string | null }>(
        "SELECT sent_at, attempts, last_error_code FROM updater.push_queue");
      assert.ok(settled.rows[0]?.sent_at, "the queue row records that it was sent");
      assert.equal(settled.rows[0]?.attempts, 1, "one bounded attempt");
      assert.equal(settled.rows[0]?.last_error_code, null);

      // A second tick with nothing queued sends nothing. This is the assertion
      // that makes "exactly one" mean one per occurrence and not one per tick.
      assert.equal((await sender.tick()).sent, 0);
      assert.equal(sent.length, 1);

      // The condition CLEARING is its own calm message, and it is a separate
      // template rather than a re-use of the alert.
      await sender.reconcile({ webDown: false });
      assert.equal((await sender.tick()).sent, 1);
      assert.equal(sent[1]?.payload.tag, "control-room-updater.recovered");
      assert.equal(sent[1]?.payload.body, "Control Room is back to normal");

      // The rate limit is real, and it is per condition: an hour of the SAME
      // alert is one push, while a DIFFERENT condition is not starved by it.
      now += 60 * 60_000 + 1;
      await sender.reconcile({ needsOwner: true });
      await sender.reconcile({ needsOwner: false });
      await sender.reconcile({ needsOwner: true });
      await sender.tick();
      assert.equal((await sender.tick()).sent, 0,
        "a second needs-owner inside the hour is grouped, not pushed again");
      assert.ok(sent.every(call => call.endpoint === ENDPOINT), "no send ever left the allow-list");
    } finally { await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the lane ran on a real cluster, not a skip", () => {
  // The attack kit's own rule: a lane with the binaries must not report green
  // without having run. Kept as its own assertion so a future `PG_BIN` accident
  // cannot turn this whole file into a silent pass.
  if (PG) assert.equal(ran, required, "every PostgreSQL test in this lane ran");
});
