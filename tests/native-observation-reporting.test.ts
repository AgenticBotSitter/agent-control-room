import assert from "node:assert/strict";
import test from "node:test";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";
import { qualityText } from "./helpers/native-quality-completion";
import { signedNodeFrameSchema } from "../src/node-protocol/v1";
import type { NativeSessionTransport } from "../src/web/v1/managed-native-sessions";
import type { NativeObservationReporter } from "../src/harness/hermes-native-v1/observation-reporter";

type Fixture = Awaited<ReturnType<typeof managedNativeSessionFixture>>;
type Connection = Awaited<ReturnType<Fixture["attach"]>>;

async function reportingFixture() {
  const x = await managedNativeSessionFixture(undefined, { reporting: true });
  try {
    await x.verify(); const connection = await x.attach(); await x.handshake(connection);
    const native = await x.dispatch(connection); assert.ok(native.reporter);
    const reporter = native.reporter, registered = await x.receiver.register(x.request, currentSignal());
    for (const phase of ["start", "running"] as const) {
      const wire = await native.produce(phase);
      // Opt-in produce does not explicitly publish: this frame came from handoff reporting.
      assert.equal(signedNodeFrameSchema.parse(JSON.parse(wire.raw)).type, "harness.native.snapshot");
      await connection.handle.progress(wire.raw, undefined, currentSignal()); await connection.peer.acknowledge();
    }
    return { x, connection, native, reporter, registered };
  } catch (error) { await x.close(); throw error; }
}

async function unchangedExecution(x: Fixture) {
  const canonical = await x.states();
  const deliveries = await x.admin(async () => {
    const rows: Record<string, unknown[]> = {};
    for (const table of ["control_native_task_queue", "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts"])
      rows[table] = (await x.f.db.query(`SELECT * FROM ${table} WHERE job_id=$1`, [x.task.jobId])).rows;
    rows.outbox = (await x.f.db.query("SELECT * FROM control_outbox ORDER BY id")).rows;
    rows.transitions = (await x.f.db.query("SELECT * FROM control_transition_events ORDER BY id")).rows;
    return rows;
  });
  return { canonical, deliveries, calls: [...x.local.calls] };
}

/** Same node bridge, delivery journal and native-run journal; only transport and server handle
 * are replaced. From the first auto-flushed snapshot onward, hold the FULL wire suffix until
 * recovery: routing a later ACK ahead of that snapshot would violate protocol sequence order. */
async function reconnectSameNode(x: Fixture, old: Connection) {
  const peer = old.peer, journal = peer.journal, runs = x.local.journal;
  if (peer.bridge.status().state !== "backing_off") await peer.bridge.disconnected();
  assert.equal(peer.incoming.length, 0); assert.equal(peer.outgoing.length, 0);
  const state = { available: true, closes: 0, sends: 0 };
  const transport: NativeSessionTransport = {
    async send(raw) { state.sends++; peer.outgoing.push(raw); },
    async close() { state.closes++; state.available = false; },
    isAvailable: () => state.available,
  };
  const handle = await x.manager.attach(x.f.prepared.request.nodeId, transport), hello = await peer.open();
  assert.notEqual(JSON.parse(hello).connectionId, JSON.parse(old.hello).connectionId);
  await handle.hello(hello, currentSignal());
  const pending: string[] = [];
  for (let count = 0; count < 20 && (peer.outgoing.length || peer.incoming.length); count++) {
    while (peer.outgoing.length) await peer.acknowledge();
    while (peer.incoming.length) {
      const raw = peer.incoming.shift()!, frame = signedNodeFrameSchema.parse(JSON.parse(raw));
      if (pending.length || frame.type === "harness.native.snapshot") pending.push(raw);
      else await handle.reconcile(raw, currentSignal());
    }
  }
  assert.equal(peer.incoming.length + peer.outgoing.length, 0);
  const sends = state.sends;
  assert.deepEqual(await handle.recover(x.request, currentSignal()), { recovered: true, grantsExecutionAuthority: false });
  assert.equal(state.sends, sends); assert.equal(peer.journal, journal); assert.equal(x.local.journal, runs);
  return { peer, handle, hello, pending, state };
}

async function drainRecovered(next: Awaited<ReturnType<typeof reconnectSameNode>>, reporter: Pick<NativeObservationReporter, "readResult">) {
  const results: Awaited<ReturnType<Connection["handle"]["progress"]>>[] = [];
  while (next.pending.length) {
    const raw = next.pending.shift()!, frame = signedNodeFrameSchema.parse(JSON.parse(raw));
    if (frame.type === "harness.native.snapshot") {
      const bytes = frame.body.state === "completed" && frame.body.result ? reporter.readResult(frame.body, currentSignal()) : undefined;
      results.push(await next.handle.progress(raw, bytes, currentSignal())); await next.peer.acknowledge();
    } else {
      assert.equal(frame.type, "protocol.ack"); await next.handle.reconcile(raw, currentSignal());
    }
    // Frames emitted while consuming a server ACK follow the already-held suffix, never precede it.
    while (next.peer.incoming.length) next.pending.push(next.peer.incoming.shift()!);
  }
  assert.equal(next.peer.outgoing.length, 0); return results;
}

test("opt-in native handoff reports saved start/poll observations and exact reporter result bytes reach pending review", async t => {
  const { x, connection, native, reporter, registered } = await reportingFixture(); t.after(x.close);
  const wire = await native.produce("completed"), before = await unchangedExecution(x);
  const bytes = reporter.readResult(wire.body, currentSignal()); assert.equal(new TextDecoder().decode(bytes), qualityText);
  assert.equal(wire.raw.includes(qualityText), false);
  const result = await connection.handle.progress(wire.raw, bytes, currentSignal()); await connection.peer.acknowledge();
  assert.equal(result.submission!.targetId, registered.receipt.targetId); assert.equal(result.submission!.qualityAccepted, false);
  const counts = await x.counts(); assert.equal(counts.events.length, 3); assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.deepEqual(await x.f.config.storage.read(counts.artifacts[0].id as string), bytes);
  const sent = connection.peer.sent.length, cp = x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`);
  const repeated = await reporter.report(currentSignal());
  assert.equal(repeated.disposition, "duplicate"); assert.equal(repeated.serverAccepted, false); assert.equal(repeated.grantsExecutionAuthority, false);
  assert.equal(connection.peer.sent.length, sent); assert.equal(connection.peer.incoming.length, 0);
  assert.deepEqual(await x.counts(), counts); assert.deepEqual(await unchangedExecution(x), before);
  assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`), cp);
  assert.equal((await x.admin(() => x.f.reviewStore.snapshot(x.f.scope.tenantId, registered.receipt.targetId))).status, "pending");
});

test("offline reporter keeps pending completed evidence and the same journals auto-flush it after signed replacement and recovery", async t => {
  const { x, connection, native, reporter } = await reportingFixture(); t.after(x.close);
  await connection.peer.bridge.disconnected(); await connection.handle.close();
  const body = await native.advanceNative("completed");
  // The authorized fake poll completed while offline; from this baseline onward there are
  // no start/poll/observe/stop calls. report/reconnect only load those saved native records.
  const before = await unchangedExecution(x), nodeSnapshot = x.local.journal.load(x.f.prepared.binding.runId);
  const delivery = connection.peer.journal.acceptedNativeDelivery(native.handoff.queueId);
  assert.deepEqual(connection.peer.journal.pendingNativeSnapshots(), [body]); assert.equal(connection.peer.incoming.length, 0);
  const reported = await reporter.report(currentSignal()); assert.equal(reported.disposition, "duplicate"); assert.equal(reported.serverAccepted, false);
  assert.deepEqual(connection.peer.journal.pendingNativeSnapshots(), [body]);
  const next = await reconnectSameNode(x, connection);
  const snapshots = next.pending.filter(raw => signedNodeFrameSchema.parse(JSON.parse(raw)).type === "harness.native.snapshot");
  assert.equal(snapshots.length, 1);
  const raw = snapshots[0], frame = signedNodeFrameSchema.parse(JSON.parse(raw));
  assert.equal(frame.type, "harness.native.snapshot"); assert.deepEqual(frame.body, body);
  assert.equal(frame.connectionId, JSON.parse(next.hello).connectionId);
  const bytes = reporter.readResult(body, currentSignal());
  const results = await drainRecovered(next, reporter); assert.equal(results.length, 1); const result = results[0];
  assert.equal(result.replayed, false); assert.equal(result.submission!.qualityAccepted, false);
  assert.deepEqual(connection.peer.journal.pendingNativeSnapshots(), []);
  assert.deepEqual(x.local.journal.load(x.f.prepared.binding.runId), nodeSnapshot);
  assert.deepEqual(connection.peer.journal.acceptedNativeDelivery(native.handoff.queueId), delivery);
  assert.deepEqual(await unchangedExecution(x), before);
  const counts = await x.counts(); assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.deepEqual(await x.f.config.storage.read(counts.artifacts[0].id as string), bytes);
  const sends = next.peer.sent.length; assert.equal((await reporter.report(currentSignal())).disposition, "duplicate");
  assert.equal(next.peer.sent.length, sends); assert.equal(next.peer.incoming.length, 0);
});

test("lost server ACK requeues the same staged native snapshot on replacement without another provider operation", async t => {
  const { x, connection, native, reporter } = await reportingFixture(); t.after(x.close);
  const wire = await native.produce("completed"), originalFrame = signedNodeFrameSchema.parse(JSON.parse(wire.raw));
  const bytes = reporter.readResult(wire.body, currentSignal()), before = await unchangedExecution(x);
  connection.peer.state.failSend = true;
  await assert.rejects(async () => connection.handle.progress(wire.raw, bytes, currentSignal()));
  assert.equal(connection.peer.state.closes, 1); assert.equal(connection.peer.outgoing.length, 0);
  const staged = connection.peer.journal.pendingOutbound().filter(row => row.frame.type === "harness.native.snapshot");
  assert.equal(staged.length, 1); assert.equal(staged[0].frame.messageId, originalFrame.messageId); assert.equal(staged[0].status, "sent");
  assert.deepEqual(connection.peer.journal.pendingNativeSnapshots(), []);
  const committed = await x.counts(), cp = x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`);
  assert.equal(committed.artifacts.length, 1); assert.equal(committed.receipts.length, 1);
  const next = await reconnectSameNode(x, connection);
  const snapshots = next.pending.filter(raw => signedNodeFrameSchema.parse(JSON.parse(raw)).type === "harness.native.snapshot");
  assert.equal(snapshots.length, 1);
  const raw = snapshots[0], fresh = signedNodeFrameSchema.parse(JSON.parse(raw));
  assert.notEqual(fresh.connectionId, originalFrame.connectionId); assert.notEqual(fresh.messageId, originalFrame.messageId);
  assert.deepEqual(fresh.body, originalFrame.body);
  const results = await drainRecovered(next, reporter); assert.equal(results.length, 1); const replay = results[0];
  assert.equal(replay.replayed, true); assert.equal(replay.submission!.qualityAccepted, false);
  assert.deepEqual(await x.counts(), committed); assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.f.scope.tenantId}`), cp);
  assert.deepEqual(await unchangedExecution(x), before);
  assert.equal(next.peer.journal.pendingOutbound().filter(row => row.frame.type === "harness.native.snapshot").length, 0);
  const sent = next.peer.sent.length; assert.equal((await reporter.report(currentSignal())).disposition, "duplicate");
  assert.equal(next.peer.sent.length, sent);
});

test("an acknowledged saved snapshot stays deduplicated across a same-journal reconnect", async t => {
  const { x, connection, native, reporter } = await reportingFixture(); t.after(x.close);
  const wire = await native.produce("completed");
  await connection.handle.progress(wire.raw, reporter.readResult(wire.body, currentSignal()), currentSignal()); await connection.peer.acknowledge();
  const before = await unchangedExecution(x), counts = await x.counts();
  const next = await reconnectSameNode(x, connection); assert.deepEqual(next.pending, []);
  const sent = next.peer.sent.length, repeated = await reporter.report(currentSignal());
  assert.equal(repeated.disposition, "duplicate"); assert.equal(repeated.serverAccepted, false);
  assert.equal(next.peer.sent.length, sent); assert.equal(next.peer.incoming.length, 0);
  assert.deepEqual(await x.counts(), counts); assert.deepEqual(await unchangedExecution(x), before);
});
