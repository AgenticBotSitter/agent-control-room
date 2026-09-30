import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { OwnerPushDispatcherV1, OWNER_PUSH_ATTEMPT_LIMIT_V1, OWNER_PUSH_RESERVATION_STALE_MS_V1,
  ownerPushBackoffMsV1, ownerPushDedupeKeyV1 } from "../src/web-push/v1";
import { PostgresOwnerPushStoreV1 } from "../src/web-push/v1/postgres-store";
import type { DatabaseClient } from "../src/persistence/database";
import type { OwnerNotificationChannelV1, OwnerPushStoreV1 } from "../src/web-push/v1/types";

// Real PostgreSQL 17, socket-only, on this stream's own port block, with only
// the production db/roles grants. Every statement here is what the OWNER WEB
// LOGIN can actually run: the dispatcher is composed on the private-web client
// (mac-local-serving.ts), so anything it does is a privilege the installed role
// has or does not have. Running it as a superuser would prove nothing.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59480);
const PORTS = Object.freeze([PORT, PORT + 1, PORT + 2, PORT + 3, PORT + 4, PORT + 5, PORT + 6, PORT + 7, PORT + 8, PORT + 9]);
const TENANT = "tenant:pushretry";
const required = requiresRealPostgres();

type Head = { action_inbox_id: string; state: string; attempt_count: number | string;
  next_attempt_at: string | Date; reserved_at: string | Date | null; completed_at: string | Date | null;
  safe_reason_code: string | null; link: string };

/** A client the real driver's session settings match, so the preflight-shaped
 * session GUCs the coordinator relies on are the ones in force. */
function asClient(options: { host: string; port: number; database: string; user: string; password: string }): DatabaseClient {
  const session = { async query<T = Record<string, unknown>>(statement: string, params: unknown[] = []) {
    const connection = new Client(options);
    await connection.connect();
    try {
      await connection.query("SET search_path=pg_catalog, public");
      const result = await connection.query(statement, params as never[]);
      return { rows: result.rows as T[] };
    } finally { await connection.end(); }
  } };
  return Object.freeze({
    query: session.query,
    async transaction<T>(callback: (tx: { query: typeof session.query }) => Promise<T>): Promise<T> {
      // A real transaction. The dispatcher's claim and settle both depend on
      // the rollback semantics being genuine, so a fake here would test nothing.
      const connection = new Client(options);
      await connection.connect();
      try {
        await connection.query("BEGIN");
        await connection.query("SET search_path=pg_catalog, public");
        const tx = { async query<U = Record<string, unknown>>(statement: string, params: unknown[] = []) {
          const result = await connection.query(statement, params as never[]);
          return { rows: result.rows as U[] };
        } };
        const value = await callback(tx);
        await connection.query("COMMIT");
        return value;
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { await connection.end(); }
    },
    async transactionWithPreCommitCheck<T>(callback: (tx: { query: typeof session.query }) => Promise<T>) {
      return await this.transaction(callback);
    },
  });
}

/** One open owner attention item, the shape the supervisor's reconciler writes. */
async function openAttention(admin: Client, id: string, kind: "failure" | "ambiguity" | "incident" = "failure") {
  await admin.query(`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
    VALUES($1,$2,'project:push','job:push',$3,'open','not_requested',now(),NULL,$4::jsonb)`,
  [id, TENANT, kind, JSON.stringify({ id, tenantId: TENANT, kind, state: "open",
    requestedAction: "Review recorded task evidence", reasonCode: "second_stall_needs_attention",
    blockedWorkItemIds: ["job:push"], legalResponses: [{ id: `response:${id}`, kind: "open_source",
      label: "Review recorded task evidence", requiresConfirmation: false, available: true }],
    evidence: [], createdAt: new Date().toISOString(), deliveryState: "not_requested" })]);
}

async function subscribe(admin: Client, id: string) {
  await admin.query(`INSERT INTO owner_web_push_subscriptions(id,tenant_id,endpoint,p256dh,auth,expires_at,created_at,updated_at)
    VALUES($1,$2,$3,'A','B',NULL,now(),now())`, [id, TENANT, `https://push.example.invalid/${id}`]);
}

const heads = (admin: Client) => admin.query<Head>(
  "SELECT action_inbox_id,state,attempt_count,next_attempt_at,reserved_at,completed_at,safe_reason_code,link FROM control_owner_push_attempt_heads WHERE tenant_id=$1 ORDER BY action_inbox_id",
  [TENANT]);

test("real PostgreSQL: the owner web login can run the dispatcher's whole path",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push retry')", [TENANT]);
      await subscribe(admin, `push:${"a".repeat(64)}`);
      const db = asClient(postgres.connection("web"));
      // Without the 0226 grant every one of these is a 42501. Prove the grant
      // is real by proving the work: the private-web login, holding only the
      // production ACLs, adopts, claims, sends and settles an item.
      let sends = 0;
      const channel: OwnerNotificationChannelV1 = { kind: "web-push",
        async send() { sends++; return { statusCode: 201 }; } };
      const store = new PostgresOwnerPushStoreV1(db);
      await openAttention(admin, "attention:supervisor:one");

      const dispatcher = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel });
      const outcomes = await dispatcher.dispatch();
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.result, "delivered", "the owner web login delivered the item");
      assert.equal(sends, 1);

      const after = (await heads(admin)).rows;
      assert.equal(after.length, 1);
      assert.equal(after[0]!.state, "delivered");
      assert.equal(Number(after[0]!.attempt_count), 1);
      assert.ok(after[0]!.completed_at, "a delivered head records when it completed");

      // A second pass must not send again. Not because the row says delivered
      // (a bug could skip the claim) but because BOTH the terminal state and the
      // 0174 dedupe ledger independently refuse it.
      const again = await dispatcher.dispatch();
      assert.equal(again.length, 0, "a delivered item is never claimed again");
      assert.equal(sends, 1, "exactly one push for one stall");
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});

test("real PostgreSQL: 50 Needs-you items at once, the endpoint down for two minutes, then it recovers",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push burst')", [TENANT]);
      await subscribe(admin, `push:${"b".repeat(64)}`);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);

      // The push service is DOWN for the whole first phase. Every one of the 50
      // items is due at once, which is the burst the plan asks for.
      let endpointUp = false;
      let sendAttempts = 0;
      const deliveredTags: string[] = [];
      const channel: OwnerNotificationChannelV1 = { kind: "web-push", async send(_subscription, payload) {
        sendAttempts++;
        if (!endpointUp) throw { statusCode: 503 };
        deliveredTags.push(payload.tag);
        return { statusCode: 201 };
      } };

      // A controllable clock, anchored to REAL now. The synthetic clock steps by
      // the actual backoff schedule rather than jumping days ahead, because
      // 0225's guard independently refuses a next_attempt_at further than a day
      // from the DATABASE's statement_timestamp -- a real defence against a
      // caller scheduling an item years out, and one a fixture that raced ahead
      // of real time would trip for the wrong reason.
      let millis = Date.now();
      const clock = () => millis;
      for (let index = 0; index < 50; index++) await openAttention(admin, `attention:supervisor:burst-${index}`);

      const dispatcher = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock });
      const first = await dispatcher.dispatch();
      assert.equal(first.length, 50, "one outcome per Needs-you item in the burst");
      assert.ok(first.every(outcome => outcome.result === "retry_scheduled"),
        "every item is still waiting while the endpoint is down");
      assert.equal(sendAttempts, 50, "every item was attempted exactly once in the first pass");

      // While it is down, ticks are useless work: the backoff is not due yet.
      const stillDue = await dispatcher.dispatch();
      assert.equal(stillDue.length, 0, "nothing is due before the backoff elapses");
      assert.equal(sendAttempts, 50, "a tick inside the backoff window sends nothing");

      // Walk the clock to each item's real backoff deadline with the service
      // still down, so the bounded retry is genuinely exhausted and proven to
      // stop. The schedule is the production one, stepped by its own values, so
      // this is a test of the shipped backoff rather than of an arbitrary jump.
      for (let step = 0; step < OWNER_PUSH_ATTEMPT_LIMIT_V1; step++) {
        millis += ownerPushBackoffMsV1(step + 1) + 60_000;
        await dispatcher.dispatch();
      }
      const attempts = (await heads(admin)).rows.map(row => Number(row.attempt_count));
      assert.equal(Math.max(...attempts), OWNER_PUSH_ATTEMPT_LIMIT_V1,
        "a dead endpoint spends exactly the bounded attempts, not more");
      const exhausted = (await heads(admin)).rows.filter(row => row.state === "failed");
      assert.equal(exhausted.length, 50, "a permanently dead endpoint stops every item for good");
      assert.ok(exhausted.every(row => row.safe_reason_code === "owner_push_attempts_exhausted"));
      const before = sendAttempts;
      millis += ownerPushBackoffMsV1(OWNER_PUSH_ATTEMPT_LIMIT_V1) + 60_000;
      assert.equal((await dispatcher.dispatch()).length, 0, "a failed head is never claimed again");
      assert.equal(sendAttempts, before, "a permanently dead endpoint costs exactly the bounded attempts");

      // Now the recovery case that the plan actually asks for: the endpoint comes
      // back while items are STILL pending, and each is delivered exactly once.
      for (let index = 0; index < 50; index++) await openAttention(admin, `attention:supervisor:live-${index}`);
      endpointUp = true;
      millis += 60_000;
      const recovered = await dispatcher.dispatch();
      assert.equal(recovered.length, 50, "the recovered endpoint is offered every waiting item");
      assert.ok(recovered.every(outcome => outcome.result === "delivered"));
      assert.equal(deliveredTags.length, 50, "each item delivered exactly once");
      assert.equal(new Set(deliveredTags).size, 50, "no tag was delivered twice");
      assert.deepEqual(deliveredTags.toSorted(),
        [...Array(50).keys()].map(i => ownerPushDedupeKeyV1(`attention:supervisor:live-${i}`)).toSorted(),
        "the payload tag carries the item identity and nothing else");

      // And a further pass over the same 50 is a no-op, twice over.
      const sendCount = sendAttempts;
      millis += 8 * 60 * 60 * 1000;
      assert.equal((await dispatcher.dispatch()).length, 0);
      assert.equal(sendAttempts, sendCount, "no second push for any delivered item");
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: PORTS, database: "control_room", boundMs: 240_000 });
});

test("real PostgreSQL: two dispatchers racing one item deliver it exactly once",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push race')", [TENANT]);
      await subscribe(admin, `push:${"c".repeat(64)}`);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let sends = 0;
      const channel: OwnerNotificationChannelV1 = { kind: "web-push",
        async send() { sends++; return { statusCode: 201 }; } };
      for (let index = 0; index < 20; index++) await openAttention(admin, `attention:supervisor:race-${index}`);
      // Two dispatchers on INDEPENDENT connections. Sharing one client made this
      // test pass for the wrong reason: the pool serialises a single client, so
      // the second dispatcher never overlapped the first and the claim's
      // exclusivity was never exercised. Two connections are what a second
      // host process would have, and the only shape in which SKIP LOCKED and the
      // compare-and-set mean anything.
      const make = () => new OwnerPushDispatcherV1({ db: asClient(postgres.connection("web")), tenantId: TENANT,
        store: new PostgresOwnerPushStoreV1(asClient(postgres.connection("web"))), channel,
        clock: () => Date.now() });
      const left = make(), right = make();
      // Ten rounds of a genuine overlap: a single round can pass by luck, and a
      // guard that only fails under contention must be contended with. Round 0 is
      // the one that delivers; every round after it must find nothing at all,
      // because every item is terminal.
      for (let round = 0; round < 10; round++) {
        const outcomes = (await Promise.all([left.dispatch(), right.dispatch()])).flat();
        assert.equal(outcomes.length, round === 0 ? 20 : 0,
          `round ${round}: only the first round may claim items, and then each exactly once`);
        assert.equal(sends, 20, `round ${round}: each of the 20 items was sent exactly once across two racing dispatchers`);
      }
      const rows = (await heads(admin)).rows;
      assert.equal(rows.length, 20);
      assert.ok(rows.every(row => row.state === "delivered"));
      assert.ok(rows.every(row => Number(row.attempt_count) === 1),
        "no item was attempted twice across ten rounds of two racing dispatchers");
    } finally { await admin.end(); }
  }, { port: PORT + 2, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});

test("real PostgreSQL: a crash mid-send is recovered, and the ledger suppresses the duplicate",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push restart')", [TENANT]);
      await subscribe(admin, `push:${"d".repeat(64)}`);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      const clock = () => millis;
      let sends = 0;
      // The send succeeds, then the process dies before the head is settled. The
      // next dispatcher must NOT re-alert the phone, and must still converge on
      // 'delivered' rather than retrying for ever.
      const channel: OwnerNotificationChannelV1 = { kind: "web-push",
        async send() { sends++; return { statusCode: 201 }; } };
      await openAttention(admin, "attention:supervisor:crash");
      const crashingStore = new PostgresOwnerPushStoreV1(db);
      const dedupeKey = ownerPushDedupeKeyV1("attention:supervisor:crash");
      const at = new Date(millis).toISOString();
      // Exactly what a dispatcher that dies between the send and the settle
      // leaves behind: the 0174 ledger says DELIVERED, the head is still
      // 'reserved'. The browser really has the notification; the database has
      // not recorded that the item is finished.
      await crashingStore.reserve(TENANT, `push:${"d".repeat(64)}`, dedupeKey, at);
      sends++;
      await crashingStore.delivered(TENANT, `push:${"d".repeat(64)}`, dedupeKey, at);
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store: crashingStore, channel, clock })
        .adoptOpenAttention();
      await admin.query(`UPDATE control_owner_push_attempt_heads SET state='reserved',attempt_count=1,
        reserved_at=$3,last_attempt_at=$3,updated_at=$3 WHERE tenant_id=$1 AND action_inbox_id=$2`,
      [TENANT, "attention:supervisor:crash", at]);

      const restarted = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock });
      // Before the staleness window the reservation is respected, not stolen:
      // 'reserved' is not claimable, so a slow send is never duplicated by a
      // second dispatcher that happens to tick at the wrong moment.
      assert.equal((await restarted.dispatch()).length, 0, "a live reservation is not stolen from a slow send");
      assert.equal(sends, 1, "and nothing is sent while a live send holds the item");
      // Past it, the abandoned reservation is recovered and the item retried.
      millis += OWNER_PUSH_RESERVATION_STALE_MS_V1 + 60_000;
      const outcomes = await restarted.dispatch();
      assert.equal(outcomes.length, 1, "the abandoned reservation is picked back up");
      assert.equal(outcomes[0]!.result, "delivered",
        "the 0174 ledger already holds this exact event, so the retry is recorded as delivered");
      assert.equal(sends, 1, "the phone was not alerted a second time");
      const row = (await heads(admin)).rows[0]!;
      assert.equal(row.state, "delivered");
      assert.equal(Number(row.attempt_count), 2, "the crash still spent an attempt, which is the safe direction");
    } finally { await admin.end(); }
  }, { port: PORT + 3, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});

test("real PostgreSQL: a subscription the push service reports as gone stops for good",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push gone')", [TENANT]);
      await subscribe(admin, `push:${"f".repeat(64)}`);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      let sends = 0;
      // 404/410: the browser subscription is permanently gone. The push service
      // says so and `deliverOwnerPushV1` removes the subscription, so the item
      // must stop immediately -- spending the bounded attempts reaching nothing
      // would be eight sends to a subscription that no longer exists.
      const gone: OwnerNotificationChannelV1 = { kind: "web-push", async send() { sends++; throw { statusCode: 410 }; } };
      await openAttention(admin, "attention:supervisor:gone");
      const dispatcher = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel: gone, clock: () => millis });
      const outcomes = await dispatcher.dispatch();
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.result, "exhausted",
        "a permanently undeliverable item stops rather than retrying");
      const row = (await heads(admin)).rows[0]!;
      assert.equal(row.state, "failed");
      assert.equal(row.safe_reason_code, "owner_push_subscription_gone",
        "and says WHY, which is the actionable reason rather than the attempt bound");
      assert.equal(Number(row.attempt_count), 1, "it spent exactly one send, not the whole budget");
      // The subscription really was removed, so the next tick has nothing to try.
      const subs = await admin.query("SELECT count(*)::int AS n FROM owner_web_push_subscriptions WHERE tenant_id=$1", [TENANT]);
      assert.equal(subs.rows[0]!.n, 0, "the dead subscription is gone from the ledger");
      // And it is never picked up again, however far the clock moves.
      millis += 24 * 60 * 60 * 1000;
      assert.equal((await dispatcher.dispatch()).length, 0, "a failed head is never claimed again");
      assert.equal(sends, 1, "and the endpoint was contacted exactly once");
    } finally { await admin.end(); }
  }, { port: PORT + 6, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});

test("real PostgreSQL: the 0225 guard refuses to re-alert for a delivered stall",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push guard')", [TENANT]);
      await openAttention(admin, "attention:supervisor:guard");
      // A statement that RAISEs leaves its connection in an aborted transaction,
      // and every later statement on that connection then fails with 25P02
      // rather than with the refusal under test. So each refusal is proved on a
      // FRESH owner-web connection: what is asserted is the guard's answer, not
      // the state a previous refusal left behind.
      const asOwnerWeb = async (statement: string) => {
        const web = new Client(postgres.connection("web"));
        try { await web.connect(); return await web.query(statement); }
        finally { await web.end().catch(() => {}); }
      };
      const guard = `WHERE tenant_id='${TENANT}' AND action_inbox_id='attention:supervisor:guard'`;
      const when = new Date().toISOString();
      await asOwnerWeb(`INSERT INTO control_owner_push_attempt_heads
        (tenant_id,action_inbox_id,link,attempt_count,state,next_attempt_at,reserved_at,last_attempt_at,completed_at,created_at,updated_at)
        VALUES('${TENANT}','attention:supervisor:guard','/needs-me',1,'delivered','${when}','${when}','${when}','${when}','${when}','${when}')`);

      // The exact attack the guard exists for: rewind a delivered head so the
      // phone alerts again for a stall the owner has already been told about.
      await assert.rejects(() => asOwnerWeb(`UPDATE control_owner_push_attempt_heads
        SET state='pending',completed_at=NULL,next_attempt_at='${when}',updated_at='${when}' ${guard}`),
        /owner push attempt head rejected/);
      // Repointing the link is refused by the ACL: 0226 grants no UPDATE on it.
      await assert.rejects(() => asOwnerWeb(`UPDATE control_owner_push_attempt_heads SET link='/morning' ${guard}`),
        /permission denied|owner push attempt head rejected/);
      // The attempt count cannot be rewound, so a delivered item cannot be made
      // to look like it was never tried.
      await assert.rejects(() => asOwnerWeb(`UPDATE control_owner_push_attempt_heads SET attempt_count=0 ${guard}`),
        /owner push attempt head rejected/);
      // A delivered head cannot be pushed back into a sendable state under any
      // wording: this is the second wording, on a different column.
      await assert.rejects(() => asOwnerWeb(`UPDATE control_owner_push_attempt_heads
        SET state='reserved',reserved_at='${when}' ${guard}`),
        /owner push attempt head rejected/);
      // The column CHECK independently refuses a count beyond the bound. The
      // trigger fires first here (99 is also a jump of more than one), and that
      // ordering is the right one: the guard is the authority, the CHECK is the
      // backstop for a path the guard does not cover. A session with the trigger
      // disabled reaches the CHECK, which is asserted separately below.
      await assert.rejects(() => admin.query(`UPDATE control_owner_push_attempt_heads
        SET attempt_count=99 ${guard}`), /owner push attempt head rejected/);
      // With the trigger out of the way the column CHECK still holds the bound:
      // two independent defences, not one.
      await admin.query("ALTER TABLE control_owner_push_attempt_heads DISABLE TRIGGER control_owner_push_attempt_heads_guard");
      try {
        await assert.rejects(() => admin.query(`UPDATE control_owner_push_attempt_heads
          SET attempt_count=99 ${guard}`), /check constraint/i);
      } finally {
        await admin.query("ALTER TABLE control_owner_push_attempt_heads ENABLE TRIGGER control_owner_push_attempt_heads_guard");
      }
      // The refusals changed nothing: the head is exactly as it was written.
      const row = (await admin.query<Head>(`SELECT state,attempt_count,link,completed_at
        FROM control_owner_push_attempt_heads ${guard}`)).rows[0]!;
      assert.equal(row.state, "delivered");
      assert.equal(Number(row.attempt_count), 1);
      assert.equal(row.link, "/needs-me");
      assert.ok(row.completed_at);
    } finally { await admin.end(); }
  }, { port: PORT + 4, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});

test("real PostgreSQL: a wedged endpoint holds no database connection or row lock",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push slow')", [TENANT]);
      await subscribe(admin, `push:${"e".repeat(64)}`);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      const millis = Date.parse("2026-09-29T12:00:00.000Z");
      // A push service that hangs for 2s before failing, which is what a wedged
      // endpoint looks like. Ten dispatchers at once, all racing for the same ten
      // items, is the worst case for lock contention -- and the case where a lock
      // held across a send would show up as a statement timeout rather than as a
      // slow assert. The ten wedged sends MUST overlap, so one dispatcher holding
      // ten reservations is itself a failure.
      const slowChannel: OwnerNotificationChannelV1 = { kind: "web-push", async send() {
        await new Promise(done => setTimeout(done, 2_000));
        throw { statusCode: 503 };
      } };
      for (let index = 0; index < 10; index++) await openAttention(admin, `attention:supervisor:slow-${index}`);
      const started = Date.now();
      // Ten dispatchers on TEN INDEPENDENT connections, all racing for the same
      // ten items: the worst case for lock contention, and the only shape in
      // which a lock held across a send would show up. One shared client would
      // serialise them and hide exactly what this test exists to find.
      const runs = await Promise.all(Array.from({ length: 10 }, () => {
        const own = asClient(postgres.connection("web"));
        return new OwnerPushDispatcherV1({ db: own, tenantId: TENANT, store: new PostgresOwnerPushStoreV1(own),
          channel: slowChannel, clock: () => millis }).dispatch();
      }));
      const outcomes = runs.flat();
      assert.equal(outcomes.length, 10, "each of the ten items is claimed by exactly one dispatcher");
      assert.ok(outcomes.every(outcome => outcome.result === "retry_scheduled"),
        "a wedged endpoint is a retryable failure, not a lost subscription");
      assert.ok(Date.now() - started < 5 * 2_000,
        "the wedged sends overlap: ten items against a 2s endpoint finish in two waves, not ten");

      // The rows are settled, unreserved, and re-readable by an INDEPENDENT
      // connection. A row lock held across the send would block this
      // SELECT ... FOR UPDATE, so this statement IS the lock assertion.
      const rows = (await admin.query<Head>(`SELECT action_inbox_id,state,attempt_count,reserved_at
        FROM control_owner_push_attempt_heads WHERE tenant_id=$1 FOR UPDATE`, [TENANT])).rows;
      assert.equal(rows.length, 10);
      assert.ok(rows.every(row => row.state === "pending"));
      assert.ok(rows.every(row => row.reserved_at === null), "a settled retry leaves no reservation behind");
      assert.ok(rows.every(row => Number(row.attempt_count) === 1), "each item spent exactly one attempt");
    } finally { await admin.end(); }
  }, { port: PORT + 5, allowedPorts: PORTS, database: "control_room", boundMs: 240_000 });
});
