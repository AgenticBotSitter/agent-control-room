import test from "node:test";
import assert from "node:assert/strict";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";
import type { NativeTaskSubmissionReference } from "../src/persistence/native-task-submission";
import { WebSessionAuthority } from "../src/web/v1/session-authority";
import { signNodeFrame } from "../src/node-protocol/v1";

async function queued(onQueueReady?: import("../src/web/v1/task-assignment-coordinator").TaskAssignmentCoordinator["recoverForReadyNode"]) {
  const x = await managedNativeSessionFixture(undefined, { queue: true, onQueueReady });
  const receipt = await x.admin(async () => {
    await x.f.save(); return x.f.coordinator.enqueueNativeTask(...x.f.args, x.task.packetDigest, currentSignal());
  });
  const ref: NativeTaskSubmissionReference = { schema: "control-room.native-task-submission/v1", tenantId: x.f.scope.tenantId,
    projectId: receipt.projectId, jobId: receipt.jobId, attemptId: receipt.attemptId, queueId: receipt.queueId,
    packetDigest: receipt.packetDigest, inputDigest: x.task.inputDigest };
  return { x, ref };
}

test("readiness recovery waits for signed reconciliation and ignores later fresh acknowledgements", async t => {
  let calls = 0;
  const { x } = await queued(async (node, signal, current) => {
    assert.equal(node.nodeId, x.f.prepared.request.nodeId); assert.equal(signal.aborted, false); current(); calls++;
    return { examined: 0, recovered: 0, held: 0, truncated: false };
  }); t.after(x.close);
  const c = await x.attach(); await c.handle.hello(c.hello, currentSignal()); assert.equal(calls, 0);
  for (let i = 0; i < 20 && (c.peer.outgoing.length || c.peer.incoming.length); i++) {
    while (c.peer.outgoing.length) await c.peer.acknowledge();
    while (c.peer.incoming.length) await c.handle.reconcile(c.peer.incoming.shift()!, currentSignal());
  }
  assert.equal(calls, 1);
  const previous = c.peer.sent.find(frame => frame.type === "protocol.ack")!;
  assert.ok(previous);
  const frame = signNodeFrame({ ...previous, messageId: "message:ready-repeat-ack", nonce: "ready_repeat_ack_12345678901234567890",
    sequence: c.peer.journal.nextOutboundSequence(previous.connectionId) }, x.f.keys.privateKey);
  await c.handle.reconcile(JSON.stringify(frame), currentSignal());
  assert.equal(calls, 1); assert.equal(x.manager.queueRecoveryStatus(c.handle.nodeId).state, "complete");
  const attention = x.manager.queueAttention();
  assert.equal(attention.completeNodes, 1); assert.equal(attention.held, 0);
  assert.equal(JSON.stringify(attention).includes(c.handle.nodeId), false);
  assert.equal(calls, 1);
});

test("attention snapshot reports held and limited checks without rerunning them or retaining closed observations", async t => {
  let calls = 0;
  const { x } = await queued(async () => { calls++; return { examined: 32, recovered: 30, held: 2, truncated: true }; });
  t.after(x.close);
  assert.equal(x.manager.queueAttention().unavailableNodes, 1);
  const c = await x.attach(); assert.equal(x.manager.queueAttention().notAttemptedNodes, 1);
  await x.handshake(c);
  for (let i = 0; i < 2; i++) {
    const value = x.manager.queueAttention(); assert.equal(value.held, 2); assert.equal(value.truncatedNodes, 1);
  }
  assert.equal(calls, 1);
  await c.handle.close();
  const closed = x.manager.queueAttention(); assert.equal(closed.unavailableNodes, 1); assert.equal(closed.held, 0);
});

test("recovery failure does not close an otherwise healthy signed session", async t => {
  const { x, ref } = await queued(async () => { throw new Error("synthetic discovery failure"); }); t.after(x.close);
  const c = await x.attach(); await x.handshake(c);
  assert.equal(x.manager.queueRecoveryStatus(c.handle.nodeId).state, "uncertain");
  assert.equal(x.manager.queueAttention().uncertainNodes, 1);
  assert.equal(c.peer.state.closes, 0);
  assert.equal((await x.manager.deliverApproved(ref, currentSignal())).deliveryConfirmed, false);
});

test("readiness timeout aborts late recovery without closing the connection or retrying the hook", async t => {
  const result = { examined: 0, recovered: 0, held: 0, truncated: false };
  let release!: (value: typeof result) => void, entered!: () => void, signal!: AbortSignal, current!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); let calls = 0;
  const { x } = await queued(async (_node, suppliedSignal, suppliedCurrent) => {
    calls++; signal = suppliedSignal; current = suppliedCurrent; entered();
    return new Promise<typeof result>(resolve => { release = resolve; });
  }); t.after(x.close);
  const c = await x.attach(); t.mock.timers.enable({ apis: ["setTimeout"] });
  const handshake = x.handshake(c); await started; t.mock.timers.tick(5000); await handshake;
  assert.equal(signal.aborted, true); assert.throws(current);
  assert.equal(x.manager.queueRecoveryStatus(c.handle.nodeId).state, "uncertain");
  assert.equal(c.peer.state.closes, 0); release(result);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(x.manager.queueRecoveryStatus(c.handle.nodeId).state, "uncertain");
  t.mock.timers.reset();
});

test("replacement aborts the readiness generation before recovery can proceed", async t => {
  let checked = false;
  const { x } = await queued(async (_node, signal, current) => {
    await x.attach(); assert.equal(signal.aborted, true); assert.throws(current); checked = true;
    throw new Error("synthetic replaced readiness");
  }); t.after(x.close);
  const c = await x.attach(); await assert.rejects(x.handshake(c), /native_session_unavailable/);
  assert.equal(checked, true); assert.equal(c.peer.state.closes, 1);
  assert.equal(x.manager.queueRecoveryStatus(c.handle.nodeId).state, "not_attempted");
});
test("approved queue resolves its assigned managed session without browser credentials and accepts the later receipt", async t => {
  const { x, ref } = await queued(); t.after(x.close);
  const c = await x.attach(); await x.handshake(c);
  await x.admin(() => new WebSessionAuthority(x.f.db, x.f.scope, x.f.clock).logout(x.f.identity));
  const result = await x.manager.deliverApproved(ref, currentSignal());
  assert.equal(result.deliveryConfirmed, false);
  assert.equal(c.peer.outgoing.filter(frame => JSON.parse(frame).type === "harness.native.dispatch").length, 1);
  await c.peer.acknowledge();
  await c.handle.receipt(c.peer.incoming.shift()!, currentSignal());
  assert.equal(await x.admin(async () => (await x.f.db.query("SELECT * FROM control_native_delivery_receipts")).rows.length), 1);
});
test("no connected assigned node fails without selecting a substitute", async t => {
  const { x, ref } = await queued(); t.after(x.close);
  await assert.rejects(x.manager.deliverApproved(ref, currentSignal()), /native_session_unavailable/);
  assert.equal(await x.admin(async () => (await x.f.db.query("SELECT * FROM control_native_transmission_intents")).rows.length), 0);
});
test("session replacement between stage and transmit prevents delivery to either generation", async t => {
  const { x, ref } = await queued(); t.after(x.close);
  const c = await x.attach(); await x.handshake(c);
  let next: Awaited<ReturnType<typeof x.attach>> | undefined;
  x.hooks.afterQueueStage = async () => { next = await x.attach(); };
  await assert.rejects(x.manager.deliverApproved(ref, currentSignal()), /native_session_operation_uncertain/);
  for (const peer of [c.peer, next!.peer])
    assert.equal(peer.outgoing.filter(frame => JSON.parse(frame).type === "harness.native.dispatch").length, 0);
});
test("owner revocation after staging is checked again before transmission", async t => {
  const { x, ref } = await queued(); t.after(x.close);
  const c = await x.attach(); await x.handshake(c);
  x.hooks.afterQueueStage = () => x.admin(async () => { await x.f.db.query("UPDATE control_role_grants SET role_key='operator'"); });
  await assert.rejects(x.manager.deliverApproved(ref, currentSignal()), /native_session_operation_uncertain/);
  assert.equal(c.peer.outgoing.filter(frame => JSON.parse(frame).type === "harness.native.dispatch").length, 0);
});

for (const transmitted of [false, true]) test(`recovery refuses ${transmitted ? "transmitted" : "staged but not transmitted"} work before touching the queue`, async t => {
  const { x, ref } = await queued(); t.after(x.close);
  const c = await x.attach(); await x.handshake(c);
  if (!transmitted) x.hooks.afterQueueStage = () => { throw new Error("synthetic stop after stage"); };
  if (transmitted) await x.manager.deliverApproved(ref, currentSignal());
  else await assert.rejects(x.manager.deliverApproved(ref, currentSignal()));
  let calls = 0;
  const coordinator = x.f.create(x.f.db, { enqueueInSession: async () => {},
    recoverUnsentInSession: async () => { calls++; return true; } });
  await assert.rejects(x.admin(() => coordinator.recoverNeverStagedQueueDelivery(ref, currentSignal())));
  assert.equal(calls, 0);
  assert.equal(c.peer.outgoing.filter(raw => JSON.parse(raw).type === "harness.native.dispatch").length, transmitted ? 1 : 0);
});
