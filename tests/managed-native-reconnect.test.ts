import assert from "node:assert/strict";
import test from "node:test";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";
import { qualityText } from "./helpers/native-quality-completion";
import { signNodeFrame, signedNodeFrameSchema } from "../src/node-protocol/v1";
import type { NativeTaskSnapshotBody } from "../src/harness/v1/native-observation";
import type { LeaseRecord } from "../src/domain/v1";

type Fixture = Awaited<ReturnType<typeof managedNativeSessionFixture>>;
type Connection = Awaited<ReturnType<Fixture["attach"]>>;

/** One real synthetic delivery and native start, completed at the fake node before reconnect.
 * Only queued/running evidence has reached the control-plane when this setup returns. */
async function pendingResult() {
  const x = await managedNativeSessionFixture();
  try {
    await x.verify(); const first = await x.attach(); await x.handshake(first);
    const native = await x.dispatch(first), registered = await x.receiver.register(x.request, currentSignal());
    for (const phase of ["start", "running"] as const) {
      const wire = await native.produce(phase); await first.handle.progress(wire.raw, undefined, currentSignal()); await first.peer.acknowledge();
    }
    const completed = await native.produce("completed"), bytes = new TextEncoder().encode(qualityText);
    assert.equal(x.local.calls.filter(value => value === "start").length, 1);
    assert.equal((await x.counts()).artifacts.length, 0);
    return { x, first, registered, completed, bytes };
  } catch (error) { await x.close(); throw error; }
}

// Administrative observer only. None of these records may change because of reattachment.
async function deliveryState(x: Fixture) {
  return x.admin(async () => {
    const rows: Record<string, unknown[]> = {};
    for (const table of ["control_native_task_queue", "control_native_approval_packets", "control_native_delivery_preparations",
      "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts"])
      rows[table] = (await x.f.db.query(`SELECT * FROM ${table} WHERE job_id=$1`, [x.task.jobId])).rows;
    rows.outbox = (await x.f.db.query("SELECT * FROM control_outbox ORDER BY id")).rows;
    rows.transitions = (await x.f.db.query("SELECT * FROM control_transition_events ORDER BY id")).rows;
    return rows;
  });
}

async function recovered(x: Fixture) {
  const next = await x.attach(); await x.handshake(next);
  const sends = next.peer.state.sends, writes = x.observed.length;
  const result = await next.handle.recover(x.request, currentSignal());
  assert.deepEqual(result, { recovered: true, grantsExecutionAuthority: false });
  assert.equal(next.peer.state.sends, sends); assert.equal(next.peer.outgoing.length, 0);
  const reads = x.observed.slice(writes);
  assert.ok(reads.some(row => row.login === "managed_evidence_test" && row.sql.includes("control_native_delivery_envelopes")));
  assert.ok(reads.some(row => row.login === "managed_evidence_test" && row.sql.includes("control_harness_runs")));
  assert.equal(reads.some(row => /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:control_|node_protocol_)/i.test(row.sql)), false);
  return next;
}

/** Real portable-bridge signing of the saved observation on a new, reconciled connection.
 * This transfers synthetic recorded evidence only; it never calls the native handoff again. */
async function publishSaved(x: Fixture, next: Connection, body: NativeTaskSnapshotBody) {
  return x.admin(async () => {
    await next.peer.bridge.publishNativeSnapshot(body, new Date(x.f.clock()).toISOString());
    const raw = next.peer.incoming.shift(); assert.ok(raw);
    const frame = signedNodeFrameSchema.parse(JSON.parse(raw));
    assert.equal(frame.connectionId, JSON.parse(next.hello).connectionId); assert.deepEqual(frame.body, body);
    return raw;
  });
}

async function exactFreshReplay(x: Fixture, next: Connection, raw: string, bytes: Uint8Array) {
  // An already acknowledged snapshot is intentionally deduplicated by publishNativeSnapshot.
  // The synthetic sender re-envelopes the exact observed body with its current signing key.
  const previous = signedNodeFrameSchema.parse(JSON.parse(raw));
  const { signature, bodyDigest, ...unsigned } = previous; void signature; void bodyDigest;
  const frame = signNodeFrame({ ...unsigned, sequence: next.peer.journal.nextOutboundSequence(previous.connectionId),
    messageId: "message:reconnect-exact-result", nonce: "reconnect_exact_result_12345678901234567890" }, x.f.keys.privateKey);
  const now = new Date(x.f.clock()).toISOString();
  assert.equal(next.peer.journal.stageOutbound(frame, true, now), "staged"); next.peer.journal.markSent(frame.messageId, now);
  const result = await next.handle.progress(JSON.stringify(frame), bytes, currentSignal()); await next.peer.acknowledge(); return result;
}

test("fresh signed connection recovers recorded running task and submits its saved completed result without redispatch or native restart", async t => {
  const { x, first, registered, completed, bytes } = await pendingResult(); t.after(x.close);
  const canonical = await x.states(), durable = await deliveryState(x), calls = [...x.local.calls], before = await x.counts();
  const next = await recovered(x);
  assert.notEqual(JSON.parse(next.hello).connectionId, JSON.parse(first.hello).connectionId); assert.equal(first.peer.state.closes, 1);
  assert.deepEqual(await x.counts(), before); assert.deepEqual(await deliveryState(x), durable);
  const raw = await publishSaved(x, next, completed.body);
  const result = await next.handle.progress(raw, bytes, currentSignal()); await next.peer.acknowledge();
  assert.equal(result.state, "succeeded"); assert.equal(result.replayed, false); assert.equal(result.runId, x.registration.id);
  assert.equal(result.submission!.targetId, registered.receipt.targetId); assert.equal(result.submission!.qualityAccepted, false);
  const after = await x.counts(); assert.equal(after.events.length, before.events.length + 1);
  assert.equal(after.artifacts.length, 1); assert.equal(after.receipts.length, 1);
  assert.deepEqual(await x.f.config.storage.read(after.artifacts[0].id as string), bytes);
  const cp = x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`);
  const replay = await exactFreshReplay(x, next, raw, bytes);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.submission, result.submission);
  assert.deepEqual(await x.counts(), after); assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`), cp);
  assert.deepEqual(await x.states(), canonical); assert.deepEqual(await deliveryState(x), durable); assert.deepEqual(x.local.calls, calls);
  const target = await x.admin(() => x.f.reviewStore.snapshot(x.f.scope.tenantId, registered.receipt.targetId));
  assert.equal(target.status, "pending");
  assert.ok(x.observed.some(row => row.login === "managed_auth_test" && row.sql.includes("INSERT INTO node_protocol_replay")));
});

test("lost completed-result ACK is reconciled on a fresh recovered connection with one durable result and no native retry", async t => {
  const { x, first, completed, bytes } = await pendingResult(); t.after(x.close);
  const canonical = await x.states(), durable = await deliveryState(x), calls = [...x.local.calls];
  first.peer.state.failSend = true;
  await assert.rejects(async () => first.handle.progress(completed.raw, bytes, currentSignal()));
  assert.equal(first.peer.state.closes, 1); assert.equal(first.peer.outgoing.length, 0);
  const committed = await x.counts(); assert.equal(committed.runs[0].state, "succeeded");
  assert.equal(committed.artifacts.length, 1); assert.equal(committed.receipts.length, 1);
  const cp = x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`), oldSends = first.peer.state.sends;
  const next = await recovered(x), raw = await publishSaved(x, next, completed.body);
  const result = await next.handle.progress(raw, bytes, currentSignal()); await next.peer.acknowledge();
  assert.equal(result.replayed, true); assert.equal(result.submission!.qualityAccepted, false);
  assert.deepEqual(await x.counts(), committed); assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`), cp);
  assert.deepEqual(await x.states(), canonical); assert.deepEqual(await deliveryState(x), durable); assert.deepEqual(x.local.calls, calls);
  assert.equal(first.peer.state.sends, oldSends); assert.equal(first.peer.state.closes, 1);
  await assert.rejects(async () => first.handle.progress(completed.raw, bytes, currentSignal()));
});

test("recorded completed evidence reconnects after canonical lease expiry without reviving its orphaned attempt", async t => {
  const { x, first, completed, bytes } = await pendingResult(); t.after(x.close);
  await first.handle.progress(completed.raw, bytes, currentSignal()); await first.peer.acknowledge();
  const before = await x.states(), { job, attempt } = before;
  assert.ok(job); assert.ok(attempt); assert.ok(before.lease);
  const lease = before.lease as LeaseRecord;
  x.f.setNow(Date.parse(lease.expiresAt) + 1);
  // Explicit canonical expiry is setup for the historical-read test, not performed by recovery.
  await x.admin(() => x.f.canonical.expireLease({ tenantId: x.f.scope.tenantId, jobId: job.id, attemptId: attempt.id,
    leaseId: lease.id, expectedJobVersion: job.version, expectedAttemptVersion: attempt.version,
    expectedLeaseVersion: lease.version, epoch: lease.epoch, transitionId: "transition:reconnect-expiry",
    idempotencyKey: "managed-reconnect-expiry", actor: { actorId: "identity:test", actorType: "human" }, occurredAt: new Date(x.f.clock()).toISOString() }));
  const expired = await x.states(); assert.ok(expired.lease); assert.ok(expired.attempt);
  assert.equal(expired.lease.state, "expired"); assert.equal(expired.attempt.state, "orphaned");
  const durable = await deliveryState(x), counts = await x.counts(), calls = [...x.local.calls];
  const next = await recovered(x), raw = await publishSaved(x, next, completed.body);
  const replay = await next.handle.progress(raw, bytes, currentSignal()); await next.peer.acknowledge();
  assert.equal(replay.replayed, true); assert.equal(replay.submission!.qualityAccepted, false);
  assert.deepEqual(await x.states(), expired); assert.deepEqual(await deliveryState(x), durable);
  assert.deepEqual(await x.counts(), counts); assert.deepEqual(x.local.calls, calls);
});

for (const operation of ["stage", "transmit"] as const) test(`recovered observation session cannot ${operation} the saved native dispatch`, async t => {
  const { x } = await pendingResult(); t.after(x.close); const next = await recovered(x);
  const durable = await deliveryState(x), canonical = await x.states(), calls = [...x.local.calls], sends = next.peer.state.sends;
  await assert.rejects(async () => next.handle[operation](x.f.identity, x.task, currentSignal()));
  assert.equal(next.peer.state.sends, sends); assert.equal(next.peer.state.closes, 1);
  assert.deepEqual(await deliveryState(x), durable); assert.deepEqual(await x.states(), canonical); assert.deepEqual(x.local.calls, calls);
});
