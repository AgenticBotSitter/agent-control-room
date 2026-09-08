import assert from "node:assert/strict";
import test from "node:test";
import { nativeNodeRuntimeFixture } from "./helpers/native-node-runtime";
import { currentSignal } from "./helpers/managed-native-session";
import { qualityText } from "./helpers/native-quality-completion";
import { signedNodeFrameSchema } from "../src/node-protocol/v1";
import { sha256Digest } from "../src/security";
import { syntheticCleanupEvidence } from "./helpers/native-cleanup-evidence";
import { createNativeTaskSettlement } from "../src/harness/hermes-native-v1/task-settlement";

type Fixture = Awaited<ReturnType<typeof nativeNodeRuntimeFixture>>;
const frames = (raw: string[]) => raw.map(value => signedNodeFrameSchema.parse(JSON.parse(value)));

async function stableExecution(f: Fixture) {
  const x = f.x, canonical = await x.states();
  // Privileged disposable observer only; managed authentication/evidence/result operations
  // themselves enter the actual restricted roles through the shared fixture.
  const rows = await x.admin(async () => {
    const result: Record<string, unknown[]> = {};
    for (const table of ["control_native_task_queue", "control_native_delivery_envelopes",
      "control_native_transmission_intents", "control_native_delivery_receipts"])
      result[table] = (await x.f.db.query(`SELECT * FROM ${table} WHERE job_id=$1`, [x.task.jobId])).rows;
    result.transitions = (await x.f.db.query("SELECT * FROM control_transition_events ORDER BY id")).rows;
    result.outbox = (await x.f.db.query("SELECT * FROM control_outbox ORDER BY id")).rows;
    return result;
  });
  return { canonical, rows, registrations: x.inputRegistrations() };
}

async function pendingResult(f: Fixture) {
  const x = f.x, counts = await x.counts();
  assert.equal(counts.runs.length, 1); assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.deepEqual(await x.f.config.storage.read(counts.artifacts[0].id as string), new TextEncoder().encode(qualityText));
  const targetId = await x.admin(async () => {
    const rows = await x.f.db.query<{ plan: { targetId: string } }>(
      "SELECT plan FROM control_native_review_plans WHERE run_id=$1", [x.registration.id]);
    assert.equal(rows.rows.length, 1); return rows.rows[0].plan.targetId;
  });
  const review = await x.admin(() => x.f.reviewStore.snapshot(x.f.scope.tenantId, targetId));
  assert.equal(review.status, "pending");
  return counts;
}

async function started(f: Fixture) {
  await f.x.verify(); const connection = await f.connect();
  assert.deepEqual(f.x.local.calls, []);
  await f.dispatch(connection);
  assert.deepEqual(f.x.local.calls, []); assert.equal(f.x.inputRegistrations(), 1);
  assert.equal((await f.x.counts()).events.length, 0);
  // Explicit fake-provider operation. The admin boundary only supplies fixture policy reads.
  const snapshot = await f.x.admin(() => f.runtime.start(currentSignal()));
  assert.equal(snapshot.state, "queued"); assert.deepEqual(f.x.local.calls, ["capabilities", "start"]);
  await f.pump(connection); return connection;
}

test("node runtime intake waits for explicit start, starts once and routes completed bytes into pending exact review", async t => {
  const f = await nativeNodeRuntimeFixture(); t.after(f.close);
  const connection = await started(f), before = await stableExecution(f), calls = [...f.x.local.calls];
  const saved = f.x.local.journal.load(f.x.registration.id);
  assert.ok(saved);
  assert.deepEqual(await f.x.admin(() => f.runtime.start(currentSignal())), saved);
  await f.pump(connection); assert.deepEqual(f.x.local.calls, calls);
  f.advance(); f.setResult(qualityText);
  const completed = await f.x.admin(() => f.runtime.poll(currentSignal())); assert.equal(completed.state, "completed");
  const outgoing = frames(connection.incoming); assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].type, "harness.native.snapshot");
  if (outgoing[0].type !== "harness.native.snapshot") throw new Error("missing completed snapshot");
  assert.deepEqual(f.runtime.readResult(outgoing[0].body, currentSignal()), new TextEncoder().encode(qualityText));
  await f.pump(connection);
  const counts = await pendingResult(f); assert.equal(counts.events.length, 2);
  assert.deepEqual(f.x.local.calls, ["capabilities", "start", "status"]);
  assert.deepEqual(await stableExecution(f), before);
  assert.equal(frames(connection.serverSent).filter(frame => frame.type === "harness.native.dispatch").length, 1);
  assert.ok(f.x.observed.some(row => row.login === "managed_auth_test" && row.sql.includes("INSERT INTO node_protocol_replay")));
  assert.ok(f.x.observed.some(row => row.login === "managed_evidence_test" && row.sql.includes("INSERT INTO control_harness_runs")));
  assert.ok(f.x.observed.some(row => row.login === "managed_result_test" && row.sql.includes("INSERT INTO control_native_review_plans")));
  const binding = f.x.f.prepared.binding, local = f.x.local;
  const cleanup = syntheticCleanupEvidence({ enrollment: f.config.enrollment, binding, runs: local.journal,
    effects: local.effects, security: f.x.f.native.trust, clock: f.x.f.clock }); t.after(cleanup.close);
  const beforeSettlement = await stableExecution(f), priorCalls = [...local.calls];
  await assert.rejects(f.runtime.closeForSettlement(sha256Digest("wrong task")));
  const receipt = await createNativeTaskSettlement(cleanup.config, { ...cleanup.deps,
    effects: local.effects, executions: local.executions, runtime: f.runtime }).settle(currentSignal());
  assert.equal(receipt.localEffectSettled, true); assert.equal(receipt.canonicalCapacityReleased, false);
  assert.equal(local.effects.countActive(binding.tenantId, binding.nodeId), 0);
  assert.equal(local.executions.load(cleanup.claim.executionId)?.state, "completed");
  assert.deepEqual(await stableExecution(f), beforeSettlement);
  assert.deepEqual(local.calls, priorCalls);
  const closed = await f.runtime.closeForSettlement(sha256Digest(binding)); closed.assertClosed();
  assert.equal(closed.descendantsStoppedVerified, false);
  await assert.rejects(f.runtime.start(currentSignal()));
});

test("disconnected runtime reports saved completion and reconnects the same journals without another native request or dispatch", async t => {
  const f = await nativeNodeRuntimeFixture(); t.after(f.close); const first = await started(f);
  await f.runtime.disconnected(currentSignal()); await first.server.close();
  f.advance(); f.setResult(qualityText);
  assert.equal((await f.x.admin(() => f.runtime.poll(currentSignal()))).state, "completed");
  const pending = f.journal.pendingNativeSnapshots(); assert.equal(pending.length, 1);
  assert.equal(first.incoming.length, 0);
  const calls = [...f.x.local.calls], before = await stableExecution(f);
  const delivery = f.journal.acceptedNativeDelivery(f.config.queueId), saved = f.x.local.journal.load(f.x.registration.id);
  assert.equal((await f.runtime.report(currentSignal())).disposition, "duplicate");
  assert.deepEqual(f.x.local.calls, calls); assert.deepEqual(f.journal.pendingNativeSnapshots(), pending);
  const next = await f.connect("recover");
  assert.notEqual(frames(next.nodeSent)[0].connectionId, frames(first.nodeSent)[0].connectionId);
  const emitted = frames(next.nodeSent);
  assert.deepEqual(emitted.map(frame => frame.type), ["connection.hello", "protocol.ack", "node.reconciliation.report",
    "harness.native.snapshot", "protocol.ack"]);
  assert.deepEqual(emitted[3].body, pending[0]);
  assert.equal(frames(next.serverSent).some(frame => frame.type === "harness.native.dispatch"), false);
  await pendingResult(f); assert.deepEqual(await stableExecution(f), before); assert.deepEqual(f.x.local.calls, calls);
  assert.deepEqual(f.journal.acceptedNativeDelivery(f.config.queueId), delivery);
  assert.deepEqual(f.x.local.journal.load(f.x.registration.id), saved);
  assert.deepEqual(f.journal.pendingNativeSnapshots(), []);
  const sent = next.nodeSent.length;
  assert.equal((await f.runtime.report(currentSignal())).disposition, "duplicate");
  await f.pump(next); assert.equal(next.nodeSent.length, sent); assert.deepEqual(f.x.local.calls, calls);
});

test("new runtime over retained journals is report-only and recovers an unacknowledged completed result without replaying execution", async t => {
  const f = await nativeNodeRuntimeFixture(); t.after(f.close); const first = await started(f);
  f.advance(); f.setResult(qualityText);
  await f.x.admin(() => f.runtime.poll(currentSignal()));
  // The signed completed frame is sent but never delivered to the server. Closing the
  // runtime leaves its durable body staged, not an invented fresh run or acknowledgement.
  const held = frames(first.incoming); assert.equal(held.length, 1); assert.equal(held[0].type, "harness.native.snapshot");
  await f.runtime.close(); await first.server.close();
  const before = await stableExecution(f), counts = await f.x.counts(), calls = [...f.x.local.calls];
  assert.equal(counts.artifacts.length, 0);
  const delivery = f.journal.acceptedNativeDelivery(f.config.queueId), saved = f.x.local.journal.load(f.x.registration.id);
  const replacement = f.create();
  assert.equal((await replacement.report(currentSignal())).disposition, "duplicate");
  assert.deepEqual(f.x.local.calls, calls); assert.deepEqual(await f.x.counts(), counts);
  const next = await f.connect("recover", replacement), emitted = frames(next.nodeSent);
  assert.deepEqual(emitted.map(frame => frame.type), ["connection.hello", "protocol.ack", "node.reconciliation.report",
    "harness.native.snapshot", "protocol.ack"]);
  assert.deepEqual(emitted[3].body, held[0].body);
  assert.notEqual(emitted[3].messageId, held[0].messageId); assert.notEqual(emitted[3].connectionId, held[0].connectionId);
  assert.equal(frames(next.serverSent).some(frame => frame.type === "harness.native.dispatch"), false);
  await pendingResult(f); assert.deepEqual(await stableExecution(f), before); assert.deepEqual(f.x.local.calls, calls);
  assert.deepEqual(f.journal.acceptedNativeDelivery(f.config.queueId), delivery);
  assert.deepEqual(f.x.local.journal.load(f.x.registration.id), saved);
  const sent = next.nodeSent.length;
  assert.equal((await replacement.report(currentSignal())).disposition, "duplicate");
  await f.pump(next); assert.equal(next.nodeSent.length, sent); assert.deepEqual(f.x.local.calls, calls);
});

test("separately signed recovery allows post-deadline stop once and later status without renewing canonical work", async t => {
  const f = await nativeNodeRuntimeFixture(); t.after(f.close); const connection = await started(f);
  const before = await stableExecution(f), delivery = f.journal.acceptedNativeDelivery(f.config.queueId);
  const deadline = f.x.f.prepared.binding.deadline;
  f.advance(deadline + 1 - f.x.f.clock());
  assert.ok(f.x.f.clock() > deadline); assert.ok(f.x.f.clock() < f.x.f.packet.recovery.body.expiresAt);
  assert.deepEqual(f.x.f.packet.recovery.body.operations, ["status", "stop"]);
  // Root's shared fake transport acknowledges stopping, not physical cessation. Its
  // subsequent running status must not undo the saved stopping state or replay the POST.
  const stopped = await f.x.admin(() => f.runtime.stop(currentSignal()));
  assert.equal(stopped.state, "stopping"); assert.equal(stopped.stopAttempted, true);
  assert.deepEqual(f.x.local.calls, ["capabilities", "start", "stop"]);
  await f.pump(connection);
  const again = await f.x.admin(() => f.runtime.stop(currentSignal()));
  assert.equal(again.stopAttempted, true); assert.equal(again.state, "stopping");
  await f.pump(connection);
  assert.deepEqual(f.x.local.calls, ["capabilities", "start", "stop", "status"]);
  assert.deepEqual(await stableExecution(f), before); assert.deepEqual(f.journal.acceptedNativeDelivery(f.config.queueId), delivery);
  assert.equal((await f.x.counts()).artifacts.length, 0);
});
