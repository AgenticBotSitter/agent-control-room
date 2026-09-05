import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { prepareNativeTaskApproval, verifyNativeTaskApprovalBinding } from "../src/harness/hermes-native-v1/task-approval-binding";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { enrollment, instant } from "./hermes-native-fixture";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { computeArtifactBodyDigest, computeNormalizedOperationDigest, evaluateLocalPolicy, signArtifact,
  createExecutionAuthoritySnapshot, applyExecutionAuthorityEvent, createPreEffectMarker, SqliteEffectClaimStore,
  type LocalPolicyEvaluationInputV1, type OwnerApprovalAttestationBodyV1 } from "../src/node-policy/v1";

async function fixture() {
  const f = await taskAssignmentFixture();
  const assigned = (await f.assign()).receipt, canonical = new CanonicalStore(f.db);
  const job = await canonical.get(f.scope.tenantId, "job", assigned.jobId);
  const attempt = await canonical.get(f.scope.tenantId, "attempt", assigned.attemptId);
  const lease = await canonical.get(f.scope.tenantId, "lease", assigned.leaseId);
  const plan = await f.planner.read(assigned.jobId); assert.ok(plan);
  const input = { job, attempt, lease, input: plan.input, enrollment, nodeClass: "personal-compute", now: instant + 9000 };
  const prepared = prepareNativeTaskApproval(input);
  return { ...f, assigned, input, prepared, authority: plan.job.authority };
}

test("canonical assignment produces exact native approval material with stable effect and session identity", async t => {
  const f = await fixture(); t.after(f.close);
  const p = f.prepared;
  assert.equal(p.startsWork, false); assert.equal(p.grantsExecutionAuthority, false);
  assert.equal(p.request.operationDigest, computeNormalizedOperationDigest(p.request));
  assert.equal(p.binding.requestDigest, sha256Digest(p.body));
  assert.deepEqual(verifyNativeTaskApprovalBinding(enrollment, p.request, p.start).binding, p.binding);
  const later = prepareNativeTaskApproval({ ...f.input, now: instant + 10000 });
  assert.equal(later.start.effectClaimKey, p.start.effectClaimKey); assert.equal(later.binding.sessionId, p.binding.sessionId);
  assert.equal(later.request.operationDigest, p.request.operationDigest);
  assert.notEqual(later.request.occurredAt, p.request.occurredAt);
});

test("native payload, destination, model, qualification, lease and authority changes cannot retain an approval binding", async t => {
  const f = await fixture(); t.after(f.close); const p = f.prepared;
  for (const change of [{ prompt: "Changed prompt" }, { instructions: "Changed instructions" }, { deadline: p.start.deadline - 1 },
    { effectClaimKey: sha256Digest("wrong") }, { runId: "run:wrong" }, { nodeId: "node:wrong" }])
    assert.throws(() => verifyNativeTaskApprovalBinding(enrollment, p.request, { ...p.start, ...change }), /binding_invalid/);
  for (const change of [{ model: "other-model" }, { provider: "other" }, { canonicalDestination: "https://other.example.test:443" },
    { qualificationDigest: sha256Digest("other") }, { profile: "other" }, { profilePolicyDigest: sha256Digest("other") }])
    assert.throws(() => verifyNativeTaskApprovalBinding({ ...enrollment, ...change }, p.request, p.start), /binding_invalid/);
  for (const change of [{ leaseId: "lease:other" }, { leaseEpoch: p.request.leaseEpoch + 1 }, { authorityDigest: sha256Digest("other") },
    { payloadDigest: undefined }, { payloadDigest: "malformed" }])
    assert.throws(() => verifyNativeTaskApprovalBinding(enrollment, { ...p.request, ...change }, p.start), /binding_invalid/);
});

test("builder rejects mismatched or non-executable canonical reservations and unsupported authority", async t => {
  const f = await fixture(); t.after(f.close);
  const job = f.input.job!, attempt = f.input.attempt!, lease = f.input.lease!;
  for (const change of [{ job: { ...job, state: "proposed" } }, { job: { ...job, inputDigest: sha256Digest("other") } },
    { attempt: { ...attempt, nodeId: "node:other" } }, { attempt: { ...attempt, attemptNumber: 2 } },
    { lease: { ...lease, state: "expired" } }, { lease: { ...lease, epoch: 2 } }, { lease: { ...lease, jobId: "job:other" } },
    { now: f.prepared.start.deadline }, { now: Number.NaN }, { input: { prompt: "Changed", instructions: "" } }])
    assert.throws(() => prepareNativeTaskApproval({ ...f.input, ...change }), /binding_invalid/);
  for (const patch of [{ effectPolicy: "preauthorized" }, { maxCostUsd: 1 }, { allowedOperations: ["other"] }, { maxDurationSeconds: 301 }]) {
    const authority = { ...f.authority, ...patch } as typeof f.authority;
    authority.digest = computeAuthorityDigest(authority);
    assert.throws(() => prepareNativeTaskApproval({ ...f.input, job: { ...job, authority } }), /binding_invalid/);
  }
});

test("real owner signature accepts only the exact native payload through the existing local evaluator", async t => {
  const f = await fixture(); t.after(f.close); const p = f.prepared;
  const at = new Date(f.input.now).toISOString(), expiresAt = new Date(p.start.deadline).toISOString();
  const keys = generateKeyPairSync("ed25519"), otherKeys = generateKeyPairSync("ed25519");
  const approvalBody: OwnerApprovalAttestationBodyV1 = { schema: "control-room.owner-approval-attestation/v1",
    tenantId: p.request.tenantId, nodeId: p.request.nodeId, projectId: p.request.projectId, jobId: p.request.jobId,
    attemptId: p.request.attemptId, operationDigest: p.request.operationDigest, risk: "low", decision: "approved",
    issuedAt: at, expiresAt, nonce: "c3ludGhldGljLW5vbmNl", approvalKeyId: "approval-key:test", bodyDigest: "" };
  approvalBody.bodyDigest = computeArtifactBodyDigest(approvalBody);
  const ceiling = { schema: "control-room.node-authority-ceiling/v1" as const, tenantId: p.request.tenantId, nodeId: p.request.nodeId,
    version: 1, issuedAt: at, issuerKeyId: "owner-key:test", projectIds: [p.request.projectId], executorIds: [p.request.executorId],
    operationIds: [p.request.operationId], credentialRefs: p.request.credentialRefs, filesystemRoots: [],
    networkDestinations: [enrollment.canonicalDestination], maxRisk: "low" as const, externalEffects: "approval_required" as const,
    maxDurationSeconds: 60, maxConcurrentEffects: 1, bodyDigest: "" };
  ceiling.bodyDigest = computeArtifactBodyDigest(ceiling);
  const evaluation: LocalPolicyEvaluationInputV1 = { request: { ...p.request, approval: signArtifact(approvalBody, keys.privateKey) }, ceiling,
    lease: { tenantId: p.request.tenantId, nodeId: p.request.nodeId, jobId: p.request.jobId, attemptId: p.request.attemptId,
      leaseId: p.request.leaseId, leaseEpoch: p.request.leaseEpoch, validFrom: at, expiresAt,
      authorityDigest: f.authority.digest, authority: f.authority, parentAuthorities: [] },
    executor: { contractVersion: "control-room-node-policy/v1", executorId: p.request.executorId, operationIds: [p.request.operationId],
      externalEffectOperationIds: [p.request.operationId], targetKinds: ["network"], supportsCancellation: true,
      supportsNetworkIdentityEnforcement: true, costMeter: "none" },
    keyAvailability: { state: "available", keyReferenceId: "key:test", observedAt: at }, activeExternalEffects: 0,
    approvalKey: { keyId: approvalBody.approvalKeyId, publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url") } };
  const clock = { now: () => at };
  const accepted = evaluateLocalPolicy(evaluation, clock);
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  assert.equal(evaluateLocalPolicy({ ...evaluation, request: p.request }, clock).accepted, false);
  const unbound = { ...evaluation.request, payloadDigest: undefined };
  unbound.operationDigest = computeNormalizedOperationDigest(unbound);
  assert.equal(evaluateLocalPolicy({ ...evaluation, request: unbound }, clock).accepted, false);
  assert.equal(evaluateLocalPolicy({ ...evaluation, request: { ...evaluation.request, approval: signArtifact(approvalBody, otherKeys.privateKey) } }, clock).accepted, false);
  const changed = { ...evaluation.request, payloadDigest: sha256Digest("changed input") };
  changed.operationDigest = computeNormalizedOperationDigest(changed);
  assert.equal(evaluateLocalPolicy({ ...evaluation, request: changed }, clock).accepted, false);
  assert.equal(evaluateLocalPolicy(evaluation, { now: () => expiresAt }).accepted, false);
});

test("durable pre-effect marker retains payload commitment and rejects tampering without creating another effect", async t => {
  const f = await fixture(); t.after(f.close); const p = f.prepared;
  const store = new SqliteEffectClaimStore(":memory:", { testOnlyAllowEphemeral: true }); t.after(() => store.close());
  const at = new Date(f.input.now).toISOString(), deadline = new Date(p.start.deadline).toISOString();
  const admitted = createExecutionAuthoritySnapshot({ executionId: "execution:native:test", admissionId: "admission:native:test",
    identity: { tenantId: p.request.tenantId, nodeId: p.request.nodeId, projectId: p.request.projectId, jobId: p.request.jobId,
      attemptId: p.request.attemptId, operationDigest: p.request.operationDigest },
    authorityDigest: p.request.authorityDigest, createdAt: at, leaseEpoch: p.request.leaseEpoch,
    deadlineSources: { admittedAt: at, ceilingDurationSeconds: 60, authorityDurationSeconds: 60,
      authorityExpiresAt: f.authority.expiresAt, leaseExpiresAt: deadline } });
  const execution = applyExecutionAuthorityEvent(admitted, { eventId: "event:native:start", kind: "start", occurredAt: at }).snapshot;
  const claimed = store.claim({ messageId: "message:native:test", execution, claimedAt: at });
  assert.equal(claimed.lookup.kind, "full"); if (claimed.lookup.kind !== "full") assert.fail();
  const marker = createPreEffectMarker({ markerId: "marker:native:test", claim: claimed.lookup.snapshot,
    request: p.request, authorityDigest: p.request.authorityDigest, effectiveDeadline: deadline, markedAt: at });
  assert.equal(marker.operation.payloadDigest, p.request.payloadDigest);
  assert.throws(() => store.commitPreEffectMarker({ ...marker, operation: { ...marker.operation, payloadDigest: sha256Digest("changed") } }));
  store.commitPreEffectMarker(marker);
  assert.equal(store.claim({ messageId: "message:native:duplicate", execution, claimedAt: at }).disposition, "in_progress");
});
