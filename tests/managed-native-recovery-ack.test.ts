import test from "node:test";
import assert from "node:assert/strict";
import { signNodeFrame, signedNodeFrameSchema } from "../src/node-protocol/v1";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";

for (const state of ["prepared", "sent", "receipted"] as const)
  for (const mode of ["known-ack", "unknown-ack", "second-reconciliation"] as const)
    test(`${state} connection handles delayed ${mode} without changing delivery state`, async t => {
      const x = await managedNativeSessionFixture(); t.after(x.close);
      const c = await x.attach(); await x.handshake(c);
      await x.admin(async () => { await x.f.save(); await x.f.coordinator.enqueueNativeTask(...x.f.args, x.task.packetDigest, currentSignal()); });
      await c.handle.stage(x.f.identity, x.task, currentSignal());
      if (state !== "prepared") await c.handle.transmit(x.f.identity, x.task, currentSignal());
      if (state === "receipted") {
        await c.peer.acknowledge(); await c.handle.receipt(c.peer.incoming.shift()!, currentSignal());
      }
      const report = c.peer.sent.find(frame => frame.type === "node.reconciliation.report"); assert.ok(report);
      const accepted = c.peer.sent.find(frame => frame.type === "protocol.ack"); assert.ok(accepted);
      const { signature, bodyDigest, ...unsigned } = signedNodeFrameSchema.parse(mode === "second-reconciliation" ? report : accepted);
      void signature; void bodyDigest;
      const next = { ...unsigned, sequence: c.peer.journal.nextOutboundSequence(unsigned.connectionId),
        messageId: `message:${state}-${mode}`, nonce: `delayed_${state}_${mode}_123456789012345678901234` };
      const frame = mode === "unknown-ack" ? signNodeFrame({ ...next, type: "protocol.ack",
        body: { acknowledgedMessageIds: ["message:never-issued"], highestContiguousSequence: 1, disposition: "accepted" } }, x.f.keys.privateKey)
        : signNodeFrame(next, x.f.keys.privateKey);
      const before = await x.counts(), states = await x.states(), calls = [...x.local.calls], sends = c.peer.state.sends;
      if (mode === "known-ack") await c.handle.reconcile(JSON.stringify(frame), currentSignal());
      else await assert.rejects(c.handle.reconcile(JSON.stringify(frame), currentSignal()));
      assert.deepEqual(await x.counts(), before); assert.deepEqual(await x.states(), states); assert.deepEqual(x.local.calls, calls);
      assert.equal(c.peer.state.sends, sends); assert.equal(c.peer.state.closes, mode === "known-ack" ? 0 : 1);
      if (mode === "known-ack" && state === "prepared") await c.handle.transmit(x.f.identity, x.task, currentSignal());
      if (mode === "known-ack" && state === "sent") {
        await c.peer.acknowledge(); await c.handle.receipt(c.peer.incoming.shift()!, currentSignal());
      }
    });

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
