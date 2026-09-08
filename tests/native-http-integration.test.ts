import assert from "node:assert/strict";
import test from "node:test";
import { nativeHttpFixture } from "./helpers/native-http";
import { currentSignal } from "./helpers/managed-native-session";
import { qualityText } from "./helpers/native-quality-completion";
import { signedNodeFrameSchema } from "../src/node-protocol/v1";

type Fixture = Awaited<ReturnType<typeof nativeHttpFixture>>;

async function stable(x: Fixture) {
  const { f } = x, canonical = await f.x.states();
  // Disposable administrative observer only. Actual server auth/evidence/result writes
  // are still made by the shared fixture's separately restricted database identities.
  const rows = await f.x.admin(async () => {
    const records: Record<string, unknown[]> = {};
    for (const table of ["control_native_task_queue", "control_native_delivery_envelopes",
      "control_native_transmission_intents", "control_native_delivery_receipts"])
      records[table] = (await f.x.f.db.query(`SELECT * FROM ${table} WHERE job_id=$1`, [f.x.task.jobId])).rows;
    records.transitions = (await f.x.f.db.query("SELECT * FROM control_transition_events ORDER BY id")).rows;
    records.outbox = (await f.x.f.db.query("SELECT * FROM control_outbox ORDER BY id")).rows;
    return records;
  });
  return { canonical, rows, calls: [...f.x.local.calls], registrations: f.x.inputRegistrations() };
}

async function pendingReview(x: Fixture) {
  const { f } = x, counts = await f.x.counts();
  assert.equal(counts.runs.length, 1); assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.deepEqual(await f.x.f.config.storage.read(counts.artifacts[0].id as string), new TextEncoder().encode(qualityText));
  const targetId = await f.x.admin(async () => {
    const rows = await f.x.f.db.query<{ plan: { targetId: string } }>(
      "SELECT plan FROM control_native_review_plans WHERE run_id=$1", [f.x.registration.id]);
    assert.equal(rows.rows.length, 1); return rows.rows[0].plan.targetId;
  });
  assert.equal((await f.x.admin(() => f.x.f.reviewStore.snapshot(f.x.f.scope.tenantId, targetId))).status, "pending");
  return counts;
}

async function started(x: Fixture) {
  await x.f.x.verify(); const client = x.create();
  await x.f.x.admin(() => client.host.open("initial", currentSignal()));
  assert.equal(client.host.isReady(), true); assert.deepEqual(x.f.x.local.calls, []);
  assert.equal((await x.f.x.counts()).runs.length, 0);
  await x.server.stage(x.f.config.enrollment.nodeId, x.f.x.f.identity, x.f.x.task, currentSignal());
  await x.server.transmit(x.f.config.enrollment.nodeId, x.f.x.f.identity, x.f.x.task, currentSignal());
  // Idle HTTP exchange retrieves staged work; neither staging nor exchange starts a provider.
  await x.f.x.admin(() => client.host.step(currentSignal()));
  assert.equal(x.f.x.inputRegistrations(), 1); assert.deepEqual(x.f.x.local.calls, []);
  assert.equal((await x.f.x.counts()).events.length, 0);
  assert.equal((await x.f.x.admin(() => client.node.start(currentSignal()))).state, "queued");
  await x.f.x.admin(() => client.host.step(currentSignal()));
  assert.deepEqual(x.f.x.local.calls, ["capabilities", "start"]); return client;
}

async function completeLocally(x: Fixture) {
  x.f.advance(); x.f.setResult(qualityText);
  assert.equal((await x.f.x.admin(() => x.f.runtime.poll(currentSignal()))).state, "completed");
}

// Assertion-only inspection; the HTTP exchange fixture never selects a packet's operation.
function inspectedPackets(commands: ReturnType<Fixture["create"]>["commands"]) {
  return commands.flatMap(command => command.operation === "exchange" && command.packet !== null
    ? [signedNodeFrameSchema.parse(JSON.parse((JSON.parse(command.packet) as { raw: string }).raw))] : []);
}

test("actual HTTP host exchange performs signed intake and delivers exact completed bytes into pending review only after explicit native start", async t => {
  const x = await nativeHttpFixture(); t.after(x.close); const client = await started(x);
  const calls = [...x.f.x.local.calls];
  await x.f.x.admin(() => client.node.start(currentSignal()));
  await x.f.x.admin(() => client.host.step(currentSignal())); assert.deepEqual(x.f.x.local.calls, calls);
  await completeLocally(x); const before = await stable(x);
  await x.f.x.admin(() => client.host.step(currentSignal()));
  assert.equal((await pendingReview(x)).events.length, 2); assert.deepEqual(await stable(x), before);
  assert.deepEqual(x.f.x.local.calls, ["capabilities", "start", "status"]);
  assert.equal(inspectedPackets(client.commands).filter(frame => frame.type === "harness.native.dispatch.receipt").length, 1);
  assert.equal(client.commands.filter(command => command.operation === "open").length, 1);
  assert.ok(client.responses.every(response => response.status === 200));
  assert.ok(x.f.x.observed.some(row => row.login === "managed_auth_test" && row.sql.includes("INSERT INTO node_protocol_replay")));
  assert.ok(x.f.x.observed.some(row => row.login === "managed_evidence_test" && row.sql.includes("INSERT INTO control_harness_runs")));
  assert.ok(x.f.x.observed.some(row => row.login === "managed_result_test" && row.sql.includes("INSERT INTO control_native_review_plans")));
});

test("canonical queue delivery through the HTTP session registers its receipt and reaches pending review", async t => {
  const x = await nativeHttpFixture(undefined, { queue: true }); t.after(x.close);
  const { f } = x, client = x.create(); await f.x.verify();
  await f.x.admin(() => client.host.open("initial", currentSignal()));
  const queued = f.queued;
  const ref = { schema: "control-room.native-task-submission/v1" as const, tenantId: f.x.f.scope.tenantId,
    projectId: queued.projectId, jobId: queued.jobId, attemptId: queued.attemptId, queueId: queued.queueId,
    packetDigest: queued.packetDigest, inputDigest: f.x.task.inputDigest };
  const delivered = await f.x.manager.deliverApproved(ref, currentSignal());
  assert.equal(delivered.deliveryConfirmed, false);
  await f.x.admin(() => client.host.step(currentSignal()));
  assert.equal(f.x.inputRegistrations(), 1); assert.deepEqual(f.x.local.calls, []);
  await f.x.admin(() => client.node.start(currentSignal()));
  await f.x.admin(() => client.host.step(currentSignal()));
  await completeLocally(x); await f.x.admin(() => client.host.step(currentSignal()));
  await pendingReview(x);
  assert.deepEqual(f.x.local.calls, ["capabilities", "start", "status"]);
  assert.equal(inspectedPackets(client.commands).filter(frame => frame.type === "harness.native.dispatch.receipt").length, 1);
});

test("HTTP generation replacement after queue staging prevents transmission and cannot target the new session", async t => {
  const x = await nativeHttpFixture(undefined, { queue: true }); t.after(x.close);
  const { f } = x, client = x.create(); await f.x.verify();
  await f.x.admin(() => client.host.open("initial", currentSignal()));
  const queued = f.queued;
  const ref = { schema: "control-room.native-task-submission/v1" as const, tenantId: f.x.f.scope.tenantId,
    projectId: queued.projectId, jobId: queued.jobId, attemptId: queued.attemptId, queueId: queued.queueId,
    packetDigest: queued.packetDigest, inputDigest: f.x.task.inputDigest };
  let stages = 0, transmissions = 0;
  f.x.hooks.beforeQueueStage = () => { stages++; };
  f.x.hooks.beforeQueueTransmit = () => { transmissions++; };
  f.x.hooks.afterQueueStage = async () => {
    const replacement = await x.request({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" });
    assert.equal(replacement.status, 200);
    assert.notEqual((await replacement.json()).connection, client.connection());
  };
  await assert.rejects(f.x.manager.deliverApproved(ref, currentSignal()));
  assert.equal(stages, 1); assert.equal(transmissions, 0);
  assert.equal(f.x.inputRegistrations(), 0); assert.deepEqual(f.x.local.calls, []);
  assert.equal((await f.x.admin(() => f.x.f.db.query("SELECT 1 FROM control_native_transmission_intents"))).rows.length, 0);
});

test("lost HTTP response after result commit does not retry and explicit replacement recovers exact saved journals once", async t => {
  const x = await nativeHttpFixture(); t.after(x.close); const original = await started(x);
  await completeLocally(x); const before = await stable(x), requests = original.commands.length;
  const delivery = x.f.journal.acceptedNativeDelivery(x.f.config.queueId), saved = x.f.x.local.journal.load(x.f.x.registration.id);
  original.loseResponse();
  await assert.rejects(x.f.x.admin(() => original.host.step(currentSignal())), { message: "native_http_node_unavailable" });
  await original.host.close();
  assert.equal(original.commands.length, requests + 1); assert.equal(original.closes(), 1); assert.equal(original.host.isReady(), false);
  const committed = await pendingReview(x), checkpoint = x.f.x.f.checkpoints.read(`completion-gate:${x.f.x.f.scope.tenantId}`);
  assert.deepEqual(await stable(x), before);
  await assert.rejects(original.host.step(currentSignal())); assert.equal(original.commands.length, requests + 1);
  await x.f.runtime.close(); const node = x.f.create(), replacement = x.create(node);
  await x.f.x.admin(() => replacement.host.open("recover", currentSignal()));
  assert.notEqual(replacement.connection(), original.connection()); assert.equal(replacement.host.isReady(), true);
  const emitted = inspectedPackets(replacement.commands);
  assert.deepEqual(emitted.map(frame => frame.type), ["connection.hello", "protocol.ack", "node.reconciliation.report",
    "harness.native.snapshot", "protocol.ack"]);
  assert.equal(replacement.commands[0].operation, "open");
  assert.equal((replacement.commands[0] as { mode: string }).mode, "recover");
  assert.deepEqual(await pendingReview(x), committed); assert.deepEqual(await stable(x), before);
  assert.deepEqual(x.f.x.f.checkpoints.read(`completion-gate:${x.f.x.f.scope.tenantId}`), checkpoint);
  assert.deepEqual(x.f.journal.acceptedNativeDelivery(x.f.config.queueId), delivery);
  assert.deepEqual(x.f.x.local.journal.load(x.f.x.registration.id), saved);
  assert.equal(original.commands.length, requests + 1);
});

test("stale HTTP generation and unknown TLS peer cannot close or write through the current recovered connection", async t => {
  const x = await nativeHttpFixture(); t.after(x.close); const original = await started(x), stale = original.connection();
  await original.host.close(); const replacement = x.create();
  await x.f.x.admin(() => replacement.host.open("recover", currentSignal()));
  const current = replacement.connection(); assert.notEqual(current, stale);
  const before = await stable(x), counts = await x.f.x.counts(), protocol = await x.f.x.protocol();
  const staleClose = await x.request({ schema: "control-room.native-http/v1", operation: "close", connection: stale });
  assert.equal(staleClose.status, 503); assert.deepEqual(await staleClose.json(), { error: "native_http_unavailable" });
  const foreign = await x.request({ schema: "control-room.native-http/v1", operation: "close", connection: current },
    currentSignal(), x.socket(Buffer.from("synthetic-unrecognized-peer")));
  assert.equal(foreign.status, 503);
  assert.deepEqual(await stable(x), before); assert.deepEqual(await x.f.x.counts(), counts); assert.deepEqual(await x.f.x.protocol(), protocol);
  await x.f.x.admin(() => replacement.host.step(currentSignal()));
  assert.equal(replacement.host.isReady(), true); assert.equal(replacement.closes(), 0);
  assert.deepEqual(await stable(x), before); assert.deepEqual(await x.f.x.counts(), counts);
});

test("already cancelled node-host open never exchanges HTTP or replaces an existing managed generation", async t => {
  const x = await nativeHttpFixture(); t.after(x.close); const original = await started(x);
  const candidate = x.create(), abort = new AbortController(); abort.abort();
  const before = await stable(x), protocol = await x.f.x.protocol(), counts = await x.f.x.counts();
  await assert.rejects(candidate.host.open("recover", abort.signal), { message: "native_http_node_unavailable" });
  assert.deepEqual(candidate.commands, []); assert.equal(candidate.closes(), 0);
  assert.deepEqual(await stable(x), before); assert.deepEqual(await x.f.x.protocol(), protocol); assert.deepEqual(await x.f.x.counts(), counts);
  await x.f.x.admin(() => original.host.step(currentSignal())); assert.equal(original.host.isReady(), true);
  assert.deepEqual(await stable(x), before);
});
