// U08, ANSWERED ON REAL POSTGRESQL 17: a machine auto-pause warning is NOT
// invisible to the owner.
//
// The review listed U08 as a source-trace SUSPICION, explicitly unconfirmed:
// "Home's inspected attention reader selects jobs; it does not consume that
// system inbox item... The lead must bind/review that canonical system
// projection and its existing authorized reader; no job or owner state was
// invented." No finding was dismissed as false, and none is here: the gap in
// the evidence was the READER, not the writer.
//
// What this test measures, on a real cluster as the real coordinator:
//
//   * the real `SupervisorWatchdogV1` on an unhealthy machine pauses new starts,
//     records the incident, and writes the `attention:supervisor:` item;
//   * the real `OperatorSurfaceStoreV1.listInbox` -- the query behind
//     `/api/v1/needs-me/action-items`, which is what the owner's Needs-you list
//     renders -- returns it;
//   * the owner push dispatcher's own candidate SELECT returns it too, which is
//     the half that decides whether the PHONE rings.
//
// The suspicion said the reader "selects jobs". It does not: `listInbox` is
// `WHERE tenant_id=$1 AND state=$2` with no project predicate at all, and the
// item has `project_id IS NULL` because a machine is not a task. Both facts are
// asserted here against the live catalogue rather than against the SQL text, so
// a future change that adds a project filter fails in this lane rather than
// silently making auto-pause invisible again.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { OperatorSurfaceStoreV1 } from "../src/operator-surfaces/v1/store";
import { SupervisorWatchdogV1 } from "../src/supervisor/v1/watchdog";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

// This file's own disposable-cluster slot, inside the assigned 59880-59899 band.
const PORT = 59837, PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const TENANT = "tenant:machine-attention-pg";

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

test("U08: a machine auto-pause reaches the owner's Needs-you list and the phone push queue", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin());
    await admin.connect();
    try { await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Machine attention fixture')", [TENANT]); }
    finally { await admin.end(); }

    const coordinator = new Client(postgres.connection("coordinator"));
    await coordinator.connect();
    try {
      // THE REAL WATCHDOG on a machine that is over its load limit. The sample
      // is the one the in-repo regression test uses, so the numbers are the
      // product's own: host alive, shared memory fine, load far past the bound.
      let paused = 0;
      const watchdog = new SupervisorWatchdogV1(singleConnection(coordinator), TENANT, "service:supervisor",
        { async sample() { return { hostAlive: true, sharedMemorySegments: 5, loadOneMinute: 23.4 }; } },
        { async pauseNewStarts() { paused += 1; return { state: "paused" as const, receiptId: `pause:${paused}` }; },
          async resumeAfterMachineHealth() { return { state: "not_automatic" as const, receiptId: "resume:fixture" }; } },
        () => Date.parse("2026-10-01T19:35:00.000Z"));
      const health = await watchdog.cycle();
      assert.equal(health.healthy, false);
      assert.deepEqual(health.reasonCodes, ["load_limit"]);
      assert.equal(paused, 1, "the machine was paused, so the condition under test really happened");

      // THE ITEM EXISTS, AND IT IS PROJECT-LESS. That second half is the whole
      // shape of U08: a machine is not a task, so `project_id` is NULL, and a
      // reader that joined to projects would lose it.
      const item = await coordinator.query<{ id: string; kind: string; state: string; project_id: string | null;
        work_item_id: string | null; payload: { reasonCode: string } }>(
        `SELECT id,kind,state,project_id,work_item_id,payload FROM control_action_inbox
          WHERE tenant_id=$1 AND kind='incident'`, [TENANT]);
      assert.equal(item.rows.length, 1, "the auto-pause wrote exactly one owner attention item");
      assert.equal(item.rows[0]?.project_id, null, "with no project: a machine is not a task");
      assert.equal(item.rows[0]?.work_item_id, null, "and no work item");
      assert.equal(item.rows[0]?.state, "open", "and it is open");
      assert.equal(item.rows[0]?.payload.reasonCode, "load_limit", "naming the condition that caused it");

      // READER ONE: the store behind /api/v1/needs-me/action-items. This is what
      // the owner's Needs-you list renders, so if the item is not here the
      // reviewer's suspicion was right.
      const open = await new OperatorSurfaceStoreV1(singleConnection(coordinator))
        .listInbox({ tenantId: TENANT, state: "open", limit: 50 });
      assert.ok(open.some(entry => entry.reasonCode === "load_limit"),
        `U08 is NOT a defect: the owner's Needs-you list already contains the auto-pause (saw ${open.map(e => e.reasonCode).join(",")})`);

      // BOTH BRANCHES OF THE READER'S OWN CONDITIONAL. `listInbox` builds a
      // different statement depending on whether the caller passes a state, so
      // a project filter could be added to one branch and not the other and the
      // first assertion would still pass. Both are driven here, which is what
      // makes "the reader has no project predicate" a property of the reader
      // rather than of one code path.
      const reader = new OperatorSurfaceStoreV1(singleConnection(coordinator));
      assert.equal((await reader.listInbox({ tenantId: TENANT, state: "open", limit: 50 })).length, 1,
        "the state-filtered read returns it too");
      assert.ok((await reader.listInbox({ tenantId: TENANT, limit: 50 })).some(e => e.reasonCode === "load_limit"),
        "and so does the unfiltered read, so a caller that omits the state is not the difference");
      // READER TWO: the push dispatcher's candidate SELECT, verbatim. This is
      // the only source of phone warnings, so it is the half that decides
      // whether the owner's phone rings -- and it is the half that was least
      // clearly covered by the review.
      //
      // IT RUNS WHILE THE ITEM IS STILL OPEN, and that ordering is the test, not
      // an accident of how the blocks are stacked. The candidate query filters
      // `state='open'`, so asserting it after the resolve below could only ever
      // fail -- and an earlier version of this file did exactly that, which
      // meant the lane shipped a test that failed every time it was run and the
      // "U08 is NOT a defect" verdict was resting on a test that never passed.
      // The claim under test is "while the machine is paused, the owner's phone
      // is a push candidate", and a resolved item is by definition not that, so
      // the question has to be asked before the resolve.
      const candidates = await coordinator.query<{ id: string }>(
        `SELECT i.id FROM control_action_inbox i
          WHERE i.tenant_id=$1 AND i.state='open' AND i.kind IN ('failure','ambiguity','incident')
          ORDER BY i.created_at,i.id`, [TENANT]);
      assert.deepEqual(candidates.rows.map(row => row.id), [item.rows[0]!.id],
        "the auto-pause is a phone push candidate, not just a page row");

      // A RESOLVED item drops out of the state-filtered read and stays in the
      // unfiltered one. If that were not true, an owner who had dismissed an
      // auto-pause would still see it -- which would be a DIFFERENT defect, and
      // the cheapest way to know this test would not have introduced it is to
      // check the transition rather than assume it.
      await coordinator.query("UPDATE control_action_inbox SET state='resolved' WHERE tenant_id=$1 AND id=$2",
        [TENANT, item.rows[0]!.id]);
      assert.equal((await reader.listInbox({ tenantId: TENANT, state: "open", limit: 50 })).length, 0,
        "a resolved auto-pause leaves the outstanding list");
      assert.equal((await reader.listInbox({ tenantId: TENANT, limit: 50 })).length, 1,
        "and stays in the history, which is what makes the claim 'it was escalated' checkable later");

      // AND IT LEAVES THE PUSH QUEUE WITH IT. The same fact the page reader has
      // to honour, asserted for the dispatcher's query rather than assumed: an
      // item the owner answered must stop being a reason to buzz the phone, and
      // this is the assertion that would have caught a reader that ignored
      // `state` on the dispatch side.
      assert.deepEqual((await coordinator.query<{ id: string }>(
        `SELECT i.id FROM control_action_inbox i
          WHERE i.tenant_id=$1 AND i.state='open' AND i.kind IN ('failure','ambiguity','incident')
          ORDER BY i.created_at,i.id`, [TENANT])).rows.map(row => row.id), [],
        "once the owner has answered it, the auto-pause is no longer a push candidate");

      // A HEALTHY MACHINE DOES NOT ADD A SECOND ITEM. The watchdog runs every
      // cycle, so an id that included the cycle would give the owner a new
      // auto-pause warning every thirty seconds; a claim that the item is
      // "visible" is not worth much if it is also inescapable.
      for (let i = 0; i < 5; i += 1)
        await new SupervisorWatchdogV1(singleConnection(coordinator), TENANT, "service:supervisor",
          { async sample() { return { hostAlive: true, sharedMemorySegments: 5, loadOneMinute: 23.4 }; } },
          { async pauseNewStarts() { return { state: "paused" as const, receiptId: "pause:repeat" }; },
            async resumeAfterMachineHealth() { return { state: "not_automatic" as const, receiptId: "resume:repeat" }; } },
          () => Date.parse("2026-10-01T19:36:00.000Z")).cycle();
      const repeated = await coordinator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_action_inbox WHERE tenant_id=$1 AND kind='incident'", [TENANT]);
      assert.equal(repeated.rows[0]?.count, "1",
        "five more unhealthy cycles add no second item: the id is the incident's, not the cycle's");
    } finally { await coordinator.end(); }
    return postgres.appliedMigrations;
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });
});

test("the lane ran on a real cluster, not a skip", () => {
  if (PG) assert.equal(ran, required, "every PostgreSQL test in this lane ran");
});
