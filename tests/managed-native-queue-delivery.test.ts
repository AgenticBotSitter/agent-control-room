import test from "node:test";
import assert from "node:assert/strict";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";
import type { NativeTaskSubmissionReference } from "../src/persistence/native-task-submission";
import { WebSessionAuthority } from "../src/web/v1/session-authority";

async function queued() {
  const x = await managedNativeSessionFixture(undefined, { queue: true });
  const receipt = await x.admin(async () => {
    await x.f.save(); return x.f.coordinator.enqueueNativeTask(...x.f.args, x.task.packetDigest, currentSignal());
  });
  const ref: NativeTaskSubmissionReference = { schema: "control-room.native-task-submission/v1", tenantId: x.f.scope.tenantId,
    projectId: receipt.projectId, jobId: receipt.jobId, attemptId: receipt.attemptId, queueId: receipt.queueId,
    packetDigest: receipt.packetDigest, inputDigest: x.task.inputDigest };
  return { x, ref };
}
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
