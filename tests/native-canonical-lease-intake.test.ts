import test from "node:test";
import assert from "node:assert/strict";
import { canonicalApprovalStorageFixture } from "./helpers/canonical-approval-storage";
import { nativeEnvelopeSession } from "./helpers/native-envelope-session";
import { NativeDispatchIntakeHandler } from "../src/node-bridge/native-dispatch-handler";
import { createNativeLeaseCommandHandler } from "../src/harness/hermes-native-v1/lease-intake";
import { createNativeLeaseEvidence } from "../src/harness/hermes-native-v1/lease-evidence";
import { enrollment } from "./hermes-native-fixture";
import { sha256Digest } from "../src/security";
import { signedNodeFrameSchema } from "../src/node-protocol/v1";
import type { SqliteBridgeJournal } from "../src/node-bridge/journal";

test("joined session setup closes all owned resources after construction or handshake failures", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close);
  for (const mode of ["construction", "handshake", "cleanup-throws"] as const) {
    let journal: SqliteBridgeJournal | undefined, nativeClosed = 0, commandClosed = 0;
    await assert.rejects(nativeEnvelopeSession(f, {
      nativeHandler: value => {
        journal = value;
        const handler = new NativeDispatchIntakeHandler(enrollment, value, { approvals: f.approvals, security: f.native.trust }, f.clock);
        const close = handler.close.bind(handler);
        handler.close = () => { nativeClosed++; close(); };
        return handler;
      },
      commandHandler: () => {
        if (mode === "construction") throw new Error("synthetic constructor failure");
        return { async handle() { return false; }, close() {
          commandClosed++; if (mode === "cleanup-throws") throw new Error("synthetic cleanup failure");
        } };
      },
      nodeSend: async () => { throw new Error("synthetic handshake failure"); },
    }));
    assert.ok(journal);
    assert.equal(nativeClosed, 1);
    assert.equal(commandClosed, mode === "construction" ? 0 : 1);
    assert.throws(() => journal!.queuedCommandCount(), /closed|not open/i);
  }
});

// Synthetic keys/transport only. Canonical preparation and both checked node
// handlers are real; no manually seeded accepted command or attempt summary.
for (const invalidate of [false, true]) test(`canonical signed pair to checked bridge intake, invalidated=${invalidate}`, async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close);
  await f.save(); await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  let taskCurrent = true;
  const s = await nativeEnvelopeSession(f, { leaseDelivery: true,
    nativeHandler: journal => new NativeDispatchIntakeHandler(enrollment, journal, { approvals: f.approvals, security: f.native.trust }, f.clock),
    commandHandler: (journal, spki) => createNativeLeaseCommandHandler({ request: f.prepared.request,
      serverActorId: "server:test", serverKeyId: "key:server", serverPublicKeySpki: spki }, {
      journal, clock: f.clock, channel: () => s.bridge.nativeDeliveryChannel(),
      trust: { currentServerTrustRevision: () => "synthetic-revision:1",
        async resolveServerKey(id) { return id === "key:server" ? Buffer.from(spki, "base64url") : undefined; } },
      assertTaskCurrent: () => {
        if (dispatch.type !== "harness.native.dispatch") throw new Error("synthetic expected dispatch");
        const saved = journal.acceptedNativeDelivery(dispatch.body.queueId);
        if (!taskCurrent || !saved || sha256Digest(saved.frame) !== sha256Digest(dispatch)) throw new Error("synthetic task fence");
        return true;
      },
    }),
  }); t.after(s.close);
  await f.coordinator.stageQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
  const before = s.sent.length;
  await f.coordinator.transmitQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
  const messages = s.sent.slice(before);
  const dispatch = signedNodeFrameSchema.parse(JSON.parse(messages[0]));
  const grant = signedNodeFrameSchema.parse(JSON.parse(messages[1]));
  if (dispatch.type !== "harness.native.dispatch" || grant.type !== "job.lease.grant") throw new Error("synthetic expected pair");
  const read = createNativeLeaseEvidence({ request: dispatch.body.request, messageId: grant.messageId,
    serverActorId: "server:test", parentAuthorities: [] }, { journal: s.journal, clock: f.clock,
    trust: { async resolveServerKey(id) { return id === "key:server" ? Buffer.from(s.spki, "base64url") : undefined; } } });
  await assert.rejects(read(f.abort.signal));
  await s.bridge.receive(messages[0], new Date(f.clock()).toISOString());
  assert.ok(s.journal.acceptedNativeDelivery(dispatch.body.queueId));
  await assert.rejects(read(f.abort.signal));
  const receipt = s.incoming.shift(); assert.ok(receipt);
  const recorded = await f.store.receiveDeliveryReceipt(f.db, s.session, receipt, f.abort.signal);
  assert.equal(recorded.nodeReportedDisposition, "recorded");
  assert.equal(recorded.executionConfirmed, false);
  if (invalidate) {
    taskCurrent = false;
    await assert.rejects(s.bridge.receive(messages[1], new Date(f.clock()).toISOString()));
    await assert.rejects(read(f.abort.signal));
    assert.throws(() => s.journal.acceptedCommand(grant.messageId), /Accepted command evidence unavailable/);
    assert.equal(s.journal.queuedCommandCount(), 0);
    assert.equal(s.journal.attemptSummary(grant.body.attemptId), undefined);
    assert.equal(s.incoming.length, 0);
  } else {
    await s.bridge.receive(messages[1], new Date(f.clock()).toISOString());
    const evidence = await read(f.abort.signal);
    assert.equal(evidence.authorityDigest, dispatch.body.request.authorityDigest);
    assert.equal(evidence.leaseId, dispatch.body.request.leaseId);
    assert.equal(s.journal.attemptSummary(grant.body.attemptId)?.state, "leased");
    const ack = s.incoming.shift(); assert.ok(ack);
    assert.equal(JSON.parse(ack).type, "protocol.ack");
    await s.session.receive(ack);
    assert.equal(s.incoming.length, 0);
    await s.bridge.receive(messages[1], new Date(f.clock()).toISOString());
    const duplicate = s.incoming.shift(); assert.ok(duplicate); await s.session.receive(duplicate);
    assert.equal(s.journal.queuedCommandCount(), 1);
  }
  assert.equal((await f.db.query("SELECT * FROM control_native_transmission_intents")).rows.length, 1);
  assert.equal((await f.db.query("SELECT * FROM control_native_delivery_receipts")).rows.length, 1);
});
