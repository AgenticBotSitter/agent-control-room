import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import type { AttemptRecord, JobRecord, LeaseRecord } from "../src/domain/v1";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { canonicalJson } from "../src/security/canonical-digest";
import { CODEX_APP_SERVER_CAPABILITY, CODEX_APP_SERVER_JOB_TYPE, CODEX_START_OPERATION,
  codexTaskDispatchBodySchemaV1, codexTaskPayloadDigestV1 } from "../src/harness/codex-v1/delivery-contract";
import { createCodexOwnerPermitIssuer, describeCodexOwnerPermitReview,
  prepareCodexOwnerPermitMaterial, type CodexOwnerPermitPreparationInputV1 } from "../src/harness/codex-v1/owner-permit";

const now = 1_800_000_010_000;
const at = (offset: number) => new Date(now + offset).toISOString();
const digest = (value: string) => sha256Digest({ fixture: value });

function fixture(): CodexOwnerPermitPreparationInputV1 {
  const input = { prompt: "Summarize the assigned synthetic task.", instructions: "Return bounded plain-text evidence." };
  const authority: JobRecord["authority"] = { projectId: "project:test", allowedExecutor: "executor:codex",
    allowedOperations: [CODEX_START_OPERATION], credentialRefs: ["credential:codex"], filesystemRoots: ["/synthetic/project"],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const common = { contractVersion: "control-room-domain/v1" as const, tenantId: "tenant:test", version: 1,
    createdAt: at(-60_000), updatedAt: at(-60_000) };
  const job: JobRecord = { ...common, kind: "job", id: "job:test", workflowId: "workflow:test", projectId: "project:test",
    jobType: CODEX_APP_SERVER_JOB_TYPE, specVersion: "1.0.0", inputDigest: sha256Digest(input), state: "leased", priority: 50,
    requiredCapability: CODEX_APP_SERVER_CAPABILITY, dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } };
  const attempt: AttemptRecord = { ...common, kind: "attempt", id: "attempt:test", jobId: job.id, attemptNumber: 1, state: "leased",
    nodeId: "node:test", leaseEpoch: 1, offeredAt: at(-1000) };
  const lease: LeaseRecord = { ...common, kind: "lease", id: "lease:test", jobId: job.id, attemptId: attempt.id, nodeId: "node:test",
    epoch: 1, state: "active", acquiredAt: at(-500), expiresAt: at(120_000) };
  return { job, attempt, lease, input, binding: { tenantId: "tenant:test", nodeId: "node:test", nodeClass: "personal-compute",
    enrollmentDigest: digest("enrollment"), connectorProfileDigest: digest("connector"), workspaceIntentDigest: digest("workspace"),
    credentialRef: "credential:codex", filesystemRoot: "/synthetic/project", validUntil: now + 180_000 },
    approvalKeyId: "approval-key:test", issuedAt: now, approvalNonce: "Y29kZXgtb3duZXItcGVybWl0LW5vbmNl" };
}

function issuer(input = fixture(), key = generateKeyPairSync("ed25519"), options: { consent?: () => void; signer?: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>; publicKeySpki?: string } = {}) {
  const publicKeySpki = options.publicKeySpki ?? key.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return { key, value: createCodexOwnerPermitIssuer(input, { publicKeySpki, timeoutMs: 1000, clock: () => now,
    assertOwnerConsentCurrent: () => options.consent?.(),
    sign: options.signer ?? (async bytes => sign(null, bytes, key.privateKey)), }) };
}

test("Codex owner permit binds the exact canonical lease, node digests, and dispatch material", async () => {
  const input = fixture(), material = prepareCodexOwnerPermitMaterial(input);
  const binding = input.binding as { connectorProfileDigest: string; workspaceIntentDigest: string };
  assert.equal(material.request.operationId, CODEX_START_OPERATION);
  assert.equal(material.request.target.kind, "filesystem");
  assert.equal(material.request.target.canonicalPath, "/synthetic/project");
  assert.equal(material.start.connectorProfileDigest, binding.connectorProfileDigest);
  assert.equal(material.start.workspaceIntentDigest, binding.workspaceIntentDigest);
  assert.equal(material.request.payloadDigest, codexTaskPayloadDigestV1(material.start, material.request.authorityDigest));
  assert.equal(material.startsWork, false); assert.equal(material.grantsExecutionAuthority, false);
  const review = describeCodexOwnerPermitReview(input);
  assert.equal(review.inputDigest, material.start.inputDigest);
  assert.equal(review.signatureStatus, "unsigned");
  const { value } = issuer(input);
  const permit = await value.issue(new AbortController().signal);
  const dispatch = codexTaskDispatchBodySchemaV1.parse({ schema: "control-room.codex-task-dispatch/v1",
    queueId: `native-queue:${sha256Digest({ tenantId: material.start.tenantId, jobId: material.start.jobId, attemptId: material.start.attemptId }).slice(7)}`,
    start: material.start, request: material.request, permit, permitDigest: sha256Digest(permit) });
  assert.equal(dispatch.permit.body.operationDigest, material.start.operationDigest);
});

test("Codex owner permit refuses altered canonical bindings before signing", () => {
  for (const mutate of [
    (input: CodexOwnerPermitPreparationInputV1) => { (input.binding as { filesystemRoot: string }).filesystemRoot = "/synthetic/other"; },
    (input: CodexOwnerPermitPreparationInputV1) => { (input.binding as { nodeId: string }).nodeId = "node:other"; },
    (input: CodexOwnerPermitPreparationInputV1) => { (input.lease as LeaseRecord).epoch = 2; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => prepareCodexOwnerPermitMaterial(input), /codex_owner_permit_material_invalid/);
  }
});

test("Codex owner permit signs once and never creates recovery material", async () => {
  let calls = 0;
  const keyForCalls = generateKeyPairSync("ed25519");
  const issued = issuer(fixture(), keyForCalls, { signer: async bytes => { calls++; return sign(null, bytes, keyForCalls.privateKey); } }).value;
  const permit = await issued.issue(new AbortController().signal);
  assert.equal(permit.body.schema, "control-room.owner-approval-attestation/v1");
  assert.deepEqual(Object.keys(permit).sort(), ["body", "signature", "signatureAlgorithm"]);
  await assert.rejects(issued.issue(new AbortController().signal), /codex_owner_permit_issuance_uncertain/);
  assert.equal(calls, 1);
});

test("Codex owner permit fails closed for cancellation, revoked consent, and a foreign signing key", async () => {
  const cancelled = issuer(); const abort = new AbortController(); abort.abort();
  await assert.rejects(cancelled.value.issue(abort.signal), /codex_owner_permit_issuance_uncertain/);
  let signingCalls = 0;
  const denied = issuer(fixture(), generateKeyPairSync("ed25519"), { consent: () => { throw new Error("revoked"); },
    signer: async () => { signingCalls++; return new Uint8Array(64); } });
  await assert.rejects(denied.value.issue(new AbortController().signal), /codex_owner_permit_issuance_uncertain/);
  assert.equal(signingCalls, 0);
  const expected = generateKeyPairSync("ed25519"), foreign = generateKeyPairSync("ed25519");
  const wrong = issuer(fixture(), foreign, { publicKeySpki: expected.publicKey.export({ format: "der", type: "spki" }).toString("base64url") });
  await assert.rejects(wrong.value.issue(new AbortController().signal), /codex_owner_permit_issuance_uncertain/);
});

test("Codex owner permit cancels an in-flight signer without retrying", async () => {
  let calls = 0;
  const { value } = issuer(fixture(), generateKeyPairSync("ed25519"), { signer: async (_bytes, signal) => {
    calls++; await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    return new Uint8Array(64);
  } });
  const abort = new AbortController(), pending = value.issue(abort.signal);
  abort.abort();
  await assert.rejects(pending, /codex_owner_permit_issuance_uncertain/);
  await assert.rejects(value.issue(new AbortController().signal), /codex_owner_permit_issuance_uncertain/);
  assert.equal(calls, 1);
});
