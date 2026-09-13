import assert from "node:assert/strict";
import test from "node:test";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";

test("shared Hermes queue completes only after the authenticated machine receipt", async () => {
  const f = await managedNativeSessionFixture(undefined, { queue: true });
  try {
    await f.verify();
    const connection = await f.attachQueue();
    await f.handshakeQueue(connection);
    await f.admin(() => f.f.save());
    const queued = await f.admin(() => f.f.coordinator.enqueueNativeTask(...f.f.args,
      f.task.packetDigest, f.f.abort.signal));
    const reference = {
      schema: "control-room.native-task-submission/v1" as const,
      tenantId: f.f.scope.tenantId, projectId: f.task.projectId, jobId: f.task.jobId,
      attemptId: queued.attemptId, queueId: queued.queueId,
      inputDigest: f.task.inputDigest, packetDigest: queued.packetDigest,
    };
    let settled = false;
    const delivery = f.manager.deliverApproved(reference, currentSignal()).finally(() => { settled = true; });
    for (let i = 0; i < 20 && connection.peer.outgoing.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(connection.peer.outgoing.length, 1);
    assert.equal(JSON.parse(connection.peer.outgoing[0]).type, "harness.native.dispatch");
    assert.equal(settled, false, "transport send is not a delivery receipt");

    await connection.peer.acknowledge();
    const receipt = connection.peer.incoming.shift();
    assert.ok(receipt);
    assert.equal(JSON.parse(receipt).type, "harness.native.dispatch.receipt");
    await connection.handle.receive(receipt, undefined, currentSignal());
    const result = await delivery;
    assert.equal(result.kind, "hermes");
    assert.equal(result.deliveryConfirmed, true);
    assert.equal(result.transmissionRecorded, true);
    assert.equal(f.inputRegistrations(), 1);
  } finally {
    await f.close();
  }
});

test("missing queue receipt closes in bounded time and cannot create a second send", async () => {
  const f = await managedNativeSessionFixture(undefined, { queue: true, receiptTimeoutMs: 25 });
  try {
    await f.verify();
    const first = await f.attachQueue(); await f.handshakeQueue(first);
    await f.admin(() => f.f.save());
    const queued = await f.admin(() => f.f.coordinator.enqueueNativeTask(...f.f.args,
      f.task.packetDigest, f.f.abort.signal));
    const reference = { schema: "control-room.native-task-submission/v1" as const,
      tenantId: f.f.scope.tenantId, projectId: f.task.projectId, jobId: f.task.jobId,
      attemptId: queued.attemptId, queueId: queued.queueId, inputDigest: f.task.inputDigest, packetDigest: queued.packetDigest };
    await assert.rejects(f.manager.deliverApproved(reference, currentSignal()), /native_task_delivery_unresolved/);
    assert.equal(first.peer.state.sends, 4);
    assert.equal(first.peer.state.closes, 1);

    const replacement = await f.attachQueue(); await f.handshakeQueue(replacement);
    await assert.rejects(f.manager.deliverApproved(reference, currentSignal()));
    assert.equal(replacement.peer.outgoing.some(raw => JSON.parse(raw).type === "harness.native.dispatch"), false);
  } finally { await f.close(); }
});
