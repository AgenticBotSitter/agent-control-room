import assert from "node:assert/strict";
import test from "node:test";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";
import { qualityText } from "./helpers/native-quality-completion";
import { signedNodeFrameSchema, type SignedNodeFrame } from "../src/node-protocol/v1";
import type { NativeSessionTransport } from "../src/web/v1/managed-native-sessions";
import type { NativeObservationReporter } from "../src/harness/hermes-native-v1/observation-reporter";

type Fixture = Awaited<ReturnType<typeof managedNativeSessionFixture>>;
type Peer = ReturnType<Fixture["makePeer"]>;
type Input = Awaited<ReturnType<Fixture["manager"]["attachInput"]>>;
type Received = Awaited<ReturnType<Input["receive"]>>;

/** Every signed frame takes the same input.receive entry point, in observed transport order.
 * Parsing here only attaches exact local result bytes; it never selects a server operation. */
async function pump(peer: Peer, input: Input, reporter?: Pick<NativeObservationReporter, "readResult">) {
  const rows: { frame: SignedNodeFrame; received: Received }[] = [];
  for (let turn = 0; turn < 20 && (peer.incoming.length || peer.outgoing.length); turn++) {
    while (peer.outgoing.length) await peer.acknowledge();
    const batch = peer.incoming.splice(0), frames = batch.map(raw => signedNodeFrameSchema.parse(JSON.parse(raw)) as SignedNodeFrame);
    // Deliberately enqueue the whole observed burst without waiting between receive calls.
    const promises = batch.map((raw, index) => {
      const frame = frames[index];
      const bytes = frame.type === "harness.native.snapshot" && frame.body.state === "completed" && frame.body.result
        ? reporter?.readResult(frame.body, currentSignal()) : undefined;
      return input.receive(raw, bytes, currentSignal());
    });
    const received = await Promise.all(promises);
    frames.forEach((frame, index) => rows.push({ frame, received: received[index] }));
  }
  assert.equal(peer.incoming.length + peer.outgoing.length, 0); return rows;
}

async function initialInput() {
  const x = await managedNativeSessionFixture(undefined, { reporting: true });
  try {
    await x.verify(); const peer = x.makePeer();
    const input = await x.manager.attachInput(x.f.prepared.request.nodeId, peer.transport, { mode: "initial", task: x.request });
    const hello = await peer.open(); assert.deepEqual(await input.receive(hello, undefined, currentSignal()), { kind: "hello" });
    await pump(peer, input);
    assert.equal(input.grantsExecutionAuthority, false); assert.equal((await x.counts()).runs.length, 0); assert.equal(x.inputRegistrations(), 0);
    // Explicit privileged canonical queue/approval preparation, not an implicit input-owner effect.
    await x.admin(async () => { await x.f.save(); await x.f.coordinator.enqueueNativeTask(...x.f.args, x.task.packetDigest, currentSignal()); });
    const staged = input.stage(x.f.identity, x.task, currentSignal());
    const transmitted = input.transmit(x.f.identity, x.task, currentSignal());
    await Promise.all([staged, transmitted]);
    assert.equal(peer.outgoing.length, 1);
    const frame = signedNodeFrameSchema.parse(JSON.parse(peer.outgoing[0]));
    assert.equal(frame.type, "harness.native.dispatch");
    await peer.acknowledge();
    const native = await x.prepareNode(peer, frame as SignedNodeFrame<"harness.native.dispatch">); assert.ok(native.reporter);
    const reporter = native.reporter;
    await native.advanceNative("start");
    // Node intake and local fake start have happened, but server run registration has not.
    assert.equal((await x.counts()).runs.length, 0); assert.equal(x.inputRegistrations(), 0);
    assert.deepEqual(peer.incoming.map(raw => signedNodeFrameSchema.parse(JSON.parse(raw)).type),
      ["harness.native.dispatch.receipt", "harness.native.snapshot"]);
    const first = await pump(peer, input, reporter);
    assert.deepEqual(first.map(row => row.received.kind), ["receipt", "progress"]);
    const registration = first[0].received; assert.equal(registration.kind, "receipt");
    if (registration.kind !== "receipt") throw new Error("missing initial automatic registration");
    assert.equal(registration.registration.receipt.runId, x.registration.id); assert.equal(x.inputRegistrations(), 1);
    assert.equal((await x.counts()).runs.length, 1); assert.equal((await x.counts()).events.length, 1);
    return { x, peer, input, hello, native, reporter, registration: registration.registration };
  } catch (error) { await x.close(); throw error; }
}

async function stableExecution(x: Fixture) {
  const canonical = await x.states();
  const rows = await x.admin(async () => {
    const result: Record<string, unknown[]> = {};
    for (const table of ["control_native_task_queue", "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts"])
      result[table] = (await x.f.db.query(`SELECT * FROM ${table} WHERE job_id=$1`, [x.task.jobId])).rows;
    result.transitions = (await x.f.db.query("SELECT * FROM control_transition_events ORDER BY id")).rows;
    result.outbox = (await x.f.db.query("SELECT * FROM control_outbox ORDER BY id")).rows;
    return result;
  });
  return { canonical, rows, calls: [...x.local.calls], registrations: x.inputRegistrations() };
}

async function reconnectInput(x: Fixture, peer: Peer, oldHello: string, reporter: NativeObservationReporter) {
  if (peer.bridge.status().state !== "backing_off") await peer.bridge.disconnected();
  assert.equal(peer.incoming.length, 0); assert.equal(peer.outgoing.length, 0);
  let available = true;
  const transport: NativeSessionTransport = { async send(raw) { peer.outgoing.push(raw); },
    async close() { available = false; }, isAvailable: () => available };
  // Same node bridge and journals. Input ownership alone performs ordered recovery/routing.
  const input = await x.manager.attachInput(x.f.prepared.request.nodeId, transport, { mode: "recover", task: x.request });
  const hello = await peer.open(); assert.notEqual(JSON.parse(hello).connectionId, JSON.parse(oldHello).connectionId);
  await input.receive(hello, undefined, currentSignal());
  const rows = await pump(peer, input, reporter);
  return { input, hello, rows };
}

test("initial input owns hello, queued owner commands and back-to-back receipt/progress registration into pending exact result review", async t => {
  const { x, peer, input, native, reporter, registration } = await initialInput(); t.after(x.close);
  await native.advanceNative("running"); await pump(peer, input, reporter);
  const body = await native.advanceNative("completed"), before = await stableExecution(x);
  const rows = await pump(peer, input, reporter), last = rows.find(row => row.received.kind === "progress"); assert.ok(last);
  assert.equal(last.received.kind, "progress"); if (last.received.kind !== "progress") throw new Error("missing completed progress");
  assert.equal(last.received.result.state, "succeeded"); assert.equal(last.received.result.submission!.targetId, registration.receipt.targetId);
  assert.equal(last.received.result.submission!.qualityAccepted, false); assert.equal(x.inputRegistrations(), 1);
  const counts = await x.counts(); assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1); assert.equal(counts.events.length, 3);
  const bytes = reporter.readResult(body, currentSignal()); assert.equal(new TextDecoder().decode(bytes), qualityText);
  assert.deepEqual(await x.f.config.storage.read(counts.artifacts[0].id as string), bytes);
  assert.deepEqual(await stableExecution(x), before);
  assert.equal((await x.admin(() => x.f.reviewStore.snapshot(x.f.scope.tenantId, registration.receipt.targetId))).status, "pending");
  assert.ok(x.observed.some(row => row.login === "managed_auth_test" && row.sql.includes("INSERT INTO node_protocol_replay")));
  assert.ok(x.observed.some(row => row.login === "managed_evidence_test" && row.sql.includes("INSERT INTO control_harness_runs")));
  assert.ok(x.observed.some(row => row.login === "managed_result_test" && row.sql.includes("INSERT INTO control_native_review_plans")));
});

test("recover input serializes auto-flushed retained-journal snapshot and trailing ACK with no manual recovery or re-registration", async t => {
  const { x, peer, input, hello, native, reporter } = await initialInput(); t.after(x.close);
  await native.advanceNative("running"); await pump(peer, input, reporter);
  await peer.bridge.disconnected(); await input.close();
  const body = await native.advanceNative("completed"), before = await stableExecution(x);
  const journal = peer.journal, runs = x.local.journal, saved = runs.load(x.f.prepared.binding.runId);
  assert.deepEqual(journal.pendingNativeSnapshots(), [body]); assert.equal(peer.incoming.length, 0);
  const next = await reconnectInput(x, peer, hello, reporter);
  assert.deepEqual(next.rows.map(row => row.frame.type), [
    "protocol.ack", "node.reconciliation.report", "harness.native.snapshot", "protocol.ack",
  ]);
  const index = next.rows.findIndex(row => row.frame.type === "harness.native.snapshot"); assert.ok(index >= 0);
  assert.deepEqual(next.rows[index].frame.body, body);
  const progress = next.rows[index].received; assert.equal(progress.kind, "progress");
  if (progress.kind !== "progress") throw new Error("missing recovered progress");
  assert.equal(progress.result.replayed, false); assert.equal(progress.result.submission!.qualityAccepted, false);
  assert.equal(peer.journal, journal); assert.equal(x.local.journal, runs); assert.deepEqual(runs.load(x.f.prepared.binding.runId), saved);
  assert.deepEqual(await stableExecution(x), before); assert.equal(x.inputRegistrations(), 1);
  assert.equal((await x.counts()).artifacts.length, 1); assert.deepEqual(journal.pendingNativeSnapshots(), []);
  const sent = peer.sent.length; assert.equal((await reporter.report(currentSignal())).disposition, "duplicate");
  assert.equal(peer.sent.length, sent); assert.equal(peer.incoming.length, 0);
});

test("lost completed-result ACK is replayed by replacement input from the retained journal without new dispatch or native calls", async t => {
  const { x, peer, input, hello, native, reporter } = await initialInput(); t.after(x.close);
  await native.advanceNative("running"); await pump(peer, input, reporter);
  const body = await native.advanceNative("completed"), raw = peer.incoming.shift(); assert.ok(raw);
  const original = signedNodeFrameSchema.parse(JSON.parse(raw)), before = await stableExecution(x);
  peer.state.failSend = true;
  await assert.rejects(input.receive(raw, reporter.readResult(body, currentSignal()), currentSignal()));
  const committed = await x.counts(); assert.equal(committed.artifacts.length, 1); assert.equal(committed.receipts.length, 1);
  const cp = x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`);
  const next = await reconnectInput(x, peer, hello, reporter);
  assert.deepEqual(next.rows.map(row => row.frame.type), [
    "protocol.ack", "node.reconciliation.report", "harness.native.snapshot", "protocol.ack",
  ]);
  const received = next.rows.find(row => row.received.kind === "progress"); assert.ok(received);
  assert.notEqual(received.frame.connectionId, original.connectionId); assert.notEqual(received.frame.messageId, original.messageId);
  assert.deepEqual(received.frame.body, original.body);
  if (received.received.kind !== "progress") throw new Error("missing replayed progress");
  assert.equal(received.received.result.replayed, true); assert.equal(received.received.result.submission!.qualityAccepted, false);
  assert.deepEqual(await x.counts(), committed); assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`), cp);
  assert.deepEqual(await stableExecution(x), before); assert.equal(x.inputRegistrations(), 1);
  assert.equal(peer.journal.pendingOutbound().filter(row => row.frame.type === "harness.native.snapshot").length, 0);
});
