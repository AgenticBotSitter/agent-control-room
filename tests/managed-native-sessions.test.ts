import assert from "node:assert/strict";
import test from "node:test";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";
import { qualityText } from "./helpers/native-quality-completion";
import { signNodeFrame, signedNodeFrameSchema } from "../src/node-protocol/v1";

test("owned restricted authentication carries actual hello, dispatch receipt and completed bytes into exact pending review", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); await x.verify();
  const c = await x.attach(); assert.equal(c.handle.grantsExecutionAuthority, false); assert.equal(Object.isFrozen(c.handle), true);
  assert.deepEqual(Object.keys(c.handle).sort(), ["close", "grantsExecutionAuthority", "hello", "nodeId", "progress", "receipt", "reconcile", "recover", "stage", "transmit"].sort());
  const beforeProtocol = await x.protocol(); await x.handshake(c);
  assert.ok((await x.protocol()).connections.length > beforeProtocol.connections.length);
  const native = await x.dispatch(c), before = await x.states();
  assert.equal((await x.counts()).runs.length, 0);
  const bound = await x.receiver.register(x.request, currentSignal());
  assert.equal(bound.replayed, false); assert.equal(bound.receipt.runId, x.registration.id);
  for (const phase of ["start", "running"] as const) {
    const wire = await native.produce(phase), result = await c.handle.progress(wire.raw, undefined, currentSignal());
    assert.equal(result.submission, undefined); assert.equal(result.executionAuthorized, false); await c.peer.acknowledge();
  }
  const wire = await native.produce("completed"), bytes = new TextEncoder().encode(qualityText);
  const suppliedBytes = Uint8Array.from(bytes), pending = c.handle.progress(wire.raw, suppliedBytes, currentSignal());
  suppliedBytes.fill(0); // Input is captured before the first authentication await.
  const completed = await pending; await c.peer.acknowledge();
  assert.equal(completed.state, "succeeded"); assert.equal(completed.replayed, false);
  assert.equal(completed.submission!.targetId, bound.receipt.targetId); assert.equal(completed.submission!.qualityAccepted, false);
  assert.equal(completed.submission!.contentHash, wire.body.result!.contentHash);
  const counts = await x.counts(); assert.equal(counts.runs.length, 1); assert.equal(counts.events.length, 3);
  assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.deepEqual(await x.f.config.storage.read(counts.artifacts[0].id as string), bytes);
  const target = await x.admin(() => x.f.reviewStore.snapshot(x.f.scope.tenantId, bound.receipt.targetId));
  assert.equal(target.status, "pending"); assert.equal(target.target.producer.actorId, x.registration.nodeId);
  assert.deepEqual(await x.states(), before);
  assert.ok(x.observed.some(row => row.login === "managed_auth_test" && row.sql.includes("FROM control_node_keys")));
  assert.ok(x.observed.some(row => row.login === "managed_auth_test" && row.sql.includes("INSERT INTO node_protocol_replay")));
  assert.ok(x.observed.some(row => row.login === "managed_evidence_test" && row.sql.includes("INSERT INTO control_harness_runs")));
  assert.ok(x.observed.some(row => row.login === "managed_evidence_test" && row.sql.includes("INSERT INTO control_native_artifact_receipts")));
  assert.ok(x.observed.some(row => row.login === "managed_result_test" && row.sql.includes("INSERT INTO control_native_review_plans")));
  // Receiver replay needs a fresh authenticated envelope, not a replayed protocol message.
  const previous = signedNodeFrameSchema.parse(JSON.parse(wire.raw)); assert.equal(previous.type, "harness.native.snapshot");
  const { signature, bodyDigest, ...unsigned } = previous; void signature; void bodyDigest;
  const replayFrame = signNodeFrame({ ...unsigned, sequence: c.peer.journal.nextOutboundSequence(previous.connectionId),
    messageId: "message:managed-result-replay", nonce: "managed_result_replay_12345678901234567890" }, x.f.keys.privateKey);
  const now = new Date(x.f.clock()).toISOString(), calls = [...x.local.calls];
  assert.equal(c.peer.journal.stageOutbound(replayFrame, true, now), "staged"); c.peer.journal.markSent(replayFrame.messageId, now);
  const replay = await c.handle.progress(JSON.stringify(replayFrame), bytes, currentSignal()); await c.peer.acknowledge();
  assert.equal(replay.replayed, true); assert.deepEqual(replay.submission, completed.submission);
  assert.deepEqual(await x.counts(), counts); assert.deepEqual(x.local.calls, calls); assert.deepEqual(await x.states(), before);
});

test("actual session SQL profile rejects canonical, key, evidence, result and replay rewriting privileges", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); await x.verifyAuth();
  for (const sql of ["UPDATE control_nodes SET state='active'", "UPDATE control_node_keys SET state='revoked'",
    "INSERT INTO control_node_keys DEFAULT VALUES", "UPDATE control_jobs SET state='succeeded'",
    "INSERT INTO control_harness_runs DEFAULT VALUES", "INSERT INTO control_artifact_manifests DEFAULT VALUES",
    "INSERT INTO control_native_review_plans DEFAULT VALUES", "INSERT INTO control_completion_gate_records DEFAULT VALUES",
    "INSERT INTO control_outbox DEFAULT VALUES", "DELETE FROM node_protocol_replay",
    "UPDATE node_protocol_replay SET sequence=1", "UPDATE node_protocol_connections SET node_id='node:other'",
    "UPDATE node_protocol_replay SET replay_lock=true"])
    await assert.rejects(x.authDb.query(sql), /permission denied|replay|lock/i);
});

test("session preflight refuses extra privilege and wrong workspace instead of repairing either", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); await x.verifyAuth();
  await assert.rejects(x.verifyAuth({ ...x.checkedScope, workspaceId: "workspace:other" }));
  await x.admin(() => x.f.raw.exec("GRANT SELECT ON control_attempts TO managed_auth_test"));
  await assert.rejects(x.verifyAuth());
});

test("replacement immediately fences retained handle and requires a new real signed handshake", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close);
  const first = await x.attach(); await x.handshake(first); const sent = first.peer.state.sends, before = await x.counts();
  const peer = x.makePeer(), pending = x.manager.attach(x.f.prepared.request.nodeId, peer.transport);
  await assert.rejects(async () => first.handle.reconcile(first.hello, currentSignal()));
  const handle = await pending; assert.equal(first.peer.state.closes, 1); assert.equal(first.peer.state.sends, sent);
  const second = { peer, handle, hello: await peer.open() }; await x.handshake(second);
  assert.notEqual(JSON.parse(first.hello).connectionId, JSON.parse(second.hello).connectionId);
  assert.deepEqual(await x.counts(), before); assert.equal(x.local.calls.includes("start"), false);
  await first.handle.close(); assert.equal(first.peer.state.closes, 1);
  await assert.rejects(x.manager.attach(x.f.prepared.request.nodeId, peer.transport));
});

test("exact protocol hello replay closes the handle without another replay write or automatic resend", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); const c = await x.attach();
  await x.handshake(c); const before = await x.protocol(), sends = c.peer.state.sends;
  await assert.rejects(async () => c.handle.reconcile(c.hello, currentSignal()));
  assert.deepEqual(await x.protocol(), before); assert.equal(c.peer.state.closes, 1); assert.equal(c.peer.state.sends, sends);
  await assert.rejects(async () => c.handle.hello(c.hello, currentSignal()));
});

test("signed wrong node or tenant is rejected before durable replay consumption", async t => {
  for (const patch of [{ actorId: "node:other" }, { tenantId: "tenant:other" }]) await t.test(JSON.stringify(patch), async () => {
    const x = await managedNativeSessionFixture(); try {
      const c = await x.attach(), before = await x.protocol();
      const previous = signedNodeFrameSchema.parse(JSON.parse(c.hello));
      const { signature, bodyDigest, ...unsigned } = previous; void signature; void bodyDigest;
      const raw = JSON.stringify(signNodeFrame({ ...unsigned, ...patch }, x.f.keys.privateKey));
      await assert.rejects(async () => c.handle.hello(raw, currentSignal()));
      assert.deepEqual(await x.protocol(), before); assert.equal(c.peer.state.closes, 1); assert.equal(c.peer.state.sends, 0);
    } finally { await x.close(); }
  });
});

test("caller cancellation after authentication query prevents protocol SQL and closes transport once", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); const c = await x.attach(), before = await x.protocol();
  const abort = new AbortController(); let injected = false;
  x.hooks.afterQuery = (login, sql) => {
    if (!injected && login === "managed_auth_test" && sql.includes("FROM control_node_keys")) { injected = true; abort.abort(); }
  };
  await assert.rejects(async () => c.handle.hello(c.hello, abort.signal));
  assert.equal(injected, true); assert.deepEqual(await x.protocol(), before); assert.equal(c.peer.state.closes, 1);
  assert.equal(c.peer.state.sends, 0); await c.handle.close(); assert.equal(c.peer.state.closes, 1);
});

test("already aborted hello and unhealthy pool never enter authentication or send", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); const c = await x.attach(), before = await x.protocol();
  const abort = new AbortController(); abort.abort(); await assert.rejects(async () => c.handle.hello(c.hello, abort.signal));
  x.setHealthy(false); await assert.rejects(async () => c.handle.hello(c.hello, currentSignal()));
  assert.deepEqual(await x.protocol(), before); assert.equal(c.peer.state.sends, 0);
});

test("failed transport send preserves accepted authentication evidence but disconnects without retry", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); const c = await x.attach(), before = await x.protocol();
  c.peer.state.failSend = true; await assert.rejects(async () => c.handle.hello(c.hello, currentSignal()));
  const after = await x.protocol(); assert.equal(after.connections.length, before.connections.length + 1);
  assert.equal(after.replay.length, before.replay.length + 1); assert.equal(c.peer.state.sends, 1); assert.equal(c.peer.state.closes, 1);
  await assert.rejects(async () => c.handle.hello(c.hello, currentSignal())); assert.equal(c.peer.state.sends, 1);
  assert.equal((await x.counts()).runs.length, 0);
});

test("manager captures supplied settings, signing function and transport methods before caller replacement", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); const c = await x.attach();
  x.settings.nodes[0].nodeId = "node:mutated";
  x.settings.sign = async () => { throw new Error("replaced_signer_must_not_run"); };
  c.peer.transport.send = async () => { throw new Error("replaced_transport_must_not_run"); };
  c.peer.transport.isAvailable = () => false;
  c.peer.transport.close = async () => { throw new Error("replaced_close_must_not_run"); };
  const raw = new TextEncoder().encode(c.hello), handshake = x.handshake(c, raw); raw.fill(0);
  await handshake; assert.ok(c.peer.state.sends > 0);
  await c.handle.close(); assert.equal(c.peer.state.closes, 1);
});

test("owned close invalidates handles and closes each attached transport exactly once", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close);
  const first = await x.attach(); await x.handshake(first); const second = await x.attach(); await x.handshake(second);
  await x.manager.close(); await x.manager.close(); await first.handle.close(); await second.handle.close();
  assert.equal(first.peer.state.closes, 1); assert.equal(second.peer.state.closes, 1); assert.equal(x.manager.isAvailable(), false);
  await assert.rejects(async () => second.handle.hello(second.hello, currentSignal()));
  const other = x.makePeer(); await assert.rejects(async () => x.manager.attach(x.f.prepared.request.nodeId, other.transport));
});

test("wrong task scope through the owned stage handle creates no native run or provider call", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); const c = await x.attach(); await x.handshake(c);
  const before = await x.states();
  await assert.rejects(async () => c.handle.stage(x.f.identity, { ...x.task, projectId: "project:other" }, currentSignal()));
  assert.deepEqual(await x.states(), before); assert.equal((await x.counts()).runs.length, 0);
  assert.equal(x.local.calls.includes("start"), false); assert.equal(c.peer.state.closes, 1);
});
