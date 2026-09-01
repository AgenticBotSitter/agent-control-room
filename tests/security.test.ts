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
  type NodeRecord,
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
  const authority: JobRecord["authority"] = { projectId: workflow.projectId, allowedExecutor: "executor:synthetic", allowedOperations: ["publish:draft"], credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "high", maxDurationSeconds: 300, maxConcurrentEffects: 1, expiresAt: t10, digest: hashB };
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

async function seedEffectWorkflow(canonical: CanonicalStore, records: ReturnType<typeof effectRecords>) {
  await canonical.create(records.request);
  await canonical.create(records.workflow);
  await canonical.create(records.job);
  const node: NodeRecord = {
    contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id: "node:security", tenantId: "tenant:owner",
    displayName: "Security node", state: "pending_enrollment", platform: "linux", architecture: "x64",
    identityKeyId: "key:security", hardwareFingerprint: hashA, softwareFingerprint: hashB,
    policyVersion: "1.0.0", minimumProtocolVersion: "control-room-node/v1", version: 0, createdAt: t0, updatedAt: t0,
  };
  await canonical.create(node);
  await canonical.transition({ tenantId: node.tenantId, kind: "node", entityId: node.id, expectedVersion: 0, toState: "active", transitionId: "transition:security-node", idempotencyKey: "idem-security-node", actor: ownerActor, occurredAt: t0, recordPatch: { enrolledAt: t0 } });
  const ready = await canonical.transition({ tenantId: records.job.tenantId, kind: "job", entityId: records.job.id, expectedVersion: 0, toState: "ready", transitionId: "transition:security-ready", idempotencyKey: "idem-security-ready", actor: ownerActor, occurredAt: t0 });
  await canonical.claimReadyJob({ tenantId: records.job.tenantId, jobId: records.job.id, expectedJobVersion: ready.entity.version, nodeId: node.id, attemptId: records.attempt.id, leaseId: "lease:security", transitionId: "transition:security-claim", idempotencyKey: "idem-security-claim", actor: ownerActor, acquiredAt: t0, expiresAt: t5 });
  await canonical.create(records.approval);
  await canonical.create(records.effect);
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

test("secret walkers retain canaries under post-import host traversal substitution", () => {
  const nativeDefineProperty = Object.defineProperty,
    entriesDescriptor = Object.getOwnPropertyDescriptor(Object, "entries"),
    arrayDescriptor = Object.getOwnPropertyDescriptor(Array, "isArray"),
    forEachDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "forEach"),
    someDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "some"),
    pushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "push"),
    joinDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "join"),
    mapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "map"),
    fromEntriesDescriptor = Object.getOwnPropertyDescriptor(Object, "fromEntries"),
    definePropertyDescriptor = Object.getOwnPropertyDescriptor(Object, "defineProperty"),
    testDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "test"),
    execDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "exec"),
    applyDescriptor = Object.getOwnPropertyDescriptor(Reflect, "apply"),
    errorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Error");
  assert.ok(entriesDescriptor); assert.ok(arrayDescriptor); assert.ok(forEachDescriptor); assert.ok(someDescriptor);
  assert.ok(pushDescriptor); assert.ok(joinDescriptor); assert.ok(mapDescriptor); assert.ok(fromEntriesDescriptor);
  assert.ok(definePropertyDescriptor); assert.ok(testDescriptor); assert.ok(execDescriptor); assert.ok(applyDescriptor);
  assert.ok(errorDescriptor);
  const sentinel = new Error("hostile secret walker"), hostile = () => { throw sentinel; };
  class HostileError { constructor() { throw sentinel; } }
  let rejected: unknown, redacted: ReturnType<typeof redactSecrets> | undefined;
  nativeDefineProperty(Object, "entries", { ...entriesDescriptor, value: hostile });
  nativeDefineProperty(Array, "isArray", { ...arrayDescriptor, value: hostile });
  nativeDefineProperty(Array.prototype, "forEach", { ...forEachDescriptor, value: hostile });
  nativeDefineProperty(Array.prototype, "some", { ...someDescriptor, value: hostile });
  nativeDefineProperty(Array.prototype, "push", { ...pushDescriptor, value: hostile });
  nativeDefineProperty(Array.prototype, "join", { ...joinDescriptor, value: hostile });
  nativeDefineProperty(Array.prototype, "map", { ...mapDescriptor, value: hostile });
  nativeDefineProperty(Object, "fromEntries", { ...fromEntriesDescriptor, value: hostile });
  nativeDefineProperty(Object, "defineProperty", { ...definePropertyDescriptor, value: hostile });
  nativeDefineProperty(RegExp.prototype, "test", { ...testDescriptor, value: hostile });
  nativeDefineProperty(RegExp.prototype, "exec", { ...execDescriptor, value: hostile });
  nativeDefineProperty(Reflect, "apply", { ...applyDescriptor, value: hostile });
  nativeDefineProperty(globalThis, "Error", { ...errorDescriptor, value: HostileError });
  try {
    try { assertNoSecretMaterial({ nested: [{ note: "api_key=unsafe-value-123" }] }); }
    catch (error) { rejected = error; }
    redacted = redactSecrets({ nested: [{ apiKey: "sk_test_abcdefghijklmnopqrstuvwxyz" }], safe: "visible" });
  } finally {
    nativeDefineProperty(Object, "entries", entriesDescriptor);
    nativeDefineProperty(Array, "isArray", arrayDescriptor);
    nativeDefineProperty(Array.prototype, "forEach", forEachDescriptor);
    nativeDefineProperty(Array.prototype, "some", someDescriptor);
    nativeDefineProperty(Array.prototype, "push", pushDescriptor);
    nativeDefineProperty(Array.prototype, "join", joinDescriptor);
    nativeDefineProperty(Array.prototype, "map", mapDescriptor);
    nativeDefineProperty(Object, "fromEntries", fromEntriesDescriptor);
    nativeDefineProperty(Object, "defineProperty", definePropertyDescriptor);
    nativeDefineProperty(RegExp.prototype, "test", testDescriptor);
    nativeDefineProperty(RegExp.prototype, "exec", execDescriptor);
    nativeDefineProperty(Reflect, "apply", applyDescriptor);
    nativeDefineProperty(globalThis, "Error", errorDescriptor);
  }
  assert.ok(rejected instanceof Error);
  assert.notEqual(rejected, sentinel);
  assert.deepEqual(redacted, { value: { nested: [{ apiKey: "[REDACTED]" }], safe: "visible" },
    redactedPaths: ["$.nested[0].apiKey"] });
});

test("redaction preserves sparse array topology", () => {
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = "visible";
  const output = redactSecrets(sparse).value as unknown[];
  assert.equal(output.length, 2);
  assert.equal(Object.hasOwn(output, 0), false);
  assert.equal(Object.hasOwn(output, 1), true);
  assert.equal(output[1], "visible");
});

test("secret walkers ignore a dishonest post-import RegExp exec", () => {
  const execDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "exec");
  assert.ok(execDescriptor);
  let behavior = 0, rejected: unknown;
  Object.defineProperty(RegExp.prototype, "exec", { ...execDescriptor, value: () => { behavior += 1; return null; } });
  try {
    try { assertNoSecretMaterial("api_key=unsafe-value-123"); }
    catch (error) { rejected = error; }
    assert.deepEqual(redactSecrets("api_key=unsafe-value-123"), {
      value: "[REDACTED]", redactedPaths: ["$"],
    });
  } finally {
    Object.defineProperty(RegExp.prototype, "exec", execDescriptor);
  }
  assert.equal(behavior, 0);
  assert.ok(rejected instanceof Error);
  assert.match(rejected.message, /secret material/);
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
  await security.bootstrapOwner({ ...ownerAuthentication, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner", now: t1 });
  await assert.rejects(security.bootstrapOwner({ ...ownerAuthentication, identityId: "identity:other", grantId: "grant:other", displayName: "Other", now: t1 }), /already consumed/);
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
  await security.bootstrapOwner({ ...ownerAuthentication, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner", now: t1 });
  const records = effectRecords();
  await seedEffectWorkflow(canonical, records);

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
  await security.bootstrapOwner({ ...ownerAuthentication, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner", now: t1 });
  const records = effectRecords();
  await seedEffectWorkflow(canonical, records);
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

test("CR-4Q rejects under-classified policy decisions at consequential-action consumption", async () => {
  const db = await migratedDatabase();
  const canonical = new CanonicalStore(adaptPglite(db));
  const security = new SecurityStore(adaptPglite(db));
  await security.bootstrapOwner({ ...ownerAuthentication, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner", now: t1 });
  const records = effectRecords();
  await seedEffectWorkflow(canonical, records);

  await security.authorize({
    decisionId: "decision:approval-underclassified", authentication: ownerAuthentication,
    request: { tenantId: "tenant:owner", action: "approval.decide", resourceType: "approval", resourceId: records.approval.id, projectId: records.job.projectId, risk: "low", externalEffect: false, occurredAt: t1 },
  });
  await assert.rejects(
    canonical.resolveApproval({ tenantId: "tenant:owner", approvalId: records.approval.id, expectedVersion: 0, toState: "approved", policyDecisionId: "decision:approval-underclassified", transitionId: "transition:approval-underclassified", idempotencyKey: "idem-approval-underclassified", actor: ownerActor, occurredAt: t1 }),
    /not bound/,
  );

  await security.authorize({
    decisionId: "decision:approval-exact", authentication: ownerAuthentication,
    request: { tenantId: "tenant:owner", action: "approval.decide", resourceType: "approval", resourceId: records.approval.id, projectId: records.job.projectId, risk: "high", externalEffect: true, occurredAt: t1 },
  });
  await canonical.resolveApproval({ tenantId: "tenant:owner", approvalId: records.approval.id, expectedVersion: 0, toState: "approved", policyDecisionId: "decision:approval-exact", transitionId: "transition:approval-exact", idempotencyKey: "idem-approval-exact", actor: ownerActor, occurredAt: t1 });
  await security.authorize({
    decisionId: "decision:effect-underclassified", authentication: ownerAuthentication,
    request: { tenantId: "tenant:owner", action: "effect.authorize", resourceType: "effect_intent", resourceId: records.effect.id, projectId: records.job.projectId, risk: "low", externalEffect: false, occurredAt: t1 },
  });
  await assert.rejects(
    canonical.authorizeEffect({ tenantId: "tenant:owner", effectIntentId: records.effect.id, expectedVersion: 0, policyDecisionId: "decision:effect-underclassified", transitionId: "transition:effect-underclassified", idempotencyKey: "idem-effect-underclassified", actor: ownerActor, occurredAt: t1 }),
    /not bound/,
  );
  await db.close();
});

test("CR-4Q enforces required approval roles and current grant state", async () => {
  const db = await migratedDatabase();
  const canonical = new CanonicalStore(adaptPglite(db));
  const security = new SecurityStore(adaptPglite(db));
  await security.bootstrapOwner({ ...ownerAuthentication, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner", now: t1 });
  const operatorAuthentication: VerifiedAuthentication = { ...ownerAuthentication, subject: "operator-subject" };
  await db.query(
    `INSERT INTO control_identities (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
     VALUES ('identity:operator','tenant:owner','human','Operator',$1,$2,'active',$3,$3)`,
    [operatorAuthentication.provider, sha256Digest({ provider: operatorAuthentication.provider, subject: operatorAuthentication.subject }), t0],
  );
  await db.query(
    `INSERT INTO control_role_grants (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
     VALUES ('grant:operator','tenant:owner','identity:operator','operator','["approval.decide"]'::jsonb,'["project:security"]'::jsonb,'high',true,true,$1,$1)`,
    [t0],
  );
  const records = effectRecords();
  await seedEffectWorkflow(canonical, records);
  await security.authorize({
    decisionId: "decision:operator-approval", authentication: operatorAuthentication,
    request: { tenantId: "tenant:owner", action: "approval.decide", resourceType: "approval", resourceId: records.approval.id, projectId: records.job.projectId, risk: "high", externalEffect: true, occurredAt: t1 },
  });
  await assert.rejects(
    canonical.resolveApproval({ tenantId: "tenant:owner", approvalId: records.approval.id, expectedVersion: 0, toState: "approved", policyDecisionId: "decision:operator-approval", transitionId: "transition:operator-approval", idempotencyKey: "idem-operator-approval", actor: { actorId: "identity:operator", actorType: "human" }, occurredAt: t1 }),
    /role requirement/,
  );
  await db.query(`UPDATE control_role_grants SET revoked_at=$1,updated_at=$1 WHERE id='grant:operator'`, [t1]);
  await assert.rejects(
    canonical.resolveApproval({ tenantId: "tenant:owner", approvalId: records.approval.id, expectedVersion: 0, toState: "approved", policyDecisionId: "decision:operator-approval", transitionId: "transition:revoked-operator", idempotencyKey: "idem-revoked-operator", actor: { actorId: "identity:operator", actorType: "human" }, occurredAt: t1 }),
    /no longer active/,
  );
  await db.close();
});

test("expired authentication cannot bootstrap the owner", async () => {
  const db = await migratedDatabase();
  const security = new SecurityStore(adaptPglite(db));
  await assert.rejects(
    security.bootstrapOwner({ ...ownerAuthentication, expiresAt: t1, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner", now: t1 }),
    /currently valid/,
  );
  await db.close();
});
