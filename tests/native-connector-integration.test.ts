import assert from "node:assert/strict";
import test from "node:test";
import { createNativeConnector } from "../src/node-bridge/native-connector";
import type { NativeHttpClient } from "../src/node-bridge/native-http-host";
import { signedNodeFrameSchema } from "../src/node-protocol/v1";
import { nativeHttpFixture } from "./helpers/native-http";
import { currentSignal } from "./helpers/managed-native-session";
import { qualityText } from "./helpers/native-quality-completion";

type Fixture = Awaited<ReturnType<typeof nativeHttpFixture>>;
type Client = ReturnType<Fixture["createClient"]>;
const settings = { maxCycles: 3, intervalMs: 1, timeoutMs: 60_000 };

// The real HTTP handler still selects its own restricted auth/evidence/result identities.
// PGlite has one backend: restore the disposable administrative identity after each HTTP
// exchange only for subsequent fake-node approval/provider reads, not server writes.
function fixtureClient(x: Fixture, wire: Client, afterExchange?: () => Promise<void>): NativeHttpClient {
  return { async exchange(command, signal) {
    try { const response = await wire.client.exchange(command, signal);
      await afterExchange?.(); return response;
    } finally { await x.f.x.admin(async () => {}); }
  }, close: () => wire.client.close() };
}

async function pendingReview(x: Fixture) {
  const counts = await x.f.x.counts();
  assert.equal(counts.runs.length, 1); assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.deepEqual(await x.f.x.f.config.storage.read(counts.artifacts[0].id as string), new TextEncoder().encode(qualityText));
  const target = await x.f.x.admin(async () => {
    const rows = await x.f.x.f.db.query<{ plan: { targetId: string } }>(
      "SELECT plan FROM control_native_review_plans WHERE run_id=$1", [x.f.x.registration.id]);
    assert.equal(rows.rows.length, 1); return rows.rows[0].plan.targetId;
  });
  assert.equal((await x.f.x.admin(() => x.f.x.f.reviewStore.snapshot(x.f.x.f.scope.tenantId, target))).status, "pending");
  return counts;
}

async function dispatch(x: Fixture, signal: AbortSignal) {
  assert.deepEqual(x.f.x.local.calls, []);
  await x.server.dispatch(x.f.config.enrollment.nodeId, x.f.x.f.identity, x.f.x.task, signal);
  assert.deepEqual(x.f.x.local.calls, []);
  // Labelled fake-node setup/readback boundary; the server dispatch used its real owner.
  await x.f.x.admin(async () => {});
}

function completeOnSecondWait(x: Fixture) {
  let waits = 0;
  return async (milliseconds: number, signal: AbortSignal) => {
    assert.equal(milliseconds, settings.intervalMs); assert.equal(signal.aborted, false);
    waits++;
    if (waits === 1) await dispatch(x, signal);
    else { assert.equal(waits, 2); assert.deepEqual(x.f.x.local.calls, ["capabilities", "start"]);
      x.f.advance(); x.f.setResult(qualityText); await x.f.x.admin(async () => {}); }
  };
}

// Assertion-only decoding after routing: the transport and connector exchange opaque strings.
function frames(wire: Client) {
  return wire.commands.flatMap(command => command.operation === "exchange" && command.packet !== null
    ? [signedNodeFrameSchema.parse(JSON.parse((JSON.parse(command.packet) as { raw: string }).raw))] : []);
}

async function preserved(x: Fixture) {
  const canonical = await x.f.x.states();
  const rows = await x.f.x.admin(async () => {
    const result: Record<string, unknown[]> = {};
    for (const table of ["control_native_task_queue", "control_native_delivery_envelopes",
      "control_native_transmission_intents", "control_native_delivery_receipts"])
      result[table] = (await x.f.x.f.db.query(`SELECT * FROM ${table} WHERE job_id=$1`, [x.f.x.task.jobId])).rows;
    return result;
  });
  return { canonical, rows, calls: [...x.f.x.local.calls], registrations: x.f.x.inputRegistrations() };
}

test("connector alone drives signed HTTP dispatch, native execution and exact bytes into pending review", async t => {
  const x = await nativeHttpFixture(), wire = x.createClient();
  const connector = createNativeConnector(x.f.runtime, fixtureClient(x, wire), settings,
    { assertCurrent() {}, wait: completeOnSecondWait(x) });
  t.after(async () => { try { await connector.close(); } finally { await x.close(); } });
  await x.f.x.verify();
  const canonical = await x.f.x.states();
  assert.equal(wire.commands.length, 0); assert.deepEqual(x.f.x.local.calls, []);
  assert.equal((await x.f.x.counts()).runs.length, 0);
  const result = await x.f.x.admin(() => connector.run("initial", currentSignal()));
  assert.deepEqual(result, { disposition: "terminal", state: "completed", cycles: 3 });
  assert.equal((await pendingReview(x)).events.length, 2);
  assert.deepEqual(x.f.x.local.calls, ["capabilities", "start", "status"]);
  assert.deepEqual(await x.f.x.states(), canonical); assert.equal(x.f.x.inputRegistrations(), 1);
  assert.equal(frames(wire).filter(frame => frame.type === "harness.native.dispatch.receipt").length, 1);
  assert.equal(wire.commands.filter(command => command.operation === "open").length, 1);
  assert.equal(wire.commands.filter(command => command.operation === "close").length, 1);
  assert.equal(wire.closes(), 1);
  assert.ok(x.f.x.observed.some(row => row.login === "managed_auth_test" && row.sql.includes("INSERT INTO node_protocol_replay")));
  assert.ok(x.f.x.observed.some(row => row.login === "managed_evidence_test" && row.sql.includes("INSERT INTO control_harness_runs")));
  assert.ok(x.f.x.observed.some(row => row.login === "managed_result_test" && row.sql.includes("INSERT INTO control_native_review_plans")));
  const calls = [...x.f.x.local.calls], commands = wire.commands.length;
  assert.throws(() => connector.run("initial", currentSignal()));
  assert.deepEqual(x.f.x.local.calls, calls); assert.equal(wire.commands.length, commands);
});

test("waiting connector reaches its cycle bound without dispatch, registration or native effects", async t => {
  const x = await nativeHttpFixture(), wire = x.createClient(); let waits = 0;
  const connector = createNativeConnector(x.f.runtime, fixtureClient(x, wire), settings,
    { assertCurrent() {}, async wait() { waits++; } });
  t.after(async () => { try { await connector.close(); } finally { await x.close(); } });
  await x.f.x.verify(); const before = await preserved(x), counts = await x.f.x.counts();
  const result = await x.f.x.admin(() => connector.run("initial", currentSignal()));
  assert.deepEqual(result, { disposition: "bounded", state: "waiting", cycles: 3 });
  assert.equal(waits, 2); assert.deepEqual(await preserved(x), before);
  assert.deepEqual(await x.f.x.counts(), counts); assert.deepEqual(x.f.x.local.calls, []);
  assert.equal(frames(wire).filter(frame => frame.type === "harness.native.dispatch.receipt").length, 0);
  assert.equal(wire.closes(), 1);
});

test("lost HTTP response after result commit stops the connector without retry; a new connector recovers retained journals without native restart", async t => {
  const x = await nativeHttpFixture(), wire = x.createClient();
  let lostAt: number | undefined;
  const connector = createNativeConnector(x.f.runtime, fixtureClient(x, wire, async () => {
    // Effect-free fault injection observes the actual server commit, not packet types.
    // The committed response is withheld from the connector exactly once.
    if (lostAt === undefined && (await x.f.x.counts()).artifacts.length === 1) {
      lostAt = wire.commands.length; throw new Error("synthetic_lost_committed_http_response");
    }
  }), settings, { assertCurrent() {}, wait: completeOnSecondWait(x) });
  const cleanup: { replacement?: ReturnType<typeof createNativeConnector> } = {};
  t.after(async () => { try { await connector.close(); await cleanup.replacement?.close(); } finally { await x.close(); } });
  await x.f.x.verify();
  await assert.rejects(x.f.x.admin(() => connector.run("initial", currentSignal())), { message: "native_connector_unavailable" });
  assert.ok(lostAt); assert.equal(wire.commands.length, lostAt); assert.equal(wire.closes(), 1);
  const counts = await pendingReview(x), before = await preserved(x);
  const delivery = x.f.journal.acceptedNativeDelivery(x.f.config.queueId), saved = x.f.x.local.journal.load(x.f.x.registration.id);
  const checkpoint = x.f.x.f.checkpoints.read(`completion-gate:${x.f.x.f.scope.tenantId}`);
  assert.deepEqual(x.f.x.local.calls, ["capabilities", "start", "status"]);
  const recoveredWire = x.createClient(), node = x.f.create();
  const replacement = createNativeConnector(node, fixtureClient(x, recoveredWire), settings,
    { assertCurrent() {}, async wait() { assert.fail("saved terminal recovery must not wait for a new native execution"); } });
  cleanup.replacement = replacement;
  const recovered = await x.f.x.admin(() => replacement.run("recover", currentSignal()));
  assert.deepEqual(recovered, { disposition: "terminal", state: "completed", cycles: 1 });
  assert.notEqual(recoveredWire.connection(), wire.connection());
  assert.deepEqual(frames(recoveredWire).map(frame => frame.type), ["connection.hello", "protocol.ack", "node.reconciliation.report",
    "harness.native.snapshot", "protocol.ack"]);
  assert.deepEqual(await pendingReview(x), counts); assert.deepEqual(await preserved(x), before);
  assert.deepEqual(x.f.journal.acceptedNativeDelivery(x.f.config.queueId), delivery);
  assert.deepEqual(x.f.x.local.journal.load(x.f.x.registration.id), saved);
  assert.deepEqual(x.f.x.f.checkpoints.read(`completion-gate:${x.f.x.f.scope.tenantId}`), checkpoint);
  assert.equal(wire.commands.length, lostAt); assert.equal(recoveredWire.closes(), 1);
});
