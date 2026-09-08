import test from "node:test";
import assert from "node:assert/strict";
import { nativeNodeRuntimeFixture } from "./helpers/native-node-runtime";
import { currentSignal } from "./helpers/managed-native-session";
import { readNativeRestartInventory } from "../src/harness/hermes-native-v1/restart-inventory";
import { syntheticCleanupEvidence } from "./helpers/native-cleanup-evidence";
import { createNativeTaskSettlement } from "../src/harness/hermes-native-v1/task-settlement";
import { qualityText } from "./helpers/native-quality-completion";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { createLeaseAwareNativeNodeRuntime, type LeaseAwareNativeNodeRuntimeDependencies } from "../src/harness/hermes-native-v1/node-runtime";

type Fixture = Awaited<ReturnType<typeof nativeNodeRuntimeFixture>>;
function sources(f: Fixture) {
  return { bridge: f.journal, runs: f.x.local.journal, effects: f.x.local.effects, executions: f.x.local.executions };
}
function scope(f: Fixture) { return { tenantId: f.config.enrollment.tenantId, nodeId: f.config.enrollment.nodeId }; }

test("restart inventory follows actual delivery, run, retained result and checked historical settlement", async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { leaseAware: true }); t.after(f.close);
  const inspect = () => readNativeRestartInventory(scope(f), sources(f), currentSignal());
  assert.equal(inspect().status, "no_unresolved_local_work");
  const c = await f.connect(); await f.dispatch(c);
  assert.deepEqual(inspect().pending, [{ queueId: f.queued.queueId, runId: f.x.f.prepared.binding.runId, reason: "delivery_without_run" }]);
  assert.throws(() => f.createLeaseAware(), /restart_reconciliation_required/);
  await f.x.admin(() => f.runtime.start(currentSignal())); await f.pump(c);
  assert.equal(inspect().pending[0].reason, "unsettled_run"); assert.equal(inspect().activeEffects, 1);
  f.advance(); f.setResult(qualityText);
  await f.x.admin(() => f.runtime.poll(currentSignal())); await f.pump(c);
  assert.equal(inspect().status, "reconciliation_required");
  assert.throws(() => f.createLeaseAware(), /restart_reconciliation_required/);
  const cleanup = syntheticCleanupEvidence({ enrollment: f.config.enrollment, binding: f.x.f.prepared.binding,
    runs: f.x.local.journal, effects: f.x.local.effects, security: f.x.f.native.trust, clock: f.x.f.clock }); t.after(cleanup.close);
  await createNativeTaskSettlement(cleanup.config, { ...cleanup.deps, effects: f.x.local.effects,
    executions: f.x.local.executions, runtime: f.runtime }).settle(currentSignal());
  const final = inspect();
  assert.equal(final.status, "no_unresolved_local_work"); assert.equal(final.activeEffects, 0);
  assert.deepEqual(final.settledRunIds, [f.x.f.prepared.binding.runId]);
  assert.equal(final.permitsFreshPickup, false); assert.equal(final.currentCleanupVerified, false);
  assert.equal(final.grantsExecutionAuthority, false);
  // A completed run and zero active claims are insufficient when retained
  // settlement evidence cannot be read. Do not erase it from pending work.
  let failedHistoryReads = 0;
  const unavailableHistory = readNativeRestartInventory(scope(f), { ...sources(f),
    executions: { load: f.x.local.executions.load.bind(f.x.local.executions), events() {
      failedHistoryReads++; throw new Error("synthetic unavailable settlement history");
    } } }, currentSignal());
  assert.ok(failedHistoryReads > 0);
  assert.equal(unavailableHistory.activeEffects, 0);
  assert.equal(unavailableHistory.status, "reconciliation_required");
  assert.deepEqual(unavailableHistory.settledRunIds, []);
  assert.deepEqual(unavailableHistory.pending, [{ runId: f.x.f.prepared.binding.runId,
    queueId: f.queued.queueId, reason: "unsettled_run" }]);
  assert.equal(unavailableHistory.permitsFreshPickup, false);
  assert.equal(unavailableHistory.currentCleanupVerified, false);
  assert.equal(unavailableHistory.grantsExecutionAuthority, false);
  const next = f.createLeaseAware(); assert.equal(next.hasAcceptedDispatch(), false); await next.close();
  const serialized = JSON.stringify(final) + JSON.stringify(f.x.local.journal.inventory()) + JSON.stringify(f.journal.nativeRestartInventory());
  assert.equal(serialized.includes(qualityText), false); assert.equal(serialized.includes("resultText"), false);
  assert.equal(serialized.includes("prompt"), false); assert.equal(serialized.includes("approval"), false);
});

test("restart inspection and runtime use the same captured resources despite caller-container mutation", async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { leaseAware: true }); t.after(f.close);
  const actual = f.x.local.journal.inventory.bind(f.x.local.journal);
  const deps: LeaseAwareNativeNodeRuntimeDependencies = { ...f.dependencies, runs: f.x.local.journal,
    security: { ...f.dependencies.security, loadCeiling: f.x.f.native.trust.loadCeiling.bind(f.x.f.native.trust),
      currentPolicyRevision: f.x.f.native.trust.currentPolicyRevision.bind(f.x.f.native.trust) },
    local: { ...f.x.local.dependencies, effects: f.x.local.effects, executions: f.x.local.executions },
    keys: { async availability() { return f.x.local.policy.keyAvailability; } }, localPaused: () => false };
  const policy = { executor: structuredClone(f.x.local.policy.executor), nodeClass: "personal-compute", nodeSigningKeyReferenceId: "key:test", parentAuthorities: [] };
  const poison = new Proxy({}, { get() { throw new Error("synthetic swapped store"); } });
  let reads = 0;
  f.x.local.journal.inventory = () => {
    reads++;
    deps.runs = poison as typeof deps.runs; deps.journal = poison as typeof deps.journal;
    deps.local.effects = poison as typeof deps.local.effects; deps.local.executions = poison as typeof deps.local.executions;
    policy.nodeSigningKeyReferenceId = "key:changed";
    return actual();
  };
  let runtime: ReturnType<typeof createLeaseAwareNativeNodeRuntime>;
  try { runtime = createLeaseAwareNativeNodeRuntime(f.unassignedConfig, policy, deps); }
  finally { f.x.local.journal.inventory = actual; }
  t.after(() => runtime.close()); assert.equal(reads, 2);
  const c = await f.connect("initial", runtime); await f.dispatch(c);
  assert.equal((await f.x.admin(() => runtime.start(currentSignal()))).state, "queued");
  await f.pump(c);
  assert.equal(f.x.local.calls.filter(call => call === "start").length, 1);
});

test("bridge inventory checks every retained attempt and refuses oversized inventory", () => {
  const journal = new SqliteBridgeJournal(":memory:");
  try {
    const summary = { attemptId: "attempt:0", jobId: "job:test", leaseId: "lease:test", leaseEpoch: 1,
      state: "leased" as const, lastEventSequence: 0, checkpointIds: [] };
    journal.upsertAttempt({ ...summary, lastEventSequence: 0.5 }, "2026-09-08T00:00:00.000Z");
    assert.throws(() => journal.nativeRestartInventory());
    journal.upsertAttempt(summary, "2026-09-08T00:00:00.000Z");
    assert.equal(journal.nativeRestartInventory().attempts.length, 1);
    for (let index = 1; index <= 1024; index++) journal.upsertAttempt({ ...summary, attemptId: `attempt:${index}` }, "2026-09-08T00:00:00.000Z");
    assert.throws(() => journal.nativeRestartInventory(), /ceiling/);
  } finally { journal.close(); }
});

test("orphan run and unknown bridge attempt are reconciliation requirements, never an empty inventory", async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { leaseAware: true }); t.after(f.close);
  const binding = f.x.f.prepared.binding;
  f.x.local.journal.reserve(binding, f.x.f.clock());
  f.journal.upsertAttempt({ attemptId: "attempt:unknown", jobId: "job:unknown", leaseId: "lease:unknown", leaseEpoch: 1,
    state: "leased", lastEventSequence: 0, checkpointIds: [] }, new Date(f.x.f.clock()).toISOString());
  const result = readNativeRestartInventory(scope(f), sources(f), currentSignal());
  assert.equal(result.status, "reconciliation_required"); assert.equal(result.unknownAttempts, 1);
  assert.deepEqual(result.pending, [{ runId: binding.runId, queueId: null, reason: "run_without_delivery" }]);
  assert.equal(result.permitsFreshPickup, false);
  assert.throws(() => f.createLeaseAware(), /restart_reconciliation_required/);
});

test("cross-store mutation, mixed scope and cancellation refuse a restart classification", async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { leaseAware: true }); t.after(f.close);
  const deps = sources(f); let reads = 0;
  assert.throws(() => readNativeRestartInventory(scope(f), { ...deps, bridge: { nativeRestartInventory() {
    if (++reads === 2) f.x.local.journal.reserve(f.x.f.prepared.binding, f.x.f.clock());
    return f.journal.nativeRestartInventory();
  } } }, currentSignal()), /native_restart_inventory_unavailable/);
  assert.throws(() => readNativeRestartInventory({ ...scope(f), nodeId: "node:other" }, deps, currentSignal()), /unavailable/);
  assert.throws(() => readNativeRestartInventory(scope(f), deps, AbortSignal.abort()), /unavailable/);
});
