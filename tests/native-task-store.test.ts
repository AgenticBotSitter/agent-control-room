import assert from "node:assert/strict";
import test from "node:test";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { binding, digest, instant } from "./hermes-native-fixture";
import { at, nativeTaskFixture, observation, registration } from "./native-task-fixture";

test("canonical task registration and signed snapshot ingestion survive duplicate delivery and reconnect gaps", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); await f.runs.create(registration);
  const queued = f.frame(observation());
  const received = await f.service.ingest(JSON.stringify(queued), f.options());
  assert.deepEqual(received.event, { runId: binding.runId, snapshotVersion: 3, replayed: false });
  assert.deepEqual(received.acknowledgement.acknowledgedMessageIds, [queued.messageId]);
  assert.equal((await f.service.ingest(JSON.stringify(queued), f.options())).event.replayed, true);
  const completed = f.frame(observation({ version: 19, state: "completed", observedAt: instant + 2000, upstreamUpdatedAt: instant + 1500, resultText: "Synthetic result" }));
  await f.service.ingest(JSON.stringify(completed), f.options(at(2000)));
  const reopened = new HarnessRunStoreV1(f.db, new Uint8Array(32).fill(17));
  assert.equal((await reopened.get(binding.tenantId, binding.runId))?.state, "succeeded");
  const registeredAgain = await reopened.create(registration);
  assert.equal(registeredAgain.replayed, true); assert.equal(registeredAgain.run.state, "succeeded");
  const events = await reopened.events(binding.tenantId, binding.runId);
  assert.deepEqual(events.map(event => event.sequence), [1, 2]);
  assert.deepEqual(events.map(event => event.payload.category), ["native_snapshot", "native_snapshot"]);
  assert.equal((await f.canonical.get(binding.tenantId, "attempt", binding.attemptId))?.state, "leased");
  assert.equal((await f.canonical.get(binding.tenantId, "job", binding.jobId))?.state, "leased");
  assert.equal((await f.db.query(`SELECT * FROM control_artifact_lineage`)).rows.length, 0);
  assert.equal(await reopened.get("tenant:other", binding.runId), undefined);
});

for (const [state, expected] of [["running", "running"], ["waiting_approval", "waiting_approval"], ["stopping", "cancelling"],
  ["completed", "succeeded"], ["cancelled", "cancelled"], ["interrupted", "failed"], ["ambiguous", "disconnected"]] as const) {
  test(`first native snapshot may be ${state} without fabricated intermediate events`, async t => {
    const f = await nativeTaskFixture(); t.after(f.close); await f.runs.create(registration);
    const result = await f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, observation({ state, stopAttempted: state === "stopping" }));
    assert.equal(result.run.state, expected);
    if (state === "cancelled") assert.equal(result.run.cancelState, "reported");
    if (["stopping", "cancelled", "interrupted"].includes(state)) assert.equal(result.run.startedAt, undefined);
    assert.equal((await f.runs.events(binding.tenantId, binding.runId)).length, 1);
  });
}

test("preflight failure does not invent a native execution start", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); await f.runs.create(registration);
  const result = await f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId,
    observation({ state: "failed", nativeRunId: null, safeReason: "preflight_failed" }));
  assert.equal(result.run.startedAt, undefined); assert.equal(result.run.state, "failed"); assert.equal(result.run.finishedAt, at(1000));
});

test("snapshot identity binds canonical project, job, attempt, lease, input, node and session", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  await assert.rejects(f.runs.create({ ...registration, nativeTask: { ...registration.nativeTask!, inputDigest: digest("e") } }), /binding/);
  await assert.rejects(f.runs.create({ ...registration, nativeTask: { ...registration.nativeTask!, leaseEpoch: 2 } }), /binding/);
  await f.runs.create(registration);
  await assert.rejects(f.runs.create({ ...registration, id: "run:second", nativeSessionKeyDigest: digest("e") }), /already has/);
  for (const patch of [{ projectId: "project:other" }, { jobId: "job:other" }, { attemptId: "attempt:other" }, { leaseId: "lease:other" },
    { leaseEpoch: 2 }, { sessionKeyDigest: digest("e") }, { bindingDigest: digest("f") }]) {
    await assert.rejects(f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, { ...observation(), ...patch }), /identity/);
  }
  await assert.rejects(f.runs.recordNativeSnapshot(binding.tenantId, "node:other", observation()), /identity/);
  assert.equal((await f.runs.events(binding.tenantId, binding.runId)).length, 0);
});

test("snapshot versions, native handles, timestamps and stop intent remain monotonic", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); await f.runs.create(registration);
  const first = observation({ state: "stopping", stopAttempted: true, upstreamUpdatedAt: instant });
  await f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, first);
  for (const patch of [{ snapshotVersion: 2 }, { nativeRunKeyDigest: digest("e") }, { upstreamUpdatedAt: null },
    { observedAt: at(500) }, { stopAttempted: false }, { state: "running" as const }, { state: "prepared" as const }]) {
    await assert.rejects(f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, { ...first, snapshotVersion: 4, ...patch }), /conflict/);
  }
  await assert.rejects(f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, { ...first, safeReason: "transport_unavailable" }), /replay conflict/);
  await f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, { ...first, snapshotVersion: 6, state: "completed" });
  await assert.rejects(f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, { ...first, snapshotVersion: 7 }), /conflict|immutable/);
  assert.equal((await f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, first)).replayed, true);
});

test("late evidence for the exact expired lease is retained without extending authority", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); await f.runs.create(registration);
  const lease = (await f.canonical.get(binding.tenantId, "lease", "lease:test"))!;
  const job = (await f.canonical.get(binding.tenantId, "job", binding.jobId))!;
  const attempt = (await f.canonical.get(binding.tenantId, "attempt", binding.attemptId))!;
  const expired = await f.canonical.expireLease({ tenantId: binding.tenantId, leaseId: lease.id, jobId: job.id, attemptId: attempt.id,
    expectedLeaseVersion: lease.version, expectedJobVersion: job.version, expectedAttemptVersion: attempt.version, epoch: 1,
    transitionId: "transition:expire", idempotencyKey: "native-fixture-expire-lease", actor: { actorId: "identity:test", actorType: "human" }, occurredAt: at(300_000) });
  const body = observation({ state: "completed", version: 8, observedAt: instant + 400_000 });
  await f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, body);
  assert.equal((await f.db.query<{ state: string }>(`SELECT state FROM control_leases WHERE id='lease:test'`)).rows[0].state, "expired");
  assert.equal((await f.canonical.get(binding.tenantId, "job", binding.jobId))?.state, expired.job.state);
});

test("legacy lifecycle cannot overwrite native observations or claim confirmed cleanup", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); await f.runs.create(registration);
  const event = { schemaVersion: "control-room-harness-event/v1" as const, tenantId: binding.tenantId, runId: binding.runId,
    sequence: 1, occurredAt: at(1000), source: "adapter" as const, sourceEventKeyDigest: digest() };
  await assert.rejects(f.runs.append({ ...event, payload: { category: "lifecycle", state: "running" } }), /cannot be mixed/);
  await assert.rejects(f.runs.append({ ...event, payload: { category: "native_snapshot", snapshot: observation() } }), /authenticated/);
  await assert.rejects(f.runs.create({ ...registration, cancelState: "confirmed" }), /mismatch/);
});

test("unregistered, stale-connection, future and unauthenticated snapshots have one coarse rejection", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  await assert.rejects(f.service.ingest(JSON.stringify(f.frame()), f.options()), { message: "native_snapshot_rejected" });
  await f.runs.create(registration);
  const valid = f.frame();
  await assert.rejects(f.service.ingest(JSON.stringify(valid), { ...f.options(), expectedConnectionId: "connection:other" }), { message: "native_snapshot_rejected" });
  await assert.rejects(f.service.ingest(JSON.stringify({ ...valid, signature: "a".repeat(86) }), f.options()), { message: "native_snapshot_rejected" });
  // A rejected transport/signature has not consumed its replay slot.
  await f.service.ingest(JSON.stringify(valid), f.options());
  await f.db.query(`UPDATE control_node_keys SET state='revoked',revoked_at=$1 WHERE id='key:test'`, [at(1000)]);
  await assert.rejects(f.service.ingest(JSON.stringify(valid), f.options()), { message: "native_snapshot_rejected" });
});
