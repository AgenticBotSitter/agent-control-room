import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeAuthorityDigest } from "../src/security/index.ts";
import {
  AdmissionConflictError,
  NODE_POLICY_CONTRACT_V1,
  SqliteLocalAdmissionStore,
  computeArtifactBodyDigest,
  computeNormalizedOperationDigest,
  type LocalPolicyDecisionV1,
  type LocalPolicyEvaluationInputV1,
} from "../src/node-policy/v1/index.ts";
import { DurablePolicyCommandHandler } from "../src/node-bridge/index.ts";
import type { SignedNodeFrame } from "../src/node-protocol/v1/index.ts";

const now = "2026-08-23T12:00:00.000Z";
const hash = (character: string) => `sha256:${character.repeat(64)}`;
const identity = {
  tenantId: "tenant:owner", nodeId: "node:marvin", projectId: "project:alpha",
  jobId: "job:alpha", attemptId: "attempt:alpha:1", operationDigest: hash("a"),
};

function decision(accepted: boolean, marker = "a"): LocalPolicyDecisionV1 {
  const base = {
    contractVersion: NODE_POLICY_CONTRACT_V1, requestId: "request:alpha", requestDigest: hash(marker),
    ceilingDigest: hash("c"), authorityDigest: hash("d"), decidedAt: now,
  } as const;
  return accepted ? { ...base, accepted: true } : { ...base, accepted: false, detail: "operation_not_allowed", wireCategory: "policy" };
}

function evaluation(keyState: "available" | "locked" = "available"): LocalPolicyEvaluationInputV1 {
  const authority = {
    projectId: "project:alpha", allowedExecutor: "executor:local", allowedOperations: ["operation:read"],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "none" as const, allowedNetworkDestinations: [],
    effectPolicy: "none" as const, maxRisk: "low" as const, maxDurationSeconds: 300,
    maxConcurrentEffects: 0, expiresAt: "2026-08-23T13:00:00.000Z", digest: "",
  };
  authority.digest = computeAuthorityDigest(authority);
  const request: LocalPolicyEvaluationInputV1["request"] = {
    contractVersion: NODE_POLICY_CONTRACT_V1, requestId: "request:alpha", tenantId: "tenant:owner",
    nodeId: "node:marvin", nodeClass: "personal-compute", projectId: "project:alpha", jobId: "job:alpha",
    attemptId: "attempt:alpha:1", leaseId: "lease:alpha:1", leaseEpoch: 1, executorId: "executor:local",
    operationId: "operation:read", operationDigest: hash("a"), authorityDigest: authority.digest,
    credentialRefs: [], target: { kind: "none" }, risk: "low", externalEffect: false,
    estimatedDurationSeconds: 30, occurredAt: now,
  };
  request.operationDigest = computeNormalizedOperationDigest(request);
  const ceilingMaterial = {
    schema: "control-room.node-authority-ceiling/v1" as const, tenantId: "tenant:owner", nodeId: "node:marvin",
    version: 1, issuedAt: now, issuerKeyId: "owner-key:ceiling:1", projectIds: ["project:alpha"],
    executorIds: ["executor:local"], operationIds: ["operation:read"], credentialRefs: [], filesystemRoots: [],
    networkDestinations: [], maxRisk: "low" as const, externalEffects: "none" as const,
    maxDurationSeconds: 300, maxConcurrentEffects: 0,
  };
  return {
    request, ceiling: { ...ceilingMaterial, bodyDigest: computeArtifactBodyDigest(ceilingMaterial) },
    lease: {
      tenantId: "tenant:owner", nodeId: "node:marvin", jobId: "job:alpha", attemptId: "attempt:alpha:1",
      leaseId: "lease:alpha:1", leaseEpoch: 1, validFrom: now, expiresAt: "2026-08-23T12:30:00.000Z",
      authorityDigest: authority.digest, authority, parentAuthorities: [],
    },
    executor: {
      contractVersion: NODE_POLICY_CONTRACT_V1, executorId: "executor:local", operationIds: ["operation:read"],
      externalEffectOperationIds: [], targetKinds: ["none"], supportsCancellation: true,
      supportsNetworkIdentityEnforcement: false, costMeter: "none",
    },
    keyAvailability: { state: keyState, keyReferenceId: "key-reference:node:1", observedAt: now },
    activeExternalEffects: 0,
  };
}

test("admissions survive restart and exact fresh-message retries alias one durable decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-room-admission-"));
  const path = join(directory, "admission.sqlite");
  try {
    let store = new SqliteLocalAdmissionStore(path);
    const accepted = decision(true);
    assert.equal(store.record({ messageId: "message:one", identity, decision: accepted, recordedAt: now }), "recorded");
    assert.equal(store.record({ messageId: "message:one", identity, decision: accepted, recordedAt: now }), "duplicate");
    assert.equal(store.record({ messageId: "message:retry", identity, decision: accepted, recordedAt: now }), "duplicate");
    assert.equal(store.count(), 1);
    assert.equal(store.findByMessage("message:retry")?.disposition, "accepted");
    store.close();
    store = new SqliteLocalAdmissionStore(path);
    assert.equal(store.findByMessage("message:one")?.decisionDigest, store.findByMessage("message:retry")?.decisionDigest);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("message conflicts and a second accepted decision for one operation fail closed", () => {
  assert.throws(() => new SqliteLocalAdmissionStore(":memory:"), /filesystem path/);
  const store = new SqliteLocalAdmissionStore(":memory:", { testOnlyAllowEphemeral: true });
  store.record({ messageId: "message:one", identity, decision: decision(true), recordedAt: now });
  assert.throws(() => store.record({ messageId: "message:one", identity, decision: decision(false, "b"), recordedAt: now }), AdmissionConflictError);
  assert.throws(() => store.record({ messageId: "message:two", identity, decision: decision(true, "b"), recordedAt: now }), AdmissionConflictError);
  assert.equal(store.count(), 1);
  store.close();
});

test("durable policy handler records acceptance or a coarse refusal before reporting handled", async () => {
  const acceptedStore = new SqliteLocalAdmissionStore(":memory:", { testOnlyAllowEphemeral: true });
  const acceptedHandler = new DurablePolicyCommandHandler(acceptedStore, () => ({ evaluation: evaluation() }));
  const frame = { messageId: "message:admit" } as SignedNodeFrame;
  assert.equal(await acceptedHandler.handle(frame, now), true);
  assert.equal(acceptedStore.findByMessage(frame.messageId)?.disposition, "accepted");
  assert.deepEqual(acceptedHandler.result(frame.messageId), { disposition: "accepted" });
  const laterRetry = { messageId: "message:admit-retry" } as SignedNodeFrame;
  assert.equal(await acceptedHandler.handle(laterRetry, "2026-08-23T12:01:00.000Z"), true);
  assert.equal(acceptedStore.count(), 1);
  assert.equal(acceptedStore.findByMessage(laterRetry.messageId)?.decision.decidedAt, now);
  acceptedStore.close();

  const refusedStore = new SqliteLocalAdmissionStore(":memory:", { testOnlyAllowEphemeral: true });
  const refusedHandler = new DurablePolicyCommandHandler(refusedStore, () => ({ evaluation: evaluation("locked") }));
  const refusedFrame = { messageId: "message:refuse" } as SignedNodeFrame;
  assert.equal(await refusedHandler.handle(refusedFrame, now), true);
  const result = refusedHandler.result(refusedFrame.messageId);
  assert.equal(result?.disposition, "refused");
  assert.equal(result?.receipt?.category, "maintenance");
  assert.equal(JSON.stringify(result?.receipt).includes("keystore_unavailable"), false);
  refusedStore.close();
});
