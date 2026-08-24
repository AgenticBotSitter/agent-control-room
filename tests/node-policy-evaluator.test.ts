import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security/index.ts";
import {
  NODE_POLICY_CONTRACT_V1,
  buildWireDenialReceipt,
  computeArtifactBodyDigest,
  computeNormalizedOperationDigest,
  evaluateLocalPolicy,
  signArtifact,
  type LocalPolicyEvaluationInputV1,
  type NodeAuthorityCeilingV1,
  type OwnerApprovalAttestationBodyV1,
} from "../src/node-policy/v1/index.ts";
import { MutableTestClock } from "../src/node-policy/v1/testing.ts";
import type { AuthorityEnvelope } from "../src/domain/v1/index.ts";

const now = "2026-08-23T12:00:00.000Z";
const leaseExpiry = "2026-08-23T12:30:00.000Z";
const authorityExpiry = "2026-08-23T13:00:00.000Z";
const digestA = `sha256:${"a".repeat(64)}`;

function withArtifactDigest<T extends object>(material: T): T & { bodyDigest: string } {
  return { ...material, bodyDigest: computeArtifactBodyDigest(material) };
}

function authority(overrides: Partial<Omit<AuthorityEnvelope, "digest">> = {}): AuthorityEnvelope {
  const material = {
    projectId: "project:alpha",
    allowedExecutor: "executor:local",
    allowedOperations: ["operation:read", "operation:upload"],
    credentialRefs: ["credential:publish"],
    filesystemRoots: ["C:\\ControlRoom"],
    networkPolicy: "allowlist" as const,
    allowedNetworkDestinations: ["https://api.example.test:443"],
    effectPolicy: "preauthorized" as const,
    maxRisk: "high" as const,
    maxDurationSeconds: 600,
    maxConcurrentEffects: 2,
    expiresAt: authorityExpiry,
    ...overrides,
  };
  const result = { ...material, digest: "" } as AuthorityEnvelope;
  result.digest = computeAuthorityDigest(result);
  return result;
}

function ceiling(overrides: Partial<Omit<NodeAuthorityCeilingV1, "bodyDigest">> = {}): NodeAuthorityCeilingV1 {
  return withArtifactDigest({
    schema: "control-room.node-authority-ceiling/v1" as const,
    tenantId: "tenant:owner",
    nodeId: "node:marvin",
    version: 1,
    issuedAt: now,
    issuerKeyId: "owner-key:ceiling:1",
    projectIds: ["project:alpha"],
    executorIds: ["executor:local"],
    operationIds: ["operation:read", "operation:upload"],
    credentialRefs: ["credential:publish"],
    filesystemRoots: ["C:\\ControlRoom"],
    networkDestinations: ["https://api.example.test:443"],
    maxRisk: "high" as const,
    externalEffects: "preauthorized" as const,
    maxDurationSeconds: 600,
    maxConcurrentEffects: 2,
    ...overrides,
  });
}

function fixture(): LocalPolicyEvaluationInputV1 {
  const leaseAuthority = authority();
  const request: LocalPolicyEvaluationInputV1["request"] = {
      contractVersion: NODE_POLICY_CONTRACT_V1,
      requestId: "request:policy:1",
      tenantId: "tenant:owner",
      nodeId: "node:marvin",
      nodeClass: "personal-compute",
      projectId: "project:alpha",
      jobId: "job:alpha",
      attemptId: "attempt:alpha:1",
      leaseId: "lease:alpha:1",
      leaseEpoch: 1,
      executorId: "executor:local",
      operationId: "operation:read",
      operationDigest: digestA,
      authorityDigest: leaseAuthority.digest,
      credentialRefs: [],
      target: { kind: "none" },
      risk: "low",
      externalEffect: false,
      estimatedDurationSeconds: 60,
      occurredAt: now,
  };
  request.operationDigest = computeNormalizedOperationDigest(request);
  return {
    request,
    ceiling: ceiling(),
    lease: {
      tenantId: "tenant:owner",
      nodeId: "node:marvin",
      jobId: "job:alpha",
      attemptId: "attempt:alpha:1",
      leaseId: "lease:alpha:1",
      leaseEpoch: 1,
      validFrom: now,
      expiresAt: leaseExpiry,
      authorityDigest: leaseAuthority.digest,
      authority: leaseAuthority,
      parentAuthorities: [],
    },
    executor: {
      contractVersion: NODE_POLICY_CONTRACT_V1,
      executorId: "executor:local",
      operationIds: ["operation:read", "operation:upload"],
      externalEffectOperationIds: ["operation:upload"],
      targetKinds: ["filesystem", "network", "none"],
      supportsCancellation: true,
      supportsNetworkIdentityEnforcement: true,
      costMeter: "monotonic_reservable",
    },
    keyAvailability: { state: "available", keyReferenceId: "key-reference:node:1", observedAt: now },
    activeExternalEffects: 0,
  };
}

function bindOperation(input: LocalPolicyEvaluationInputV1): LocalPolicyEvaluationInputV1 {
  const request = { ...input.request };
  request.operationDigest = computeNormalizedOperationDigest(request);
  return { ...input, request };
}

function withAuthority(input: LocalPolicyEvaluationInputV1, next: AuthorityEnvelope): LocalPolicyEvaluationInputV1 {
  return bindOperation({
    ...input,
    request: { ...input.request, authorityDigest: next.digest },
    lease: { ...input.lease, authority: next, authorityDigest: next.digest },
  });
}

function decide(input: LocalPolicyEvaluationInputV1) {
  return evaluateLocalPolicy(input, new MutableTestClock(now));
}

function assertDenied(input: LocalPolicyEvaluationInputV1, detail: string): void {
  const decision = decide(input);
  assert.equal(decision.accepted, false);
  if (!decision.accepted) assert.equal(decision.detail, detail);
}

test("a fully contained request is accepted with deterministic local evidence", () => {
  const input = fixture();
  const decision = decide(input);
  assert.equal(decision.accepted, true);
  assert.equal(decision.requestDigest, sha256Digest(input.request));
  assert.equal(decision.ceilingDigest, input.ceiling.bodyDigest);
  assert.equal(decision.authorityDigest, input.lease.authority.digest);
  assert.equal(decision.decidedAt, now);
  assert.deepEqual(decide(input), decision);
});

test("tenant, node, job, attempt, lease, epoch, project, and digest bindings are exact", () => {
  const base = fixture();
  for (const changed of [
    { ...base, request: { ...base.request, tenantId: "tenant:other" } },
    { ...base, request: { ...base.request, nodeId: "node:other" } },
    { ...base, request: { ...base.request, jobId: "job:other" } },
    { ...base, request: { ...base.request, attemptId: "attempt:other" } },
    { ...base, request: { ...base.request, leaseId: "lease:other" } },
    { ...base, request: { ...base.request, leaseEpoch: 2 } },
    { ...base, request: { ...base.request, projectId: "project:other" } },
    { ...base, request: { ...base.request, authorityDigest: `sha256:${"b".repeat(64)}` } },
  ]) assertDenied(changed, "authority_invalid");
});

test("future and expired local authority windows deny from the injected clock", () => {
  const base = fixture();
  assertDenied({ ...base, lease: { ...base.lease, validFrom: "2026-08-23T12:01:00.000Z" } }, "authority_not_yet_valid");
  assertDenied({
    ...base,
    lease: { ...base.lease, validFrom: "2026-08-23T11:00:00.000Z", expiresAt: "2026-08-23T11:59:00.000Z" },
  }, "authority_expired");
  assertDenied({ ...base, keyAvailability: { ...base.keyAvailability, observedAt: "2026-08-23T12:01:00.000Z" } }, "authority_not_yet_valid");
});

test("valid online authority still cannot widen any owner-ceiling dimension", () => {
  const base = fixture();
  const extraOperation = withAuthority({
    ...base,
    request: { ...base.request, operationId: "operation:admin" },
    executor: { ...base.executor, operationIds: ["operation:admin", ...base.executor.operationIds] },
  }, authority({ allowedOperations: ["operation:admin", "operation:read", "operation:upload"] }));
  assertDenied(extraOperation, "operation_not_allowed");

  assertDenied(withAuthority({ ...base, request: { ...base.request, credentialRefs: ["credential:other"] } }, authority({
    credentialRefs: ["credential:other", "credential:publish"],
  })), "credential_not_allowed");
  assertDenied(withAuthority({ ...base, request: { ...base.request, risk: "critical" } }, authority({ maxRisk: "critical" })), "risk_exceeded");
  assertDenied(withAuthority({ ...base, request: { ...base.request, estimatedDurationSeconds: 601 } }, authority({ maxDurationSeconds: 1_000 })), "duration_exceeded");

  const network = withAuthority({
    ...base,
    request: {
      ...base.request, operationId: "operation:upload", externalEffect: true,
      target: { kind: "network", canonicalDestination: "https://other.example.test:443" },
    },
  }, authority({ allowedNetworkDestinations: ["https://other.example.test:443"] }));
  assertDenied(network, "network_destination_not_allowed");

  const noEffectsCeiling = ceiling({ externalEffects: "none", maxConcurrentEffects: 0, networkDestinations: [] });
  assertDenied(bindOperation({ ...base, ceiling: noEffectsCeiling, request: { ...base.request, operationId: "operation:upload", externalEffect: true } }), "effect_policy_exceeded");
});

test("delegated authority chains can narrow but cannot expand or detach", () => {
  const root = authority({ allowedOperations: ["operation:read", "operation:upload"] });
  const child = authority({ allowedOperations: ["operation:read"], parentDigest: root.digest });
  let input = withAuthority(fixture(), child);
  input = { ...input, lease: { ...input.lease, parentAuthorities: [root] } };
  assert.equal(decide(input).accepted, true);

  const narrowRoot = authority({ allowedOperations: ["operation:read"] });
  const widerChild = authority({ allowedOperations: ["operation:read", "operation:upload"], parentDigest: narrowRoot.digest });
  input = withAuthority(fixture(), widerChild);
  input = { ...input, lease: { ...input.lease, parentAuthorities: [narrowRoot] } };
  assertDenied(input, "authority_invalid");

  const detached = authority({ allowedOperations: ["operation:read"], parentDigest: `sha256:${"c".repeat(64)}` });
  assertDenied(withAuthority(fixture(), detached), "authority_invalid");
});

test("effect classification, approval, expiry, cost, concurrency, and key availability fail closed", () => {
  const base = fixture();
  assertDenied(bindOperation({ ...base, request: { ...base.request, externalEffect: true } }), "authority_invalid");
  assertDenied({ ...base, keyAvailability: { ...base.keyAvailability, state: "locked" } }, "keystore_unavailable");

  const effect = bindOperation({
    ...base,
    ceiling: ceiling({ externalEffects: "approval_required" }),
    request: { ...base.request, operationId: "operation:upload", externalEffect: true },
  } satisfies LocalPolicyEvaluationInputV1);
  assertDenied(effect, "approval_missing");
  assertDenied({ ...effect, activeExternalEffects: 2 }, "concurrency_exceeded");

  const approvalKeys = generateKeyPairSync("ed25519");
  const publicKeySpki = approvalKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const approvalBody: OwnerApprovalAttestationBodyV1 = withArtifactDigest({
    schema: "control-room.owner-approval-attestation/v1" as const,
    tenantId: effect.request.tenantId,
    nodeId: effect.request.nodeId,
    projectId: effect.request.projectId,
    jobId: effect.request.jobId,
    attemptId: effect.request.attemptId,
    operationDigest: effect.request.operationDigest,
    risk: effect.request.risk,
    decision: "approved" as const,
    issuedAt: now,
    expiresAt: "2026-08-23T12:01:00.000Z",
    nonce: "approval_nonce_1234567890",
    approvalKeyId: "approval-key:owner:1",
  });
  const approved = {
    ...effect,
    request: { ...effect.request, approval: signArtifact(approvalBody, approvalKeys.privateKey) },
    approvalKey: { keyId: "approval-key:owner:1", publicKeySpki },
  } satisfies LocalPolicyEvaluationInputV1;
  assert.equal(decide(approved).accepted, true);
  assertDenied({ ...approved, approvalKey: { ...approved.approvalKey, keyId: "approval-key:other" } }, "approval_invalid");

  const costAuthority = authority({ maxCostUsd: 2 });
  const cost = withAuthority({
    ...base,
    ceiling: ceiling({ maxCostUsd: "3" }),
    request: { ...base.request, estimatedCostUsd: "1.5" },
  }, costAuthority);
  assert.equal(decide(cost).accepted, true);
  assertDenied({ ...cost, executor: { ...cost.executor, costMeter: "none" } }, "cost_unmeasurable");
  assertDenied(bindOperation({ ...cost, request: { ...cost.request, estimatedCostUsd: "2.5" } }), "cost_exceeded");
  const unmeasured = withAuthority({ ...base, ceiling: ceiling({ maxCostUsd: "3" }) }, costAuthority);
  assertDenied(unmeasured, "cost_unmeasurable");
});

test("wire denial receipts contain only server-known references and a coarse category", () => {
  const input = { ...fixture(), keyAvailability: { ...fixture().keyAvailability, state: "missing" as const } };
  const decision = decide(input);
  assert.equal(decision.accepted, false);
  if (decision.accepted) return;
  const receipt = buildWireDenialReceipt(decision, {
    receiptId: "receipt:policy:1",
    relatedMessageId: "message:offer:1",
    jobId: input.request.jobId,
    attemptId: input.request.attemptId,
    occurredAt: now,
  });
  assert.deepEqual(receipt, {
    contractVersion: NODE_POLICY_CONTRACT_V1,
    receiptId: "receipt:policy:1",
    relatedMessageId: "message:offer:1",
    jobId: "job:alpha",
    attemptId: "attempt:alpha:1",
    category: "maintenance",
    occurredAt: now,
  });
  const serialized = JSON.stringify(receipt);
  for (const forbidden of [decision.detail, decision.requestDigest, decision.ceilingDigest, input.ceiling.filesystemRoots[0]]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
