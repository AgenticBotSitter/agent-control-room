import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  DOMAIN_CONTRACT_VERSION,
  type ApprovalRecord,
  type AttemptRecord,
  type EffectIntentRecord,
  type JobRecord,
  type RequestRecord,
  type WorkflowRecord,
} from "../src/domain/v1/index.ts";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { adaptPglite } from "../src/persistence/database.ts";
import {
  SecurityStore,
  assertDigest,
  assertNoSecretMaterial,
  computeAuthorityDigest,
  computeEffectOperationDigest,
  evaluatePolicy,
  redactSecrets,
  sha256Digest,
  type AuthenticatedPrincipal,
  type RoleGrant,
  type VerifiedAuthentication,
} from "../src/security/index.ts";

const t0 = "2026-08-22T18:00:00.000Z";
const t1 = "2026-08-22T18:01:00.000Z";
const t5 = "2026-08-22T18:05:00.000Z";
const t10 = "2026-08-22T18:10:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const ownerActor = { actorId: "identity:owner", actorType: "human" as const };

async function migratedDatabase() {
  const db = new PGlite();
  const files = (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(resolve("db/migrations", file), "utf8"));
  await db.query(`INSERT INTO tenants (id,display_name) VALUES ('tenant:owner','Owner')`);
  return db;
}

const ownerAuthentication: VerifiedAuthentication = {
  tenantId: "tenant:owner",
  provider: "test-verified-provider",
  subject: "owner-subject",
  verifiedAt: t0,
  expiresAt: t10,
  strongFactor: { evidenceId: "factor:passkey-1", method: "passkey", verifiedAt: t0, expiresAt: t5 },
};

function effectRecords() {
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: "tenant:owner", version: 0, createdAt: t0, updatedAt: t0 } as const;
  const request: RequestRecord = {
    ...common, kind: "request", id: "request:security", projectId: "project:security", title: "Security request",
    objective: "Verify exact operation authorization", state: "draft", priority: 50, requestedBy: ownerActor,
    idempotencyKey: "request-security-0001",
  };
  const workflow: WorkflowRecord = {
    ...common, kind: "workflow", id: "workflow:security", requestId: request.id, projectId: "project:security",
    definitionVersion: "1.0.0", definitionDigest: hashA, authorityMode: "control_room_native", state: "proposed",
    jobIds: ["job:security"],
  };
  const authority: JobRecord["authority"] = { projectId: workflow.projectId, allowedExecutor: "executor:synthetic", allowedOperations: ["publish:draft"], credentialRefs: [], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxDurationSeconds: 300, expiresAt: t10, digest: hashB };
  authority.digest = computeAuthorityDigest(authority);
  const job: JobRecord = {
    ...common, kind: "job", id: "job:security", workflowId: workflow.id, projectId: workflow.projectId,
    jobType: "synthetic:security", specVersion: "1.0.0", inputDigest: hashA, state: "proposed", priority: 50,
    requiredCapability: "capability:security", dependsOnJobIds: [],
    authority,
    retryPolicy: { maxAttempts: 2, backoffSeconds: 1, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" },
  };
  const attempt: AttemptRecord = {
    ...common, kind: "attempt", id: "attempt:security", jobId: job.id, attemptNumber: 1, state: "offered", offeredAt: t0,
  };
  const operation = { operation: "publish:draft", destination: "youtube:staging" };
  const approval: ApprovalRecord = {
    ...common, kind: "approval", id: "approval:security", operationDigest: hashA, scope: "effect:security", risk: "high",
    state: "pending", requestedBy: ownerActor, requiredActorType: "owner", expiresAt: t10,
  };
  const effect: EffectIntentRecord = {
    ...common, kind: "effect_intent", id: "effect:security", jobId: job.id, attemptId: attempt.id,
    operation: operation.operation, operationDigest: hashA, destination: operation.destination, idempotencyKey: "effect-security-0001",
    risk: "high", state: "proposed", approvalId: approval.id,
  };
  effect.operationDigest = computeEffectOperationDigest(effect, job.projectId);
  approval.operationDigest = effect.operationDigest;
  return { request, workflow, job, attempt, approval, effect };
}

test("canonical digests are stable and reject non-JSON or mismatched content", () => {
  assert.equal(sha256Digest({ b: 2, a: [true, "x"] }), sha256Digest({ a: [true, "x"], b: 2 }));
  assert.notEqual(sha256Digest({ value: 1 }), sha256Digest({ value: 2 }));
  assert.doesNotThrow(() => assertDigest({ value: 1 }, sha256Digest({ value: 1 })));
  assert.throws(() => assertDigest({ value: 2 }, sha256Digest({ value: 1 })), /digest mismatch/);
  assert.throws(() => sha256Digest({ invalid: undefined }), /Non-JSON value/);
});

test("secret canaries are rejected while logical credential references remain safe", () => {
  assert.doesNotThrow(() => assertNoSecretMaterial({ credentialRefs: ["youtube:staging-uploader"] }));
  assert.throws(() => assertNoSecretMaterial({ apiKey: "sk_test_abcdefghijklmnopqrstuvwxyz" }), /secret material/);
  assert.throws(() => assertNoSecretMaterial({ note: "password=hunter-two-secret" }), /secret material/);
  const redacted = redactSecrets({ apiKey: "sk_test_abcdefghijklmnopqrstuvwxyz", safe: "visible" });
  assert.deepEqual(redacted.value, { apiKey: "[REDACTED]", safe: "visible" });
  assert.deepEqual(redacted.redactedPaths, ["$.apiKey"]);
});

test("deterministic policy fails closed for scope, risk, expiry, and missing strong factor", () => {
  const principal: AuthenticatedPrincipal = { tenantId: "tenant:owner", identityId: "identity:owner", actorType: "human", authenticatedAt: t0, expiresAt: t10 };
  const grant: RoleGrant = { id: "grant:operator", allowedActions: ["effect.authorize"], projectIds: ["project:one"], riskCeiling: "high", allowExternalEffects: true, requireStrongFactor: false };
  const request = { tenantId: "tenant:owner", action: "effect.authorize", resourceType: "effect_intent", resourceId: "effect:one", projectId: "project:one", risk: "high" as const, externalEffect: true, occurredAt: t1 };
  assert.deepEqual(evaluatePolicy(principal, [grant], request).reasonCodes, ["strong_factor_required"]);
  assert.deepEqual(evaluatePolicy({ ...principal, strongFactor: ownerAuthentication.strongFactor }, [grant], { ...request, projectId: "project:other" }).reasonCodes, ["no_matching_grant"]);
  assert.deepEqual(evaluatePolicy({ ...principal, tenantId: "tenant:other" }, [grant], request).reasonCodes, ["tenant_mismatch"]);
  assert.deepEqual(evaluatePolicy({ ...principal, expiresAt: t1 }, [grant], request).reasonCodes, ["session_expired"]);
  assert.deepEqual(evaluatePolicy({ ...principal, strongFactor: ownerAuthentication.strongFactor }, [{ ...grant, revokedAt: t0 }], request).reasonCodes, ["no_matching_grant"]);
  assert.equal(evaluatePolicy({ ...principal, strongFactor: ownerAuthentication.strongFactor }, [grant], request).allowed, true);
});

test("owner bootstrap is single-use and policy decisions are durable append-only records", async () => {
  const db = await migratedDatabase();
  const security = new SecurityStore(adaptPglite(db));
  await security.bootstrapOwner({ ...ownerAuthentication, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner" });
  await assert.rejects(security.bootstrapOwner({ ...ownerAuthentication, identityId: "identity:other", grantId: "grant:other", displayName: "Other" }), /already consumed/);
  await assert.rejects(security.authorize({
    decisionId: "decision:forged",
    authentication: { ...ownerAuthentication, subject: "forged-subject" },
    request: { tenantId: "tenant:owner", action: "effect.authorize", resourceType: "effect_intent", resourceId: "effect:forged", projectId: "project:security", risk: "high", externalEffect: true, occurredAt: t1 },
  }), /active identity/);
  const decision = await security.authorize({
    decisionId: "decision:durable",
    authentication: ownerAuthentication,
    request: { tenantId: "tenant:owner", action: "effect.authorize", resourceType: "effect_intent", resourceId: "effect:durable", projectId: "project:security", risk: "high", externalEffect: true, occurredAt: t1 },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.strongFactorEvidenceId, "factor:passkey-1");
  await assert.rejects(db.query(`DELETE FROM control_policy_decisions WHERE id='decision:durable'`), /append-only relation/i);
  await db.close();
});

test("approval resolution and effect authorization are exact, strong, and single-use", async () => {
  const db = await migratedDatabase();
  const canonical = new CanonicalStore(adaptPglite(db));
  const security = new SecurityStore(adaptPglite(db));
  await security.bootstrapOwner({ ...ownerAuthentication, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner" });
  const records = effectRecords();
  await canonical.create(records.request);
  await canonical.create(records.workflow);
  await canonical.create(records.job);
  await canonical.create(records.attempt);
  await canonical.create(records.approval);
  await canonical.create(records.effect);

  await assert.rejects(canonical.transition({ tenantId: records.approval.tenantId, kind: "approval", entityId: records.approval.id, expectedVersion: 0, toState: "approved", transitionId: "transition:approval-bypass", idempotencyKey: "idem-approval-bypass", actor: ownerActor, occurredAt: t1, recordPatch: { decidedBy: ownerActor, decidedAt: t1 } }), /coordinated repository operation/);

  await security.authorize({
    decisionId: "decision:approval",
    authentication: ownerAuthentication,
    request: { tenantId: "tenant:owner", action: "approval.decide", resourceType: "approval", resourceId: records.approval.id, projectId: records.job.projectId, risk: "high", externalEffect: true, occurredAt: t1 },
  });
  await canonical.resolveApproval({ tenantId: "tenant:owner", approvalId: records.approval.id, expectedVersion: 0, toState: "approved", policyDecisionId: "decision:approval", transitionId: "transition:approval", idempotencyKey: "idem-approval", actor: ownerActor, occurredAt: t1 });

  await security.authorize({
    decisionId: "decision:effect",
    authentication: ownerAuthentication,
    request: { tenantId: "tenant:owner", action: "effect.authorize", resourceType: "effect_intent", resourceId: records.effect.id, projectId: records.job.projectId, risk: "high", externalEffect: true, occurredAt: t1 },
  });
  const authorized = await canonical.authorizeEffect({ tenantId: "tenant:owner", effectIntentId: records.effect.id, expectedVersion: 0, policyDecisionId: "decision:effect", transitionId: "transition:effect", idempotencyKey: "idem-effect", actor: ownerActor, occurredAt: t1 });
  assert.equal(authorized.entity.state, "authorized");
  assert.equal((await canonical.authorizeEffect({ tenantId: "tenant:owner", effectIntentId: records.effect.id, expectedVersion: 0, policyDecisionId: "decision:effect", transitionId: "ignored", idempotencyKey: "idem-effect", actor: ownerActor, occurredAt: t1 })).replayed, true);
  const consumed = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_approval_consumptions WHERE approval_id=$1`, [records.approval.id]);
  assert.equal(consumed.rows[0].count, "1");
  await assert.rejects(db.query(`DELETE FROM control_approval_consumptions WHERE approval_id=$1`, [records.approval.id]), /append-only relation/i);
  await db.close();
});

test("revoked approval cannot authorize a pending consequential effect", async () => {
  const db = await migratedDatabase();
  const canonical = new CanonicalStore(adaptPglite(db));
  const security = new SecurityStore(adaptPglite(db));
  await security.bootstrapOwner({ ...ownerAuthentication, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner" });
  const records = effectRecords();
  for (const record of [records.request, records.workflow, records.job, records.attempt, records.approval, records.effect]) {
    await canonical.create(record);
  }
  await security.authorize({
    decisionId: "decision:approve-before-revoke", authentication: ownerAuthentication,
    request: { tenantId: "tenant:owner", action: "approval.decide", resourceType: "approval", resourceId: records.approval.id, projectId: records.job.projectId, risk: "high", externalEffect: true, occurredAt: t1 },
  });
  await canonical.resolveApproval({ tenantId: "tenant:owner", approvalId: records.approval.id, expectedVersion: 0, toState: "approved", policyDecisionId: "decision:approve-before-revoke", transitionId: "transition:approve-before-revoke", idempotencyKey: "idem-approve-before-revoke", actor: ownerActor, occurredAt: t1 });
  await security.authorize({
    decisionId: "decision:revoke", authentication: ownerAuthentication,
    request: { tenantId: "tenant:owner", action: "approval.decide", resourceType: "approval", resourceId: records.approval.id, projectId: records.job.projectId, risk: "high", externalEffect: true, occurredAt: t1 },
  });
  await canonical.resolveApproval({ tenantId: "tenant:owner", approvalId: records.approval.id, expectedVersion: 1, toState: "revoked", policyDecisionId: "decision:revoke", transitionId: "transition:revoke", idempotencyKey: "idem-revoke", actor: ownerActor, occurredAt: t1, safeReasonCode: "owner_revoked" });
  await security.authorize({
    decisionId: "decision:effect-after-revoke", authentication: ownerAuthentication,
    request: { tenantId: "tenant:owner", action: "effect.authorize", resourceType: "effect_intent", resourceId: records.effect.id, projectId: records.job.projectId, risk: "high", externalEffect: true, occurredAt: t1 },
  });
  await assert.rejects(canonical.authorizeEffect({ tenantId: "tenant:owner", effectIntentId: records.effect.id, expectedVersion: 0, policyDecisionId: "decision:effect-after-revoke", transitionId: "transition:effect-after-revoke", idempotencyKey: "idem-effect-after-revoke", actor: ownerActor, occurredAt: t1 }), /not approved/);
  assert.equal((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_approval_consumptions`)).rows[0].count, "0");
  await db.close();
});
