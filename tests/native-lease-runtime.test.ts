import test from "node:test";
import assert from "node:assert/strict";
import { nativeNodeRuntimeFixture } from "./helpers/native-node-runtime";
import { currentSignal } from "./helpers/managed-native-session";
import { qualityText } from "./helpers/native-quality-completion";
import { signedNodeFrameSchema } from "../src/node-protocol/v1";

test("lease-aware runtime waits for paired grant then uses verified current policy to start once", async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { leaseAware: true }); t.after(f.close);
  assert.equal(f.runtime.hasAcceptedDispatch(), false);
  await assert.rejects(f.runtime.start(currentSignal()), /not_ready/);
  assert.equal(f.x.local.journal.load(f.x.f.prepared.binding.runId), undefined);
  const c = await f.connect();
  await c.server.stage(f.x.f.identity, f.x.task, currentSignal());
  await c.server.transmit(f.x.f.identity, f.x.task, currentSignal());
  assert.deepEqual(c.outgoing.map(raw => JSON.parse(raw).type), ["harness.native.dispatch", "job.lease.grant"]);
  await f.x.admin(() => f.runtime.receive(c.outgoing.shift()!, currentSignal()));
  assert.equal(f.runtime.hasAcceptedDispatch(), false);
  await assert.rejects(f.runtime.start(currentSignal()), /not_ready/);
  assert.equal(f.x.local.journal.load(f.x.f.prepared.binding.runId), undefined);
  assert.deepEqual(f.x.local.calls, []);
  await f.pump(c);
  assert.equal(f.runtime.hasAcceptedDispatch(), true);
  const run = await f.x.admin(() => f.runtime.start(currentSignal()));
  assert.equal(run.state, "queued");
  await f.pump(c);
  assert.equal(f.x.local.calls.filter(call => call === "start").length, 1);
  assert.equal((await f.x.admin(() => f.runtime.start(currentSignal()))).state, "queued");
  assert.equal(f.x.local.calls.filter(call => call === "start").length, 1);
  await f.pump(c); f.advance(); f.setResult(qualityText);
  assert.equal((await f.x.admin(() => f.runtime.poll(currentSignal()))).state, "completed");
  await f.pump(c);
  const counts = await f.x.counts();
  assert.equal(counts.runs.length, 1); assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.deepEqual(await f.x.f.config.storage.read(counts.artifacts[0].id as string), new TextEncoder().encode(qualityText));
  const target = await f.x.admin(async () => (await f.x.f.db.query<{ plan: { targetId: string } }>(
    "SELECT plan FROM control_native_review_plans WHERE run_id=$1", [f.x.registration.id])).rows[0].plan.targetId);
  assert.equal((await f.x.admin(() => f.x.f.reviewStore.snapshot(f.x.f.scope.tenantId, target))).status, "pending");
  assert.equal(f.x.local.effects.countActive(f.config.enrollment.tenantId, f.config.enrollment.nodeId), 1);
});

for (const mode of ["grant-only", "wrong-causation", "disconnect"] as const) test(`incomplete or mismatched lease delivery cannot reserve a native run: ${mode}`, async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { leaseAware: true }); t.after(f.close);
  const c = await f.connect();
  await c.server.stage(f.x.f.identity, f.x.task, currentSignal());
  await c.server.transmit(f.x.f.identity, f.x.task, currentSignal());
  const dispatch = c.outgoing.shift()!, grantRaw = c.outgoing.shift()!;
  if (mode !== "grant-only") await f.x.admin(() => f.runtime.receive(dispatch, currentSignal()));
  if (mode === "disconnect") {
    await f.x.admin(() => f.runtime.disconnected(currentSignal()));
    await assert.rejects(f.x.admin(() => f.runtime.receive(grantRaw, currentSignal())));
  } else if (mode === "grant-only") {
    await assert.rejects(f.x.admin(() => f.runtime.receive(grantRaw, currentSignal())));
  } else {
    const signed = signedNodeFrameSchema.parse(JSON.parse(grantRaw));
    const { signature, bodyDigest, ...unsigned } = signed; void signature; void bodyDigest;
    const wrong = await f.x.settings.sign({ ...unsigned, causationId: "message:another-dispatch" });
    await assert.rejects(f.x.admin(() => f.runtime.receive(JSON.stringify(wrong), currentSignal())));
  }
  await assert.rejects(f.runtime.start(currentSignal()));
  assert.deepEqual(f.x.local.calls, []);
  assert.equal(f.x.local.journal.load(f.x.f.prepared.binding.runId), undefined);
  assert.equal(f.journal.queuedCommandCount(), 0);
});

for (const change of ["pause", "cancel", "missing-ceiling"] as const) test(`lease-aware runtime checks retained policy before native effects: ${change}`, async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { leaseAware: true, leaseCeiling: change !== "missing-ceiling" }); t.after(f.close);
  const c = await f.connect(); await f.dispatch(c);
  assert.equal(f.runtime.hasAcceptedDispatch(), true);
  if (change === "pause") f.setPaused(true);
  if (change === "cancel") {
    const attempt = f.journal.attemptSummary(f.x.f.prepared.request.attemptId); assert.ok(attempt);
    f.journal.upsertAttempt({ ...attempt, state: "cancelled" }, new Date(f.x.f.clock()).toISOString());
  }
  if (change === "cancel") await assert.rejects(f.x.admin(() => f.runtime.start(currentSignal())), /not_ready/);
  else assert.equal((await f.x.admin(() => f.runtime.start(currentSignal()))).state, "failed");
  assert.deepEqual(f.x.local.calls, []);
  assert.equal(f.x.local.effects.countActive(f.config.enrollment.tenantId, f.config.enrollment.nodeId), 0);
});

test("queue-selected lease-aware runtime captures journal methods before delayed delivery", async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { leaseAware: true, queue: true }); t.after(f.close);
  const methods = { acceptedCommand: f.journal.acceptedCommand, attemptSummary: f.journal.attemptSummary,
    nodeControlState: f.journal.nodeControlState, recordInitialLease: f.journal.recordInitialLease };
  for (const name of Object.keys(methods) as (keyof typeof methods)[]) {
    // The original atomic store method itself calls this.attemptSummary while
    // writing; preserve its implementation until intake finishes. This checks
    // runtime dependency capture, not immutability of an entire supplied class.
    if (name === "attemptSummary") continue;
    f.journal[name] = () => { throw new Error("synthetic replaced method"); };
  }
  try {
    const c = await f.connect("initial", f.runtime, "queue");
    await f.x.manager.deliverApproved({ schema: "control-room.native-task-submission/v1", tenantId: f.config.enrollment.tenantId,
      projectId: f.queued.projectId, jobId: f.queued.jobId, attemptId: f.queued.attemptId, queueId: f.queued.queueId,
      packetDigest: f.queued.packetDigest, inputDigest: f.x.task.inputDigest }, currentSignal());
    await f.pump(c);
    f.journal.attemptSummary = () => { throw new Error("synthetic replaced method"); };
    assert.equal(f.runtime.hasAcceptedDispatch(), true); assert.equal(f.runtime.queueId, f.queued.queueId);
    assert.deepEqual(f.x.local.calls, []);
    assert.equal((await f.x.admin(() => f.runtime.start(currentSignal()))).state, "queued");
    await f.pump(c);
    assert.equal(f.x.local.calls.filter(call => call === "start").length, 1);
  } finally { Object.assign(f.journal, methods); }
});
