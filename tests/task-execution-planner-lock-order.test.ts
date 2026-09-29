import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { HERMES_LOCAL_ADAPTER_V1, HERMES_LOCAL_START_OPERATION_V1 } from "../src/harness/hermes-local-v1";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { interceptNativeQualityDatabase, nativeQualityCompletionFixture } from "./helpers/native-quality-completion";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, enrollment, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { taskDraft } from "./helpers/web-task";

// Canonical write order: parent tenant before the completion-gate integrity row, and both before
// any tenant-FK INSERT. Taking the tenant lock any later would deadlock with task assignment,
// which holds the tenant FOR UPDATE before reading the gate. See COMPLETION_GATE_LOCK_ORDER.md.
function lockOrder(statements: readonly string[]) {
  const tenantLock = statements.findIndex(sql => sql === "SELECT id FROM tenants WHERE id=$1 FOR KEY SHARE");
  const gateLock = statements.findIndex(sql => /control_completion_gate_integrity.*FOR UPDATE/u.test(sql));
  const requestInsert = statements.findIndex(sql => /^INSERT INTO control_requests/u.test(sql));
  return { tenantLock, gateLock, requestInsert };
}

test("planner.plan() takes the tenant key-share before the gate and before its tenant-FK insert", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:hermes-worker",
    allowedOperations: [HERMES_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:hermes-worker"], filesystemRoots: [],
    networkPolicy: "allowlist", allowedNetworkDestinations: [enrollment.canonicalDestination], effectPolicy: "approval_required",
    maxRisk: "low", maxDurationSeconds: 120, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:lock-order-plan", adapter: HERMES_LOCAL_ADAPTER_V1, authority,
    instructions: "Return a bounded plain-text result.", connectorProfileDigest: sha256Digest("lock-order-plan-build"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const statements: string[] = [];
  const tracedDb = interceptNativeQualityDatabase(f.db, sql => statements.push(sql.replace(/\s+/gu, " ").trim()));
  const planner = new TaskExecutionPlanner(tracedDb, f.scope, { template, integrityKey: new Uint8Array(32).fill(61),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints, localAdapterAdmission: { enabledAdapters: [HERMES_LOCAL_ADAPTER_V1] } },
  () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "lock-order-plan-source");
  await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const { tenantLock, gateLock, requestInsert } = lockOrder(statements);
  assert.ok(tenantLock >= 0 && gateLock > tenantLock && requestInsert > gateLock,
    JSON.stringify({ tenantLock, gateLock, requestInsert }));
});

test("planner.revise() takes the tenant key-share before the gate and before its tenant-FK insert", async () => {
  const original = await nativeQualityCompletionFixture();
  try {
    await original.verify();
    // Revisions must not overlap the still-active ownership lease of their source.
    await original.createCompletion().releaseCapacity(original.request, () => {});
    const changeReview = (await original.review("changes_requested")).receipt;
    const statements: string[] = [];
    const tracedDb = interceptNativeQualityDatabase(original.f.db, sql => statements.push(sql.replace(/\s+/gu, " ").trim()));
    const planner = new TaskExecutionPlanner(tracedDb, original.f.scope, original.f.plannerConfig, original.f.clock, original.f.ownerConfig);
    await planner.revise(original.f.identity, original.registration.projectId, original.registration.jobId,
      { runId: original.registration.id, targetId: original.target.id, targetDigest: original.request.targetDigest,
        contentHash: original.artifact.contentHash, reviewId: changeReview.reviewId, feedback: "Please improve the evidence." },
      new AbortController().signal);
    const { tenantLock, gateLock, requestInsert } = lockOrder(statements);
    assert.ok(tenantLock >= 0 && gateLock > tenantLock && requestInsert > gateLock,
      JSON.stringify({ tenantLock, gateLock, requestInsert }));
  } finally { await original.close(); }
});
