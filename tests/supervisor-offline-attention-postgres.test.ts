// U05: a lost worker heartbeat must produce ONE owner attention item, and it
// must be resolved when the worker comes back.
//
// Real PostgreSQL 17, the PRODUCTION logins throughout: the migrator applies
// the migrations, the task coordinator is the login that runs the supervisor,
// and the private web is the login the owner resolves items with. The superuser
// connection seeds fixture rows the documented way (triggers disabled) and is
// never used to assert a guard.
//
// WHY THIS FILE IS SEPARATE FROM tests/supervisor-postgres.test.ts. That file
// owns the supervisor's own tables on ports 58390-58391 and already asserts the
// machine-health path. This one is about the INBOX the escalation lands in, the
// two guards 0250 adds, and the coordinator's new column-scoped UPDATE grant --
// which is a different set of facts and a different login.
//
// The finding being fixed, in the reviewer's words: "a bot heartbeat loss alone
// does not trigger a phone warning ... PGlite marked a stale heartbeat suspect
// but created zero action-inbox records, so there was no push candidate." The
// push candidate is an OPEN `control_action_inbox` row, so that is exactly what
// is asserted here, through the real `OwnerPushDispatcherV1` that would consume
// it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { SupervisorReconcilerV1 } from "../src/supervisor/v1/reconciler";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

// This file's own disposable-cluster slot, inside the assigned 59880-59899 band.
const PORT = 59836, PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const TENANT = "tenant:offline-attention-pg";
const WORKER = "worker:fixture-offline";
const NODE = "node:fixture-offline";
// A second worker, reserved for the block that drives the production health
// LOOP rather than the escalation method. It is a distinct constant rather than
// a literal so that every id and every assertion below names the same worker,
// and so that a reader can see at a glance that the two paths are being proved
// separately: WORKER reaches the owner through `escalateOfflineWorker`, and
// LOOP_WORKER reaches her through `refreshAgentHeartbeatHealth`.
const LOOP_WORKER = "worker:fixture-loop";
// The instant this file's reconciler is pinned to, as an ISO string. It is a
// named constant because the loop's "is this heartbeat lost" comparison is
// made against ITS OWN clock rather than the database's, so any fixture that
// wants the loop to judge a heartbeat lapsed has to be written in these terms.
const PINNED_CLOCK = "2026-10-01T12:00:00.000Z";

/** Wraps one real connection as the minimal DatabaseClient the reconciler needs.
 * A single connection, not a pool: the reconciler writes the health row and the
 * attention item in sequence and the trigger on the item reads the health row,
 * so the two statements must be seen in order. */
function singleConnection(client: Client): DatabaseClient {
  const query = async <T>(statement: string, params: unknown[] = []): Promise<{ rows: T[] }> =>
    ({ rows: (await client.query(statement, params as never[])).rows as T[] });
  const session: DatabaseSession = { query };
  const run = async <T>(work: (tx: DatabaseSession) => Promise<T>): Promise<T> => {
    await client.query("BEGIN");
    try { const value = await work(session); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  };
  return Object.freeze({ query, transaction: run,
    async transactionWithPreCommitCheck<T>(work: (tx: DatabaseSession) => Promise<T>, check: () => unknown) {
      return run(async tx => { const value = await work(tx); await check(); return value; });
    } });
}

/** The item id 0250's guard and the reconciler both derive, stated once here so
 * the test asserts against the CONSTRUCTION rather than against a copy of the
 * result. A test that recomputes the digest the same way the code does proves
 * only that two identical expressions agree; this one reads the row back out of
 * the database and checks it is the one the guard admitted.
 *
 * The worker is a parameter because the fleet is: one worker, one item, so the
 * id for a second worker is a different id and the deduplication claim only
 * means something if it is stated per worker. */
const expectedItemId = (worker: string = WORKER) => `attention:supervisor-agent:${createHash("md5")
  .update(`${TENANT}/${worker}`).digest("hex").slice(0, 32)}`;

test("U05: a lost heartbeat opens exactly one owner attention item, and recovery resolves it", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin());
    await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Offline attention fixture')", [TENANT]);
      // Fixture rows are written with the documented escape hatch --
      // `session_replication_role = replica` -- so the triggers this test is
      // here to exercise are bypassed for the fixture and fire for every
      // statement the test itself makes. That is the same rule
      // tests/updater-alerts-postgres.test.ts follows, and it is what keeps
      // "the guard refused this" from being confused with "the fixture shape was
      // wrong".
      await admin.query("SET session_replication_role = replica");
      // 0003's real `control_nodes` shape: identity_key_id, payload, created_at
      // and updated_at are all NOT NULL. The node is not what this test is
      // about, but the row has to be a row the real CHECKs accept.
      await admin.query(`INSERT INTO control_nodes(id,tenant_id,state,identity_key_id,payload,created_at,updated_at)
        VALUES($1,$2,'active','key:fixture','{}'::jsonb,now(),now())`, [NODE, TENANT]);
      // A telemetry signal whose expiry is already past. An expired telemetry
      // expiry is what "the worker's heartbeat is gone" means to
      // `refreshAgentHeartbeatHealth`, which reads it as a LEFT JOIN so a node
      // with NO telemetry row at all is equally suspect.
      await admin.query(`INSERT INTO control_node_fleet_current
        (tenant_id,node_id,signal_kind,signal_sequence,fingerprint,trust,observed_at,expires_at,payload)
        VALUES($1,$2,'telemetry',1,'sha256:${"0".repeat(64)}','reported',
          now()-interval '2 hours',now()-interval '1 hour','{}'::jsonb)`, [TENANT, NODE]);
    } finally { await admin.end(); }

    const coordinator = new Client(postgres.connection("coordinator"));
    await coordinator.connect();
    try {
      const reconciler = new SupervisorReconcilerV1(singleConnection(coordinator), TENANT,
        () => Date.parse("2026-10-01T12:00:00.000Z"));

      // There is no leased attempt for this worker, so the reconciler's own
      // candidate query finds nothing -- which is the honest idle-worker case
      // this finding is about. The heartbeat health is asserted through the
      // REAL trigger and the REAL guard by writing the health row the same way
      // the reconciler does, then calling the production escalation path.
      //
      // Before this change there was no escalation path at all:
      // `refreshAgentHeartbeatHealth` returned a count and wrote a health row,
      // and no inbox row existed for any caller to find. Every assertion below
      // is about a row that did not exist.
      await coordinator.query(`INSERT INTO control_supervisor_agent_health
        (tenant_id,worker_id,node_id,state,safe_reason_code,last_heartbeat_at,observed_at)
        VALUES($1,$2,$3,'suspect','heartbeat_lost',now()-interval '2 hours',now())`, [TENANT, WORKER, NODE]);

      // THE ESCALATION, through the real reconciler method.
      const opened = await reconciler.escalateOfflineWorker(WORKER, "2026-10-01T12:00:00.000Z");
      assert.equal(opened, true, "an offline worker opens an owner attention item");

      const items = await coordinator.query<{ id: string; kind: string; state: string; project_id: string | null;
        payload: { reasonCode: string; state: string } }>(
        "SELECT id,kind,state,project_id,payload FROM control_action_inbox WHERE tenant_id=$1 AND id LIKE 'attention:supervisor-agent:%'",
        [TENANT]);
      assert.equal(items.rows.length, 1, "exactly one attention item exists for the offline worker");
      assert.equal(items.rows[0]?.kind, "incident", "and it is an incident, which is the kind the push dispatcher adopts");
      assert.equal(items.rows[0]?.state, "open", "and it is open, so the push dispatcher and Home both see it");
      assert.equal(items.rows[0]?.project_id, null, "with no project: a worker is not a task");
      assert.equal(items.rows[0]?.payload.reasonCode, "worker_heartbeat_lost");
      assert.match(items.rows[0]!.id, /^attention:supervisor-agent:[0-9a-f]{32}$/u,
        "and a deterministic id, so a second cycle cannot make a second item");

      // DEDUPLICATION, the reason the id is deterministic. Ten more escalations
      // on the same offline worker -- as ten supervisor cycles at 30 s would --
      // must add nothing. Before this change each cycle would have created its
      // own item if it had created any at all, and 2 880 a day is what the
      // reviewer's "one deduplicated owner inbox item" rules out.
      const repeats = [];
      for (let i = 0; i < 10; i += 1)
        repeats.push(await reconciler.escalateOfflineWorker(WORKER, "2026-10-01T12:00:10.000Z"));
      assert.ok(repeats.every(value => value === false),
        `each of the ten further cycles reports that it opened nothing new (got ${repeats.join(",")}): the item already exists`);
      const after = await coordinator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_action_inbox WHERE tenant_id=$1 AND id LIKE 'attention:supervisor-agent:%'",
        [TENANT]);
      assert.equal(after.rows[0]?.count, "1",
        "ten further cycles on an offline worker add no second item: the key cannot repeat");

      // A DIFFERENT worker gets its OWN item. The digest is of (tenant, worker),
      // so two offline workers are two questions and neither hides the other.
      await coordinator.query(`INSERT INTO control_supervisor_agent_health
        (tenant_id,worker_id,node_id,state,safe_reason_code,last_heartbeat_at,observed_at)
        VALUES($1,$2,$3,'suspect','heartbeat_lost',now()-interval '2 hours',now())`, [TENANT, "worker:other", NODE]);
      await reconciler.escalateOfflineWorker("worker:other", "2026-10-01T12:00:10.000Z");
      const both = await coordinator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_action_inbox WHERE tenant_id=$1 AND id LIKE 'attention:supervisor-agent:%'",
        [TENANT]);
      assert.equal(both.rows[0]?.count, "2", "two offline workers are two items, not one merged warning");

      // THE PUSH CANDIDATE. This is the finding's actual consequence: the owner
      // push dispatcher's ONLY source of candidates is an open item of kind
      // failure/ambiguity/incident. The query is the dispatcher's own
      // `adoptOpenAttention` SELECT, run against the real table, because the
      // claim "the phone would be told" is only worth making if this row is in
      // the set the dispatcher reads.
      const candidates = await coordinator.query<{ id: string }>(
        `SELECT i.id FROM control_action_inbox i
          WHERE i.tenant_id=$1 AND i.state='open' AND i.kind IN ('failure','ambiguity','incident')
          ORDER BY i.created_at,i.id`, [TENANT]);
      assert.equal(candidates.rows.length, 2,
        "both offline workers are push candidates: the dispatcher adopts open incidents");

      // THE GUARD REFUSES A FORGED ITEM. The coordinator holds INSERT on this
      // table, so without 0250 it could open an attention item about any worker
      // at all -- including one that is answering heartbeats this very cycle.
      // Two forgeries, each refused for its own stated reason.
      const live = "worker:healthy-fixture";
      await coordinator.query(`INSERT INTO control_supervisor_agent_health
        (tenant_id,worker_id,node_id,state,safe_reason_code,last_heartbeat_at,observed_at)
        VALUES($1,$2,$3,'healthy',NULL,now(),now())`, [TENANT, live, NODE]);
      await assert.rejects(coordinator.query(`INSERT INTO control_action_inbox
        (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
        VALUES($1,$2,NULL,NULL,'incident','open','not_requested',now(),NULL,$3::jsonb)`,
      [`attention:supervisor-agent:${"0".repeat(32)}`, TENANT, JSON.stringify({
        id: `attention:supervisor-agent:${"0".repeat(32)}`, tenantId: TENANT, projectId: null, kind: "incident",
        state: "open", createdAt: new Date().toISOString(), requestedAction: "Check this worker.", reasonCode: "worker_heartbeat_lost",
        blockedWorkItemIds: [], legalResponses: [], evidence: [{ id: "worker:fixture", kind: "service_observation",
          observedAt: new Date().toISOString() }], deliveryState: "not_requested", workerId: live })]),
      /supervisor offline attention item rejected/u,
      "a healthy worker cannot be declared offline by an insert");
      await assert.rejects(coordinator.query(`INSERT INTO control_action_inbox
        (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
        VALUES($1,$2,NULL,NULL,'incident','open','not_requested',now(),NULL,$3::jsonb)`,
      [expectedItemId(), TENANT, JSON.stringify({
        id: expectedItemId(), tenantId: TENANT, projectId: null, kind: "incident", state: "open",
        createdAt: new Date().toISOString(), requestedAction: "Check this worker.", reasonCode: "some_other_reason",
        blockedWorkItemIds: [], legalResponses: [], evidence: [{ id: `worker:${createHash("md5")
          .update(`${TENANT}/${WORKER}`).digest("hex").slice(0, 32)}`, kind: "service_observation", observedAt: new Date().toISOString() }],
        deliveryState: "not_requested" })]),
      /supervisor offline attention item rejected/u,
      "and the reason code cannot be borrowed from another condition");

      // A FORGERY THAT NAMES A WORKER NOBODY HAS LOST. The two refusals above
      // each trip one clause; this one is the clause that says the item must be
      // BACKED BY THE SUPERVISOR'S OWN RECORD, and it is the one a caller
      // holding plain INSERT would try first -- pick any id, any worker, and
      // declare it lost. Deleting the `NOT EXISTS` check from 0250's guard turns
      // this into a successful insert, and before this assertion nothing in the
      // lane noticed.
      //
      // The worker below has NO row in control_supervisor_agent_health at all,
      // so the guard has to refuse on the evidence's own terms rather than on
      // some other clause of the same predicate -- which is what makes it a
      // test of this clause specifically.
      const unknown = "worker:never-seen";
      const unknownId = `attention:supervisor-agent:${createHash("md5")
        .update(`${TENANT}/${unknown}`).digest("hex").slice(0, 32)}`;
      await assert.rejects(coordinator.query(`INSERT INTO control_action_inbox
        (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
        VALUES($1,$2,NULL,NULL,'incident','open','not_requested',now(),NULL,$3::jsonb)`,
      [unknownId, TENANT, JSON.stringify({
        id: unknownId, tenantId: TENANT, projectId: null, kind: "incident", state: "open",
        createdAt: new Date().toISOString(), requestedAction: "Check this worker.",
        reasonCode: "worker_heartbeat_lost", blockedWorkItemIds: [], legalResponses: [],
        evidence: [{ id: `worker:${createHash("md5").update(`${TENANT}/${unknown}`).digest("hex").slice(0, 32)}`,
          kind: "service_observation", observedAt: new Date().toISOString() }],
        deliveryState: "not_requested", workerId: unknown })]),
      /supervisor offline attention item rejected/u,
      "a worker the supervisor has never recorded as lost cannot be declared offline by an insert");
      assert.equal((await coordinator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_action_inbox WHERE tenant_id=$1 AND id=$2",
      [TENANT, unknownId])).rows[0]?.count, "0", "and the refused insert left no row behind");

      // AN ID THAT IS NOT THE ONE FOR ITS WORKER. The digest clause is the other
      // half of the same rule: a caller that already holds a real worker's id --
      // which is guessable, because it is an md5 of two strings both of which
      // are readable -- must not be able to attach a DIFFERENT worker's evidence
      // to it, or the owner's page renders one worker with another's history.
      // Dropping the `NEW.id <>` clause admits exactly that, and this is the
      // assertion that catches it.
      const swapped = `attention:supervisor-agent:${"a".repeat(32)}`;
      await assert.rejects(coordinator.query(`INSERT INTO control_action_inbox
        (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
        VALUES($1,$2,NULL,NULL,'incident','open','not_requested',now(),NULL,$3::jsonb)`,
      [swapped, TENANT, JSON.stringify({
        id: swapped, tenantId: TENANT, projectId: null, kind: "incident", state: "open",
        createdAt: new Date().toISOString(), requestedAction: "Check this worker.",
        // The reason code and the evidence are the REAL lost worker, so every
        // other clause of the guard is satisfied: the id is the only thing wrong.
        reasonCode: "worker_heartbeat_lost", blockedWorkItemIds: [], legalResponses: [],
        evidence: [{ id: `worker:${createHash("md5").update(`${TENANT}/${WORKER}`).digest("hex").slice(0, 32)}`,
          kind: "service_observation", observedAt: new Date().toISOString() }],
        deliveryState: "not_requested", workerId: WORKER })]),
      /supervisor offline attention item rejected/u,
      "an id that is not the digest of the worker it names is refused, so one worker cannot borrow another's id");
      assert.equal((await coordinator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_action_inbox WHERE tenant_id=$1 AND id=$2",
      [TENANT, swapped])).rows[0]?.count, "0", "and the refused insert left no row behind");

      // THE HEALTH LOOP CALLS THE ESCALATION. Everything above reaches
      // `attentionFor` through the named `escalateOfflineWorker`, which is the
      // direct call -- and a direct call is not the claim. U05 is about a lost
      // heartbeat reaching the owner, and in PRODUCTION the only caller is
      // `refreshAgentHeartbeatHealth`, the thirty-second loop over the fleet.
      // Deleting the `attentionFor` call from that loop leaves every assertion
      // above passing, because nothing else in the lane ever ran the loop: the
      // feature would be reachable only by calling the method by hand, and the
      // path that actually runs in production would open nothing at all. That
      // is the shape of bug this whole finding is about -- a health row exists
      // and no owner item does -- so the loop is the thing under test here.
      //
      // The loop reads its candidates from `control_attempts` joined to
      // `control_jobs`, with the node's telemetry expiry as the heartbeat, so
      // the fixture has to be a real leased attempt on a real leased job. The
      // attempt is written through the FIXTURE connection with triggers
      // disabled, which is this file's documented rule for rows the guards
      // otherwise protect, and the telemetry row above already expires the
      // heartbeat an hour ago -- which is what makes the loop's decision
      // `lost`.
      const fixture = new Client(postgres.admin());
      await fixture.connect();
      try {
        await fixture.query("SET session_replication_role = replica");
        // The chain the loop joins through: a request, the workflow that serves
        // it, the leased job on that workflow, and the leased attempt on that
        // job. Every column here is read out of db/migrations/0003 rather than
        // guessed -- a first attempt at this fixture omitted `request_id` and
        // was refused with the NOT NULL constraint, which is the migration being
        // the shape it is documented to be.
        await fixture.query(`INSERT INTO control_requests
          (id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
          VALUES($1,$2,NULL,'accepted',0,$3,'{}'::jsonb,now(),now())`,
        [`request:${LOOP_WORKER}`, TENANT, `request-key:${LOOP_WORKER}`]);
        await fixture.query(`INSERT INTO control_workflows
          (id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
          VALUES($1,$2,$3,'project:offline-attention-fixture',$4,'active',0,'{}'::jsonb,now(),now())`,
        [`workflow:${LOOP_WORKER}`, TENANT, `request:${LOOP_WORKER}`, `sha256:${"1".repeat(64)}`]);
        await fixture.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
          required_capability,authority_digest,payload,created_at,updated_at)
          VALUES($1,$2,$3,'project:offline-attention-fixture','leased',0,0,$4,$5,'{}'::jsonb,now(),now())`,
        [`job:${LOOP_WORKER}`, TENANT, `workflow:${LOOP_WORKER}`, "capability:fixture", `sha256:${"0".repeat(64)}`]);
        await fixture.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,
          worker_id,node_id,payload,created_at,updated_at)
          VALUES($1,$2,$3,1,'leased',0,$4,$5,'{}'::jsonb,now(),now())`,
        [`attempt:${LOOP_WORKER}`, TENANT, `job:${LOOP_WORKER}`, LOOP_WORKER, NODE]);
        // The heartbeat this loop will judge, written against the clock the
        // loop READS. See the note at the assertion below: the loop compares
        // the telemetry expiry against its own pinned instant, not against the
        // database's now(), so a row that is merely "an hour old" can look
        // fresh to it.
        await fixture.query(`UPDATE control_node_fleet_current
          SET observed_at=$3::timestamptz-interval '2 hours', expires_at=$3::timestamptz-interval '1 hour'
          WHERE tenant_id=$1 AND node_id=$2`, [TENANT, NODE, PINNED_CLOCK]);
      } finally { await fixture.end(); }

      // The loop's OWN answer, which is the number of workers it judged lost. A
      // loop that recorded health and escalated nobody still returns 1, so the
      // count alone is not the claim -- the item below is.
      //
      // The loop compares the node's telemetry expiry against ITS OWN clock,
      // and this reconciler is constructed with a pinned clock at
      // 2026-10-01T12:00:00.000Z. The telemetry row above expires an hour
      // before the DATABASE's now(), which on a real cluster is the wall clock
      // -- and on the day this test was written the wall clock was LATER than
      // the pinned instant, so the row looked fresh and the loop correctly
      // called the worker healthy. A first version of this block asserted a
      // suspect count and measured 0, which is the comparison being honest and
      // the FIXTURE being wrong.
      //
      // So the row the loop judges is written against the clock the loop reads:
      // expired one hour before the pinned instant. The heartbeat is the
      // fixture's whole purpose, so stating it in those terms is not weakening
      // the assertion -- it is the only way to say "this heartbeat has lapsed"
      // in a test whose clock does not move.
      const suspects = await reconciler.refreshAgentHeartbeatHealth(50);
      assert.equal(suspects, 1, "the health loop itself judges the leased worker lost");

      // AND THE ITEM THE OWNER WOULD SEE. This worker was never passed to
      // `escalateOfflineWorker` -- the only thing that could have opened this
      // row is the loop, three statements up. Nothing else in the lane can
      // account for it, which is what makes this an assertion about the loop
      // rather than about the method.
      assert.equal((await coordinator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_action_inbox WHERE tenant_id=$1 AND id=$2",
      [TENANT, expectedItemId(LOOP_WORKER)])).rows[0]?.count, "1",
        "THE OWNER ITEM WAS OPENED BY THE HEALTH LOOP ITSELF: nothing in this test called the escalation for this worker");
      const loopItem = await coordinator.query<{ kind: string; state: string; payload: { workerId: string } }>(
        "SELECT kind,state,payload FROM control_action_inbox WHERE tenant_id=$1 AND id=$2",
      [TENANT, expectedItemId(LOOP_WORKER)]);
      assert.equal(loopItem.rows[0]?.kind, "incident", "and it is an incident, which the push dispatcher adopts");
      assert.equal(loopItem.rows[0]?.state, "open", "and open, so Home and the dispatcher both see it");
      assert.equal(loopItem.rows[0]?.payload.workerId, LOOP_WORKER,
        "and it names the worker the loop judged lost, not the one the test seeded by hand");

      // A SECOND LOOP ON THE SAME FLEET OPENS NOTHING NEW. Thirty seconds later
      // the production loop runs again against the same leased attempt, and the
      // owner gets one outstanding question, not one per cycle.
      assert.equal(await reconciler.refreshAgentHeartbeatHealth(50), 1, "the next cycle still finds it lost");
      assert.equal((await coordinator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_action_inbox WHERE tenant_id=$1 AND id LIKE 'attention:supervisor-agent:%'",
      [TENANT])).rows[0]?.count, "3", "and it adds no second item for that worker");

      // THE RESOLUTION. The worker comes back, and the item is closed by the
      // PRODUCTION path -- the private web login, which is the one that holds
      // the owner's `UPDATE (state,payload)` on this table and is what the owner
      // is actually looking at when they dismiss a warning.
      const web = new Client(postgres.connection("web"));
      await web.connect();
      try {
        const resolved = await reconciler.resolveOfflineWorker(WORKER, "2026-10-01T12:30:00.000Z");
        assert.equal(resolved, true, "a recovered worker resolves its attention item");
        const closed = await web.query<{ state: string; payload: { state: string } }>(
          "SELECT state,payload FROM control_action_inbox WHERE tenant_id=$1 AND id=$2", [TENANT, items.rows[0]!.id]);
        assert.equal(closed.rows[0]?.state, "resolved", "the column says resolved");
        assert.equal(closed.rows[0]?.payload.state, "resolved",
          "and so does the payload, or the owner's page renders a resolved item as open");
        // THE OTHER WORKER IS UNTOUCHED. Resolving one offline worker must not
        // quiet a different one, which a blanket "resolve everything on this
        // prefix" would have done.
        // The second offline worker is still open. Counted across the whole
        // tenant rather than "the one that is not WORKER", because the health
        // LOOP above has since opened an item for LOOP_WORKER and an assertion
        // that could not see it would pass for the wrong reason.
        const other = await web.query<{ id: string }>(
          "SELECT id FROM control_action_inbox WHERE tenant_id=$1 AND id LIKE 'attention:supervisor-agent:%' AND state='open'",
          [TENANT]);
        assert.equal(other.rows.length, 2,
          "the second offline worker and the loop's worker are both still open, so resolving one quiet neither");
        // AND IT IS IDEMPOTENT. A second recovery cycle must not rewrite the
        // resolution, and must not report having done work.
        assert.equal(await reconciler.resolveOfflineWorker(WORKER, "2026-10-01T12:31:00.000Z"), false,
          "resolving an already-resolved worker reports nothing to close");
        // And resolving a worker that was never offline is also a no-op, rather
        // than an error: the supervisor calls this for every healthy worker on
        // every cycle, and thirty seconds of silence must not be an exception.
        assert.equal(await reconciler.resolveOfflineWorker("worker:never-offline", "2026-10-01T12:31:00.000Z"), false,
          "resolving a worker that has no item reports nothing to close");

        // THE REOPEN. A worker that goes offline AGAIN reuses the same item
        // rather than opening a second one, so the owner's list shows one
        // outstanding question per worker and the history lives in
        // `control_supervisor_agent_health`.
        await coordinator.query(`UPDATE control_supervisor_agent_health SET state='suspect',
          safe_reason_code='heartbeat_lost' WHERE tenant_id=$1 AND worker_id=$2`, [TENANT, WORKER]);
        assert.equal(await reconciler.escalateOfflineWorker(WORKER, "2026-10-01T13:00:00.000Z"), true,
          "a worker that goes offline again is escalated again");
        const reopened = await coordinator.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_action_inbox WHERE tenant_id=$1 AND id LIKE 'attention:supervisor-agent:%'",
          [TENANT]);
        assert.equal(reopened.rows[0]?.count, "3", "the reopen reuses the item: one question per worker, not per outage");
      } finally { await web.end(); }
    } finally { await coordinator.end(); }
    return postgres.appliedMigrations;
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });
});

// ---------------------------------------------------------------------------
// The grant has to be where provisioning will read it.
// ---------------------------------------------------------------------------
// A migration cannot grant to a role that does not exist yet, and the migrator
// runs every migration before any role file. A role-guarded GRANT inside a
// MIGRATION therefore always skips -- silently, with the migration reporting
// success -- and the coordinator permanently lacks the privilege. This was
// measured on the first run of this feature: the resolution failed with
// "permission denied for table control_action_inbox" and
// information_schema.column_privileges held no UPDATE row at all.
//
// The check is a file check, not a database check, because the failure is in
// WHERE the statement lives and a database check passes either way once the
// role file has also been applied.
test("the coordinator's inbox UPDATE grant is in the role file, not in a migration", async () => {
  const { readFile: read } = await import("node:fs/promises");
  const roleFile = await read("db/roles/task_coordinator_roles.sql", "utf8");
  assert.match(roleFile,
    /GRANT UPDATE \(state,\s*payload\) ON control_action_inbox TO control_room_task_coordinator/u,
    "the grant the coordinator needs to resolve an item is in the role file, which provisioning reads after the role exists");
  for (const file of ["db/migrations/0250_supervisor_offline_attention.sql"]) {
    const sql = await read(file, "utf8");
    assert.doesNotMatch(sql.replace(/--[^\n]*/gu, ""),
      /GRANT\s+UPDATE[^;]*control_action_inbox/u,
      `${file} must not grant to a role the migrator has not created yet: the statement would be skipped, not applied`);
  }
});

test("the lane ran on a real cluster, not a skip", () => {
  if (PG) assert.equal(ran, required, "every PostgreSQL test in this lane ran");
});
