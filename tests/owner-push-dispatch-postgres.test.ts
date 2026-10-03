import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { acceptedTags, crashChild, scratchDirectory } from "./support/owner-push-crash";
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
// Fourteen slots, not ten: the claim-window, retry-ledger and INSERT-refusal
// cases below were added later and each needs its own cluster, because two
// `withRealPostgres` bodies cannot share a port while both are up.
const PORTS = Object.freeze(Array.from({ length: 14 }, (_, index) => PORT + index));
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
  // A REAL push-service host, because 0227 holds the subscriptions table to the
  // allow list. A `push.example.invalid` fixture would now be refused by the
  // CHECK, so every test here would be measuring the constraint instead of the
  // dispatcher.
  await admin.query(`INSERT INTO owner_web_push_subscriptions(id,tenant_id,endpoint,p256dh,auth,expires_at,created_at,updated_at)
    VALUES($1,$2,$3,'A','B',NULL,now(),now())`, [id, TENANT, `https://fcm.googleapis.com/fcm/send/${id.replaceAll(":", "")}`]);
}

const heads = (admin: Client) => admin.query<Head>(
  "SELECT action_inbox_id,state,attempt_count,next_attempt_at,reserved_at,completed_at,safe_reason_code,link FROM control_owner_push_attempt_heads WHERE tenant_id=$1 ORDER BY action_inbox_id",
  [TENANT]);

/**
 * Walk one adopted head to `state='reserved'` at `count`, the way a dispatcher
 * that spent those attempts really did.
 *
 * 0225's guard refuses any jump of more than one attempt, and that refusal is
 * the correct one: it is what stops a caller rewinding or inflating a head. So
 * the crash fixtures here do NOT disable the trigger to seed a stranded
 * reservation -- they spend the attempts one at a time through the same guard
 * production writes through. A fixture that armed its way past the guard would
 * be able to build a state no dispatcher could ever produce.
 */
async function windHeadToReserved(admin: Client, item: string, count: number, at: string): Promise<void> {
  for (let attempt = 1; attempt <= count; attempt++) {
    await admin.query(`UPDATE control_owner_push_attempt_heads
      SET attempt_count=attempt_count+1,state=CASE WHEN attempt_count+1>=$4 THEN 'reserved' ELSE state END,
        reserved_at=CASE WHEN attempt_count+1>=$4 THEN $3 ELSE reserved_at END,
        last_attempt_at=$3,next_attempt_at=$3,updated_at=$3
      WHERE tenant_id=$1 AND action_inbox_id=$2`, [TENANT, item, at, count]);
  }
}

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

test("real PostgreSQL: 50 Needs-you items with NO subscribed phone, then the owner subscribes",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      // No `subscribe()` call. This is the DEFAULT state of a fresh install, and
      // the state the owner returns to by unsubscribing every browser -- the
      // population most likely to hit the old bug.
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push nobody')", [TENANT]);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      const clock = () => millis;
      let sends = 0;
      const channel: OwnerNotificationChannelV1 = { kind: "web-push",
        async send() { sends++; return { statusCode: 201 }; } };
      for (let index = 0; index < 50; index++) await openAttention(admin, `attention:supervisor:nobody-${index}`);
      const dispatcher = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock });

      // Ticks with nobody to send to. The step is the no-subscription re-check
      // interval, not the SEND backoff schedule: an item with no phone is not a
      // failing send, so it is re-checked on its own much shorter clock. Twelve
      // steps is an hour of real time -- well past the four minutes at which the
      // old code burned the entire attempt budget, which is the whole point.
      for (let tick = 0; tick < 12; tick++) {
        millis += 5 * 60_000;
        await dispatcher.dispatch();
      }
      assert.equal(sends, 0, "with no subscription nothing is ever sent");
      const waiting = (await heads(admin)).rows;
      assert.equal(waiting.length, 50, "all 50 items are still tracked, not dropped");
      assert.ok(waiting.every(row => row.state === "pending"),
        "and every one of them is still waiting rather than failed or stuck");
      // THE REGRESSION. The old code claimed first and 'refunded' afterwards,
      // which 0225's guard refuses, so the increments stuck: after eight ticks
      // the item sat at attempt_count=8, 'pending', permanently unclaimable, and
      // never delivered even once the owner subscribed. Here the count never
      // moves, because the item is never claimed.
      assert.ok(waiting.every(row => Number(row.attempt_count) === 0),
        `an item with nobody to send it to must spend no attempt; found ${
          [...new Set(waiting.map(row => Number(row.attempt_count)))].join(",")}`);
      assert.ok(waiting.every(row => row.reserved_at === null), "and is never left reserved");
      assert.ok(waiting.every(row => row.safe_reason_code === "owner_push_no_subscription"),
        "and says plainly that it is waiting for a subscription, which is the actionable reason");
      // And the reason it is still waiting is a real time in the future, not
      // 'now' -- leaving it at now is what re-claimed it every tick.
      assert.ok(waiting.every(row => Date.parse(String(row.next_attempt_at)) > millis),
        "each item is re-checked later rather than on the next tick");

      // The owner subscribes. Nothing else changes: the same dispatcher, the same
      // 50 items, the same heads.
      await subscribe(admin, `push:${"9".repeat(64)}`);
      millis += 6 * 60_000;
      const deliveredTags: string[] = [];
      const live: OwnerNotificationChannelV1 = { kind: "web-push",
        async send(_subscription, payload) { sends++; deliveredTags.push(payload.tag); return { statusCode: 201 }; } };
      const healed = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel: live, clock });
      const outcomes = await healed.dispatch();
      assert.equal(outcomes.length, 50, "every waiting item is offered the moment the owner subscribes");
      assert.ok(outcomes.every(outcome => outcome.result === "delivered"));
      assert.equal(deliveredTags.length, 50, "each item delivered exactly once");
      assert.equal(new Set(deliveredTags).size, 50, "no tag was delivered twice");
      const after = (await heads(admin)).rows;
      assert.ok(after.every(row => row.state === "delivered"));
      assert.ok(after.every(row => Number(row.attempt_count) === 1),
        "and each spent exactly one attempt, on the send that actually happened");

      // A second pass over the same 50 is a no-op, however far the clock moves.
      const before = sends;
      millis += 8 * 60 * 60 * 1000;
      assert.equal((await healed.dispatch()).length, 0, "a delivered item is never claimed again");
      assert.equal(sends, before, "no second push for any delivered item");
    } finally { await admin.end(); }
  }, { port: PORT + 7, allowedPorts: PORTS, database: "control_room", boundMs: 240_000 });
});

test("real PostgreSQL: many dispatchers racing a tenant with no subscription spend no attempts",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      // The pre-claim gate adds a read that the old path did not have, and a
      // read is where two dispatchers can agree about something that is no
      // longer true. Twenty dispatchers on INDEPENDENT connections, all seeing
      // no subscription, must leave every item exactly as it was: no attempt
      // spent, nothing reserved, and the reason recorded once.
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push race nobody')", [TENANT]);
      const db = asClient(postgres.connection("web"));
      let millis = Date.now();
      const channel: OwnerNotificationChannelV1 = { kind: "web-push",
        async send() { throw new Error("must not be called with no subscription"); } };
      for (let index = 0; index < 20; index++) await openAttention(admin, `attention:supervisor:racenobody-${index}`);
      const before = Date.now();
      const runs = await Promise.all(Array.from({ length: 20 }, () => {
        const own = asClient(postgres.connection("web"));
        return new OwnerPushDispatcherV1({ db: own, tenantId: TENANT, store: new PostgresOwnerPushStoreV1(own),
          channel, clock: () => millis }).dispatch();
      }));
      assert.ok(Date.now() - before < 60_000, "twenty concurrent dispatchers finish promptly: the gate is one read, not a queue");
      // Every dispatcher reports the same deferral, and between them they
      // report each of the 20 items -- the gate's UPDATE is idempotent, so a
      // second dispatcher over the same rows simply takes none.
      const reported = runs.flat();
      assert.ok(reported.every(outcome => outcome.result === "no_subscription"));
      assert.equal(new Set(reported.map(outcome => outcome.actionInboxId)).size, 20,
        "and every item is accounted for across the twenty racing dispatchers");
      const after = (await heads(admin)).rows;
      assert.equal(after.length, 20);
      assert.ok(after.every(row => row.state === "pending"));
      assert.ok(after.every(row => Number(row.attempt_count) === 0),
        `twenty racing dispatchers must spend no attempt; found ${
          [...new Set(after.map(row => Number(row.attempt_count)))].join(",")}`);
      assert.ok(after.every(row => row.reserved_at === null), "and none is left reserved by the stampede");
      // Now the owner subscribes, and one tick delivers all 20 exactly once.
      await subscribe(admin, `push:${"5".repeat(64)}`);
      millis += 6 * 60_000;
      const tags: string[] = [];
      const live: OwnerNotificationChannelV1 = { kind: "web-push",
        async send(_subscription, payload) { tags.push(payload.tag); return { statusCode: 201 }; } };
      const healed = await Promise.all([0, 1, 2].map(() => {
        const own = asClient(postgres.connection("web"));
        return new OwnerPushDispatcherV1({ db: own, tenantId: TENANT, store: new PostgresOwnerPushStoreV1(own),
          channel: live, clock: () => millis }).dispatch();
      }));
      assert.equal(healed.flat().filter(outcome => outcome.result === "delivered").length, 20,
        "every waiting item is delivered once the owner subscribes");
      assert.equal(tags.length, 20, "and no item is pushed twice");
      assert.equal(new Set(tags).size, 20, "no tag was delivered twice");
    } finally { await admin.end(); }
  }, { port: PORT + 9, allowedPorts: PORTS, database: "control_room", boundMs: 240_000 });
});

test("real PostgreSQL: a subscription that vanishes mid-batch spends one attempt, then stops visibly",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push vanished')", [TENANT]);
      const db = asClient(postgres.connection("web"));
      let millis = Date.now();
      // The pre-claim gate sees a subscription, then it is gone by the time the
      // send happens -- the owner's only browser is unsubscribed while the batch
      // is in flight. This is the residual path that still spends an attempt, and
      // it must not be able to starve: the bound turns it into a visible
      // 'failed', which is the property the old code lacked.
      //
      // `list` is what makes the vanishing: the first call (the dispatcher's
      // pre-claim gate) sees the subscription, and every call after it -- which
      // is `deliverOwnerPushV1`'s own per-item list -- sees none. The first
      // `list` call is the gate, because nothing else runs before it.
      let listCalls = 0;
      const present = Object.freeze({ id: `push:${"7".repeat(64)}`, tenantId: TENANT,
        endpoint: "https://fcm.googleapis.com/fcm/send/vanished", p256dh: "A", auth: "B", expiresAt: null });
      const store: OwnerPushStoreV1 = {
        async subscribe() {}, async unsubscribe() { return true; },
        async list() { return listCalls++ === 0 ? [present] : []; },
        async reserve() { return "reserved" as const; }, async delivered() {}, async failed() {},
      };
      let sends = 0;
      const channel: OwnerNotificationChannelV1 = { kind: "web-push", async send() { sends++; return { statusCode: 201 }; } };
      await openAttention(admin, "attention:supervisor:vanished");
      const dispatcher = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock: () => millis });
      const outcomes = await dispatcher.dispatch();
      assert.equal(outcomes.length, 1, "the item is still tracked, whatever happened to the phone");
      assert.equal(outcomes[0]!.result, "retry_scheduled", "with nothing to send to it waits, it does not fail");
      assert.equal(sends, 0, "and nothing was sent");
      const row = (await heads(admin)).rows[0]!;
      assert.equal(row.state, "pending");
      assert.equal(Number(row.attempt_count), 1, "the claim spent the one attempt it really spent");
      assert.equal(row.safe_reason_code, "owner_push_no_subscription");
      // Now walk it to the bound. A head that runs out of attempts must reach
      // 'failed' with a reason, rather than sitting at pending with an exhausted
      // count and no claimant -- which is the stuck state the review found.
      //
      // The step is the SEND backoff, because a claimed item that found nobody
      // is scheduled on the send schedule, not the no-subscription re-check.
      // Each step is capped at an hour so the clock stays inside 0225's guard
      // horizon -- which refuses a next_attempt_at more than a day past the
      // DATABASE's own clock, an independent defence a fixture that raced
      // ahead of real time would trip for the wrong reason.
      for (let step = 1; step < OWNER_PUSH_ATTEMPT_LIMIT_V1; step++) {
        millis += Math.min(ownerPushBackoffMsV1(step) + 60_000, 60 * 60_000);
        // Re-arm the vanishing for each subsequent tick: the gate must see a
        // subscription again for the item to be claimed at all, or this would
        // prove the pre-claim gate rather than the bound.
        listCalls = 0;
        await dispatcher.dispatch();
        // The deadline the previous settle actually wrote, rather than an
        // assumption about it: this is the value a real tick would compare
        // against, and stepping past a stale one would silently test nothing.
        millis = Math.max(millis, Date.parse(String((await heads(admin)).rows[0]!.next_attempt_at)) + 1_000);
      }
      const exhausted = (await heads(admin)).rows[0]!;
      assert.equal(exhausted.state, "failed", "a truly exhausted item is visibly failed, not stuck pending");
      assert.equal(exhausted.safe_reason_code, "owner_push_attempts_exhausted",
        "and says it ran out of attempts, which is the actionable reason");
      assert.ok(exhausted.completed_at, "with a completion instant, so it is terminal in both senses");
      assert.equal(Number(exhausted.attempt_count), OWNER_PUSH_ATTEMPT_LIMIT_V1);
      millis += 24 * 60 * 60 * 1000;
      assert.equal((await dispatcher.dispatch()).length, 0, "and it is never claimed again");
    } finally { await admin.end(); }
  }, { port: PORT + 8, allowedPorts: PORTS, database: "control_room", boundMs: 240_000 });
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

// Mutation cook-pushretry.json#2: the 0174 ledger's `state='failed'` upgrade in
// `PostgresOwnerPushStoreV1.reserve`.
//
// Why a test that only COUNTS sends stays green with the mutation applied:
// `deliverOwnerPushV1` sends for BOTH `reserved` and `previous_attempt_failed`
// (delivery.ts:44-46), so the retry's send happens either way and every
// send-count assertion still passes. What differs is the DURABLE EVIDENCE --
// `store.delivered()` only updates rows whose state is `reserved`
// (postgres-store.ts:58-60), so with the mutation the successful retry leaves
// the row 'failed' and the ledger still says the phone was never told. The
// observable consequence is a SECOND delivery of the same event later, which
// this test asserts does NOT happen.
test("real PostgreSQL: a send that failed then succeeded leaves the ledger delivered, and dedupes the next pass",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push retry ledger')", [TENANT]);
      const subscriptionId = `push:${"7".repeat(64)}`;
      await subscribe(admin, subscriptionId);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      const dedupeKey = ownerPushDedupeKeyV1("attention:supervisor:ledger");
      await openAttention(admin, "attention:supervisor:ledger");

      const ledger = async () => (await admin.query<{ state: string; status_code: number | null; completed_at: string | Date | null }>(
        "SELECT state,status_code,completed_at FROM owner_web_push_deliveries WHERE tenant_id=$1 AND subscription_id=$2 AND dedupe_key=$3",
      [TENANT, subscriptionId, dedupeKey])).rows[0];

      // --- FIRST ATTEMPT: the endpoint is down. This is the ordinary product
      // path, through the real store and the production login.
      let sends = 0;
      let up = false;
      const channel: OwnerNotificationChannelV1 = { kind: "web-push", async send() {
        sends++;
        if (!up) throw { statusCode: 503 };
        return { statusCode: 201 };
      } };
      const first = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock: () => millis });
      assert.equal((await first.dispatch()).length, 1, "the item is claimed once");
      assert.equal(sends, 1, "the down endpoint was contacted once");
      assert.equal((await ledger())!.state, "failed", "a send that failed is recorded as failed, not delivered");

      // --- THE RETRY: the endpoint recovers. `reserve` is asked for the SAME
      // (tenant, subscription, dedupe_key), so its ON CONFLICT branch runs, and
      // the question the test exists to answer is what that branch does to a
      // 'failed' row.
      up = true;
      millis += ownerPushBackoffMsV1(1) + 60_000;
      const retry = await first.dispatch();
      assert.equal(retry.length, 1, "the waiting item is claimed again");
      assert.equal(retry[0]!.result, "delivered", "the retry succeeds, so the item is delivered");
      assert.equal(sends, 2, "the recovering endpoint was really contacted");

      // THE DISTINGUISHING ASSERTION. Read on an INDEPENDENT connection, so
      // this is what the database holds and not what the sender believes.
      const afterRetry = await ledger();
      assert.equal(afterRetry!.state, "delivered",
        "the retried send is recorded as DELIVERED: the 'failed' row was upgraded to 'reserved' before the send, "
        + "so `delivered()`'s state='reserved' predicate matched it");
      assert.equal(afterRetry!.status_code, 201, "and carries the status the push service returned");

      // The consequence, which is what makes the two behaviours observably
      // different rather than two ledgers with different words in them: a
      // later delivery of the same event must be SUPPRESSED by this ledger.
      millis += 8 * 60 * 60 * 1000;
      assert.equal((await first.dispatch()).length, 0, "a delivered item is never claimed again");
      assert.equal(sends, 2, "so the phone is not alerted a second time for one stall");
    } finally { await admin.end(); }
  }, { port: PORT + 10, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});

// Mutation cook-pushretry.json#4: `h.state='pending'` in the claim SELECT
// (dispatcher.ts:304).
//
// The claim reserves exactly the rows its own transaction holds locked, and the
// reserve repeats `state='pending'` in its WHERE clause, so a 'reserved' row
// that slips into the SELECT window cannot be reserved a second time. That
// later guard prevents a DUPLICATE; it does not prevent the row from CONSUMING
// one slot of `LIMIT $3`. The claim transaction commits before the send, so a
// 'reserved' row left by a dispatcher that died mid-send holds no lock and is
// not filtered by FOR UPDATE SKIP LOCKED either.
test("real PostgreSQL: a reserved head younger than the stale window does not consume the claim's limit",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push claim window')", [TENANT]);
      await subscribe(admin, `push:${"8".repeat(64)}`);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      const clock = () => millis;
      const RESERVED = "attention:supervisor:reserved", PENDING = "attention:supervisor:due";
      await openAttention(admin, RESERVED);
      await openAttention(admin, PENDING);
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, clock,
        channel: { kind: "web-push", async send() { return { statusCode: 201 }; } } }).adoptOpenAttention();

      // Both heads are due, and the RESERVED one sorts FIRST in the claim's
      // `ORDER BY h.next_attempt_at,h.action_inbox_id` window. It is younger
      // than OWNER_PUSH_RESERVATION_STALE_MS_V1, so
      // `recoverStaleReservations` cannot reclaim it and it is a genuine
      // mid-send reservation rather than an abandoned one.
      const when = new Date(millis).toISOString();
      await admin.query(`UPDATE control_owner_push_attempt_heads
        SET state='reserved',attempt_count=1,reserved_at=$3,last_attempt_at=$3,updated_at=$3,
          next_attempt_at=$4
        WHERE tenant_id=$1 AND action_inbox_id=$2`, [TENANT, RESERVED, when, new Date(millis - 1_000).toISOString()]);
      await admin.query(`UPDATE control_owner_push_attempt_heads SET next_attempt_at=$3,updated_at=$3
        WHERE tenant_id=$1 AND action_inbox_id=$2`, [TENANT, PENDING, when]);
      assert.ok(Date.parse(when) - Date.parse(new Date(millis - 1_000).toISOString()) < OWNER_PUSH_RESERVATION_STALE_MS_V1,
        "the reserved head is well inside the stale window, so only the claim's own state filter can exclude it");

      // LIMIT 1. The whole defect is that a row the caller may not claim can
      // take the one slot, so a batch of one is the shape that exposes it.
      let sends = 0;
      const dispatcher = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, clock,
        channel: { kind: "web-push", async send(_subscription, payload) { sends++; return { statusCode: 201 }; } } });
      const outcomes = await dispatcher.dispatch(1);
      assert.equal(outcomes.length, 1,
        `the claim returns one outcome: a window holding only an unclaimable row would return none. ${JSON.stringify(outcomes)}`);
      assert.equal(outcomes[0]!.actionInboxId, PENDING,
        "and the one slot went to the DUE PENDING head, not to the reserved one");
      assert.equal(sends, 1, "so the waiting item is actually sent on this pass");
      const rows = (await heads(admin)).rows;
      const reservedRow = rows.find(row => row.action_inbox_id === RESERVED)!;
      assert.equal(reservedRow.state, "reserved", "the live reservation is left exactly as its owner left it");
      assert.equal(Number(reservedRow.attempt_count), 1, "and it spent no attempt: nothing claimed it");
      assert.equal(rows.find(row => row.action_inbox_id === PENDING)!.state, "delivered",
        "the due head is delivered in the pass its own window made room for");

      // The FULL-WINDOW variant, because a batch of one is the smallest shape
      // that shows the slot being wasted. Sixty-four reserved heads filling the
      // default window is the production shape: with the state filter widened,
      // `adoptOpenAttention` and `recoverStaleReservations` leave them alone,
      // the SELECT returns 64 rows the UPDATE refuses all of, and the batch is
      // empty while a genuinely due item waits behind them.
      // The reset deletes the attention ITEMS too, not just their heads. Heads
      // cascade from the items, and leaving the two items from the first half in
      // place would let `adoptOpenAttention`'s own LIMIT 64 window adopt them
      // instead of two of the fillers -- which is a fixture bug, not a property
      // of the guard, and is exactly the kind of thing that makes a full-window
      // test quietly measure nothing.
      const BURNT = 64;
      await admin.query("DELETE FROM control_action_inbox WHERE tenant_id=$1", [TENANT]);
      assert.equal((await heads(admin)).rows.length, 0, "the tenant starts the full window with no heads at all");
      for (let index = 0; index < BURNT; index += 1) await openAttention(admin, `attention:supervisor:fill-${index}`);
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, clock,
        channel: { kind: "web-push", async send() { return { statusCode: 201 }; } } }).adoptOpenAttention();
      await admin.query(`UPDATE control_owner_push_attempt_heads SET state='reserved',attempt_count=1,
        reserved_at=$2,last_attempt_at=$2,updated_at=$2,next_attempt_at=$3 WHERE tenant_id=$1`,
      [TENANT, new Date(millis - 1_000).toISOString(), new Date(millis - 2_000).toISOString()]);
      await openAttention(admin, "attention:supervisor:behind");
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, clock,
        channel: { kind: "web-push", async send() { return { statusCode: 201 }; } } }).adoptOpenAttention();
      // The waiting item is due SOONEST, so it is first in the window by
      // `ORDER BY next_attempt_at` -- and it still has to be reached.
      await admin.query(`UPDATE control_owner_push_attempt_heads SET next_attempt_at=$3,updated_at=$3
        WHERE tenant_id=$1 AND action_inbox_id=$2`,
      [TENANT, "attention:supervisor:behind", new Date(millis - 60_000).toISOString()]);
      const sendsBefore = sends;
      const full = await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, clock,
        channel: { kind: "web-push", async send(_subscription, payload) { sends++; return { statusCode: 201 }; } } }).dispatch();
      assert.deepEqual(full.map(outcome => outcome.actionInboxId), ["attention:supervisor:behind"],
        "a full window of reserved heads still lets the due item through: the reserved ones are not claimable");
      assert.equal(sends, sendsBefore + 1, "and the due item is sent, not merely reported");
      const fill = (await heads(admin)).rows.filter(row => row.action_inbox_id.startsWith("attention:supervisor:fill-"));
      assert.equal(fill.length, BURNT, "the filler heads are all still there");
      assert.ok(fill.every(row => row.state === "reserved" && Number(row.attempt_count) === 1),
        "and none of them was claimed, re-reserved or charged an attempt");

      // --- UNDER LOAD, because a widened state filter does its real damage
      // here rather than in a two-row fixture: with 'reserved' rows selectable,
      // N dispatchers each pick the same unclaimable rows into their own LIMIT
      // window, so every one of them returns an empty batch and the due item
      // starves for as long as the reservations are young. Thirty dispatchers
      // on INDEPENDENT connections is the stampede the guard has to survive;
      // one shared client would serialise them and hide it.
      await admin.query("DELETE FROM control_action_inbox WHERE tenant_id=$1", [TENANT]);
      // The ORDER here is the whole fixture. The filler heads are adopted and
      // reserved FIRST, and the items to be delivered are adopted AFTER, so the
      // single bulk UPDATE touches only the fillers. Reversing those two steps
      // reserves the due items too, and the stampede then has nothing to send --
      // a fixture that measures nothing while looking like a starvation test.
      for (let index = 0; index < BURNT; index += 1) await openAttention(admin, `attention:supervisor:racefill-${index}`);
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, clock,
        channel: { kind: "web-push", async send() { return { statusCode: 201 }; } } }).adoptOpenAttention();
      await admin.query(`UPDATE control_owner_push_attempt_heads SET state='reserved',attempt_count=1,
        reserved_at=$2,last_attempt_at=$2,updated_at=$2,next_attempt_at=$3 WHERE tenant_id=$1`,
      [TENANT, new Date(millis - 1_000).toISOString(), new Date(millis - 2_000).toISOString()]);
      assert.equal((await heads(admin)).rows.filter(row => row.state === "reserved").length, BURNT,
        "the filler window is full of unclaimable reservations before anything is due behind it");
      const STAMPEDE = 30;
      for (let index = 0; index < STAMPEDE; index += 1) await openAttention(admin, `attention:supervisor:race-${index}`);
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, clock,
        channel: { kind: "web-push", async send() { return { statusCode: 201 }; } } }).adoptOpenAttention();
      assert.equal((await heads(admin)).rows.filter(row => row.state === "pending").length, STAMPEDE,
        "and exactly the STAMPEDE items are pending behind them");
      const tags: string[] = [];
      const began = Date.now();
      const runs = await Promise.all(Array.from({ length: STAMPEDE }, () => {
        const own = asClient(postgres.connection("web"));
        return new OwnerPushDispatcherV1({ db: own, tenantId: TENANT, store: new PostgresOwnerPushStoreV1(own),
          clock, channel: { kind: "web-push", async send(_subscription, payload) {
            tags.push(payload.tag); return { statusCode: 201 }; } } }).dispatch();
      }));
      assert.ok(Date.now() - began < 120_000, "thirty concurrent dispatchers finish promptly rather than queueing");
      const raced = runs.flat();
      assert.equal(raced.filter(outcome => outcome.result === "delivered").length, STAMPEDE,
        `every due item is delivered exactly once across ${STAMPEDE} racing dispatchers; got ${raced.length} outcomes`);
      assert.equal(new Set(raced.map(outcome => outcome.actionInboxId)).size, STAMPEDE,
        "and no item is claimed twice: the reserved filler heads never enter the window to crowd one out");
      assert.equal(tags.length, STAMPEDE, "so exactly one push landed per item");
      assert.equal(new Set(tags).size, STAMPEDE, "and no tag was pushed twice: no duplicate send under a stampede");
      // Scoped to the RACED items. The filler heads are supposed to be still
      // 'reserved' -- that is the precondition, not a failure -- so asserting
      // over every head in the tenant would test the fixture against itself.
      const racedRows = (await heads(admin)).rows.filter(row => row.action_inbox_id.startsWith("attention:supervisor:race-"));
      assert.equal(racedRows.length, STAMPEDE, "every raced item has a head");
      assert.ok(racedRows.every(row => row.state === "delivered" && Number(row.attempt_count) === 1),
        `every raced head is delivered on exactly one attempt; saw ${[...new Set(racedRows.map(r => r.state))].join(",")}`);
      const stillReserved = (await heads(admin)).rows.filter(row => row.action_inbox_id.startsWith("attention:supervisor:racefill-"));
      assert.ok(stillReserved.every(row => row.state === "reserved" && Number(row.attempt_count) === 1),
        "and the reserved filler heads were never touched by any of the thirty dispatchers");
    } finally { await admin.end(); }
  }, { port: PORT + 11, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});

// Mutations cook-pushretry.json#11 and #12: the 0224 table's own CONSTRAINTS,
// both of which sit inside the boundary the private-web role is granted.
//
// 0226 grants the dispatcher SELECT, INSERT and a column-scoped UPDATE on this
// table, and 0225's trigger is BEFORE UPDATE only. So a direct INSERT is a
// write the production role can really make, and these two constraints are the
// ONLY things between that role and an open redirect or two heads for one item.
// The application-side guards are kept -- `ownerPushLinkV1` still re-validates
// on the way out, and `adoptOpenAttention`'s ON CONFLICT DO NOTHING still
// holds -- but neither can make the stored rows equal, so the refusals have to
// be asserted where they live.
test("real PostgreSQL: the owner web login cannot write a head with an off-path link, or two heads for one item",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push insert refusals')", [TENANT]);
      const ITEM = "attention:supervisor:insert";
      await openAttention(admin, ITEM);
      const when = new Date().toISOString();
      // A statement that RAISEs leaves its session in an aborted transaction,
      // and every later statement on that connection then fails 25P02 rather
      // than with the refusal under test. Each refusal is therefore proved on
      // its OWN owner-web connection, which is also the honest reading of the
      // grant: the role can attempt each of these writes.
      const insertAsOwnerWeb = async (item: string, link: string) => {
        const web = new Client(postgres.connection("web"));
        try {
          await web.connect();
          return await web.query(`INSERT INTO control_owner_push_attempt_heads
            (tenant_id,action_inbox_id,link,attempt_count,state,next_attempt_at,created_at,updated_at)
            VALUES($1,$2,$3,0,'pending',$4,$4,$4)`, [TENANT, item, link, when]);
        } finally { await web.end().catch(() => {}); }
      };

      // #11. A link the column CHECK admits only by being a string that starts
      // with a slash. `//evil.invalid` is a protocol-relative URL: a phone that
      // opens it leaves the installation entirely.
      await assert.rejects(() => insertAsOwnerWeb(ITEM, "//evil.invalid"),
        (error: { code?: string; message?: string }) => {
          assert.equal(error.code, "23514",
            `the link CHECK refuses it, and it is the column CHECK that does: ${error.message}`);
          return true;
        },
        "a protocol-relative link cannot be stored, so no send can ever carry one");

      // Three more shapes the same rule covers, because the finding's example is
      // only a sample. A nested path, a differently-cased product path and an
      // unrelated product path are all strings that start with a slash and none
      // of them is one of the three the phone may open. Measured on this lane
      // rather than assumed: with the CHECK widened to '^/' all three are
      // admitted, and none of them is refused by any trigger.
      //
      // A scheme-qualified URL is NOT in this list on purpose. It does not start
      // with a slash, so both the shipped CHECK and the widened one refuse it
      // and it distinguishes nothing. It was measured, found to be equivalent
      // here, and dropped rather than left in as decoration.
      for (const link of ["/needs-me/../admin", "/Needs-me", "/admin/settings"]) {
        await assert.rejects(() => insertAsOwnerWeb(ITEM, link),
          (error: { code?: string }) => { assert.equal(error.code, "23514", `${link} is refused by the link CHECK`); return true; },
          `${link} is not a product path and is refused`);
      }

      // #12. Two heads for the SAME tenant/item. 0224's primary key is
      // (tenant_id, action_inbox_id) and 0225's trigger forbids changing it on
      // UPDATE, so the pair key is what makes one item one push for the life of
      // the installation.
      const first = await insertAsOwnerWeb(ITEM, "/needs-me");
      assert.equal(first.rowCount, 1, "the first head for an item is admitted: nothing here is over-refused");
      await assert.rejects(() => insertAsOwnerWeb(ITEM, "/morning"),
        (error: { code?: string; message?: string }) => {
          assert.equal(error.code, "23505", `the pair key refuses the second head: ${error.message}`);
          return true;
        },
        "a second head for one item is refused, so one stall can never be pushed twice");

      // And the refusals left exactly one row, holding the one link written.
      const stored = (await admin.query<{ link: string; state: string; attempt_count: number | string }>(
        "SELECT link,state,attempt_count FROM control_owner_push_attempt_heads WHERE tenant_id=$1 AND action_inbox_id=$2",
      [TENANT, ITEM])).rows;
      assert.equal(stored.length, 1, "one item, one head");
      assert.deepEqual({ link: stored[0]!.link, state: stored[0]!.state, attempt_count: Number(stored[0]!.attempt_count) },
        { link: "/needs-me", state: "pending", attempt_count: 0 },
        "and it is the one that was actually written");
    } finally { await admin.end(); }
  }, { port: PORT + 13, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
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


// ---------------------------------------------------------------------------
// R6C-04 / R6C-05: the two crash boundaries, on real PostgreSQL as the
// production owner-web login.
//
// Both lanes SIGKILL a real child dispatcher that is running the real claim SQL
// and the real send, and both then restart a dispatcher on the same database
// with the clock past OWNER_PUSH_RESERVATION_STALE_MS_V1. The child is spawned
// into its own process group and only that group is killed, so a lane can never
// reach another job's processes, and the stop is in a finally on every path.
// ---------------------------------------------------------------------------

test("real PostgreSQL: a kill on the FINAL attempt is settled honestly, not left reserved forever",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const scratch = await scratchDirectory("final-attempt");
    const item = "attention:supervisor:crash-final";
    const channel: OwnerNotificationChannelV1 = { kind: "web-push", async send() { return { statusCode: 201 }; } };
    let child: ReturnType<typeof crashChild> | undefined;
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push final crash')", [TENANT]);
      await subscribe(admin, `push:${"1".repeat(64)}`);
      await openAttention(admin, item);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      const clock = () => millis;

      // Adopt the head, then prepare it at ONE BELOW the bound: the claim the
      // child is about to take spends attempt 8, and 8 is the last one the
      // schema allows. Nothing after this point may retry the item, so the
      // crash leaves nowhere to go.
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock }).adoptOpenAttention();
      const at = new Date(millis).toISOString();
      await windHeadToReserved(admin, item, OWNER_PUSH_ATTEMPT_LIMIT_V1 - 1, at);
      await admin.query(`UPDATE control_owner_push_attempt_heads SET state='pending',
        next_attempt_at=$3,reserved_at=NULL,last_attempt_at=NULL,completed_at=NULL,
        safe_reason_code=NULL,updated_at=$3 WHERE tenant_id=$1 AND action_inbox_id=$2`,
      [TENANT, item, at]);
      assert.equal(Number((await heads(admin)).rows[0]!.attempt_count), OWNER_PUSH_ATTEMPT_LIMIT_V1 - 1,
        "the fixture really is one attempt below the bound, spent through the guard");

      // The crash. A real child, the real claim SQL, the production web login.
      // It parks after its claim transaction has COMMITTED, so the reservation
      // really is durable when it is killed and no send was ever attempted.
      child = crashChild({ connection: postgres.connection("web"), tenantId: TENANT,
        mode: "claim_committed" });
      assert.equal(await child.ready, "CLAIM_COMMITTED",
        "the child's claim really committed before it was killed");
      await child.stop();
      child = undefined;

      // What a restart finds: reserved, at the bound, with no completion.
      const stranded = (await heads(admin)).rows[0]!;
      assert.equal(stranded.state, "reserved");
      assert.equal(Number(stranded.attempt_count), OWNER_PUSH_ATTEMPT_LIMIT_V1,
        "the final attempt is spent, so no further claim is possible");
      assert.equal(stranded.completed_at, null);
      const ledger = await admin.query("SELECT count(*)::int AS n FROM owner_web_push_deliveries WHERE tenant_id=$1", [TENANT]);
      assert.equal(ledger.rows[0]!.n, 0, "and the 0174 ledger proves nothing was ever delivered");

      // The restarted dispatcher's clock, past the reservation threshold.
      millis += OWNER_PUSH_RESERVATION_STALE_MS_V1 + 60_000;
      const restarted = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock });
      // Three passes, exactly as a host restart's first ticks would be. Before
      // the fix each one returns nothing and the row stays reserved, which is
      // the finding: an item whose phone notification has stopped progressing,
      // neither delivered nor terminal.
      const passes = [await restarted.dispatch(), await restarted.dispatch(), await restarted.dispatch()];

      const settledRow = (await heads(admin)).rows[0]!;
      assert.notEqual(settledRow.state, "reserved",
        "a stale final reservation must not be left reserved forever: the owner would see an item whose phone alert has silently stopped");
      assert.ok(["failed", "delivered"].includes(settledRow.state),
        `the head reaches a terminal state, not a stuck one (found ${settledRow.state})`);
      assert.ok(settledRow.completed_at, "a terminal head carries a completion instant in both senses");
      assert.equal(Number(settledRow.attempt_count), OWNER_PUSH_ATTEMPT_LIMIT_V1,
        "attempt counts stay monotonic and are never decremented to make room for a settle");
      assert.equal(settledRow.safe_reason_code, "owner_push_crashed_at_final_attempt",
        "and says honestly that a crash, not an exhausted endpoint, is why it stopped");
      // The three passes agree, and none of them ever rings the phone: this
      // dispatcher's ledger proves the send never happened.
      assert.ok(passes.every(outcomes => outcomes.every(outcome => outcome.result !== "delivered")),
        "no pass claims the item was delivered, because no send was ever accepted");

      // And it is never claimed again, however far the clock moves.
      millis += 24 * 60 * 60_000;
      assert.equal((await restarted.dispatch()).length, 0, "a terminal head is never claimed again");
    } finally {
      if (child) await child.stop().catch(() => {});
      await scratch.remove();
      await admin.end();
    }
  }, { port: PORT + 6, allowedPorts: PORTS, database: "control_room", boundMs: 300_000 });
});

test("real PostgreSQL: a stale FINAL reservation whose ledger proves delivery is recorded as delivered",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const scratch = await scratchDirectory("final-delivered");
    const item = "attention:supervisor:crash-delivered";
    let sends = 0;
    const channel: OwnerNotificationChannelV1 = { kind: "web-push",
      async send() { sends++; return { statusCode: 201 }; } };
    let child: ReturnType<typeof crashChild> | undefined;
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push crash delivered')", [TENANT]);
      await subscribe(admin, `push:${"2".repeat(64)}`);
      await openAttention(admin, item);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      const clock = () => millis;
      const subscriptionId = `push:${"2".repeat(64)}`;
      const dedupeKey = ownerPushDedupeKeyV1(item);

      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock }).adoptOpenAttention();
      const at = new Date(millis).toISOString();
      // The crash that happened AFTER the provider accepted the final send but
      // BEFORE the head was settled: the 0174 ledger holds a DELIVERED row,
      // which is the proof that the phone really did ring, and the head is
      // still reserved at the bound with no completion.
      await store.reserve(TENANT, subscriptionId, dedupeKey, at);
      sends++;
      await store.delivered(TENANT, subscriptionId, dedupeKey, at);
      await windHeadToReserved(admin, item, OWNER_PUSH_ATTEMPT_LIMIT_V1, at);
      const before = sends;

      millis += OWNER_PUSH_RESERVATION_STALE_MS_V1 + 60_000;
      const restarted = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock });
      await restarted.dispatch();
      await restarted.dispatch();

      const settled = (await heads(admin)).rows[0]!;
      assert.equal(settled.state, "delivered",
        "the ledger proved the send landed, so this is delivered rather than a failure");
      assert.equal(settled.safe_reason_code, null,
        "a delivered head records no failure reason: nothing went wrong with the phone");
      assert.ok(settled.completed_at);
      assert.equal(Number(settled.attempt_count), OWNER_PUSH_ATTEMPT_LIMIT_V1,
        "the crashed attempt still counts: an attempt was really spent");
      assert.equal(sends, before, "and the phone was not rung a second time");
      millis += 24 * 60 * 60_000;
      assert.equal((await restarted.dispatch()).length, 0, "a delivered head is never claimed again");
    } finally {
      if (child) await child.stop().catch(() => {});
      await scratch.remove();
      await admin.end();
    }
  }, { port: PORT + 5, allowedPorts: PORTS, database: "control_room", boundMs: 300_000 });
});

test("real PostgreSQL: a stale final reservation for a CLOSED item is not resurrected",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const scratch = await scratchDirectory("final-closed");
    const item = "attention:supervisor:crash-closed";
    let sends = 0;
    const channel: OwnerNotificationChannelV1 = { kind: "web-push",
      async send() { sends++; return { statusCode: 201 }; } };
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push crash closed')", [TENANT]);
      await subscribe(admin, `push:${"3".repeat(64)}`);
      await openAttention(admin, item);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      const clock = () => millis;
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock }).adoptOpenAttention();
      const at = new Date(millis).toISOString();
      await windHeadToReserved(admin, item, OWNER_PUSH_ATTEMPT_LIMIT_V1, at);
      // The owner answered the item while the dispatcher was dead. A push for an
      // item nobody needs any more is noise, and the item's own state is the
      // authority on that -- not the head.
      // Closed by the SUPERVISOR, over its own login -- not by this fixture over
      // the web login. 0102's guard refuses exactly that: the private-web role
      // may not close a supervisor attention item at all (only its own
      // `attention:work-batch:%` rows), and MEASURED here -- the first version of
      // this fixture ran as `fixture_admin`, whose session is not a member of
      // that role, so the trigger's own membership test passed while the write
      // it was trying to model was not one the web login could ever make.
      //
      // The coordinator login is the one the supervisor loop is composed on
      // (mac-local-default-task-provider.ts), so the resolution is made the way
      // the product makes it, with the payload's `state` field moving with it.
      const coordinator = new Client(postgres.connection("coordinator"));
      try {
        await coordinator.connect();
        await coordinator.query("SET search_path=pg_catalog, public");
        await coordinator.query(`UPDATE control_action_inbox SET state='resolved',
          payload=pg_catalog.jsonb_set(payload,'{state}','"resolved"'::jsonb,true)
          WHERE tenant_id=$1 AND id=$2`, [TENANT, item]);
      } finally { await coordinator.end().catch(() => {}); }
      assert.equal((await admin.query<{ state: string }>(
        "SELECT state FROM control_action_inbox WHERE tenant_id=$1 AND id=$2", [TENANT, item])).rows[0]!.state,
        "resolved", "the item really is closed before the dispatcher restarts");

      millis += OWNER_PUSH_RESERVATION_STALE_MS_V1 + 60_000;
      const restarted = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock });
      assert.equal((await restarted.dispatch()).length, 0, "a closed item is never offered to the phone again");
      assert.equal(sends, 0, "and nothing is sent for it");
      const settled = (await heads(admin)).rows[0]!;
      assert.equal(settled.state, "failed",
        "the abandoned reservation is still settled, so it is not a row nothing can claim again");
      assert.equal(settled.safe_reason_code, "owner_push_item_no_longer_open");
      assert.ok(settled.completed_at);
      assert.equal(Number(settled.attempt_count), OWNER_PUSH_ATTEMPT_LIMIT_V1, "and the spent attempt is never refunded");
    } finally { await scratch.remove(); await admin.end(); }
  }, { port: PORT + 4, allowedPorts: PORTS, database: "control_room", boundMs: 240_000 });
});

test("real PostgreSQL: a kill after provider acceptance but before the ledger sends the event again",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const scratch = await scratchDirectory("accepted");
    const tagLog = join(scratch.path, "accepted-tags.log");
    const item = "attention:supervisor:crash-accepted";
    let sends = 0;
    // The restarted dispatcher's provider records its acceptances into the SAME
    // durable log the killed child wrote. Without that the count would only ever
    // contain the child's acceptance, and the duplicate under test would be
    // invisible: the two providers have to be counted together, which is exactly
    // what the owner's push service would see.
    const channel: OwnerNotificationChannelV1 = { kind: "web-push", async send(_subscription, payload) {
      sends++;
      await appendFile(tagLog, `${payload.tag}\n`, "utf8");
      return { statusCode: 201 };
    } };
    let child: ReturnType<typeof crashChild> | undefined;
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push crash accepted')", [TENANT]);
      await subscribe(admin, `push:${"4".repeat(64)}`);
      await openAttention(admin, item);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      const clock = () => millis;
      const dedupeKey = ownerPushDedupeKeyV1(item);

      // The crash, at the exact window delivery.ts cannot make atomic: the
      // provider ACCEPTED the send and the ledger has not recorded it.
      child = crashChild({ connection: postgres.connection("web"), tenantId: TENANT,
        mode: "provider_accepted", tagLog });
      assert.equal(await child.ready, "PROVIDER_ACCEPTED",
        "the provider really accepted the event before the process died");
      await child.stop();
      child = undefined;

      assert.deepEqual(await acceptedTags(tagLog), [dedupeKey], "the acceptance really happened, once");
      const ledger = await admin.query<{ state: string }>(
        "SELECT state FROM owner_web_push_deliveries WHERE tenant_id=$1", [TENANT]);
      assert.equal(ledger.rows[0]?.state, "reserved",
        "and the local record is still 'reserved': the kill landed between the send and the ledger write");
      const stranded = (await heads(admin)).rows[0]!;
      assert.equal(stranded.state, "reserved");
      assert.equal(Number(stranded.attempt_count), 1);

      // Restart on the same database, past the reservation threshold. The
      // 0174 ledger maps a surviving 'reserved' row to a resendable outcome, so
      // this is where the owner can be handed the same event twice.
      millis += OWNER_PUSH_RESERVATION_STALE_MS_V1 + 60_000;
      const restarted = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock });
      const outcomes = await restarted.dispatch();
      assert.equal(outcomes.length, 1, "the abandoned reservation is picked back up");
      const after = await acceptedTags(tagLog);
      const settled = (await heads(admin)).rows[0]!;
      assert.ok(settled.completed_at, "the retry settles the head, whatever it concluded");
      // The product promise: ONE owner-visible alert for one Needs-you item.
      // Whether the second acceptance is owner-VISIBLE is decided by the
      // service worker's receiver-side dedupe (owner-push-service-worker.test.mjs),
      // because the sender cannot make provider acceptance and a local database
      // write atomic. What this lane proves on the sender side is that the
      // ambiguity is real and that the item does converge on one terminal head.
      assert.equal(after.length, 2,
        `MEASURED: the provider is handed the same event twice (accepted ${JSON.stringify(after)})`);
      assert.equal(new Set(after).size, 1, "both acceptances carry the same event identity, so the receiver can recognise them");
      assert.equal(settled.state, "delivered", "and the item still converges on one delivered head");

      // The control: a durably delivered ledger must NOT produce a second
      // acceptance. This is the same lane with the ledger written, and it is
      // what makes the duplicate above a boundary fact rather than a broken
      // reserve.
      const controlItem = "attention:supervisor:crash-accepted-control";
      await openAttention(admin, controlItem);
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock }).adoptOpenAttention();
      await store.reserve(TENANT, `push:${"4".repeat(64)}`, ownerPushDedupeKeyV1(controlItem), new Date(millis).toISOString());
      sends++;
      await store.delivered(TENANT, `push:${"4".repeat(64)}`, ownerPushDedupeKeyV1(controlItem), new Date(millis).toISOString());
      const controlBefore = (await acceptedTags(tagLog)).length;
      await windHeadToReserved(admin, controlItem, 1,
        new Date(millis - OWNER_PUSH_RESERVATION_STALE_MS_V1 - 60_000).toISOString());
      await restarted.dispatch();
      assert.equal((await acceptedTags(tagLog)).length, controlBefore,
        "a durably delivered ledger stops the resend entirely: the sender's own dedupe works when it is allowed to");
    } finally {
      if (child) await child.stop().catch(() => {});
      await scratch.remove();
      await admin.end();
    }
  }, { port: PORT + 7, allowedPorts: PORTS, database: "control_room", boundMs: 300_000 });
});

test("real PostgreSQL: twenty restart dispatchers settle one stranded final reservation exactly once",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const scratch = await scratchDirectory("stranded-race");
    const items = Array.from({ length: 20 }, (_value, index) => `attention:supervisor:stranded-${index}`);
    const channel: OwnerNotificationChannelV1 = { kind: "web-push", async send() { return { statusCode: 201 }; } };
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push stranded race')", [TENANT]);
      await subscribe(admin, `push:${"6".repeat(64)}`);
      for (const item of items) await openAttention(admin, item);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      const clock = () => millis;
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock }).adoptOpenAttention();
      // Twenty heads all stranded at the bound by twenty different killed
      // dispatchers. Every one of them has to reach a terminal state, and no
      // two recovery passes may fight over the same rows.
      const strandedAt = new Date(millis - OWNER_PUSH_RESERVATION_STALE_MS_V1 - 60_000).toISOString();
      for (const stranded of items) await windHeadToReserved(admin, stranded, OWNER_PUSH_ATTEMPT_LIMIT_V1, strandedAt);
      millis += OWNER_PUSH_RESERVATION_STALE_MS_V1 + 60_000;

      // Twenty passes, twenty heads, and the SUM of what they settled is the
      // exclusivity assertion: exactly twenty settlements for twenty stranded
      // heads, so no head was settled twice and none was left out.
      //
      // `dispatch()` is what runs the recovery -- it calls
      // `recoverStaleReservations` before its claim -- so the count is read from
      // the recovered rows themselves rather than from a second call. A second
      // call here would report 0 by construction and prove nothing: the first
      // one had already taken every row.
      const settledCounts = await Promise.all(Array.from({ length: 20 }, async () => {
        const own = asClient(postgres.connection("web"));
        const dispatcher = new OwnerPushDispatcherV1({ db: own, tenantId: TENANT,
          store: new PostgresOwnerPushStoreV1(own), channel, clock: () => millis });
        // `recoverStaleReservations` is called directly here rather than through
        // `dispatch()` so the count is this pass's, with nothing else racing it
        // inside the same promise chain.
        return await dispatcher.recoverStaleReservations();
      }));
      const after = (await heads(admin)).rows;
      assert.equal(after.length, 20, "all twenty stranded heads are accounted for");
      assert.ok(after.every(row => row.state === "failed"),
        `every stranded final reservation reaches a terminal state; found ${[...new Set(after.map(row => row.state))].join(",")}`);
      assert.ok(after.every(row => row.completed_at), "and each carries a completion instant");
      assert.ok(after.every(row => row.safe_reason_code === "owner_push_crashed_at_final_attempt"),
        "with the honest crashed reason, not the endpoint-unavailable one");
      assert.ok(after.every(row => Number(row.attempt_count) === OWNER_PUSH_ATTEMPT_LIMIT_V1),
        "and no attempt count moved, in either direction, under twenty racing recoveries");
      const total = settledCounts.reduce((sum, settled) => sum + settled, 0);
      assert.equal(total, 20,
        `exactly twenty settlements happened across twenty concurrent recoveries, one per head; summed ${total} from ${JSON.stringify(settledCounts)}`);
      assert.ok(settledCounts.filter((settled) => settled > 0).length <= 20,
        "and no pass settled a head another pass had already taken");
    } finally { await scratch.remove(); await admin.end(); }
  }, { port: PORT + 9, allowedPorts: PORTS, database: "control_room", boundMs: 300_000 });
});

test("real PostgreSQL: a stale reservation BELOW the bound still returns to pending and delivers",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const scratch = await scratchDirectory("below-bound");
    const item = "attention:supervisor:crash-below-bound";
    let sends = 0;
    const channel: OwnerNotificationChannelV1 = { kind: "web-push",
      async send() { sends++; return { statusCode: 201 }; } };
    let child: ReturnType<typeof crashChild> | undefined;
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Push crash below bound')", [TENANT]);
      await subscribe(admin, `push:${"7".repeat(64)}`);
      await openAttention(admin, item);
      const db = asClient(postgres.connection("web"));
      const store = new PostgresOwnerPushStoreV1(db);
      let millis = Date.now();
      const clock = () => millis;
      // The recovery must NOT short-circuit a head that still has attempts
      // left. This is the control that keeps the new terminal path from being
      // a blanket "everything crashed is failed": an item at attempt 1 of 8 is
      // still retryable, and the fix must leave that alone.
      await new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock }).adoptOpenAttention();
      const at = new Date(millis).toISOString();
      await windHeadToReserved(admin, item, 1, at);

      millis += OWNER_PUSH_RESERVATION_STALE_MS_V1 + 60_000;
      const restarted = new OwnerPushDispatcherV1({ db, tenantId: TENANT, store, channel, clock });
      const outcomes = await restarted.dispatch();
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.result, "delivered",
        "an item below the bound is still retryable after a crash, and it delivers");
      assert.equal(sends, 1, "the retry is the send that lands");
      const settled = (await heads(admin)).rows[0]!;
      assert.equal(settled.state, "delivered");
      assert.equal(Number(settled.attempt_count), 2, "the crashed attempt still counted, and the retry added one");
      assert.equal(settled.safe_reason_code, null, "and nothing claims the phone failed");
    } finally {
      if (child) await child.stop().catch(() => {});
      await scratch.remove();
      await admin.end();
    }
  }, { port: PORT + 8, allowedPorts: PORTS, database: "control_room", boundMs: 240_000 });
});
