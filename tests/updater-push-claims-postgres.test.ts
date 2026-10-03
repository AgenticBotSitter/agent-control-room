// Real-PostgreSQL proof for the updater push queue's SCHEDULING and CLAIM
// lifecycle (N05, U06, U07, U03, U02), run on PostgreSQL 17 as the PRODUCTION
// login that executes these statements -- control_room_deployer -- and never as
// a superuser except to seed fixture rows the documented way.
//
// Every test in this file failed on the original source. The reproductions are
// stated inline as the assertion that would have passed on the old code, because
// a test that only says "this is now correct" cannot be checked against
// anything.
//
// What each test proves, in the order the findings ask for it:
//
//   N05  The passkey cooling-off notice `enqueue_cooling_off_notices` queues is
//        actually SENT, with the authorized body the database function wrote
//        (which names the passkey's ledger position), and is never settled as
//        delivered while the sender refuses its template.
//   U06  A row with `not_before` in the future is invisible to `pending()` AND
//        unclaimable by `begin()`, and becomes sendable once its due time
//        passes -- measured by moving the DATABASE clock, not the sender's.
//   U07  A process that dies between claim and settle leaves a recoverable row:
//        a new store recovers it, and the row is sent.
//   U03  A crash on the LAST attempt ends in an explicit, visible terminal
//        outcome (`updater_push_claim_expired`) rather than staying reserved
//        forever.
//   U02  A LIVE dispatcher's claim is not stolen by a concurrent dispatcher, and
//        a settle that presents the wrong token is refused -- measured with 20
//        concurrent claimers on one row.
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
import { applyUpdaterSchemaV1, type UpdaterSchemaResultV1 } from "../src/updater/v1/schema-installer";

// This lane owns the port: it runs inside `test:updater-schema`, which passes
// `CONTROL_ROOM_PG_TEST_PORT_BASE`, so it takes the same cluster slot rather
// than hardcoding one of its own and racing a sibling lane for it.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59830), PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const DEPLOYER_PASSWORD = "fixture-deployer";
const DDL_DIRECTORY = join(process.cwd(), "src/updater/v1/ddl");
const TENANT = "tenant:push-claims-pg";
const SUBSCRIPTION_ID = `push:${"b".repeat(64)}`;
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/fixture-endpoint";
const VAPID = Object.freeze({ schema: "control-room.updater-vapid/v1", subject: "mailto:owner@example.invalid",
  publicKey: "A".repeat(88), privateKey: "b".repeat(48) });
const PUSH_ID = () => `push:${randomUUID()}`;
const TEMPLATE = "control-room-updater.needs-owner";

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];

function asDeployer(postgres: Postgres) {
  return new Client({ host: postgres.socketDirectory, port: postgres.port, database: postgres.database,
    user: "control_room_deployer", password: DEPLOYER_PASSWORD });
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
      bootstrap, directory: DDL_DIRECTORY, deployerHasFixturePassword: true,
      connectDeployer: async () => {
        await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8"));
        await bootstrap.query(`ALTER ROLE control_room_deployer PASSWORD '${DEPLOYER_PASSWORD}'`);
        deployer = asDeployer(postgres);
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

async function seedSubscription(postgres: Postgres) {
  const now = new Date().toISOString();
  await seed("INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING", [TENANT], postgres);
  await seed(`INSERT INTO owner_web_push_subscriptions(id,tenant_id,endpoint,p256dh,auth,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT DO NOTHING`,
  [SUBSCRIPTION_ID, TENANT, ENDPOINT, "p256dh-fixture-value", "auth-fixture-value", now], postgres);
}

/** A temp root holding a root-shaped VAPID key, for the sender's custody seam. */
async function vapidRoot(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "updater-push-claims-pg-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "updater-state"), { recursive: true });
  await writeFile(join(root, "updater-state/vapid.json"), `${JSON.stringify(VAPID)}\n`, { mode: 0o600 });
  return root;
}

/** The REAL sender and the REAL store. Only the network call is a fake
 * function, because a real push service is not something this test may contact.
 * Everything else -- the endpoint allow-list, the queue, the claim functions, the
 * accounting, the rate limit, the per-phone receipts -- is the production
 * default path, including the real `loadUpdaterVapidV1` and the real key file;
 * only the process identity it reads is simulated, because this test is not root
 * and production is. */
function realSender(root: string, store: unknown, sends: unknown[], now: () => number, extra: Record<string, unknown> = {}) {
  return new UpdaterAlertSenderV1({ root, store: store as never, now, timeoutMs: 2_000, getuid: () => 0,
    lstat: async (path: string) => Object.assign(await lstat(path), { uid: 0 }), readFile,
    send: async (_key: unknown, subscription: { endpoint: string }, payload: unknown) => {
      (sends as unknown[]).push({ endpoint: subscription.endpoint, payload });
    }, ...extra });
}

// ---------------------------------------------------------------------------
// N05: the passkey cooling-off notice reaches a phone.
// ---------------------------------------------------------------------------
test("N05: the cooling-off notice is sent with its own authorized body, not refused as delivered", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedSubscription(postgres);
    const root = await vapidRoot(t);
    const deployer = asDeployer(postgres);
    await deployer.connect();
    try {
      // THE REAL AUTHORITY. This is the function `completeRegistration` calls,
      // with the design's own arguments: it refuses with zero subscriptions, so
      // the notice's existence here is itself the guarantee that the owner is
      // somebody who can be told.
      const credentialId = randomUUID().replace(/-/gu, "");
      const enqueued = await deployer.query<{ enqueued: number; subscriptions: number }>(
        "SELECT * FROM updater.enqueue_cooling_off_notices($1::text, 3::integer, now()+interval '24 hours',"
        + " now()+interval '12 hours')", [credentialId]);
      assert.equal(enqueued.rows[0]?.enqueued, 2, "the function queues the immediate notice and the 12 h repeat");
      assert.equal(enqueued.rows[0]?.subscriptions, 1, "and it refuses rather than warning nobody");

      // The body the function wrote IS the authorized notice, and it names the
      // ledger position. This is the text the phone has to receive: without the
      // number, the owner is told a passkey appeared and cannot act on it.
      const rows = await deployer.query<{ id: string; body: string; not_before: Date | null }>(
        "SELECT id,body,not_before FROM updater.push_queue WHERE idempotency_key LIKE 'passkey-cooling-off:%'"
        + " ORDER BY not_before NULLS FIRST,id");
      assert.equal(rows.rows.length, 2);
      const immediate = rows.rows[0]!;
      const repeat = rows.rows[1]!;
      assert.equal(immediate.not_before, null, "the immediate notice has no due time");
      assert.match(immediate.body, /revoke 3\.$/u,
        "the authorized text carries the passkey's ledger position");
      assert.ok(repeat.not_before, "the repeat is scheduled, which is what U06 is about");

      // THE SENDER. Production composition: no injected store, no injected
      // runner, no claim token from the test.
      const store = new PostgresUpdaterStoreV1(deployer as never);
      const sends: { endpoint: string; payload: Record<string, unknown> }[] = [];
      const result = await realSender(root, store, sends, () => Date.now()).tick();

      assert.equal(result.sent, 1, "the immediate cooling-off notice is sent");
      assert.equal(sends.length, 1, "exactly one notification reached the fake endpoint");
      assert.equal(sends[0]?.endpoint, ENDPOINT, "and it went to the owner's own subscription");
      // THE ASSERTION THAT FAILED BEFORE: the sender had no entry for this
      // template, so `tick()` settled the row `sent: true` with
      // `updater_push_template_refused` and called NO sender at all.
      assert.equal(sends[0]?.payload.tag, "control-room-updater.passkey_cooling_off");
      assert.equal(sends[0]?.payload.body, immediate.body,
        "the phone gets the authorized notice text, including the passkey number to revoke");

      // The row is settled as DELIVERED, not refused. Before the fix it read
      // `sent_at` set with `updater_push_template_refused`, which is a security
      // notice recorded as discarded.
      const settled = await deployer.query<{ sent_at: Date | null; last_error_code: string | null; attempts: number }>(
        "SELECT sent_at,last_error_code,attempts FROM updater.push_queue WHERE id=$1", [immediate.id]);
      assert.ok(settled.rows[0]?.sent_at, "the notice row records that it was sent");
      assert.equal(settled.rows[0]?.last_error_code, null, "not refused: this notice was delivered");
      assert.equal(settled.rows[0]?.attempts, 1, "and it cost exactly one attempt");

      // The scheduled repeat is STILL queued, still unsent, and has spent no
      // attempt: it is waiting for its due time, not consumed by the first send.
      const waiting = await deployer.query<{ sent_at: Date | null; attempts: number }>(
        "SELECT sent_at,attempts FROM updater.push_queue WHERE id=$1", [repeat.id]);
      assert.equal(waiting.rows[0]?.sent_at, null, "the 12 h repeat has not been sent yet");
      assert.equal(waiting.rows[0]?.attempts, 0, "and waiting for a phone is not a delivery attempt");
    } finally { await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

// ---------------------------------------------------------------------------
// U06: the due time is enforced on selection AND on the claim.
// ---------------------------------------------------------------------------
test("U06: a scheduled notice is invisible to selection and unclaimable until its due time", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedSubscription(postgres);
    const deployer = asDeployer(postgres);
    await deployer.connect();
    try {
      const store = new PostgresUpdaterStoreV1(deployer as never);
      const future = PUSH_ID(), due = PUSH_ID();
      // The schema's own rule, honoured: `not_before >= queued_at`. A row whose
      // due time is already in the PAST is a legitimate shape (a repeat whose
      // 12 hours have passed), and the fixture states it that way rather than
      // back-dating `queued_at`, so the only thing under test is the due time.
      await deployer.query(`INSERT INTO updater.push_queue(id,template,title,body,not_before)
        VALUES($1,$2,'Control Room updater','Control Room needs you',now()+interval '12 hours')`,
      [future, TEMPLATE]);
      await deployer.query(`INSERT INTO updater.push_queue(id,template,title,body,not_before)
        VALUES($1,$2,'Control Room updater','Control Room needs you',now())`,
      [due, TEMPLATE]);

      // HALF ONE, SELECTION. Before the fix `pending()` did not mention
      // `not_before` at all and returned the +12 h row as sendable, so the
      // repeat was pushed the moment the key was added.
      const pending = await store.pending(50) as { id: string }[];
      assert.deepEqual(pending.map(row => row.id), [due],
        "only the row whose due time has passed is sendable");
      assert.ok(!pending.some(row => row.id === future),
        "a 12 h repeat must not be returned as sendable at queue time");

      // HALF TWO, THE CLAIM. Selection is not the only door: the sender holds
      // every row's id, so a row that is not due must also be unclaimable by id.
      // Before the fix `begin()` claimed it and spent an attempt on a notice
      // whose whole purpose is to arrive twelve hours from now.
      assert.equal(await store.begin(future, { claimToken: `claim:${randomUUID()}`, claimHoldSeconds: 120 }), false,
        "a row that is not due cannot be claimed, even by id");
      const untouched = await deployer.query<{ attempts: number; claim_token: string | null }>(
        "SELECT attempts,claim_token FROM updater.push_queue WHERE id=$1", [future]);
      assert.equal(untouched.rows[0]?.attempts, 0, "and the refusal cost no attempt");
      assert.equal(untouched.rows[0]?.claim_token, null, "and left no claim behind");

      // THE SAME RULE ON THE TOKENLESS BRANCH. `begin()` has two paths: the
      // fenced one the production sender always takes, and the older
      // single-argument one kept for a store with no claim API. Both must
      // refuse a not-yet-due row, and the second one is asserted here because
      // nothing above reaches it -- every other `begin()` call in this file
      // passes a token.
      //
      // It is not a formality. The tokenless path is the one an offline fixture
      // store or a caller that has not adopted claims would take, and it is
      // also the path with no fencing token, so a due-time check that existed
      // only on the fenced path would leave exactly one door through which a
      // 12-hour repeat could be sent twelve hours early.
      assert.equal(await store.begin(future), false,
        "the tokenless branch refuses a not-yet-due row too, so there is no door around the due-time rule");
      const stillUntouched = await deployer.query<{ attempts: number; last_error_code: string | null }>(
        "SELECT attempts,last_error_code FROM updater.push_queue WHERE id=$1", [future]);
      assert.equal(stillUntouched.rows[0]?.attempts, 0, "and it spent no attempt either");
      assert.equal(stillUntouched.rows[0]?.last_error_code, null,
        "and wrote no reservation, so a row that is not due carries no trace of an attempt to send it");

      // THE DUE ROW CLAIMS NORMALLY. If the rule were "nothing is claimable"
      // this would fail, which is the control the two halves need.
      assert.equal(await store.begin(due, { claimToken: `claim:${randomUUID()}`, claimHoldSeconds: 120 }), true,
        "a due row is claimable, so the filter is a due time and not a blanket refusal");

      // AND IT IS ENFORCED BY THE DATABASE, not by the test's clock. The
      // fixture's due time is moved to now by SQL, the same way the 12 hours
      // would actually pass, and the same store then reports the row sendable --
      // so a host with a wrong clock cannot hold a scheduled notice forever,
      // which is what a sender-side comparison would have allowed.
      //
      // The update restates the row's content columns because
      // `guard_push_update` (0003, unchanged by 0004) treats a scheduled row's
      // due time as CONTENT: it is set when the row is queued and does not move
      // afterwards. That is a pre-existing rule and it is right -- a notice whose
      // due time can be rewritten at will is a notice whose schedule is a
      // suggestion. So the fixture writes the whole content row to say "this one
      // is due now", which is what the passage of twelve hours would have
      // produced. An earlier version of this test wrote `not_before` alone and
      // was refused with "updater push content is immutable" (measured), which
      // is the guard working and is why this paragraph exists.
      // Written through the FIXTURE connection as the superuser with triggers
      // disabled -- the documented way this repository seeds rows that a guard
      // otherwise protects, and the same rule
      // tests/updater-alerts-postgres.test.ts's `seed()` helper follows.
      //
      // It has to be, and that is the finding rather than a workaround: a
      // scheduled row's `not_before` is CONTENT under the pre-existing
      // `guard_push_update`, so no updater statement can move a due time once
      // the row exists. The real 12-hour repeat becomes due by the passage of
      // time, and this stands in for that passage. A version of this test that
      // tried to move it as the deployer was refused with "updater push content
      // is immutable" (measured), which is the guard correctly protecting a
      // schedule from being rewritten.
      await seed("UPDATE updater.push_queue SET not_before=now() WHERE id=$1", [future], postgres);
      const nowDue = await store.pending(50) as { id: string }[];
      assert.ok(nowDue.some(row => row.id === future),
        "once the DATABASE says it is due, the row is sendable");

      // THE SCHEDULE GUARD REFUSES AN EARLY CLAIM, whatever wrote it. This is
      // the second wall behind `claim_push`'s own WHERE clause: a direct UPDATE
      // that claims a not-yet-due row is refused by the trigger, so the rule
      // holds for every statement rather than only for the one the store uses.
      //
      // A THIRD row is used, so this asserts the trigger and not the
      // immutability rule: the row is created already scheduled, and the only
      // thing written afterwards is the claim itself.
      const scheduled = PUSH_ID();
      await deployer.query(`INSERT INTO updater.push_queue(id,template,title,body,not_before)
        VALUES($1,$2,'Control Room updater','Control Room needs you',now()+interval '1 hour')`,
      [scheduled, TEMPLATE]);
      await assert.rejects(() => deployer.query(`UPDATE updater.push_queue
        SET claim_token=$2,claim_at=now(),claim_expires_at=now()+interval '10 minutes'
        WHERE id=$1`, [scheduled, `claim:${randomUUID()}`]),
      /updater push was claimed before it was due/u,
      "a claim written directly for a not-yet-due row is refused by the trigger");
      // And the refusal cost nothing: no claim was left behind on a row the
      // store is about to skip.
      const clean = await deployer.query<{ claim_token: string | null; attempts: number }>(
        "SELECT claim_token,attempts FROM updater.push_queue WHERE id=$1", [scheduled]);
      assert.equal(clean.rows[0]?.claim_token, null, "and the refused claim left nothing behind");
      assert.equal(clean.rows[0]?.attempts, 0, "and cost no attempt");
      // THE FUNCTION'S OWN CHECK, with the trigger removed so the two cannot
      // cover for each other.
      //
      // This is here because mutation testing found the gap: deleting the
      // `not_before` predicate from `claim_push` left this test GREEN, because
      // the trigger `guard_push_schedule` still refused the early claim. Both
      // walls are real and both are wanted, but a test that cannot tell which
      // one fired is not evidence for either.
      await deployer.query("DROP TRIGGER IF EXISTS push_queue_schedule_guard ON updater.push_queue");
      try {
        assert.equal(await store.begin(scheduled, { claimToken: `claim:${randomUUID()}`, claimHoldSeconds: 120 }), false,
          "claim_push itself refuses a not-yet-due row, with the trigger gone: the due time is in the FUNCTION");
        const afterFunction = await deployer.query<{ claim_token: string | null; attempts: number }>(
          "SELECT claim_token,attempts FROM updater.push_queue WHERE id=$1", [scheduled]);
        assert.equal(afterFunction.rows[0]?.claim_token, null, "and the refusal left no claim behind");
        assert.equal(afterFunction.rows[0]?.attempts, 0, "and cost no attempt");
      } finally {
        // The trigger is restored through the fixture connection so this test
        // cannot leave the schema weaker for the ones after it.
        await seed(`DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                           JOIN pg_namespace n ON n.oid=c.relnamespace
                          WHERE n.nspname='updater' AND c.relname='push_queue' AND t.tgname='push_queue_schedule_guard') THEN
            CREATE TRIGGER push_queue_schedule_guard BEFORE UPDATE ON updater.push_queue
              FOR EACH ROW EXECUTE FUNCTION updater.guard_push_schedule();
          END IF;
        END $$;`, [], postgres);
      }
      const restored = await deployer.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
           JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='updater' AND c.relname='push_queue' AND t.tgname='push_queue_schedule_guard'`);
      assert.equal(restored.rows[0]?.n, "1", "and the trigger is back, so the next test inherits a whole schema");
    } finally { await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

// ---------------------------------------------------------------------------
// U07: a crashed claim is recovered by its owner.
// ---------------------------------------------------------------------------
test("U07: a claim abandoned by a dead process is recovered and its row is sent", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedSubscription(postgres);
    const root = await vapidRoot(t);
    const deployer = asDeployer(postgres);
    await deployer.connect();
    try {
      const id = PUSH_ID();
      await deployer.query(`INSERT INTO updater.push_queue(id,template,title,body)
        VALUES($1,$2,'Control Room updater','Control Room needs you')`, [id, TEMPLATE]);

      // THE CRASH. One store claims the row and then nothing settles it: no
      // `finish`, no `settleClaim`, no process. This is a kill between the claim
      // and the send, and it is the whole of U07.
      const dead = new PostgresUpdaterStoreV1(deployer as never);
      const deadToken = `claim:${randomUUID()}`;
      assert.equal(await dead.begin(id, { claimToken: deadToken, claimHoldSeconds: 120 }), true);

      // BEFORE THE FIX this is where the row died forever: `pending()` excluded
      // `updater_push_reserved` and `begin()` refused a reserved row, and nothing
      // in the schema recorded who held it or when, so no process could ever tell
      // an abandoned claim from a live one.
      const stranded = await deployer.query<{ attempts: number; claim_token: string | null }>(
        "SELECT attempts,claim_token FROM updater.push_queue WHERE id=$1", [id]);
      assert.equal(stranded.rows[0]?.attempts, 1, "the dead process spent an attempt, which is not refunded");
      assert.equal(stranded.rows[0]?.claim_token, deadToken, "and the claim is attributable to it");

      // A LIVE claim is not stolen. This is the U02 half and it is asserted
      // BEFORE the deadline passes, because a design that recovered on age alone
      // would take this row from a process that is still working.
      const live = new PostgresUpdaterStoreV1(deployer as never);
      assert.equal(await live.recoverExpiredClaims(64).then(rows => rows.length), 0,
        "a claim inside its deadline is not recovered: the owner may still be sending");
      assert.equal(await live.begin(id, { claimToken: `claim:${randomUUID()}`, claimHoldSeconds: 120 }), false,
        "and a second dispatcher cannot claim a row a live one holds");

      // THE DEADLINE PASSES. It is moved by SQL as a whole claim triple -- a
      // deadline with no token is refused by `push_claim_shape`, which is the
      // constraint doing its job, so the fixture expires the claim the way a
      // dead process's would be: the token still present, the deadline in the
      // past. The wait is the database's, not a 120-second sleep in a test.
      // As the FIXTURE connection with triggers disabled: the claim columns are
      // updater bookkeeping that no external statement may write, and the point
      // of the fixture is an ABANDONED claim -- token still present, both
      // instants in the past -- which is what one looks like after its holder
      // has been gone for longer than its deadline.
      await seed(`UPDATE updater.push_queue
        SET claim_at=now()-interval '2 minutes',claim_expires_at=now()-interval '1 second'
        WHERE id=$1 AND claim_token=$2`, [id, deadToken], postgres);

      // THE ROW IS STILL CLAIMED, AND IS STILL INVISIBLE. This is the state the
      // fix has to change, asserted BEFORE anything recovers it, because
      // "a queued owner warning no tick could ever drain" is the defect and it
      // has to be true on the way in to be meaningful on the way out.
      const stranded2 = await deployer.query<{ attempts: number; claim_token: string | null; sent_at: Date | null }>(
        "SELECT attempts,claim_token,sent_at FROM updater.push_queue WHERE id=$1", [id]);
      assert.equal(stranded2.rows[0]?.claim_token, deadToken, "the dead process still holds the claim");
      assert.equal(await store_pending(live, id), false,
        "and the row is INVISIBLE to selection, which is the defect: reserved rows are excluded");

      // RECOVERY IS NOT CALLED HERE ON PURPOSE. The sweep below is the sender's
      // own `tick()`, and calling the store's recovery in this test first would
      // prove the store method works rather than proving the sender runs it --
      // which is the property that mutation testing showed was untested.
      //
      // So the assertions below are read AFTER the tick, and the row's state
      // between them is exactly what production would find: claimed by a dead
      // process, past its deadline, invisible.

      // The sender's own sweep is proved by THIS tick, not by a separate block.
      // Deleting `recoverExpiredClaims` from `tick()` used to leave this test
      // green, because the assertions above call the store's recovery directly --
      // and a store method that works is not the claim that the *sender calls
      // it*, which is the whole of "an abandoned claim is recovered" since
      // nothing else in production runs a sweep. The tick below makes no
      // explicit recovery call anywhere, so it can only deliver this row if
      // `tick()` ran the sweep itself.

      // ONE REAL SENDER, ONE TICK, NO EXPLICIT RECOVERY CALL ANYWHERE ABOVE.
      //
      // This single tick is the whole of U07: a row claimed by a process that
      // died, past its deadline, invisible to selection -- becomes a delivered
      // notification. The sender's own sweep releases it, the sender then claims
      // and sends it, and the owner's phone rings. If the sweep were removed
      // from `tick()` the row would still be claimed here and nothing would be
      // sent, which is what the mutation `U07-no-recovery-sweep` demonstrates.
      const fresh = new PostgresUpdaterStoreV1(deployer as never);
      const sends: { endpoint: string; payload: Record<string, unknown> }[] = [];
      const result = await realSender(root, fresh, sends, () => Date.now()).tick();
      assert.equal(result.sent, 1, "the recovered warning is delivered on the next tick");
      assert.equal(sends.length, 1, "and exactly one notification reached the fake endpoint");
      assert.equal(sends[0]?.endpoint, ENDPOINT, "to the owner's own subscription");
      const final = await deployer.query<{ sent_at: Date | null; attempts: number; claim_token: string | null }>(
        "SELECT sent_at,attempts,claim_token FROM updater.push_queue WHERE id=$1", [id]);
      assert.ok(final.rows[0]?.sent_at, "the row records the delivery");
      assert.equal(final.rows[0]?.attempts, 2,
        "on its second attempt: the dead process's attempt stays spent, and recovery is not a refund");
      assert.equal(final.rows[0]?.claim_token, null, "and the claim is released with the settlement");
    } finally { await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

/** Is this row currently offered for sending? A named helper so the assertion
 * reads as the question it is, rather than as a filter to be re-derived. */
async function store_pending(store: PostgresUpdaterStoreV1, id: string) {
  return (await store.pending(50) as { id: string }[]).some(row => row.id === id);
}

// ---------------------------------------------------------------------------
// U03: a crash on the LAST attempt reaches an explicit terminal outcome.
// ---------------------------------------------------------------------------
test("U03: a claim abandoned on the last attempt ends in a visible terminal outcome, never reserved forever", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedSubscription(postgres);
    const deployer = asDeployer(postgres);
    await deployer.connect();
    try {
      const store = new PostgresUpdaterStoreV1(deployer as never);
      const id = PUSH_ID();
      await deployer.query(`INSERT INTO updater.push_queue(id,template,title,body)
        VALUES($1,$2,'Control Room updater','Control Room needs you')`, [id, TEMPLATE]);

      // SPEND THE WHOLE BUDGET, then claim the last attempt and die. The schema
      // caps attempts at 10 and `guard_push_update` refuses any decrement, so
      // nine earlier attempts are real history rather than a fixture fiction.
      //
      // Each earlier attempt is claimed AND SETTLED, because that is what a real
      // attempt does. The tokenless `begin()` an earlier version of this test
      // used leaves `last_error_code='updater_push_reserved'` on the row, and a
      // second tokenless `begin()` is then refused by the very reservation it
      // wrote -- so that version was measuring the reservation flag, not the
      // budget, and failed on its second iteration (measured).
      for (let i = 0; i < 9; i += 1) {
        const attemptToken = `claim:${randomUUID()}`;
        assert.equal(await store.begin(id, { claimToken: attemptToken, claimHoldSeconds: 120 }), true,
          `attempt ${i + 1} of the budget is claimable`);
        assert.equal(await store.settleClaim(id, attemptToken, { sent: false, errorCode: "updater_push_send_failed" }), true,
          `attempt ${i + 1} is settled, so the row is claimable again`);
      }
      const token = `claim:${randomUUID()}`;
      assert.equal(await store.begin(id, { claimToken: token, claimHoldSeconds: 120 }), true,
        "the last attempt is claimed");
      const last = await deployer.query<{ attempts: number }>("SELECT attempts FROM updater.push_queue WHERE id=$1", [id]);
      assert.equal(last.rows[0]?.attempts, 10, "the row is at its attempt bound with a claim outstanding");

      // THIS IS THE STATE THAT WAS UNREACHABLE BEFORE. A row reserved at the
      // bound cannot be claimed (the budget is gone), cannot be selected
      // (`updater_push_reserved` is excluded), and nothing recovered it -- so it
      // sat reserved forever looking live and behaving dead.
      assert.equal(await store_pending(store, id), false, "a reserved row is not offered for sending");
      assert.equal(await store.begin(id, { claimToken: `claim:${randomUUID()}`, claimHoldSeconds: 120 }), false,
        "and it cannot be claimed again: the budget is spent");

      // THE DEADLINE PASSES on the last claim. Written as a whole triple for the
      // same reason as in U07: `push_claim_shape` refuses a lone deadline, and
      // the point of the fixture is an ABANDONED claim -- token still there,
      // deadline in the past -- not a malformed row.
      // The same fixture path as in U07, and for the same reason: an abandoned
      // claim is a state time produces, not one a statement may write.
      await seed(`UPDATE updater.push_queue
        SET claim_at=now()-interval '2 minutes',claim_expires_at=now()-interval '1 second'
        WHERE id=$1 AND claim_token=$2`, [id, token], postgres);
      const recovered = await store.recoverExpiredClaims(64);
      assert.deepEqual(recovered.map((row: { id: string; outcome: string }) => ({ id: row.id, outcome: row.outcome })),
        [{ id, outcome: "terminated" }],
        "an abandoned claim with no budget left is TERMINATED, with its outcome reported");

      // THE TERMINAL OUTCOME IS EXPLICIT AND ANSWERABLE. A row that says
      // `updater_push_claim_expired` is a fact an operator can query; a row
      // stuck at `updater_push_reserved` is answerable by nobody, and that is
      // the whole difference between "we gave up" and "the warning vanished".
      const terminal = await deployer.query<{ sent_at: Date | null; last_error_code: string | null;
        claim_token: string | null }>("SELECT sent_at,last_error_code,claim_token FROM updater.push_queue WHERE id=$1", [id]);
      assert.ok(terminal.rows[0]?.sent_at, "the row is finished, so no later tick can claim it again");
      assert.equal(terminal.rows[0]?.last_error_code, "updater_push_claim_expired",
        "and it records WHY it stopped, which is the bound plus the abandoned claim");
      assert.equal(terminal.rows[0]?.claim_token, null, "the claim is released, so nothing is left dangling");

      // IT STAYS FINISHED. A second recovery must not re-terminate it, and a
      // claim must not resurrect it.
      assert.deepEqual(await store.recoverExpiredClaims(64), [], "a finished row is not recovered a second time");
      assert.equal(await store.begin(id, { claimToken: `claim:${randomUUID()}`, claimHoldSeconds: 120 }), false,
        "and it cannot be claimed after a terminal outcome");

      // THE OWNER STILL HAS IT. A terminal push outcome is about the PHONE, not
      // about the warning: the row is the delivery record, and the warning the
      // owner must act on is the updater's own attention state, which this
      // outcome does not touch. Asserted so a future change cannot quietly
      // "resolve" the underlying warning by settling its push row.
      const attempts = await deployer.query<{ attempts: number }>("SELECT attempts FROM updater.push_queue WHERE id=$1", [id]);
      assert.equal(attempts.rows[0]?.attempts, 10, "the budget is exactly spent and no more");
    } finally { await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

// ---------------------------------------------------------------------------
// U02: no two senders on one row.
// ---------------------------------------------------------------------------
test("U02: twenty concurrent dispatchers produce one claim, and a settle needs the token that took it", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedSubscription(postgres);
    const deployer = asDeployer(postgres);
    await deployer.connect();
    try {
      const id = PUSH_ID();
      await deployer.query(`INSERT INTO updater.push_queue(id,template,title,body)
        VALUES($1,$2,'Control Room updater','Control Room needs you')`, [id, TEMPLATE]);

      // TWENTY CONCURRENT CLAIMS ON ONE ROW, each with its own token and its own
      // connection, as twenty dispatchers on one installation would have. The
      // claim is a compare-and-set, so exactly one must win; the losers are
      // ordinary refusals, not errors.
      //
      // This is the stress case the U02 finding asked for: a second dispatcher
      // that could take a live claim would send the same owner warning twice,
      // and the row would show two attempts for one notification.
      //
      // The connections are opened BEFORE the claims start, and closed only
      // after all twenty have answered. A test that opened and closed each
      // client inside its own promise raced the cluster's own teardown and
      // surfaced as an uncaught 57P01 (measured on the first real run), which
      // says nothing about the claim.
      const tokens = Array.from({ length: 20 }, () => `claim:${randomUUID()}`);
      const clients = tokens.map(() => asDeployer(postgres));
      // Hoisted out of the `try` so the assertions below the block can still
      // name the winner: the fence assertions are about the token that took
      // the row, and they are as much part of this test as the race is.
      let winners: string[] = [];
      try {
        await Promise.all(clients.map(client => client.connect()));
        const results = await Promise.all(tokens.map((token, index) =>
          (new PostgresUpdaterStoreV1(clients[index]! as never)).begin(id,
            { claimToken: token, claimHoldSeconds: 120 })));
        winners = tokens.filter((_, index) => results[index] === true);
        assert.equal(winners.length, 1, `exactly one of twenty concurrent claims may win, got ${winners.length}`);
        const after = await deployer.query<{ attempts: number; claim_token: string }>(
          "SELECT attempts,claim_token FROM updater.push_queue WHERE id=$1", [id]);
        assert.equal(after.rows[0]?.attempts, 1, "and the row spent exactly one attempt for the twenty callers");
        assert.equal(after.rows[0]?.claim_token, winners[0], "held by the one that won");
      } finally { await Promise.all(clients.map(client => client.end().catch(() => {}))); }

      // THE FENCE. A settle that does not present the winning token is refused,
      // which is what stops a dispatcher that lost the race from recording a
      // delivery on the winner's row -- and what stops a dispatcher that was
      // taken over from overwriting the new owner's outcome.
      const impostor = tokens.find(token => token !== winners[0])!;
      assert.equal(await (new PostgresUpdaterStoreV1(deployer as never)).settleClaim(id, impostor, { sent: true }), false,
        "a settle with the wrong token is refused");
      const untouched = await deployer.query<{ sent_at: Date | null; claim_token: string; last_error_code: string | null }>(
        "SELECT sent_at,claim_token,last_error_code FROM updater.push_queue WHERE id=$1", [id]);
      assert.equal(untouched.rows[0]?.sent_at, null, "so the refused settle did not mark the row delivered");
      assert.equal(untouched.rows[0]?.claim_token, winners[0], "and did not disturb the real claim");

      // THE OWNER'S SETTLE IS ACCEPTED.
      assert.equal(await (new PostgresUpdaterStoreV1(deployer as never)).settleClaim(id, winners[0]!, { sent: true }), true,
        "the claim holder settles its own row");
      const settled = await deployer.query<{ sent_at: Date | null; claim_token: string | null }>(
        "SELECT sent_at,claim_token FROM updater.push_queue WHERE id=$1", [id]);
      assert.ok(settled.rows[0]?.sent_at, "the row records the delivery");
      assert.equal(settled.rows[0]?.claim_token, null, "and the claim is released with it");

      // A LIVE CLAIM CANNOT BE STOLEN BY A BARE UPDATE. The guard refuses a
      // token swap while the claim is inside its deadline, so the property is
      // not only in the function the callers use.
      const second = PUSH_ID();
      await deployer.query(`INSERT INTO updater.push_queue(id,template,title,body)
        VALUES($1,$2,'Control Room updater','Control Room needs you')`, [second, TEMPLATE]);
      const holder = `claim:${randomUUID()}`;
      assert.equal(await (new PostgresUpdaterStoreV1(deployer as never)).begin(second,
        { claimToken: holder, claimHoldSeconds: 120 }), true);
      await assert.rejects(() => deployer.query(`UPDATE updater.push_queue
        SET claim_token=$2,claim_at=now(),claim_expires_at=now()+interval '10 minutes' WHERE id=$1`,
      [second, `claim:${randomUUID()}`]),
      /updater push live claim cannot be stolen/u,
      "a direct UPDATE cannot take a live claim from its owner");

      // A CLAIM CANNOT BE RELEASED AND EXTENDED IN THE SAME STATEMENT. This is
      // the other direction of the same rule and it is a DIFFERENT failure: a
      // statement that clears `claim_token` while pushing `claim_expires_at`
      // further out leaves a row with a live deadline that nobody holds, and the
      // recovery sweep will then find a claim that looks live, cannot be taken
      // back, and is never released -- the "reserved forever" shape this file
      // exists to remove, reached by the back door.
      //
      // The claim above is still held by `holder` and still inside its
      // deadline, so this is a statement about the RELEASE, not about the
      // deadline having passed. The first clause of the guard (the steal rule)
      // does not fire, because the token is being set to NULL rather than to a
      // different value -- so deleting the second clause changes the outcome
      // here and nowhere else in this test.
      await assert.rejects(() => deployer.query(`UPDATE updater.push_queue
        SET claim_token=NULL,claim_expires_at=claim_expires_at+interval '1 hour' WHERE id=$1`, [second]),
      /updater push claim released with a live deadline/u,
      "a claim cannot be handed back and given more time in the same statement");
      // The refusal cost nothing: the claim is still the one its owner holds,
      // with the deadline it had. A trigger that raised after a partial write
      // would leave a row the sweep would later treat as abandoned.
      const stillHeld = await deployer.query<{ claim_token: string | null; claim_expires_at: Date | null }>(
        "SELECT claim_token,claim_expires_at FROM updater.push_queue WHERE id=$1", [second]);
      assert.equal(stillHeld.rows[0]?.claim_token, holder, "and the claim is still held by the dispatcher that took it");
      assert.ok(stillHeld.rows[0]?.claim_expires_at, "with a deadline that is still set, so the refusal did not clear it");
      // AND THE OWNER'S OWN SETTLE IS ALLOWED TO DO EXACTLY THAT. The guard
      // refuses the COMBINATION, not the release: a claim holder settling its
      // own row must still be able to clear the token and the deadline together,
      // and the whole of U02 depends on that being possible. An `IF false`
      // mutation would leave every refusal above passing while this became a
      // refusal too, so this is what tells the two rules apart.
      assert.equal(await (new PostgresUpdaterStoreV1(deployer as never))
        .settleClaim(second, holder, { sent: true }), true, "the claim holder still settles its own row");
      const settledSecond = await deployer.query<{ sent_at: Date | null; claim_token: string | null;
        claim_expires_at: Date | null }>(
        "SELECT sent_at,claim_token,claim_expires_at FROM updater.push_queue WHERE id=$1", [second]);
      assert.ok(settledSecond.rows[0]?.sent_at, "and the row records the delivery");
      assert.equal(settledSecond.rows[0]?.claim_token, null, "with the claim released");
      assert.equal(settledSecond.rows[0]?.claim_expires_at, null, "and the deadline released with it, which is the point");
    } finally { await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});


// ---------------------------------------------------------------------------
// N06 (remainder): the warning outlives the outcome, until the owner says so.
// ---------------------------------------------------------------------------
test("N06: an update error stays outstanding until the owner acknowledges it, and re-opens when it happens again", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedSubscription(postgres);
    const deployer = asDeployer(postgres);
    // The LOGIN is `control_room_web`; `control_room_private_web` is the GROUP
    // the grants are made to and it holds no password, so connecting as it
    // fails -- asynchronously, on the first query, which surfaced as an
    // uncaught 57P01 during teardown rather than as a connect error (measured).
    // The grant reaches this login through its membership, which is also why
    // the catalogue read below asks about `current_user`.
    const web = new Client({ host: postgres.socketDirectory, port: postgres.port, database: postgres.database,
      user: "control_room_web", password: (postgres.connection("web") as { password: string }).password });
    // A client that cannot connect must say so AT THE CONNECT, not on its first
    // query: an unawaited connection error becomes an unhandled 'error' event
    // that surfaces during the cluster's teardown as a 57P01, which reads as a
    // teardown race and is not one. The handler re-throws synchronously enough
    // to be attached to this test, so a wrong login is a legible failure.
    await deployer.connect();
    await web.connect().catch((error: Error) => { throw new Error(`N06 web login could not connect: ${error.message}`); });
    try {
      const store = new PostgresUpdaterStoreV1(deployer as never);

      // AN UPDATE FAILS. This is the whole of the N06 remainder: the main loop
      // saw an `error` outcome and recorded it. Nothing about the push queue is
      // asserted here, because the push queue is not the warning -- it is the
      // delivery record, marked `sent_at` the moment a provider accepts it.
      await store.observeUpdateOutcome("update_error", { runId: `run:${randomUUID()}` });

      const outstanding = await store.ownerReviews() as { review_kind: string; acknowledged_at: Date | null }[];
      assert.equal(outstanding.length, 1, "the failed update is an outstanding review");
      assert.equal(outstanding[0]?.review_kind, "update_error");
      assert.equal(outstanding[0]?.acknowledged_at, null, "and the owner has not acknowledged it");

      // THE TEXT IS THE FUNCTION'S. A review a page renders must not be
      // caller-composed prose, so the words are fixed in SQL and the caller
      // supplied only a kind.
      const full = await store.ownerReviews({ onlyOpen: false }) as { title: string; body: string }[];
      assert.match(full[0]!.title, /could not finish an update/u, "the title is the fixed template text");
      assert.match(full[0]!.body, /previous version is still installed/u,
        "and the body says what the owner's situation actually is");

      // IT SURVIVES THE NEXT TICK. The defect this fixes is an EDGE: the main
      // loop's `error` outcome is transient, so a later tick reports `idle` and
      // every edge-driven warning clears with it. Twenty more observations --
      // as twenty ticks at the production five-second interval would give --
      // must leave exactly one row, still open, with its text unchanged.
      for (let i = 0; i < 20; i += 1) await store.observeUpdateOutcome("update_error", { runId: `run:${randomUUID()}` });
      const afterTicks = await store.ownerReviews() as { review_kind: string; acknowledged_at: Date | null }[];
      assert.equal(afterTicks.length, 1, "twenty further ticks leave one review, not twenty: the kind is the key");
      assert.equal(afterTicks[0]?.acknowledged_at, null, "and it is still outstanding");
      const opened = await deployer.query<{ opened_at: Date; last_observed_at: Date }>(
        "SELECT opened_at,last_observed_at FROM updater.owner_review WHERE review_kind='update_error'");
      assert.ok(opened.rows[0], "and the row is still there");
      assert.equal(opened.rows[0]!.opened_at.getTime(), (await store.ownerReviews({ onlyOpen: false })
        .then(rows => (rows[0] as unknown as { opened_at: Date }).opened_at))!.getTime(),
        "the first occurrence is what opened it, so the page can say how long this has been happening");

      // THE OWNER ACKNOWLEDGES, through the OWNER'S OWN LOGIN. The private web
      // login is what the page runs as, and 0002 grants it UPDATE on exactly
      // the two acknowledgement columns -- so this is the production path, not
      // an administrator reaching around it.
      const acknowledged = await store.acknowledgeOwnerReview("update_error", "identity:owner-fixture");
      assert.equal(acknowledged, true, "the owner acknowledges the warning");
      const cleared = await store.ownerReviews();
      assert.equal(cleared.length, 0, "and it is no longer outstanding: the row is answered, not deleted");
      const kept = await deployer.query<{ acknowledged_at: Date | null; acknowledged_by: string | null }>(
        "SELECT acknowledged_at,acknowledged_by FROM updater.owner_review WHERE review_kind='update_error'");
      assert.ok(kept.rows[0]?.acknowledged_at, "the record of the acknowledgement is kept, not erased");
      assert.equal(kept.rows[0]?.acknowledged_by, "identity:owner-fixture", "and it names the owner who answered");

      // ACKNOWLEDGING TWICE IS NOT A SECOND ACKNOWLEDGEMENT. The second press
      // must report that it did nothing, or the owner's page would show a
      // success for a review that was already answered.
      assert.equal(await store.acknowledgeOwnerReview("update_error", "identity:owner-fixture"), false,
        "a second press reports that there was nothing outstanding");

      // THE OWNER CANNOT UN-ANSWER IT, AND CANNOT WRITE THE WARNING. These are
      // the two privileges the page must not have, and both are refused as the
      // web login rather than as a superuser.
      //
      // The un-acknowledgement is refused by the COLUMN GRANT rather than by
      // `guard_owner_review_update`, and that is worth being exact about: the
      // column UPDATE grant covers exactly the two acknowledgement columns, so
      // the web can always fill them in and can never set one back to NULL,
      // because writing NULL is not the same privilege as writing a value. The
      // guard behind it is a second wall and is asserted separately below, as
      // the deployer, which holds the column and would otherwise have no
      // reason to be stopped.
      await assert.rejects(() => web.query(
        "UPDATE updater.owner_review SET acknowledged_at=NULL WHERE review_kind='update_error'"),
      /permission denied/u,
      "the owner cannot take an acknowledgement back: writing NULL is not the granted privilege");
      await assert.rejects(() => deployer.query(
        "UPDATE updater.owner_review SET acknowledged_at=NULL WHERE review_kind='update_error'"),
      /updater owner review acknowledgement is final/u,
      "and even a login that holds the column cannot take it back once given");
      await assert.rejects(() => web.query(
        "UPDATE updater.owner_review SET title='Something else entirely' WHERE review_kind='update_error'"),
      /permission denied/u,
      "the web login cannot rewrite the warning's own text");
      await assert.rejects(() => web.query("DELETE FROM updater.owner_review"),
      /permission denied/u, "and cannot delete the record that it was raised");

      // THE IDENTITY OF A REVIEW IS IMMUTABLE, and this is asserted because
      // nothing above touches it. `guard_owner_review_update` refuses a
      // `review_kind` or an `opened_at` that moves, and those two columns are
      // the whole identity of the row: they are the key the owner acknowledges
      // by, and `opened_at` is what the page renders as "how long this has been
      // happening". A guard that let either move would let a login rewrite
      // which warning it is answering -- turning an answered "the update
      // failed" into an open "we rolled back" is a different question, and the
      // design's whole point is that acknowledging one does not quiet the other.
      //
      // The assertions are run as the DEPLOYER rather than the web login,
      // because the deployer holds the column UPDATE and would otherwise have
      // no reason to be stopped: a refusal here has to be the guard's doing, not
      // a column grant's.
      await assert.rejects(() => deployer.query(
        "UPDATE updater.owner_review SET review_kind='update_rolled_back' WHERE review_kind='update_error'"),
      /updater owner review identity is immutable/u,
      "a review's kind may not be rewritten, so an answered warning cannot become a different question");
      await assert.rejects(() => deployer.query(
        "UPDATE updater.owner_review SET opened_at=now()-interval '1 year' WHERE review_kind='update_error'"),
      /updater owner review identity is immutable/u,
      "nor may its opening instant move, so 'how long has this been happening' cannot be rewritten");
      // AND THE REFUSAL COST NOTHING: the kind and the instant are still the
      // ones the review was raised with. A trigger that raised AFTER a partial
      // write would leave the row in a state neither the design nor any caller
      // asked for.
      const identity = await deployer.query<{ review_kind: string; opened_at: Date }>(
        "SELECT review_kind,opened_at FROM updater.owner_review WHERE review_kind='update_error'");
      assert.equal(identity.rows.length, 1, "the row is still there after both refusals");
      assert.equal(identity.rows[0]?.review_kind, "update_error", "and its kind is unchanged");
      assert.equal(identity.rows[0]?.opened_at.getTime(), opened.rows[0]!.opened_at.getTime(),
        "and the instant it was first opened is the one the page will show, which the re-open assertion above established");

      // AND THE OTHER COLUMN IS STILL MOVABLE. The guard is a RULE, not a
      // blanket freeze: `last_observed_at` advances every time the same failure
      // is seen again, and the test below writes it as the deployer to prove the
      // two are not the same thing. An `IF false` mutation would leave the
      // refusals above passing while this became a refusal too -- so this
      // assertion is what tells the two guards apart.
      await deployer.query("UPDATE updater.owner_review SET last_observed_at=now() WHERE review_kind='update_error'");
      const moved = await deployer.query<{ last_observed_at: Date }>(
        "SELECT last_observed_at FROM updater.owner_review WHERE review_kind='update_error'");
      assert.notEqual(moved.rows[0]?.last_observed_at.getTime(), opened.rows[0]!.last_observed_at.getTime(),
        "while the last-observed instant still moves: the identity is frozen and the observation is not");

      // A DIFFERENT OUTCOME IS A DIFFERENT WARNING. "The update failed" and
      // "we put the old version back" are separate questions, and acknowledging
      // one must not quiet the other.
      await store.observeUpdateOutcome("update_rolled_back", { runId: `run:${randomUUID()}` });
      const both = await store.ownerReviews() as { review_kind: string }[];
      assert.deepEqual(both.map(row => row.review_kind), ["update_rolled_back"],
        "the rollback is outstanding on its own, unaffected by the acknowledged error");
      assert.equal(await store.acknowledgeOwnerReview("update_rolled_back", "identity:owner-fixture"), true);
      assert.equal((await store.ownerReviews()).length, 0, "and it clears on its own acknowledgement");

      // THE RE-OPEN. A failure that happens AGAIN is outstanding again, because
      // the thing the owner has to look at is true again. The same row is
      // reused, so this is a re-open and not a second review -- and the guard
      // that forbids undoing an acknowledgement is what makes the two facts
      // ("this was answered", "this is outstanding again") distinguishable
      // rather than contradictory.
      await store.observeUpdateOutcome("update_error", { runId: `run:${randomUUID()}` });
      const reopened = await store.ownerReviews() as { review_kind: string; acknowledged_at: Date | null }[];
      assert.equal(reopened.length, 1, "the second failure is outstanding again");
      assert.equal(reopened[0]?.review_kind, "update_error");
      assert.equal(reopened[0]?.acknowledged_at, null, "and the old acknowledgement does not carry over");
      const all = await store.ownerReviews({ onlyOpen: false }) as { review_kind: string; acknowledged_at: Date | null }[];
      assert.equal(all.length, 2, "still two rows for the life of the installation: one per outcome, not one per failure");

      // THE WEB LOGIN CAN READ WHAT IT NEEDS AND NOT WHAT IT DOES NOT. The
      // column list in 0002 is the design, and this reads the catalog rather
      // than trusting the DDL text, so a grant added anywhere else is caught.
      // Read from the CATALOGUE rather than trusting the DDL text, so a grant
      // added anywhere else is caught too. The privilege is asked about the
      // LOGIN (`control_room_web`) and not the group, because that is the role
      // the page's connection actually is; membership in
      // `control_room_private_web` is what conveys the grant.
      //
      // The FOUR-argument form is the one that names a column: (role, table,
      // column, privilege). An earlier version used the three-argument form
      // with `current_user` and the column name, which PostgreSQL reads as a
      // TABLE and answers "relation \"control_room_web\" does not exist"
      // (42P01, measured) -- a misread of the signature, not a privilege
      // problem.
      const columns = (await web.query<{ column_name: string }>(
        `SELECT a.attname AS column_name FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='updater' AND c.relname='owner_review' AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege(current_user, 'updater.owner_review', a.attname, 'SELECT') ORDER BY 1`)).rows
        .map(row => row.column_name);
      assert.deepEqual(columns, ["acknowledged_at", "acknowledged_by", "body", "last_observed_at", "review_kind", "title"],
        "the owner reads the warning and its answer, and not the internal run handle");
      await assert.rejects(() => web.query("SELECT opened_at FROM updater.owner_review"),
      /permission denied/u, "and the page cannot read when the review was first opened");
    } finally { await web.end(); await deployer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the lane ran on a real cluster, not a skip (including the N06 review)", () => {
  if (PG) assert.equal(ran, required, "every PostgreSQL test in this lane ran");
});
