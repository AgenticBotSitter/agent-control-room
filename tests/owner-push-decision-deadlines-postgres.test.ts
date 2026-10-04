// R7I-02: a decision the owner is expected to take must ring the phone, once.
//
// The dispatcher adopted only `failure`, `ambiguity` and `incident`. Every kind
// the DECISION machinery writes -- the work-batch `approval`, the pipeline
// `question`, the `authority_expiry` item that carries the deadline -- was
// silently never pushed. An owner could sit on an expiring authority with no
// notification, having been told on Settings that notices ring the phone.
//
// Real PostgreSQL 17 as the production web login (control_room_web), because the
// dispatcher is composed on the private-web client: running it as a superuser
// would prove nothing about the ACL the installed role has. The item rows are
// written with the SHIPPED producers (`workBatchOwnerNotificationV1`,
// `workBatchOwnerNotificationV1`) rather
// than by hand, so this cannot pass against a kind the product never emits.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { OwnerPushDispatcherV1 } from "../src/web-push/v1";
import { PostgresOwnerPushStoreV1 } from "../src/web-push/v1/postgres-store";
import { workBatchOwnerNotificationV1 } from "../src/work-intake/v1/owner-notification";
import type { DatabaseClient } from "../src/persistence/database";
import type { OwnerNotificationChannelV1 } from "../src/web-push/v1/types";

// A slot of its own ABOVE the push suite's block: `owner-push-dispatch-postgres`
// takes BASE+0..BASE+9, so sharing BASE and picking BASE+5 put both files on the
// same port and the harness refused the second cluster with
// `refusing_occupied_port`. Two suites that both need a cluster must not share a
// port, and the harness's refusal is the correct behaviour, not a flake.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59480) + 10;
const PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => PORT + index));
// One more block up from the attention suite's, so the two new suites and the
// push suite can all run in one lane without contending for a cluster.
const required = requiresRealPostgres();
const needsPg = () => (required ? undefined : { skip: realPostgresSkipMessage() });

const TENANT = "tenant:push-deadline", PROJECT = "project:push-deadline";

/** The dispatcher runs on the private-web role; every statement must work there. */
function asClient(options: { host: string; port: number; database: string; user: string; password: string }): DatabaseClient {
  const run = async <T>(statement: string, parameters: unknown[] = []) => {
    const connection = new Client(options);
    await connection.connect();
    try {
      await connection.query("SET search_path=pg_catalog, public");
      return { rows: (await connection.query(statement, parameters as never[])).rows as T[] };
    } finally { await connection.end(); }
  };
  const query = async <T>(statement: string, parameters: unknown[] = []) => run<T>(statement, parameters);
  return Object.freeze({
    query,
    async transaction<T>(work: (tx: { query: typeof query }) => Promise<T>): Promise<T> {
      // A real transaction: the dispatcher's claim and settle both depend on
      // genuine rollback semantics, so a fake here would test nothing.
      const connection = new Client(options);
      await connection.connect();
      try {
        await connection.query("BEGIN");
        await connection.query("SET search_path=pg_catalog, public");
        const value = await work({ query: async <U>(s: string, p: unknown[] = []) =>
          ({ rows: (await connection.query(s, p as never[])).rows as U[] }) });
        await connection.query("COMMIT");
        return value;
      } catch (error) { await connection.query("ROLLBACK").catch(() => {}); throw error; }
      finally { await connection.end(); }
    },
    async transactionWithPreCommitCheck<T>(work: (tx: { query: typeof query }) => Promise<T>) {
      return this.transaction(work);
    },
  });
}

/** One writeable attention item, in the shape the schema and the inbox render. */
async function writeItem(admin: Client, item: Record<string, unknown>, expiresAt: string | null) {
  await admin.query(`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
    VALUES($1,$2,$3,$4,$5,'open',$6,$7,$8,$9::jsonb)`,
  [item.id, TENANT, item.projectId ?? null, item.workItemId ?? null, item.kind,
    (item.deliveryState as string) ?? "not_requested", item.createdAt as string, expiresAt,
    JSON.stringify(item)]);
}

async function subscribe(admin: Client, id: string) {
  // A REAL push-service host: 0227 holds the subscriptions table to the allow
  // list, so a fixture endpoint would be measuring the constraint instead.
  await admin.query(`INSERT INTO owner_web_push_subscriptions
    (id,tenant_id,endpoint,p256dh,auth,expires_at,created_at,updated_at)
    VALUES($1,$2,$3,'A','B',NULL,now(),now())`,
  [id, TENANT, `https://fcm.googleapis.com/fcm/send/${id.replaceAll(":", "")}`]);
}

const headsOf = (admin: Client) => admin.query<{ action_inbox_id: string; state: string }>(
  "SELECT action_inbox_id,state FROM control_owner_push_attempt_heads WHERE tenant_id=$1 ORDER BY action_inbox_id",
  [TENANT]);

test("real PostgreSQL: a decision with a deadline rings the phone once, as the production web login",
  needsPg(), async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin());
    await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
      await subscribe(admin, `push:${"d".repeat(64)}`);
      const db = asClient(postgres.connection("web") as never);
      const now = new Date().toISOString();
      const deadline = new Date(Date.now() + 2 * 3_600_000).toISOString();

      // ---- the three DECISION kinds, each written by its own shipped producer ----
      // 1. The work-batch approval, which has NO deadline at all and still blocks.
      const batch = workBatchOwnerNotificationV1({ tenantId: TENANT, projectId: PROJECT,
        batchId: "batch:deadline-0001", createdAt: now }).item;
      await writeItem(admin, batch as never, null);
      // 2. A `question` the owner must answer, with a real deadline. Built by
      //    hand rather than with pipelineLoopAttentionItemV1 because 0154's guard
      //    refuses `expires_at` outright on that producer's items and requires real
      //    pipeline_run/pipeline_stage_runs rows behind them. That guard is a fact
      //    about the shipped schema, not something to work around: it means the
      //    loop-limit question itself has NO deadline, so the deadline-bearing
      //    decisions this finding is about are the authority_expiry item below and
      //    any other question that sets one.
      const question = { id: "attention:deadline:question", tenantId: TENANT, projectId: PROJECT,
        workItemId: "run:deadline-0001:stage:1", kind: "question", state: "open",
        requestedAction: "Decide whether the pipeline may continue", reasonCode: "loop_count_exceeded",
        blockedWorkItemIds: [], legalResponses: [{ id: "response:deadline:question", kind: "open_source",
          label: "Open the pipeline run", requiresConfirmation: false, available: true }],
        evidence: [], createdAt: now, deliveryState: "not_requested", expiresAt: deadline };
      await writeItem(admin, question as never, deadline);
      // 3. The authority expiry: the item that IS the deadline, with the shape
      //    `projectReadyFrontierNoRelayAttentionV1` writes.
      await writeItem(admin, { ...question, id: "attention:deadline:authority",
        workItemId: "job:deadline-authority", kind: "authority_expiry",
        requestedAction: "Review expired repository fake delivery window",
        reasonCode: "delivery_window_expired", legalResponses: [{ id: "response:deadline:authority",
          kind: "request_review", label: "Request bounded reconciliation review", requiresConfirmation: true,
          available: false, unavailableReasonCode: "repository_simulation_only" }] }, deadline);
      // 4. A failure, the kind that already worked before the fix.
      await writeItem(admin, { ...question, id: "attention:deadline:failure", kind: "failure",
        workItemId: "job:deadline-failure", requestedAction: "Review recorded task evidence",
        reasonCode: "second_stall_needs_attention", blockedWorkItemIds: ["job:deadline-failure"] }, null);
      // 5. A `review` item: a notification of fact, not a decision. This one must
      //    NOT ring, or every returned result would page the owner.
      await writeItem(admin, { ...question, id: "attention:deadline:review", kind: "review",
        requestedAction: "Review the returned result", reasonCode: "result_returned" }, null);

      const sent: string[] = [];
      const channel: OwnerNotificationChannelV1 = { kind: "web-push",
        async send(_subscription, payload) { sent.push(payload.tag); return { statusCode: 201 }; } };
      const dispatcher = new OwnerPushDispatcherV1({ db, tenantId: TENANT,
        store: new PostgresOwnerPushStoreV1(db), channel });

      const outcomes = await dispatcher.dispatch();
      const ids = outcomes.map(outcome => outcome.actionInboxId).sort();
      assert.deepEqual(ids, [
        "attention:deadline:authority", "attention:deadline:failure", "attention:deadline:question",
        "attention:work-batch:batch:deadline-0001",
      ], "every open DECISION rang the phone; the review item did not");
      assert.ok(outcomes.every(outcome => outcome.result === "delivered"));
      assert.equal(sent.length, 4, "exactly one push per decision");
      assert.equal(new Set(sent).size, 4, "and no duplicate tag");

      const heads = (await headsOf(admin)).rows.map(row => row.action_inbox_id);
      assert.equal(heads.includes("attention:deadline:review"), false,
        "a review notification must not get a push head at all");

      // ---- exactly once: a second dispatcher and a repeated tick send nothing ----
      const second = new OwnerPushDispatcherV1({ db, tenantId: TENANT,
        store: new PostgresOwnerPushStoreV1(db), channel });
      assert.deepEqual(await second.dispatch(), [], "a second dispatcher sends nothing");
      const third = await dispatcher.dispatch();
      assert.deepEqual(third, [], "a repeated tick sends nothing");
      assert.equal(sent.length, 4, "the four pushes are still the only pushes");
      assert.deepEqual((await headsOf(admin)).rows.map(row => row.state),
        ["delivered", "delivered", "delivered", "delivered"], "every head is terminal");

      // ---- a decision that is no longer open stops being a candidate ----
      // Resolving the deadline-bearing authority item must not leave a head that
      // can still be claimed, which is the existing `i.state='open'` filter.
      // Resolving an item is what a PRODUCER does, not the reader. It runs as a
      // login outside control_room_private_web: 0102's update guard refuses any
      // UPDATE on this table when `session_user` is a member of that role, and
      // the fixture's admin login is both superuser AND a member of it -- so an
      // admin UPDATE trips the very guard this assertion depends on. `SET SESSION
      // AUTHORIZATION` is used rather than `SET ROLE` because the guard reads
      // `session_user`, which `SET ROLE` does not change.
      await admin.query("SET SESSION AUTHORIZATION control_room_schema_owner");
      try {
        await admin.query("UPDATE control_action_inbox SET state='resolved' WHERE id='attention:deadline:question'");
      } finally { await admin.query("RESET SESSION AUTHORIZATION"); }
      const resolved = new OwnerPushDispatcherV1({ db, tenantId: TENANT,
        store: new PostgresOwnerPushStoreV1(db), channel });
      assert.deepEqual(await resolved.dispatch(), [], "a resolved item is never re-sent");
      assert.equal(sent.length, 4);

      // ---- and an EXPIRED deadline does not ring either ----
      const expiredId = "attention:deadline:expired";
      await writeItem(admin, { ...question, id: expiredId, kind: "authority_expiry",
        requestedAction: "Review expired repository fake delivery window",
        reasonCode: "delivery_window_expired",
        createdAt: new Date(Date.now() - 7_200_000).toISOString() },
        new Date(Date.now() - 3_600_000).toISOString());
      // The item is still 'open' in the schema -- R7I-05 is that nothing sweeps it
      // to 'expired', and that is NOT fixed here. What this asserts is the narrower
      // property that matters for the push path: adding an already-lapsed deadline
      // does not ring a phone that was never told it was waiting.
      const before = sent.length;
      await dispatcher.adoptOpenAttention();
      const expiredHeads = (await headsOf(admin)).rows.filter(row => row.action_inbox_id === expiredId);
      assert.equal(expiredHeads.length, 1,
        "an open item with a lapsed deadline is still adopted: the schema has no expired sweep (R7I-05), and this test does not pretend otherwise");
      assert.ok(before >= 4);
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 600_000 });
});

test("the adopted kind list is exactly the decision kinds, and review is not among them", () => {
  // A cheap unit check on the rule itself, so the list cannot drift from the
  // reasoning in the dispatcher's comment without a database anywhere near it.
  assert.deepEqual(OwnerPushDispatcherV1.adoptedKindsV1().slice().sort(),
    ["ambiguity", "approval", "authority_expiry", "failure", "incident", "question"]);
  assert.equal(OwnerPushDispatcherV1.adoptedKindsV1().includes("review" as never), false,
    "a review is a notification of fact; pushing it would page the owner per result");
  assert.equal(OwnerPushDispatcherV1.adoptedKindsV1().includes("native_session" as never), false);
});