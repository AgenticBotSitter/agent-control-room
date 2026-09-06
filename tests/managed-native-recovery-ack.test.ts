import test from "node:test";
import assert from "node:assert/strict";
import { signNodeFrame, signedNodeFrameSchema } from "../src/node-protocol/v1";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";

for (const mode of ["unknown-ack", "second-reconciliation"] as const)
  test(`recovered connection rejects ${mode} without reopening delivery or recording progress`, async t => {
    const x = await managedNativeSessionFixture(); t.after(x.close);
    const original = await x.attach(); await x.handshake(original); await x.dispatch(original);
    await x.receiver.register(x.request, currentSignal());
    const next = await x.attach(); await x.handshake(next); await next.handle.recover(x.request, currentSignal());
    const report = next.peer.sent.find(frame => frame.type === "node.reconciliation.report"); assert.ok(report);
    const { signature, bodyDigest, ...unsigned } = signedNodeFrameSchema.parse(report); void signature; void bodyDigest;
    const base = { ...unsigned, sequence: next.peer.journal.nextOutboundSequence(unsigned.connectionId),
      messageId: `message:recovered-${mode}`, nonce: `recovered_${mode}_123456789012345678901234` };
    const frame = mode === "unknown-ack" ? signNodeFrame({ ...base, type: "protocol.ack",
      body: { acknowledgedMessageIds: ["message:never-issued"], highestContiguousSequence: 1, disposition: "accepted" } }, x.f.keys.privateKey)
      : signNodeFrame(base, x.f.keys.privateKey);
    const before = await x.counts(), states = await x.states(), calls = [...x.local.calls], sends = next.peer.state.sends;
    await assert.rejects(next.handle.reconcile(JSON.stringify(frame), currentSignal()), { message: "native_session_operation_uncertain" });
    assert.deepEqual(await x.counts(), before); assert.deepEqual(await x.states(), states); assert.deepEqual(x.local.calls, calls);
    assert.equal(next.peer.state.sends, sends); assert.equal(next.peer.state.closes, 1);
  });
