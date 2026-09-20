import assert from "node:assert/strict";
import test from "node:test";
import { signNodeFrame } from "../src/node-protocol/v1";
import type { NativeTaskSubmissionReference } from "../src/persistence/native-task-submission";
import { currentSignal, managedNativeSessionFixture } from "./helpers/managed-native-session";

async function queued(x: Awaited<ReturnType<typeof managedNativeSessionFixture>>) {
  const receipt = await x.admin(async () => {
    await x.f.save();
    return x.f.coordinator.enqueueNativeTask(...x.f.args, x.task.packetDigest, currentSignal());
  });
  return {
    schema: "control-room.native-task-submission/v1" as const,
    tenantId: x.f.scope.tenantId,
    projectId: receipt.projectId,
    jobId: receipt.jobId,
    attemptId: receipt.attemptId,
    queueId: receipt.queueId,
    packetDigest: receipt.packetDigest,
    inputDigest: x.task.inputDigest,
  } satisfies NativeTaskSubmissionReference;
}

async function deliverAndAcknowledge(
  x: Awaited<ReturnType<typeof managedNativeSessionFixture>>,
  primary: Awaited<ReturnType<typeof x.attachQueue>>,
  task: Awaited<ReturnType<typeof queued>>,
) {
  const delivery = x.manager.deliverApproved(task, currentSignal());
  for (let i = 0; i < 20 && primary.peer.outgoing.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(primary.peer.outgoing.filter(frame => JSON.parse(frame).type === "harness.native.dispatch").length, 1);
  await primary.peer.acknowledge();
  const receipt = primary.peer.incoming.shift();
  assert.ok(receipt);
  await primary.handle.receive(receipt, undefined, currentSignal());
  return delivery;
}

test("two enrolled synthetic workers share one database and never substitute a connected wrong worker", async t => {
  const x = await managedNativeSessionFixture(undefined, { queue: true, twoNodes: true });
  t.after(x.close);
  assert.ok(x.secondaryNode);
  assert.equal(x.settings.nodes.length, 2);
  assert.deepEqual(await x.admin(async () => (await x.f.db.query<{ id: string }>(
    "SELECT id FROM control_nodes WHERE tenant_id=$1 ORDER BY id", [x.f.scope.tenantId],
  )).rows.map(row => row.id)), [x.secondaryNode.nodeId, x.f.prepared.request.nodeId].sort());

  const secondary = await x.attach(x.secondaryNode.nodeId);
  await x.handshake(secondary);
  const task = await queued(x);
  await assert.rejects(x.manager.deliverApproved(task, currentSignal()), /native_session_unavailable/);
  assert.equal(secondary.peer.outgoing.filter(frame => JSON.parse(frame).type === "harness.native.dispatch").length, 0);

  // The non-target worker may reconnect without changing the canonical route.
  await secondary.handle.close();
  const reconnectedSecondary = await x.attach(x.secondaryNode.nodeId);
  await x.handshake(reconnectedSecondary);
  const primary = await x.attachQueue();
  await x.handshakeQueue(primary);
  const sent = await deliverAndAcknowledge(x, primary, task);
  assert.equal(sent.deliveryConfirmed, true);
  assert.equal(reconnectedSecondary.peer.outgoing.filter(frame => JSON.parse(frame).type === "harness.native.dispatch").length, 0);
});

test("a second enrolled worker rejects an incompatible protocol before becoming ready", async t => {
  const x = await managedNativeSessionFixture(undefined, { queue: true, twoNodes: true });
  t.after(x.close);
  assert.ok(x.secondaryNode);
  const secondary = await x.attach(x.secondaryNode.nodeId);
  const original = JSON.parse(secondary.hello);
  const { signature: _signature, ...unsigned } = original;
  const incompatible = signNodeFrame({ ...unsigned,
    body: { ...unsigned.body, supportedProtocols: ["unsupported-v0"] } }, secondary.peer.privateKey);
  await assert.rejects(secondary.handle.hello(JSON.stringify(incompatible), currentSignal()), /native_session_operation_uncertain/);
  assert.deepEqual(x.manager.queueRecoveryStatus(x.secondaryNode.nodeId), { state: "unavailable" });
});

test("a revoked enrolled worker cannot become a substitute for the assigned worker", async t => {
  const x = await managedNativeSessionFixture(undefined, { queue: true, twoNodes: true });
  t.after(x.close);
  assert.ok(x.secondaryNode);
  await x.admin(async () => {
    await x.f.db.query("UPDATE control_node_keys SET state='revoked',revoked_at=$1 WHERE tenant_id=$2 AND node_id=$3 AND id=$4", [
      new Date(x.f.clock()).toISOString(), x.f.scope.tenantId, x.secondaryNode!.nodeId, x.secondaryNode!.nodeKeyId,
    ]);
  });
  const revoked = await x.attach(x.secondaryNode.nodeId);
  await assert.rejects(revoked.handle.hello(revoked.hello, currentSignal()), /native_session_operation_uncertain/);
  const primary = await x.attachQueue();
  await x.handshakeQueue(primary);
  const task = await queued(x);
  const sent = await deliverAndAcknowledge(x, primary, task);
  assert.equal(sent.deliveryConfirmed, true);
  assert.equal(revoked.peer.outgoing.filter(frame => JSON.parse(frame).type === "harness.native.dispatch").length, 0);
});

test("a targeted worker alone sends a completed result after delivery acknowledgements are reconciled", async t => {
  const x = await managedNativeSessionFixture(undefined, { queue: true, twoNodes: true, reporting: true });
  t.after(x.close);
  assert.ok(x.secondaryNode);
  const secondary = await x.attach(x.secondaryNode.nodeId);
  await x.handshake(secondary);
  const primary = await x.attachQueue();
  await x.handshakeQueue(primary);
  const task = await queued(x), delivery = x.manager.deliverApproved(task, currentSignal());
  for (let i = 0; i < 20 && primary.peer.outgoing.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
  const frame = JSON.parse(primary.peer.outgoing[0]) as Parameters<typeof x.prepareNode>[1];
  await primary.peer.acknowledge();
  const receipt = primary.peer.incoming.shift(); assert.ok(receipt);
  await primary.handle.receive(receipt, undefined, currentSignal());
  await delivery;
  while (primary.peer.outgoing.length) await primary.peer.acknowledge();

  const native = await x.prepareNode(primary.peer, frame);
  assert.ok(native.reporter);
  for (const phase of ["start", "running", "completed"] as const) {
    const body = await native.advanceNative(phase);
    await native.reporter.report(currentSignal());
    const observation = primary.peer.incoming.shift(); assert.ok(observation);
    const bytes = phase === "completed" ? native.reporter.readResult(body, currentSignal()) : undefined;
    await primary.handle.receive(observation, bytes, currentSignal());
    while (primary.peer.outgoing.length) await primary.peer.acknowledge();
  }
  const counts = await x.counts();
  assert.equal(counts.artifacts.length, 1);
  assert.equal(counts.receipts.length, 1);
  assert.equal(secondary.peer.outgoing.some(raw => JSON.parse(raw).type === "harness.native.dispatch"), false);
});
