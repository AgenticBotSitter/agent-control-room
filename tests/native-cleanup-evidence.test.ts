import assert from "node:assert/strict";
import test from "node:test";
import { createNativeCleanupEvidence } from "../src/harness/hermes-native-v1/cleanup-evidence";
import { createNativeTaskSettlement } from "../src/harness/hermes-native-v1/task-settlement";
import { sha256Digest } from "../src/security";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";
import { syntheticCleanupEvidence } from "./helpers/native-cleanup-evidence";
import { response, statusBody } from "./hermes-native-fixture";

const signal = () => new AbortController().signal;
async function fixture() {
  const f = await nativeLeaseEvidenceFixture(), control = f.create();
  const adapter = f.adapter(control, { ...f.transport, async json(wire) {
    if (wire.operation !== "status") return f.transport.json(wire);
    await wire.authorize(); f.calls.push("status");
    return response(statusBody("completed", { session_id: f.prepared.binding.sessionId, output: "Synthetic completed result" }));
  } });
  await adapter.start(f.prepared.start);
  f.setNow(f.dependencies.clock!() + 1000); await adapter.poll(f.prepared.binding.runId);
  const cleanup = syntheticCleanupEvidence({ enrollment: f.startConfig.enrollment, binding: f.prepared.binding,
    runs: f.nativeRunJournal, effects: f.effects, security: f.trust, clock: f.dependencies.clock! });
  return { ...cleanup, f, deps: { ...cleanup.deps, effects: f.effects },
    close: async () => { cleanup.close(); control.close(); await f.close(); } };
}

test("accepted exact cleanup evidence is read-only and cannot clear retained active capacity", async t => {
  const x = await fixture(); t.after(x.close); const reader = x.create(); t.after(reader.close);
  const calls = [...x.f.calls], active = x.f.effects.countActive(x.config.enrollment.tenantId, x.config.enrollment.nodeId);
  assert.equal(active, 1);
  const evidence = await reader.verify(signal()); evidence.assertFresh();
  assert.equal(Object.isFrozen(evidence), true); assert.equal(evidence.releasesCapacity, false);
  assert.equal(evidence.grantsExecutionAuthority, false); assert.match(evidence.evidenceDigest, /^sha256:/);
  assert.equal(JSON.stringify(evidence).includes(x.snapshot.resultText!), false);
  assert.deepEqual(x.f.calls, calls); assert.deepEqual(x.f.nativeRunJournal.load(x.snapshot.binding.runId), x.snapshot);
  assert.deepEqual(x.f.effects.load(x.snapshot.binding.effectClaimKey), { kind: "full", snapshot: x.claim });
  assert.equal(x.f.effects.countActive(x.config.enrollment.tenantId, x.config.enrollment.nodeId), active);
  reader.close(); assert.throws(evidence.assertFresh);
});

test("cleanup evidence refuses mismatched identity, active work, expired proof and forged owner acceptance", async t => {
  const x = await fixture(); t.after(x.close); const original = structuredClone(x.proof);
  const bad: Record<string, unknown>[] = [
    ...["enrollmentDigest", "producerDigest", "bindingDigest", "snapshotDigest", "markerDigest"].map(field => ({ [field]: `sha256:${"e".repeat(64)}` })),
    { nativeRunId: "run_22222222-2222-4222-8222-222222222222" }, { remainingDescendants: 1 }, { pendingNativeRequests: 1 },
    { state: "running" }, { observedAt: original.observedAt + 1 }, { validUntil: original.observedAt },
    { validUntil: original.observedAt + 30_001 },
  ];
  for (const change of bad) {
    Object.assign(x.proof, original, change); const reader = x.create();
    await assert.rejects(reader.verify(signal()), /native_cleanup_evidence_unavailable/);
    Object.assign(x.proof, original); await assert.rejects(reader.verify(signal())); reader.close();
  }
  const forged = structuredClone(x.config); forged.acceptance.signature = "a".repeat(86);
  await assert.rejects(createNativeCleanupEvidence(forged, x.deps).verify(signal()));
  assert.equal(x.f.effects.countActive(x.config.enrollment.tenantId, x.config.enrollment.nodeId), 1);
});

test("proof freshness binds source revision, owner pins and cancellation", async t => {
  const x = await fixture(); t.after(x.close);
  const original = structuredClone(x.proof), reader = x.create(), controller = new AbortController();
  const evidence = await reader.verify(controller.signal); x.proof.revision++;
  assert.throws(evidence.assertFresh); Object.assign(x.proof, original); await assert.rejects(reader.verify(signal()));
  const second = x.create(), next = await second.verify(controller.signal); controller.abort(); assert.throws(next.assertFresh);
  const third = x.create(), last = await third.verify(signal()); x.deps.approvals.close(); assert.throws(last.assertFresh);
  assert.deepEqual(x.f.effects.load(x.snapshot.binding.effectClaimKey), { kind: "full", snapshot: x.claim });
});

test("retained native observation changes and committed trust changes invalidate earlier cleanup proof", async t => {
  const x = await fixture(); t.after(x.close);
  const reader = x.create(), evidence = await reader.verify(signal());
  x.f.setNow(x.snapshot.observedAt + 1);
  x.f.nativeRunJournal.update(x.snapshot.binding.runId, x.snapshot.version, { observedAt: x.snapshot.observedAt + 1 });
  assert.throws(evidence.assertFresh);
  x.proof.snapshotDigest = sha256Digest(x.f.nativeRunJournal.load(x.snapshot.binding.runId));
  x.proof.observedAt++; x.proof.revision++;
  const next = x.create(), fresh = await next.verify(signal());
  await x.f.revoke(); assert.throws(fresh.assertFresh);
  assert.deepEqual(x.f.effects.load(x.snapshot.binding.effectClaimKey), { kind: "full", snapshot: x.claim });
});

test("final synchronous cleanup reads cannot borrow an earlier wall-clock or monotonic validity check", async t => {
  const x = await fixture(); t.after(x.close);
  let elapsed = 0; t.mock.method(performance, "now", () => elapsed);
  for (const fault of ["deadline", "expiry", "abort"] as const) {
    let reads = 0; elapsed = 0; const controller = new AbortController();
    x.proof.observedAt = x.f.dependencies.clock!(); x.proof.validUntil = x.proof.observedAt + 10_000;
    const reader = createNativeCleanupEvidence(x.config, { ...x.deps, readSupervisedCleanup() {
      if (++reads === 2) {
        if (fault === "deadline") elapsed = 5000;
        else if (fault === "expiry") x.f.setNow(x.proof.validUntil);
        else controller.abort();
      }
      return x.proof;
    } });
    await assert.rejects(reader.verify(controller.signal), /native_cleanup_evidence_unavailable/);
    assert.equal(reads, 2); reader.close();
  }
  assert.deepEqual(x.f.effects.load(x.snapshot.binding.effectClaimKey), { kind: "full", snapshot: x.claim });
});

test("local settlement joins exact cleanup with execution completion before freeing the effect", async t => {
  const x = await fixture(); t.after(x.close); let drained = false;
  const beforeCalls = [...x.f.calls];
  const settlement = createNativeTaskSettlement(x.config, { ...x.deps, executions: x.f.executions,
    runtime: { async closeForSettlement(bindingDigest) {
      assert.equal(bindingDigest, sha256Digest(x.config.binding)); drained = true;
      return { bindingDigest, descendantsStoppedVerified: false, assertClosed() { assert.equal(drained, true); } };
    } } });
  const receipt = await settlement.settle(signal());
  assert.equal(receipt.localEffectSettled, true); assert.equal(receipt.canonicalCapacityReleased, false);
  assert.equal(receipt.grantsExecutionAuthority, false); assert.equal(receipt.qualityAccepted, false);
  assert.equal(x.f.effects.countActive(x.config.enrollment.tenantId, x.config.enrollment.nodeId), 0);
  assert.equal(x.f.executions.load(x.claim.executionId)?.state, "completed");
  assert.deepEqual(x.f.calls, beforeCalls);
  await assert.rejects(settlement.settle(signal()));
});

test("late cleanup failure retains capacity and reconstruction replays only execution completion", async t => {
  const x = await fixture(); t.after(x.close);
  let failAfterExecution = true, closes = 0;
  const runtime = { async closeForSettlement(bindingDigest: string) {
    closes++; return { bindingDigest, descendantsStoppedVerified: false as const, assertClosed() {} };
  } };
  const deps = { ...x.deps, runtime, executions: x.f.executions, readSupervisedCleanup() {
    if (failAfterExecution && x.f.executions.load(x.claim.executionId)?.state === "completed") {
      throw new Error("synthetic proof lost after execution commit");
    }
    return x.proof;
  } };
  const first = createNativeTaskSettlement(x.config, deps);
  await assert.rejects(first.settle(signal()), /native_task_settlement_unavailable/);
  assert.equal(x.f.executions.load(x.claim.executionId)?.state, "completed");
  assert.deepEqual(x.f.effects.load(x.claim.claimKey), { kind: "full", snapshot: x.claim });
  assert.equal(x.f.effects.countActive(x.config.enrollment.tenantId, x.config.enrollment.nodeId), 1);
  const events = x.f.executions.events(x.claim.executionId), calls = [...x.f.calls];
  failAfterExecution = false;
  const second = createNativeTaskSettlement(x.config, deps);
  assert.equal((await second.settle(signal())).localEffectSettled, true);
  assert.deepEqual(x.f.executions.events(x.claim.executionId), events);
  assert.deepEqual(x.f.calls, calls); assert.equal(closes, 2);
});

test("unproven runtime drainage and cancellation cannot mutate settlement state", async t => {
  const x = await fixture(); t.after(x.close); const execution = x.f.executions.load(x.claim.executionId);
  for (const fault of ["wrong_binding", "close_failed", "not_drained", "cancelled"] as const) {
    const controller = new AbortController();
    const settlement = createNativeTaskSettlement(x.config, { ...x.deps, executions: x.f.executions,
      runtime: { async closeForSettlement(bindingDigest) {
        if (fault === "close_failed") throw new Error("synthetic uncertain close");
        if (fault === "cancelled") controller.abort();
        return { bindingDigest: fault === "wrong_binding" ? sha256Digest("other") : bindingDigest,
          descendantsStoppedVerified: false, assertClosed() { if (fault === "not_drained") throw new Error("still draining"); } };
      } } });
    await assert.rejects(settlement.settle(controller.signal), /native_task_settlement_unavailable/);
    assert.deepEqual(x.f.executions.load(x.claim.executionId), execution);
    assert.deepEqual(x.f.effects.load(x.claim.claimKey), { kind: "full", snapshot: x.claim });
  }
});

test("asynchronous drainage assertions are refused before writes and after the tentative effect write", async t => {
  const x = await fixture(); t.after(x.close); const execution = x.f.executions.load(x.claim.executionId);
  for (const late of [false, true]) {
    const settlement = createNativeTaskSettlement(x.config, { ...x.deps, executions: x.f.executions,
      runtime: { async closeForSettlement(bindingDigest) {
        return { bindingDigest, descendantsStoppedVerified: false, assertClosed() {
          const claim = x.f.effects.load(x.claim.claimKey);
          if (!late || claim?.kind === "full" && claim.snapshot.state === "confirmed")
            return Promise.reject(new Error("async drainage failure")) as unknown as undefined;
        } };
      } } });
    await assert.rejects(settlement.settle(signal()), /native_task_settlement_unavailable/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(x.f.effects.load(x.claim.claimKey), { kind: "full", snapshot: x.claim });
    if (!late) assert.deepEqual(x.f.executions.load(x.claim.executionId), execution);
    else assert.equal(x.f.executions.load(x.claim.executionId)?.state, "completed");
    assert.equal(x.f.effects.countActive(x.config.enrollment.tenantId, x.config.enrollment.nodeId), 1);
  }
});

test("confirmation proof cannot bless another event or a caller-selected post-transition digest", async t => {
  const x = await fixture(); t.after(x.close);
  const first = x.create(), proof = await first.verify(signal());
  assert.throws(() => proof.confirmation.verifyCurrent(sha256Digest("arbitrary target")));
  const second = x.create(), next = await second.verify(signal());
  assert.throws(() => x.f.effects.applyChecked(x.claim.claimKey, { ...next.confirmation.event,
    destinationReceiptDigest: sha256Digest("different evidence") }, next.confirmation));
  assert.deepEqual(x.f.effects.load(x.claim.claimKey), { kind: "full", snapshot: x.claim });
  assert.equal(x.f.effects.countActive(x.config.enrollment.tenantId, x.config.enrollment.nodeId), 1);
});
