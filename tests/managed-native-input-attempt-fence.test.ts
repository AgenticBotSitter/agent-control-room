import assert from "node:assert/strict";
import test from "node:test";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";
import { signedNodeFrameSchema, type SignedNodeFrame } from "../src/node-protocol/v1";
import type { DatabaseClient } from "../src/persistence/database";

type Fixture = Awaited<ReturnType<typeof managedNativeSessionFixture>>;
type Input = Awaited<ReturnType<Fixture["manager"]["attachInput"]>>;
type Peer = ReturnType<Fixture["makePeer"]>;

async function handshake(x: Fixture, attemptId = x.request.attemptId) {
  const peer = x.makePeer(), input = await x.manager.attachInput(x.f.prepared.request.nodeId, peer.transport,
    { mode: "initial", task: { ...x.request, attemptId } });
  await input.receive(await peer.open(), undefined, currentSignal());
  for (let turn = 0; turn < 20 && (peer.incoming.length || peer.outgoing.length); turn++) {
    while (peer.outgoing.length) await peer.acknowledge();
    await Promise.all(peer.incoming.splice(0).map(raw => input.receive(raw, undefined, currentSignal())));
  }
  assert.equal(peer.incoming.length + peer.outgoing.length, 0); return { peer, input };
}

const queue = (x: Fixture) => x.admin(async () => {
  await x.f.save(); await x.f.coordinator.enqueueNativeTask(...x.f.args, x.task.packetDigest, currentSignal());
});

async function savedDispatch(x: Fixture) {
  return x.admin(async () => {
    const rows: Record<string, unknown[]> = {};
    for (const table of ["control_native_approval_packets", "control_native_task_queue", "control_native_delivery_preparations",
      "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts"])
      rows[table] = (await x.f.db.query(`SELECT * FROM ${table} WHERE job_id=$1`, [x.task.jobId])).rows;
    rows.audit = (await x.f.db.query("SELECT * FROM audit_events WHERE project_id=$1 ORDER BY id", [x.task.projectId])).rows;
    rows.auditHeads = (await x.f.db.query("SELECT * FROM control_audit_chain_heads ORDER BY tenant_id,chain_partition")).rows;
    return rows;
  });
}

test("configured wrong attempt refuses stage without durable preparation, envelope or audit changes and leaves the real queued packet stageable", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); await x.verify();
  const wrongAttempt = "attempt:wrong-input-binding"; assert.notEqual(wrongAttempt, x.request.attemptId);
  const wrong = await handshake(x, wrongAttempt); await queue(x);
  // Packet/project/job/input are all the actual saved values. Only input configuration differs.
  const before = await savedDispatch(x), canonical = await x.states(), calls = [...x.local.calls];
  assert.equal(before.control_native_approval_packets.length, 1); assert.equal(before.control_native_task_queue.length, 1);
  assert.equal(before.control_native_delivery_envelopes.length, 0); assert.equal(before.control_native_transmission_intents.length, 0);
  const sends = wrong.peer.state.sends;
  await assert.rejects(wrong.input.stage(x.f.identity, x.task, currentSignal()));
  assert.deepEqual(await savedDispatch(x), before); assert.deepEqual(await x.states(), canonical);
  assert.equal(wrong.peer.state.sends, sends); assert.equal(wrong.peer.state.closes, 1);
  assert.deepEqual(x.local.calls, calls); assert.equal(x.inputRegistrations(), 0);
  const correct = await handshake(x), staged = await correct.input.stage(x.f.identity, x.task, currentSignal());
  assert.equal(staged.attemptId, x.request.attemptId);
  const after = await savedDispatch(x); assert.equal(after.control_native_delivery_envelopes.length, 1);
  assert.equal(after.control_native_transmission_intents.length, 0); assert.equal(after.control_native_delivery_receipts.length, 0);
  assert.deepEqual(after.control_native_task_queue, before.control_native_task_queue);
  assert.deepEqual(after.control_native_approval_packets, before.control_native_approval_packets);
  assert.equal(correct.peer.outgoing.length, 0); // Stage signs/stores only; no transmit is invoked.
  assert.deepEqual(x.local.calls, calls); assert.deepEqual(await x.states(), canonical);
});

test("actual generation replacement at result-registration final precommit rolls back its plan and fences retained input progress", async t => {
  const x = await managedNativeSessionFixture(undefined, { reporting: true }); t.after(x.close); await x.verify();
  const { peer, input } = await handshake(x); await queue(x);
  await input.stage(x.f.identity, x.task, currentSignal()); await input.transmit(x.f.identity, x.task, currentSignal());
  const dispatch = signedNodeFrameSchema.parse(JSON.parse(peer.outgoing[0])); assert.equal(dispatch.type, "harness.native.dispatch");
  await peer.acknowledge();
  const receipt = peer.incoming.shift(); assert.ok(receipt);
  const native = await x.prepareNode(peer, dispatch as SignedNodeFrame<"harness.native.dispatch">);
  await native.advanceNative("start"); const progress = peer.incoming.shift(); assert.ok(progress);
  const canonical = await x.states(), calls = [...x.local.calls], cp = x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`);
  const replacementPeer: Peer = x.makePeer(), replacement: { promise?: Promise<Input> } = {};
  let injected = false;
  const original = x.f.db;
  // Replace the fixture's mutable reference to its immutable adapter, not the adapter or any
  // production object. Restricted pools retain their role setup and original transaction checks.
  const intercepted: DatabaseClient = { ...original,
    transactionWithPreCommitCheck: (work, check) => {
      let containsReviewPlanInsert = false;
      return original.transactionWithPreCommitCheck(tx => work({ async query<T>(sql: string, params?: unknown[]) {
        const value = await tx.query<T>(sql, params);
        if (sql.includes("INSERT INTO control_native_review_plans")) containsReviewPlanInsert = true;
        return value;
      } }), () => {
        // SQL work has returned; invalidate the actual session generation immediately before
        // the original result-writer precommit/currentness checks, without bypassing those checks.
        if (containsReviewPlanInsert && !injected) {
          injected = true;
          replacement.promise = x.manager.attachInput(x.f.prepared.request.nodeId, replacementPeer.transport,
            { mode: "initial", task: x.request });
        }
        return check();
      });
    },
  };
  x.f.db = intercepted;
  try {
    await assert.rejects(input.receive(receipt, undefined, currentSignal()));
    assert.equal(injected, true); assert.ok(replacement.promise); await replacement.promise;
  } finally { x.f.db = original; }
  const plans = await x.resultDb.query("SELECT * FROM control_native_review_plans WHERE run_id=$1", [x.registration.id]);
  assert.deepEqual(plans.rows, []);
  const before = await x.counts(); assert.equal(before.runs.length, 1); assert.equal(before.events.length, 0);
  assert.equal(before.artifacts.length, 0); assert.equal(before.receipts.length, 0);
  const protocolBefore = await x.protocol(), dispatchBefore = await savedDispatch(x);
  await assert.rejects(input.receive(progress, undefined, currentSignal()));
  assert.deepEqual(await x.protocol(), protocolBefore); assert.deepEqual(await savedDispatch(x), dispatchBefore);
  assert.deepEqual(await x.counts(), before); assert.deepEqual(await x.states(), canonical); assert.deepEqual(x.local.calls, calls);
  assert.equal(peer.state.closes, 1); assert.equal(peer.outgoing.length, 0);
  assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`), cp);
});
