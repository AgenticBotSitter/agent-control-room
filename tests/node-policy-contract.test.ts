import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  APPROVAL_ATTESTATION_SCHEMA_V1,
  NODE_CEILING_SCHEMA_V1,
  NODE_POLICY_CONTRACT_V1,
  SERVER_TRUST_BUNDLE_SCHEMA_V1,
  assertArtifactBodyDigest,
  buildNodePolicyJsonSchemas,
  canonicalFilesystemPathSchema,
  canonicalNetworkDestinationSchema,
  computeArtifactBodyDigest,
  executorCapabilitySchema,
  localPolicyDecisionSchema,
  normalizedLocalPolicyRequestSchema,
  ownerApprovalAttestationSchema,
  ownerSignedTrustBundleSchema,
  signArtifact,
  signedNodeAuthorityCeilingSchema,
  verifyArtifactSignature,
  wireDenialReceiptSchema,
  type NodeAuthorityCeilingV1,
  type OwnerApprovalAttestationBodyV1,
  type ServerTrustBundleBodyV1,
} from "../src/node-policy/v1/index.ts";
import { signedNodeFrameSchema } from "../src/node-protocol/v1/index.ts";
import { computeAuthorityDigest, sha256Digest } from "../src/security/index.ts";

const issuedAt = "2026-08-23T12:00:00.000Z";
const expiresAt = "2026-08-23T12:10:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64url") };
}

function withDigest<T extends object>(material: T): T & { bodyDigest: string } {
  return { ...material, bodyDigest: computeArtifactBodyDigest(material) };
}

function ceiling(overrides: Partial<Omit<NodeAuthorityCeilingV1, "bodyDigest">> = {}): NodeAuthorityCeilingV1 {
  return withDigest({
    schema: NODE_CEILING_SCHEMA_V1,
    tenantId: "tenant:owner",
    nodeId: "node:mac-mini",
    version: 1,
    issuedAt,
    issuerKeyId: "owner-key:provisioning:1",
    projectIds: ["project:alpha"],
    executorIds: ["executor:synthetic"],
    operationIds: ["synthetic:run"],
    credentialRefs: ["credential:publishing"],
    filesystemRoots: ["/srv/control-room/output"],
    networkDestinations: ["https://api.example.com:443"],
    maxRisk: "high" as const,
    externalEffects: "preauthorized" as const,
    maxDurationSeconds: 600,
    maxConcurrentEffects: 2,
    maxCostUsd: "4.25",
    ...overrides,
  });
}

function trustBundle(overrides: Partial<Omit<ServerTrustBundleBodyV1, "bodyDigest">> = {}): ServerTrustBundleBodyV1 {
  const server = keyMaterial();
  return withDigest({
    schema: SERVER_TRUST_BUNDLE_SCHEMA_V1,
    tenantId: "tenant:owner",
    nodeClass: "personal-compute",
    epoch: 1,
    issuedAt,
    ownerRootKeyId: "owner-key:root:1",
    keys: [{ keyId: "server-key:primary", algorithm: "ed25519" as const, spki: server.spki, state: "active" as const }],
    ...overrides,
  });
}

function approval(overrides: Partial<Omit<OwnerApprovalAttestationBodyV1, "bodyDigest">> = {}): OwnerApprovalAttestationBodyV1 {
  return withDigest({
    schema: APPROVAL_ATTESTATION_SCHEMA_V1,
    tenantId: "tenant:owner",
    nodeId: "node:mac-mini",
    projectId: "project:alpha",
    jobId: "job:publish:1",
    attemptId: "attempt:publish:1",
    operationDigest: hashA,
    risk: "high" as const,
    decision: "approved" as const,
    issuedAt,
    expiresAt,
    nonce: "approval_nonce_1234567890",
    approvalKeyId: "owner-key:approval:1",
    ...overrides,
  });
}

test("signed owner ceiling validates its canonical digest and Ed25519 signature", () => {
  const keys = keyMaterial();
  const artifact = signArtifact(ceiling(), keys.privateKey);
  assert.deepEqual(signedNodeAuthorityCeilingSchema.parse(artifact), artifact);
  assert.equal(verifyArtifactSignature(artifact, keys.spki), true);

  const tampered = { ...artifact, body: { ...artifact.body, executorIds: ["executor:attacker"] } };
  assert.equal(signedNodeAuthorityCeilingSchema.safeParse(tampered).success, false);
  assert.throws(() => assertArtifactBodyDigest(tampered.body), /digest mismatch/i);

  const forgedSignature = { ...artifact, signature: `${artifact.signature[0] === "A" ? "B" : "A"}${artifact.signature.slice(1)}` };
  assert.equal(verifyArtifactSignature(forgedSignature, keys.spki), false);
  assert.equal(signedNodeAuthorityCeilingSchema.safeParse({ ...artifact, unexpected: true }).success, false);
});

test("owner ceiling rejects noncanonical arrays, contradictory effects, dates, and money", () => {
  assert.equal(signedNodeAuthorityCeilingSchema.safeParse({ body: ceiling({ projectIds: ["project:z", "project:a"] }), signatureAlgorithm: "Ed25519", signature: "a".repeat(86) }).success, false);
  assert.equal(signedNodeAuthorityCeilingSchema.safeParse({ body: ceiling({ operationIds: ["synthetic:run", "synthetic:run"] }), signatureAlgorithm: "Ed25519", signature: "a".repeat(86) }).success, false);
  assert.equal(signedNodeAuthorityCeilingSchema.safeParse({ body: ceiling({ externalEffects: "none", maxConcurrentEffects: 0 }), signatureAlgorithm: "Ed25519", signature: "a".repeat(86) }).success, false);
  assert.equal(signedNodeAuthorityCeilingSchema.safeParse({ body: ceiling({ externalEffects: "approval_required", maxConcurrentEffects: 0 }), signatureAlgorithm: "Ed25519", signature: "a".repeat(86) }).success, false);
  assert.equal(signedNodeAuthorityCeilingSchema.safeParse({ body: ceiling({ issuedAt: "2026-08-23T06:00:00-06:00" }), signatureAlgorithm: "Ed25519", signature: "a".repeat(86) }).success, false);
  assert.equal(signedNodeAuthorityCeilingSchema.safeParse({ body: ceiling({ maxCostUsd: "4.250" }), signatureAlgorithm: "Ed25519", signature: "a".repeat(86) }).success, false);
});

test("owner-signed trust bundles require active sorted keys and bound shrink authorization", () => {
  const owner = keyMaterial();
  const body = trustBundle();
  const artifact = signArtifact(body, owner.privateKey);
  assert.deepEqual(ownerSignedTrustBundleSchema.parse(artifact), artifact);
  assert.equal(verifyArtifactSignature(artifact, owner.spki), true);

  const revoked = trustBundle({ keys: body.keys.map((key) => ({ ...key, state: "revoked" as const })) });
  assert.equal(ownerSignedTrustBundleSchema.safeParse(signArtifact(revoked, owner.privateKey)).success, false);

  const second = keyMaterial();
  const unsorted = trustBundle({ keys: [
    { keyId: "server-key:z", algorithm: "ed25519", spki: second.spki, state: "active" },
    { keyId: "server-key:a", algorithm: "ed25519", spki: body.keys[0].spki, state: "active" },
  ] });
  assert.equal(ownerSignedTrustBundleSchema.safeParse(signArtifact(unsorted, owner.privateKey)).success, false);

  assert.equal(ownerSignedTrustBundleSchema.safeParse({
    ...artifact,
    shrinkAuthorization: { keyId: "owner-key:step-up:1", bundleBodyDigest: hashB, signatureAlgorithm: "Ed25519", signature: "a".repeat(86) },
  }).success, false);
});

test("approval attestations are exact-scope, expiring, digest-bound signed artifacts", () => {
  const owner = keyMaterial();
  const artifact = signArtifact(approval(), owner.privateKey);
  assert.deepEqual(ownerApprovalAttestationSchema.parse(artifact), artifact);
  assert.equal(verifyArtifactSignature(artifact, owner.spki), true);

  const bothScopes = approval({ nodeClass: "personal-compute" });
  assert.equal(ownerApprovalAttestationSchema.safeParse(signArtifact(bothScopes, owner.privateKey)).success, false);
  const { nodeId: _nodeId, bodyDigest: _bodyDigest, ...noScopeMaterial } = approval();
  void _nodeId;
  void _bodyDigest;
  const noScope = withDigest(noScopeMaterial);
  assert.equal(ownerApprovalAttestationSchema.safeParse(signArtifact(noScope, owner.privateKey)).success, false);
  const expired = approval({ expiresAt: issuedAt });
  assert.equal(ownerApprovalAttestationSchema.safeParse(signArtifact(expired, owner.privateKey)).success, false);
});

test("filesystem and HTTPS destination grammars reject ambiguous or noncanonical targets", () => {
  for (const value of ["/srv/control-room/output", "C:\\ControlRoom\\output"]) assert.equal(canonicalFilesystemPathSchema.safeParse(value).success, true, value);
  for (const value of ["srv/output", "/srv/../etc", "C:\\ControlRoom\\..\\Windows", "c:\\output", "/srv/output/"]) assert.equal(canonicalFilesystemPathSchema.safeParse(value).success, false, value);

  for (const value of ["https://api.example.com:443", "https://xn--bcher-kva.example:8443"]) assert.equal(canonicalNetworkDestinationSchema.safeParse(value).success, true, value);
  for (const value of ["https://api.example.com", "https://API.example.com:443", "https://api.example.com:443/path", "http://api.example.com:80", "https://api.example.com:65536"]) assert.equal(canonicalNetworkDestinationSchema.safeParse(value).success, false, value);
});

test("normalized local requests and executor capabilities fail closed on unenforceable controls", () => {
  const request = {
    contractVersion: NODE_POLICY_CONTRACT_V1,
    requestId: "request:policy:1",
    tenantId: "tenant:owner",
    nodeId: "node:mac-mini",
    nodeClass: "personal-compute",
    projectId: "project:alpha",
    jobId: "job:publish:1",
    attemptId: "attempt:publish:1",
    leaseId: "lease:publish:1",
    leaseEpoch: 1,
    executorId: "executor:publisher",
    operationId: "publish:upload",
    operationDigest: hashA,
    authorityDigest: hashB,
    credentialRefs: ["credential:publishing"],
    target: { kind: "network" as const, canonicalDestination: "https://api.example.com:443" },
    risk: "high" as const,
    externalEffect: true,
    estimatedDurationSeconds: 120,
    estimatedCostUsd: "1.25",
    occurredAt: issuedAt,
  };
  assert.deepEqual(normalizedLocalPolicyRequestSchema.parse(request), request);
  assert.equal(normalizedLocalPolicyRequestSchema.safeParse({ ...request, externalEffect: false }).success, false);
  assert.equal(normalizedLocalPolicyRequestSchema.safeParse({ ...request, credentialRefs: ["credential:z", "credential:a"] }).success, false);
  assert.equal(normalizedLocalPolicyRequestSchema.safeParse({ ...request, estimatedCostUsd: "1.0" }).success, false);

  const capability = {
    contractVersion: NODE_POLICY_CONTRACT_V1,
    executorId: "executor:publisher",
    operationIds: ["publish:upload"],
    externalEffectOperationIds: ["publish:upload"],
    targetKinds: ["network"],
    supportsCancellation: true,
    supportsNetworkIdentityEnforcement: true,
    costMeter: "monotonic_reservable",
  };
  assert.deepEqual(executorCapabilitySchema.parse(capability), capability);
  assert.equal(executorCapabilitySchema.safeParse({ ...capability, supportsNetworkIdentityEnforcement: false }).success, false);
});

test("local decisions retain detail while wire denial receipts expose only coarse categories", () => {
  const decision = {
    contractVersion: NODE_POLICY_CONTRACT_V1,
    requestId: "request:policy:1",
    accepted: false,
    detail: "network_destination_not_allowed",
    wireCategory: "policy",
    requestDigest: hashA,
    ceilingDigest: hashB,
    authorityDigest: hashA,
    decidedAt: issuedAt,
  };
  assert.deepEqual(localPolicyDecisionSchema.parse(decision), decision);
  assert.equal(localPolicyDecisionSchema.safeParse({ ...decision, accepted: true }).success, false);

  const receipt = {
    contractVersion: NODE_POLICY_CONTRACT_V1,
    receiptId: "receipt:deny:1",
    relatedMessageId: "message:offer:1",
    jobId: "job:publish:1",
    attemptId: "attempt:publish:1",
    category: "policy",
    occurredAt: issuedAt,
  };
  assert.deepEqual(wireDenialReceiptSchema.parse(receipt), receipt);
  assert.equal(wireDenialReceiptSchema.safeParse({ ...receipt, detail: decision.detail }).success, false);
  assert.equal(wireDenialReceiptSchema.safeParse({ ...receipt, ceilingDigest: hashB }).success, false);
});

test("lease grants and renewals require a complete authority with its computed digest", () => {
  const authority = {
    projectId: "project:alpha",
    allowedExecutor: "executor:synthetic",
    allowedOperations: ["synthetic:run"],
    credentialRefs: [],
    filesystemRoots: [],
    networkPolicy: "none" as const,
    allowedNetworkDestinations: [],
    effectPolicy: "none" as const,
    maxRisk: "low" as const,
    maxDurationSeconds: 300,
    maxConcurrentEffects: 0,
    expiresAt,
    digest: hashA,
  };
  authority.digest = computeAuthorityDigest(authority);
  const frameBase = {
    protocol: "control-room-node/v1",
    direction: "server_to_node",
    messageId: "message:lease:1",
    correlationId: "correlation:lease:1",
    tenantId: "tenant:owner",
    actorId: "control-room:server",
    senderKind: "control_room",
    keyId: "server-key:primary",
    connectionId: "connection:1",
    sequence: 1,
    sentAt: issuedAt,
    expiresAt,
    nonce: "lease_nonce_1234567890123456",
    type: "job.lease.grant",
    body: {
      offerId: "offer:1",
      nodeId: "node:mac-mini",
      jobId: "job:1",
      attemptId: "attempt:1",
      leaseId: "lease:1",
      leaseEpoch: 1,
      acquiredAt: issuedAt,
      expiresAt,
      authorityDigest: authority.digest,
      authority,
    },
    signature: "a".repeat(86),
  } as const;
  const valid = { ...frameBase, bodyDigest: sha256Digest(frameBase.body) };
  assert.equal(signedNodeFrameSchema.safeParse(valid).success, true);
  const { authority: _authority, ...missingBody } = valid.body;
  void _authority;
  assert.equal(signedNodeFrameSchema.safeParse({ ...valid, body: missingBody, bodyDigest: sha256Digest(missingBody) }).success, false);
  const forgedAuthority = { ...authority, digest: hashA };
  const forgedBody = { ...valid.body, authorityDigest: hashA, authority: forgedAuthority };
  assert.equal(signedNodeFrameSchema.safeParse({ ...valid, body: forgedBody, bodyDigest: sha256Digest(forgedBody) }).success, false);

  const { nodeId: _nodeId, ...untargetedBody } = valid.body;
  void _nodeId;
  assert.equal(signedNodeFrameSchema.safeParse({ ...valid, body: untargetedBody, bodyDigest: sha256Digest(untargetedBody) }).success, false);

  const noncanonicalAuthority = {
    ...authority,
    networkPolicy: "allowlist" as const,
    allowedNetworkDestinations: ["destination:not-canonical"],
  };
  noncanonicalAuthority.digest = computeAuthorityDigest(noncanonicalAuthority);
  const noncanonicalBody = { ...valid.body, authorityDigest: noncanonicalAuthority.digest, authority: noncanonicalAuthority };
  assert.equal(signedNodeFrameSchema.safeParse({ ...valid, body: noncanonicalBody, bodyDigest: sha256Digest(noncanonicalBody) }).success, false);

  const renewalBody = {
    nodeId: "node:mac-mini",
    jobId: "job:1",
    attemptId: "attempt:1",
    leaseId: "lease:1",
    leaseEpoch: 1,
    renewedAt: issuedAt,
    expiresAt,
    authorityDigest: authority.digest,
    authority,
  };
  assert.equal(signedNodeFrameSchema.safeParse({
    ...valid,
    messageId: "message:renewal:1",
    type: "job.lease.renewed",
    body: renewalBody,
    bodyDigest: sha256Digest(renewalBody),
  }).success, true);
});

test("committed CR-5C.1 JSON Schemas match the strict runtime validators", async () => {
  for (const [filename, generated] of Object.entries(buildNodePolicyJsonSchemas())) {
    const committed = JSON.parse(await readFile(resolve("contracts", filename), "utf8")) as unknown;
    assert.deepEqual(committed, generated, `${filename} must be regenerated with pnpm policy:generate`);
  }
});
