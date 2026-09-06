import assert from "node:assert/strict";
import test from "node:test";
import { nativeWireFixture } from "./helpers/native-wire";
import { currentSignal } from "./helpers/managed-native-session";
import { qualityText } from "./helpers/native-quality-completion";
import { signedNodeFrameSchema } from "../src/node-protocol/v1";

type Fixture = Awaited<ReturnType<typeof nativeWireFixture>>;
// Inspection for assertions/fault construction only: never used by the opaque transport pump.
function inspect(packet: string) {
  const value = JSON.parse(packet) as { schema: string; raw: string; result: string | null };
  assert.equal(value.schema, "control-room.native-wire/v1");
  return { ...value, frame: signedNodeFrameSchema.parse(JSON.parse(value.raw)) };
}

async function stable(x: Fixture) {
  const { f } = x, canonical = await f.x.states();
  const rows = await f.x.admin(async () => {
    const value: Record<string, unknown[]> = {};
    for (const table of ["control_native_task_queue", "control_native_delivery_envelopes",
      "control_native_transmission_intents", "control_native_delivery_receipts"])
      value[table] = (await f.x.f.db.query(`SELECT * FROM ${table} WHERE job_id=$1`, [f.x.task.jobId])).rows;
    value.transitions = (await f.x.f.db.query("SELECT * FROM control_transition_events ORDER BY id")).rows;
    value.outbox = (await f.x.f.db.query("SELECT * FROM control_outbox ORDER BY id")).rows;
    return value;
  });
  return { canonical, rows, calls: [...f.x.local.calls], registrations: f.x.inputRegistrations() };
}

async function pendingReview(x: Fixture) {
  const { f } = x, counts = await f.x.counts();
  assert.equal(counts.runs.length, 1); assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.deepEqual(await f.x.f.config.storage.read(counts.artifacts[0].id as string), new TextEncoder().encode(qualityText));
  const targetId = await f.x.admin(async () => {
    const result = await f.x.f.db.query<{ plan: { targetId: string } }>(
      "SELECT plan FROM control_native_review_plans WHERE run_id=$1", [f.x.registration.id]);
    assert.equal(result.rows.length, 1); return result.rows[0].plan.targetId;
  });
  assert.equal((await f.x.admin(() => f.x.f.reviewStore.snapshot(f.x.f.scope.tenantId, targetId))).status, "pending");
  return counts;
}

async function started(x: Fixture) {
  await x.f.x.verify(); const { connection } = await x.connect();
  assert.deepEqual(x.f.x.local.calls, []);
  const registration = await x.dispatch(connection);
  assert.equal(registration[0].kind, "receipt");
  assert.deepEqual(x.f.x.local.calls, []); assert.equal(x.f.x.inputRegistrations(), 1);
  assert.equal((await x.f.x.counts()).events.length, 0);
  // Only this explicit runtime action enters the synthetic provider.
  assert.equal((await x.f.x.admin(() => x.f.runtime.start(currentSignal()))).state, "queued");
  await x.pump(connection); return connection;
}

async function completeLocally(x: Fixture) {
  x.f.advance(); x.f.setResult(qualityText);
  assert.equal((await x.f.x.admin(() => x.f.runtime.poll(currentSignal()))).state, "completed");
}

test("opaque wire carries real signed intake and exact completed bytes into pending review only after explicit native start", async t => {
  const x = await nativeWireFixture(); t.after(x.close); const connection = await started(x);
  const calls = [...x.f.x.local.calls];
  await x.f.x.admin(() => x.f.runtime.start(currentSignal())); await x.pump(connection);
  assert.deepEqual(x.f.x.local.calls, calls);
  await completeLocally(x); const before = await stable(x);
  assert.equal(connection.incoming.length, 1);
  const sent = inspect(connection.incoming[0]); assert.equal(sent.frame.type, "harness.native.snapshot");
  assert.equal(sent.result, Buffer.from(qualityText).toString("base64"));
  const received = await x.pump(connection); assert.equal(received.length, 1); assert.equal(received[0].kind, "progress");
  if (received[0].kind !== "progress") throw new Error("missing completed progress");
  assert.equal(received[0].result.submission!.qualityAccepted, false);
  const counts = await pendingReview(x); assert.equal(counts.events.length, 2);
  assert.deepEqual(await stable(x), before); assert.deepEqual(x.f.x.local.calls, ["capabilities", "start", "status"]);
  assert.equal(connection.serverSent.map(inspect).filter(packet => packet.frame.type === "harness.native.dispatch").length, 1);
  assert.ok(x.f.x.observed.some(row => row.login === "managed_auth_test" && row.sql.includes("INSERT INTO node_protocol_replay")));
  assert.ok(x.f.x.observed.some(row => row.login === "managed_evidence_test" && row.sql.includes("INSERT INTO control_harness_runs")));
  assert.ok(x.f.x.observed.some(row => row.login === "managed_result_test" && row.sql.includes("INSERT INTO control_native_review_plans")));
});

test("lost opaque completed packet reconnects the same runtime journals with exact saved bytes and no new native request or dispatch", async t => {
  const x = await nativeWireFixture(); t.after(x.close); const first = await started(x);
  await completeLocally(x); assert.equal(first.incoming.length, 1);
  const lost = first.incoming.shift(); assert.ok(lost); const original = inspect(lost);
  const before = await stable(x), saved = x.f.x.local.journal.load(x.f.x.registration.id);
  const delivery = x.f.journal.acceptedNativeDelivery(x.f.config.queueId);
  assert.equal((await x.f.x.counts()).artifacts.length, 0);
  await x.f.runtime.disconnected(currentSignal()); await first.server.close();
  const { connection: next, received } = await x.connect("recover");
  const emitted = next.nodeSent.map(inspect);
  assert.deepEqual(emitted.map(packet => packet.frame.type), ["connection.hello", "protocol.ack", "node.reconciliation.report",
    "harness.native.snapshot", "protocol.ack"]);
  assert.deepEqual(emitted[3].frame.body, original.frame.body); assert.equal(emitted[3].result, original.result);
  assert.notEqual(emitted[3].frame.connectionId, original.frame.connectionId);
  assert.notEqual(emitted[3].frame.messageId, original.frame.messageId);
  assert.equal(next.serverSent.map(inspect).some(packet => packet.frame.type === "harness.native.dispatch"), false);
  const progress = received.find(value => value.kind === "progress"); assert.ok(progress);
  if (progress.kind !== "progress") throw new Error("missing recovered progress");
  assert.equal(progress.result.replayed, false);
  await pendingReview(x); assert.deepEqual(await stable(x), before);
  assert.deepEqual(x.f.x.local.journal.load(x.f.x.registration.id), saved);
  assert.deepEqual(x.f.journal.acceptedNativeDelivery(x.f.config.queueId), delivery);
});

test("lost result ACK survives runtime replacement over retained journals and replays one canonical result through opaque wire", async t => {
  const x = await nativeWireFixture(); t.after(x.close); const first = await started(x);
  await completeLocally(x); assert.equal(first.incoming.length, 1);
  const packet = first.incoming.shift(); assert.ok(packet);
  // Deliver one opaque packet, but deliberately withhold the queued server ACK.
  const received = await first.server.receive(packet, currentSignal()); assert.equal(received.kind, "progress");
  assert.equal(first.outgoing.length, 1);
  const original = inspect(packet), committed = await pendingReview(x), before = await stable(x);
  const checkpoint = x.f.x.f.checkpoints.read(`completion-gate:${x.f.x.f.scope.tenantId}`);
  const saved = x.f.x.local.journal.load(x.f.x.registration.id), delivery = x.f.journal.acceptedNativeDelivery(x.f.config.queueId);
  await x.f.runtime.close(); await first.server.close();
  const replacement = x.f.create();
  assert.equal((await replacement.report(currentSignal())).disposition, "duplicate");
  const { connection: next, received: replayed } = await x.connect("recover", replacement);
  const emitted = next.nodeSent.map(inspect);
  assert.deepEqual(emitted.map(value => value.frame.type), ["connection.hello", "protocol.ack", "node.reconciliation.report",
    "harness.native.snapshot", "protocol.ack"]);
  assert.deepEqual(emitted[3].frame.body, original.frame.body); assert.equal(emitted[3].result, original.result);
  assert.notEqual(emitted[3].frame.connectionId, original.frame.connectionId);
  assert.notEqual(emitted[3].frame.messageId, original.frame.messageId);
  const progress = replayed.find(value => value.kind === "progress"); assert.ok(progress);
  if (progress.kind !== "progress") throw new Error("missing replay");
  assert.equal(progress.result.replayed, true); assert.equal(progress.result.submission!.qualityAccepted, false);
  assert.equal(next.serverSent.map(inspect).some(value => value.frame.type === "harness.native.dispatch"), false);
  assert.deepEqual(await pendingReview(x), committed); assert.deepEqual(await stable(x), before);
  assert.deepEqual(x.f.x.f.checkpoints.read(`completion-gate:${x.f.x.f.scope.tenantId}`), checkpoint);
  assert.deepEqual(x.f.x.local.journal.load(x.f.x.registration.id), saved);
  assert.deepEqual(x.f.journal.acceptedNativeDelivery(x.f.config.queueId), delivery);
  const sent = next.nodeSent.length;
  assert.equal((await replacement.report(currentSignal())).disposition, "duplicate");
  await x.pump(next); assert.equal(next.nodeSent.length, sent); assert.deepEqual(await stable(x), before);
});

for (const fault of ["missing", "tampered"] as const) test(`${fault} completed wire bytes close the actual server connection without evidence, result or ACK writes`, async t => {
  const x = await nativeWireFixture(); t.after(x.close); const connection = await started(x);
  await completeLocally(x); assert.equal(connection.incoming.length, 1);
  const original = connection.incoming.shift(); assert.ok(original);
  const packet = JSON.parse(original) as { schema: string; raw: string; result: string | null };
  assert.equal(packet.result, Buffer.from(qualityText).toString("base64"));
  if (fault === "missing") packet.result = null;
  else {
    const bytes = Buffer.from(packet.result!, "base64"); bytes[0] ^= 1; packet.result = bytes.toString("base64");
  }
  const counts = await x.f.x.counts(), before = await stable(x), protocol = await x.f.x.protocol();
  const checkpoint = x.f.x.f.checkpoints.read(`completion-gate:${x.f.x.f.scope.tenantId}`), sent = connection.serverSent.length;
  await assert.rejects(connection.server.receive(JSON.stringify(packet), currentSignal()), { message: "native_input_uncertain" });
  assert.equal(connection.state.serverCloses, 1); assert.equal(connection.state.available, false);
  assert.equal(connection.serverSent.length, sent); assert.equal(connection.outgoing.length, 0);
  assert.deepEqual(await x.f.x.counts(), counts); assert.equal(counts.artifacts.length, 0);
  assert.deepEqual(await stable(x), before); assert.deepEqual(await x.f.x.protocol(), protocol);
  assert.deepEqual(x.f.x.f.checkpoints.read(`completion-gate:${x.f.x.f.scope.tenantId}`), checkpoint);
  await assert.rejects(connection.server.receive(original, currentSignal()));
  assert.equal(connection.state.serverCloses, 1); assert.deepEqual(await x.f.x.counts(), counts);
});
