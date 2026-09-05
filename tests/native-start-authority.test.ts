import assert from "node:assert/strict";
import test from "node:test";
import { nativeStartAuthorityFixture } from "./helpers/native-start-authority";
import { instant } from "./hermes-native-fixture";
import { computeArtifactBodyDigest } from "../src/node-policy/v1";
import type { NativeStartAuthorityDependencies } from "../src/harness/hermes-native-v1/start-authority";

test("real policy and durable stores gate the actual native adapter's single fake submission", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  const controller = f.create(); t.after(() => controller.close()); const adapter = f.adapter(controller);
  assert.equal(f.reads(), 0); assert.equal(f.admissions.count(), 0); assert.equal(f.effects.countFull(), 0);
  const snapshot = await adapter.start(f.prepared.start);
  assert.equal(snapshot.state, "queued", JSON.stringify(snapshot));
  assert.deepEqual(f.calls, ["capabilities", "start"]); assert.ok(f.profileChecks() >= 5);
  assert.equal(f.admissions.count(), 1); assert.equal(f.effects.countFull(), 1);
  const claim = f.effects.load(f.prepared.binding.effectClaimKey); assert.equal(claim?.kind, "full");
  if (claim?.kind !== "full") assert.fail(); assert.equal(claim.snapshot.state, "executing"); assert.ok(claim.snapshot.markerDigest);
  assert.equal(f.executions.load(claim.snapshot.executionId)?.state, "executing");
  await adapter.start(f.prepared.start); assert.deepEqual(f.calls, ["capabilities", "start"]);
  const polled = await adapter.poll(f.prepared.binding.runId); assert.equal(polled.state, "running");
  assert.equal(f.calls.at(-1), "status");
});

test("missing current key, pause, qualification, approval or capacity blocks before any fake transport", async t => {
  for (const failure of ["key", "pause", "profile", "approval", "capacity", "lease"] as const) await t.test(failure, async t => {
    const f = await nativeStartAuthorityFixture(); t.after(f.close);
    if (failure === "key") f.policy.keyAvailability.state = "locked";
    if (failure === "pause") f.policy.paused = true;
    if (failure === "profile") f.setProfile(false);
    if (failure === "approval") f.policy.approvalKey = undefined;
    if (failure === "capacity") f.setExtraActive(1);
    if (failure === "lease") f.policy.lease.leaseEpoch++;
    const controller = f.create(); t.after(() => controller.close());
    assert.equal((await f.adapter(controller).start(f.prepared.start)).state, "failed");
    assert.deepEqual(f.calls, []); assert.equal(f.effects.countFull(), 0); assert.equal(f.admissions.count(), 0);
  });
});

test("authority is refreshed before authenticated start bytes even after a committed marker", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close); const controller = f.create(); t.after(() => controller.close());
  const adapter = f.adapter(controller, { ...f.transport, async json(wire) {
    if (wire.operation === "start") f.policy.paused = true;
    return f.transport.json(wire);
  } });
  assert.equal((await adapter.start(f.prepared.start)).state, "ambiguous");
  assert.deepEqual(f.calls, ["capabilities"]); assert.equal(f.effects.countFull(), 1);
  const claim = f.effects.load(f.prepared.binding.effectClaimKey); assert.equal(claim?.kind === "full" && claim.snapshot.state, "ambiguous");
  f.policy.paused = false; await adapter.start(f.prepared.start); assert.deepEqual(f.calls, ["capabilities"]);
});

test("lost marker acknowledgement quarantines the controller and leaves the durable effect ambiguous", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close); let marks = 0;
  const effects: NativeStartAuthorityDependencies["effects"] = { claim: f.effects.claim.bind(f.effects), load: f.effects.load.bind(f.effects),
    recover: f.effects.recover.bind(f.effects), commitPreEffectMarker(marker) { marks++; f.effects.commitPreEffectMarker(marker); throw new Error("synthetic lost acknowledgement"); } };
  const controller = f.create({ effects }); t.after(() => controller.close()); const adapter = f.adapter(controller);
  assert.equal((await adapter.start(f.prepared.start)).state, "ambiguous"); assert.equal(marks, 1);
  assert.deepEqual(f.calls, ["capabilities"]);
  const claim = f.effects.load(f.prepared.binding.effectClaimKey); assert.equal(claim?.kind === "full" && claim.snapshot.state, "ambiguous");
  await assert.rejects(controller.authority.markStart(f.prepared.binding), /unavailable/);
  const replacement = f.create(); t.after(() => replacement.close());
  await assert.rejects(replacement.authority.check("start", f.prepared.binding), /unavailable/);
  assert.equal(marks, 1);
});

test("two controllers cannot claim or mark the same effect concurrently", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close); const first = f.create(), second = f.create();
  t.after(() => { first.close(); second.close(); });
  const results = await Promise.allSettled([first.authority.markStart(f.prepared.binding), second.authority.markStart(f.prepared.binding)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(f.effects.countFull(), 1); assert.equal(f.admissions.count(), 1);
});

test("different task controllers cannot oversubscribe node capacity from stale concurrent counts", async t => {
  const f = await nativeStartAuthorityFixture(), g = await nativeStartAuthorityFixture("second-native-task-001"); t.after(f.close); t.after(g.close);
  assert.notEqual(f.prepared.binding.effectClaimKey, g.prepared.binding.effectClaimKey);
  const first = f.create({ readCurrent: async () => ({ ...f.policy, activeExternalEffects: 0 }) });
  const second = g.create({ admissions: f.admissions, executions: f.executions, effects: f.effects,
    readCurrent: async () => ({ ...g.policy, activeExternalEffects: 0 }) });
  t.after(() => { first.close(); second.close(); });
  const results = await Promise.allSettled([first.authority.markStart(f.prepared.binding), second.authority.markStart(g.prepared.binding)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(f.effects.countFull(), 1); assert.equal(f.effects.countActive(f.scope.tenantId, f.route.nodeId), 1);
});

test("expired, narrower and backward-clock authority cannot reach a marker", async t => {
  for (const failure of ["expired", "narrower", "backward"] as const) await t.test(failure, async t => {
    const f = await nativeStartAuthorityFixture(); t.after(f.close); const controller = f.create(); t.after(() => controller.close());
    if (failure === "expired") f.setNow(f.prepared.binding.deadline);
    if (failure === "narrower") { f.policy.ceiling.maxDurationSeconds = 1; f.policy.ceiling.bodyDigest = computeArtifactBodyDigest(f.policy.ceiling); }
    if (failure === "backward") { await controller.authority.check("start", f.prepared.binding); f.setNow(instant + 8000); }
    await assert.rejects(controller.authority.markStart(f.prepared.binding), /unavailable/);
    assert.equal(f.effects.countFull(), 0);
  });
});

test("close aborts a pending check and a late resolver cannot write admission", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close); let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const controller = f.create({ async readCurrent() { started(); await new Promise<void>(resolve => { release = resolve; }); return f.policy; } });
  const marking = controller.authority.markStart(f.prepared.binding); await entered; controller.close();
  await assert.rejects(marking, /unavailable/); release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.admissions.count(), 0); assert.equal(f.effects.countFull(), 0);
});

test("bounded profile timeout cannot turn a late response into a marker", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close); let release!: () => void;
  const controller = f.create({ checkMs: 20, async assertProfileCurrent() { await new Promise<void>(resolve => { release = resolve; }); } });
  t.after(() => controller.close());
  await assert.rejects(controller.authority.markStart(f.prepared.binding), /unavailable/);
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.admissions.count(), 0); assert.equal(f.effects.countFull(), 0);
});

test("mismatched binding, stop and post-deadline observation do not inherit start permission", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close); const controller = f.create(); t.after(() => controller.close());
  await assert.rejects(controller.authority.check("start", { ...f.prepared.binding, requestDigest: `sha256:${"e".repeat(64)}` }), /unavailable/);
  await assert.rejects(controller.authority.check("stop", f.prepared.binding), /unavailable/);
  await controller.authority.markStart(f.prepared.binding); f.setNow(f.prepared.binding.deadline);
  await assert.rejects(controller.authority.check("status", f.prepared.binding), /unavailable/);
  await assert.rejects(controller.authority.check("events", f.prepared.binding), /unavailable/);
  assert.deepEqual(f.calls, []);
});

test("configuration snapshots resist later input mutation and excess pending checks are not queued", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close); const controller = f.create(); t.after(() => controller.close());
  f.config.request.approval.signature = "invalid-signature";
  await controller.authority.check("start", f.prepared.binding);
  let waiting = 0;
  // Use the captured valid signed request in a fresh fixture; all resolver waits are abortable by close.
  const g = await nativeStartAuthorityFixture(); t.after(g.close);
  const bounded = g.create({ readCurrent: async () => { waiting++; return new Promise(() => {}); } });
  const pending = Array.from({ length: 8 }, () => bounded.authority.check("start", g.prepared.binding));
  const outcomes = Promise.allSettled(pending);
  await assert.rejects(bounded.authority.check("start", g.prepared.binding), /unavailable/);
  assert.equal(waiting, 8); bounded.close();
  assert.equal((await outcomes).filter(result => result.status === "rejected").length, 8);
  assert.equal(g.effects.countFull(), 0);
});

test("timed-out unresolved resolvers retain capacity across repeated batches", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close); let started = 0;
  const releases: Array<() => void> = [];
  const controller = f.create({ checkMs: 10, async readCurrent() {
    started++; await new Promise<void>(resolve => releases.push(resolve));
    throw new Error("synthetic late failure");
  } });
  t.after(() => controller.close());
  for (let batch = 0; batch < 3; batch++) {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => controller.authority.check("capabilities", f.prepared.binding)));
    assert.equal(results.filter(result => result.status === "rejected").length, 8);
    assert.equal(started, 8);
  }
  for (const release of releases) release();
  await new Promise<void>(resolve => setImmediate(resolve));
  const resumed = controller.authority.check("capabilities", f.prepared.binding);
  const rejected = assert.rejects(resumed, /unavailable/);
  assert.equal(started, 9); releases[8](); await rejected;
  assert.equal(f.admissions.count(), 0); assert.equal(f.effects.countFull(), 0);
});

test("a replacement controller cannot resurrect expired durable authority using an earlier wall clock", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close); const first = f.create();
  await first.authority.markStart(f.prepared.binding); first.close();
  const claim = f.effects.load(f.prepared.binding.effectClaimKey); if (claim?.kind !== "full") assert.fail();
  f.executions.apply(claim.snapshot.executionId, { eventId: "event:native:expired", kind: "deadline_crossed",
    occurredAt: new Date(f.prepared.binding.deadline).toISOString(), latenessMilliseconds: 0 });
  const replacement = f.create(); t.after(() => replacement.close());
  await assert.rejects(replacement.authority.check("status", f.prepared.binding), /unavailable/);
  await assert.rejects(replacement.authority.check("events", f.prepared.binding), /unavailable/);
  await assert.rejects(replacement.authority.check("start", f.prepared.binding), /unavailable/);
});
