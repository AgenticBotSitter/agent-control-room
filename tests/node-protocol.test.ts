import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite, type DatabaseClient } from "../src/persistence/database.ts";
import { computeAuthorityDigest, sha256Digest } from "../src/security/index.ts";
import {
  DatabaseNodeKeyResolver,
  DatabaseReplayGuard,
  buildNodeProtocolJsonSchemas,
  EnrollmentError,
  FixedWindowProtocolRateLimiter,
  NODE_PROTOCOL_V1,
  NodeEnrollmentStore,
  NodeProtocolAuthenticator,
  ProtocolAuthenticationError,
  ProtocolNegotiationError,
  negotiateProtocolVersion,
  signEnrollmentProof,
  signNodeFrame,
  signedNodeFrameSchema,
  type EnrollmentChallenge,
  type EnrollmentProof,
  type NodeMessageType,
  type SignedNodeFrame,
  type VerifyFrameOptions,
  type UnsignedNodeFrame,
} from "../src/node-protocol/v1/index.ts";

const t0 = "2026-08-22T18:00:00.000Z";
const t1 = "2026-08-22T18:01:00.000Z";
const t2 = "2026-08-22T18:02:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;

async function migratedDatabase() {
  const db = new PGlite();
  const files = (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(resolve("db/migrations", file), "utf8"));
  await db.query(`INSERT INTO tenants (id,display_name) VALUES ('tenant:owner','Owner')`);
  return db;
}

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64url") };
}

function unsignedProof(challenge: EnrollmentChallenge, spki: string): Omit<EnrollmentProof, "signature"> {
  return {
    challengeId: challenge.challengeId,
    challengeNonce: challenge.challengeNonce,
    nodeId: "node:mac-mini",
    displayName: "Marvin Mac mini",
    nodeClass: "personal-compute",
    publicKey: { keyId: "node-key:mac-mini:1", algorithm: "ed25519", spki },
    platformFacts: {
      platform: "macos",
      architecture: "arm64",
      hardwareFingerprint: hashA,
      softwareFingerprint: hashB,
      bridgeVersion: "0.1.0",
      attestation: { source: "local-discovery" },
    },
    supportedProtocols: [NODE_PROTOCOL_V1],
  };
}

async function enroll(db: DatabaseClient, privateKey: KeyObject, spki: string) {
  const store = new NodeEnrollmentStore(db, [{ keyId: "server-key:primary", algorithm: "ed25519", spki }]);
  const issued = await store.issueToken({ tenantId: "tenant:owner", nodeClass: "personal-compute", createdBy: "identity:owner", createdAt: t0 });
  const challenge = await store.createChallenge({ tokenId: issued.tokenId, token: issued.token, nodeClass: "personal-compute", supportedProtocols: [NODE_PROTOCOL_V1] }, t0, "challenge:mac-mini");
  const proof = signEnrollmentProof(unsignedProof(challenge, spki), privateKey);
  const result = await store.complete(proof, { now: t1, policyVersion: "policy:default:v1", initialGrant: { nodeClass: "personal-compute", allowedRisk: ["low"] } });
  assert.equal(result.accepted, true);
  if (result.accepted) {
    assert.deepEqual(result.initialGrant, { nodeClass: "personal-compute", allowedRisk: ["low"] });
    assert.equal(result.serverTrustKeys[0].spki, spki);
  }
  return { store, issued, challenge, proof, result };
}

function helloFrame(privateKey: KeyObject, overrides: Partial<SignedNodeFrame<"connection.hello">> = {}): SignedNodeFrame<"connection.hello"> {
  const body = {
    supportedProtocols: [NODE_PROTOCOL_V1], features: ["reconciliation"], requestedMaxFrameBytes: 65_536,
    lastAcknowledgedServerSequence: 0, unresolvedAttemptIds: [],
  };
  return signNodeFrame({
    protocol: NODE_PROTOCOL_V1,
    direction: "node_to_server",
    messageId: "message:hello:1",
    correlationId: "correlation:connection:1",
    tenantId: "tenant:owner",
    actorId: "node:mac-mini",
    senderKind: "node",
    keyId: "node-key:mac-mini:1",
    connectionId: "connection:1",
    sequence: 1,
    sentAt: t1,
    expiresAt: t2,
    nonce: "nonce_hello_12345678901234567890",
    type: "connection.hello",
    body,
    ...overrides,
  } as UnsignedNodeFrame<"connection.hello">, privateKey);
}

function heartbeatFrame(privateKey: KeyObject, overrides: Partial<SignedNodeFrame<"node.heartbeat">> = {}): SignedNodeFrame<"node.heartbeat"> {
  return signNodeFrame({
    protocol: NODE_PROTOCOL_V1,
    direction: "node_to_server",
    messageId: "message:heartbeat:2",
    correlationId: "correlation:connection:1",
    tenantId: "tenant:owner",
    actorId: "node:mac-mini",
    senderKind: "node",
    keyId: "node-key:mac-mini:1",
    connectionId: "connection:1",
    sequence: 2,
    sentAt: t1,
    expiresAt: t2,
    nonce: "nonce_heartbeat_1234567890123456",
    type: "node.heartbeat",
    body: {
      observedAt: t1, health: "healthy", policyVersion: "policy:default:v1", activeAttemptIds: [],
      resources: { freeMemoryMb: 20_000, freeScratchMb: 100_000, cpuUtilizationPercent: 10 },
    },
    ...overrides,
  } as UnsignedNodeFrame<"node.heartbeat">, privateKey);
}

async function expectAuthCode(promise: Promise<unknown>, code: ProtocolAuthenticationError["code"]) {
  await assert.rejects(promise, (error) => error instanceof ProtocolAuthenticationError && error.code === code);
}

function verifyOptions(overrides: Partial<VerifyFrameOptions> = {}): VerifyFrameOptions {
  return { expectedDirection: "node_to_server", receivedAt: t1, transportIdentity: "transport:test", ...overrides };
}

function rateLimiter(maximum = 100) {
  return new FixedWindowProtocolRateLimiter(maximum, 60);
}

function generatedSchemaAccepts(schemaValue: unknown, value: unknown): boolean {
  if (!schemaValue || typeof schemaValue !== "object" || Array.isArray(schemaValue)) return schemaValue === true;
  const schema = schemaValue as Record<string, unknown>;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((candidate) => generatedSchemaAccepts(candidate, value));
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => candidate === value)) return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, unknown> : {};
    if (Array.isArray(schema.required)
      && !schema.required.every((key) => typeof key === "string" && Object.hasOwn(record, key))) return false;
    for (const [key, child] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) {
        if (!generatedSchemaAccepts(properties[key], child)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object"
        && !generatedSchemaAccepts(schema.additionalProperties, child)) return false;
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (Array.isArray(schema.prefixItems)) {
      if (value.length !== schema.prefixItems.length) return false;
      for (let index = 0; index < value.length; index += 1) {
        if (!generatedSchemaAccepts(schema.prefixItems[index], value[index])) return false;
      }
    } else if (schema.items && typeof schema.items === "object") {
      for (let index = 0; index < value.length; index += 1) {
        if (!generatedSchemaAccepts(schema.items, value[index])) return false;
      }
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !(new RegExp(schema.pattern)).test(value)) return false;
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) return false;
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) return false;
    if (typeof schema.maximum === "number" && (value as number) > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && (value as number) <= schema.exclusiveMinimum) return false;
  } else if (schema.type === "number" && typeof value !== "number") return false;
  else if (schema.type === "boolean" && typeof value !== "boolean") return false;
  else if (schema.type === "null" && value !== null) return false;
  return true;
}

test("version negotiation selects a known mutual version and fails closed", () => {
  assert.equal(negotiateProtocolVersion(["future/v9", NODE_PROTOCOL_V1]), NODE_PROTOCOL_V1);
  assert.throws(() => negotiateProtocolVersion(["future/v9"]), ProtocolNegotiationError);
});

test("strict protocol schemas reject unknown fields and invalid direction ownership", () => {
  const keys = keyMaterial();
  const frame = helloFrame(keys.privateKey);
  assert.equal(signedNodeFrameSchema.parse(frame).type, "connection.hello");
  assert.equal(signedNodeFrameSchema.safeParse({ ...frame, unexpected: true }).success, false);
  assert.equal(signedNodeFrameSchema.safeParse({ ...frame, senderKind: "control_room" }).success, false);
});

test("every CR-5A connection, heartbeat, offer, lease, event, cancellation, and reconciliation body is represented", () => {
  const keys = keyMaterial();
  const template = helloFrame(keys.privateKey);
  const lease = { jobId: "job:1", attemptId: "attempt:1", leaseId: "lease:1", leaseEpoch: 1 };
  const authority = {
    projectId: "project:1", allowedExecutor: "executor:synthetic", allowedOperations: ["synthetic:run"], credentialRefs: [],
    filesystemRoots: [], networkPolicy: "none" as const, allowedNetworkDestinations: [], effectPolicy: "none" as const,
    maxRisk: "low" as const, maxDurationSeconds: 300, maxConcurrentEffects: 0, expiresAt: t2, digest: hashA,
  };
  authority.digest = computeAuthorityDigest(authority);
  const enrollmentEnvelope = {
    body: { contractVersion: "control-room-enrollment/v1", tenantId: "tenant:owner",
      nodeId: "node:mac-mini", connectionId: "connection:1" },
    attestation: { algorithm: "ed25519", keyId: "node-key:mac-mini:1",
      publicKeySpki: "A".repeat(40), signature: "B".repeat(40) },
  };
  const cases: Array<{ type: NodeMessageType; direction: "node_to_server" | "server_to_node"; body: unknown }> = [
    { type: "connection.accepted", direction: "server_to_node", body: { selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: ["reconciliation"], maxFrameBytes: 65_536, heartbeatIntervalSeconds: 30, serverTime: t1 } },
    { type: "connection.enrollment.deliver", direction: "node_to_server", body: {
      deliveryId: "delivery:connection:1", enrollmentContract: "control-room-enrollment/v1",
      envelopeDigest: sha256Digest(enrollmentEnvelope), envelope: enrollmentEnvelope } },
    { type: "node.heartbeat", direction: "node_to_server", body: { observedAt: t1, health: "healthy", policyVersion: "policy:v1", activeAttemptIds: [], resources: { freeMemoryMb: 1, freeScratchMb: 1, cpuUtilizationPercent: 1 } } },
    { type: "job.offer", direction: "server_to_node", body: { offerId: "offer:1", nodeId: "node:mac-mini", jobId: lease.jobId, attemptId: lease.attemptId, proposedLeaseEpoch: 1, offerExpiresAt: t2, jobType: "synthetic:test", specVersion: "1.0.0", inputDigest: hashA, artifactManifestIds: [], authority } },
    { type: "job.offer.decision", direction: "node_to_server", body: { offerId: "offer:1", jobId: lease.jobId, attemptId: lease.attemptId, decision: "accepted" } },
    { type: "job.lease.grant", direction: "server_to_node", body: { offerId: "offer:1", nodeId: "node:mac-mini", ...lease, acquiredAt: t1, expiresAt: t2, authorityDigest: authority.digest, authority } },
    { type: "job.lease.renewed", direction: "server_to_node", body: { nodeId: "node:mac-mini", ...lease, renewedAt: t1, expiresAt: t2, authorityDigest: authority.digest, authority } },
    { type: "job.event", direction: "node_to_server", body: { ...lease, event: "started", sequence: 1, occurredAt: t1, artifactManifestIds: [] } },
    { type: "job.cancel", direction: "server_to_node", body: { ...lease, reasonCode: "owner_requested" } },
    { type: "job.cancel.ack", direction: "node_to_server", body: { ...lease, reasonCode: "owner_requested", disposition: "accepted" } },
    { type: "node.reconciliation.request", direction: "server_to_node", body: { lastAcknowledgedNodeSequence: 1, requestedAttemptIds: [lease.attemptId] } },
    { type: "node.reconciliation.report", direction: "node_to_server", body: { lastAcknowledgedServerSequence: 1, attempts: [{ attemptId: lease.attemptId, leaseId: lease.leaseId, leaseEpoch: 1, state: "running", lastEventSequence: 1, checkpointIds: [] }] } },
    { type: "node.operation.request", direction: "server_to_node", body: { requestId: "node-operation:1", nodeId: "node:mac-mini", operation: "request_drain", desiredState: "draining", expectedNodeVersion: 4, requestDigest: hashA } },
    { type: "node.operation.ack", direction: "node_to_server", body: { requestId: "node-operation:1", nodeId: "node:mac-mini", operation: "request_drain", expectedNodeVersion: 4, disposition: "applied", acknowledgementId: "ack:node-operation:1", resultingNodeVersion: 5 } },
    { type: "protocol.ack", direction: "server_to_node", body: { acknowledgedMessageIds: ["message:1"], highestContiguousSequence: 1, disposition: "accepted" } },
  ];
  for (const item of cases) {
    const senderKind = item.direction === "node_to_server" ? "node" : "control_room";
    const candidate = {
      ...template,
      direction: item.direction,
      senderKind,
      actorId: senderKind === "node" ? "node:mac-mini" : "control-room:server",
      keyId: senderKind === "node" ? "node-key:mac-mini:1" : "server-key:primary",
      type: item.type,
      body: item.body,
      bodyDigest: sha256Digest(item.body),
    };
    assert.equal(signedNodeFrameSchema.safeParse(candidate).success, true, `${item.type} must have a valid strict schema`);
  }
});

test("committed node protocol JSON Schemas match the runtime validators", async () => {
  for (const [filename, generated] of Object.entries(buildNodeProtocolJsonSchemas())) {
    const committed = JSON.parse(await readFile(resolve("contracts", filename), "utf8")) as unknown;
    assert.deepEqual(committed, generated, `${filename} must be regenerated with pnpm protocol:generate`);
  }
});

test("enrollment delivery generated schema and runtime share the structural rejection corpus", () => {
  const keys = keyMaterial(), template = helloFrame(keys.privateKey);
  const envelope = {
    body: { contractVersion: "control-room-enrollment/v1", tenantId: "tenant:owner",
      nodeId: "node:mac-mini", connectionId: "connection:1", providerSpecific: false },
    attestation: { algorithm: "ed25519", keyId: "node-key:mac-mini:1",
      publicKeySpki: "A".repeat(40), signature: "B".repeat(40) },
  };
  const body = { deliveryId: "delivery:connection:1", enrollmentContract: "control-room-enrollment/v1",
    envelopeDigest: sha256Digest(envelope), envelope };
  const valid = { ...template, direction: "node_to_server", senderKind: "node",
    type: "connection.enrollment.deliver", body, bodyDigest: sha256Digest(body) };
  const generated = buildNodeProtocolJsonSchemas()["control-room-node-v1-frame.schema.json"];
  assert.equal(generatedSchemaAccepts(generated, valid), true);
  assert.equal(signedNodeFrameSchema.safeParse(valid).success, true);

  const malformed = [
    { ...valid, direction: "server_to_node" },
    { ...valid, senderKind: "control_room" },
    { ...valid, body: { ...body, deliveryId: "a" } },
    { ...valid, body: { ...body, envelope: "scalar" } },
    { ...valid, body: { ...body, envelope: { attestation: envelope.attestation } } },
    { ...valid, body: { ...body, envelope: { ...envelope,
      attestation: { ...envelope.attestation, unexpected: true } } } },
  ];
  for (const candidate of malformed) {
    assert.equal(generatedSchemaAccepts(generated, candidate), false);
    assert.equal(signedNodeFrameSchema.safeParse(candidate).success, false);
  }

  const crossScopeEnvelope = { ...envelope, body: { ...envelope.body, tenantId: "tenant:other" } };
  const crossScopeBody = { ...body, envelope: crossScopeEnvelope,
    envelopeDigest: sha256Digest(crossScopeEnvelope) };
  const crossScope = { ...valid, body: crossScopeBody, bodyDigest: sha256Digest(crossScopeBody) };
  assert.equal(generatedSchemaAccepts(generated, crossScope), true,
    "JSON Schema covers structure; signed runtime validation owns relational identity binding");
  assert.equal(signedNodeFrameSchema.safeParse(crossScope).success, false);
});

test("single-use enrollment persists only a token digest and atomically activates node identity", async () => {
  const raw = await migratedDatabase();
  const db = adaptPglite(raw);
  const keys = keyMaterial();
  const enrolled = await enroll(db, keys.privateKey, keys.spki);
  const token = await raw.query<{ token_digest: string; state: string }>(`SELECT token_digest,state FROM node_enrollment_tokens WHERE id=$1`, [enrolled.issued.tokenId]);
  assert.equal(token.rows[0].state, "consumed");
  assert.notEqual(token.rows[0].token_digest, enrolled.issued.token);
  const node = await raw.query<{ state: string; version: number; identity_key_id: string }>(`SELECT state,version,identity_key_id FROM control_nodes WHERE id='node:mac-mini'`);
  assert.deepEqual(node.rows[0], { state: "active", version: 1, identity_key_id: "node-key:mac-mini:1" });
  assert.equal((await raw.query(`SELECT id FROM control_transition_events WHERE entity_id='node:mac-mini'`)).rows.length, 1);
  assert.equal((await raw.query(`SELECT id FROM control_outbox WHERE aggregate_id='node:mac-mini'`)).rows.length, 1);
  await assert.rejects(
    raw.query(`UPDATE node_enrollment_tokens SET state='issued',consumed_at=NULL WHERE id=$1`, [enrolled.issued.tokenId]),
    /cannot be restored/,
  );
  await assert.rejects(
    raw.query(`UPDATE node_enrollment_challenges SET state='issued',consumed_at=NULL WHERE id=$1`, [enrolled.challenge.challengeId]),
    /cannot be restored/,
  );
  await assert.rejects(
    enrolled.store.createChallenge({ tokenId: enrolled.issued.tokenId, token: enrolled.issued.token, nodeClass: "personal-compute", supportedProtocols: [NODE_PROTOCOL_V1] }, t1),
    (error) => error instanceof EnrollmentError && error.safeReasonCode === "invalid_enrollment",
  );
  await raw.close();
});

test("expired tokens, wrong token classes, bad proofs, and unsupported versions fail closed", async () => {
  const raw = await migratedDatabase();
  const db = adaptPglite(raw);
  const server = keyMaterial();
  const store = new NodeEnrollmentStore(db, [{ keyId: "server-key:primary", algorithm: "ed25519", spki: server.spki }]);
  const short = await store.issueToken({ tenantId: "tenant:owner", nodeClass: "personal-compute", createdBy: "identity:owner", createdAt: t0, expiresAt: "2026-08-22T18:00:01.000Z" });
  await assert.rejects(
    store.createChallenge({ tokenId: short.tokenId, token: short.token, nodeClass: "personal-compute", supportedProtocols: [NODE_PROTOCOL_V1] }, t1),
    (error) => error instanceof EnrollmentError && error.safeReasonCode === "expired_enrollment",
  );
  const current = await store.issueToken({ tenantId: "tenant:owner", nodeClass: "personal-compute", createdBy: "identity:owner", createdAt: t0, tokenId: "enrollment:current" });
  await assert.rejects(
    store.createChallenge({ tokenId: current.tokenId, token: current.token, nodeClass: "gpu-render", supportedProtocols: [NODE_PROTOCOL_V1] }, t0),
    (error) => error instanceof EnrollmentError && error.safeReasonCode === "invalid_enrollment",
  );
  await assert.rejects(
    store.createChallenge({ tokenId: current.tokenId, token: current.token, nodeClass: "personal-compute", supportedProtocols: ["future/v9"] }, t0),
    (error) => error instanceof EnrollmentError && error.safeReasonCode === "unsupported_protocol",
  );
  const challenge = await store.createChallenge({ tokenId: current.tokenId, token: current.token, nodeClass: "personal-compute", supportedProtocols: [NODE_PROTOCOL_V1] }, t0, "challenge:bad-proof");
  const keys = keyMaterial();
  const attacker = keyMaterial();
  const badProof = signEnrollmentProof(unsignedProof(challenge, keys.spki), attacker.privateKey);
  await assert.rejects(store.complete(badProof, { now: t1, policyVersion: "policy:v1", initialGrant: {} }), /rejected/);
  const goodProof = signEnrollmentProof(unsignedProof(challenge, keys.spki), keys.privateKey);
  assert.equal((await store.complete(goodProof, { now: t1, policyVersion: "policy:v1", initialGrant: {} })).accepted, true);
  await raw.close();
});

test("authenticated frames bind identity, digest, signature, lifetime, type, and replay state", async () => {
  const raw = await migratedDatabase();
  const db = adaptPglite(raw);
  const keys = keyMaterial();
  await enroll(db, keys.privateKey, keys.spki);
  const authenticator = new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(db), new DatabaseReplayGuard(db), rateLimiter());
  const hello = helloFrame(keys.privateKey);
  const accepted = await authenticator.verify(JSON.stringify(hello), verifyOptions());
  assert.equal(accepted.frame.messageId, hello.messageId);
  assert.equal(accepted.delivery, "accepted");
  assert.equal((await authenticator.verify(JSON.stringify(hello), verifyOptions())).delivery, "duplicate");
  const conflictingReplay = helloFrame(keys.privateKey, {
    body: { ...hello.body, features: ["different-signed-content"] },
  });
  await expectAuthCode(authenticator.verify(JSON.stringify(conflictingReplay), verifyOptions()), "replayed");
  const heartbeat = heartbeatFrame(keys.privateKey);
  assert.equal((await authenticator.verify(JSON.stringify(heartbeat), verifyOptions())).frame.sequence, 2);
  const gap = heartbeatFrame(keys.privateKey, { messageId: "message:gap:4", sequence: 4, nonce: "nonce_gap_123456789012345678901234" });
  await expectAuthCode(authenticator.verify(JSON.stringify(gap), verifyOptions()), "replayed");
  await raw.close();
});

test("forged, expired, tampered, wrong-direction, unknown-version, oversized, and malformed frames are rejected", async () => {
  const raw = await migratedDatabase();
  const db = adaptPglite(raw);
  const keys = keyMaterial();
  const attacker = keyMaterial();
  await enroll(db, keys.privateKey, keys.spki);
  const resolver = new DatabaseNodeKeyResolver(db);
  const noReplay = { consume: async () => "accepted" as const };
  const authenticator = new NodeProtocolAuthenticator(resolver, noReplay, rateLimiter());
  await expectAuthCode(authenticator.verify(JSON.stringify(helloFrame(attacker.privateKey)), verifyOptions()), "unauthenticated");
  await expectAuthCode(authenticator.verify(JSON.stringify(helloFrame(keys.privateKey)), verifyOptions({ receivedAt: "2026-08-22T18:03:00.000Z" })), "expired");
  const badDigest = { ...helloFrame(keys.privateKey), bodyDigest: hashA };
  await expectAuthCode(authenticator.verify(JSON.stringify(badDigest), verifyOptions()), "unauthenticated");
  await expectAuthCode(authenticator.verify(JSON.stringify(helloFrame(keys.privateKey)), verifyOptions({ expectedDirection: "server_to_node" })), "forbidden");
  const future = { ...helloFrame(keys.privateKey), protocol: "control-room-node/v99" };
  await expectAuthCode(authenticator.verify(JSON.stringify(future), verifyOptions()), "unsupported_version");
  await expectAuthCode(authenticator.verify(`${JSON.stringify(helloFrame(keys.privateKey))}${" ".repeat(100)}`, verifyOptions({ maxFrameBytes: 100 })), "malformed_frame");
  await expectAuthCode(authenticator.verify("{not-json", verifyOptions()), "malformed_frame");
  await raw.close();
});

test("quarantined nodes cannot authenticate", async () => {
  const raw = await migratedDatabase();
  const db = adaptPglite(raw);
  const keys = keyMaterial();
  await enroll(db, keys.privateKey, keys.spki);
  const authenticator = new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(db), { consume: async () => "accepted" as const }, rateLimiter());
  const row = await raw.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM control_nodes WHERE id='node:mac-mini'`);
  const payload = { ...row.rows[0].payload, state: "quarantined", version: 2, quarantineReasonCode: "security_review", updatedAt: t1 };
  await raw.query(`UPDATE control_nodes SET state='quarantined',version=2,payload=$1::jsonb,updated_at=$2 WHERE id='node:mac-mini'`, [JSON.stringify(payload),t1]);
  await expectAuthCode(authenticator.verify(JSON.stringify(helloFrame(keys.privateKey)), verifyOptions()), "forbidden");
  await raw.close();
});

test("revoked keys cannot authenticate or be restored", async () => {
  const raw = await migratedDatabase();
  const db = adaptPglite(raw);
  const keys = keyMaterial();
  await enroll(db, keys.privateKey, keys.spki);
  const authenticator = new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(db), { consume: async () => "accepted" as const }, rateLimiter());
  await raw.query(`UPDATE control_node_keys SET state='revoked',revoked_at=$1 WHERE tenant_id='tenant:owner' AND node_id='node:mac-mini'`, [t1]);
  await expectAuthCode(authenticator.verify(JSON.stringify(helloFrame(keys.privateKey)), verifyOptions()), "forbidden");
  await assert.rejects(raw.query(`UPDATE control_node_keys SET state='active',revoked_at=NULL WHERE tenant_id='tenant:owner' AND node_id='node:mac-mini'`), /cannot be restored/);
  await assert.rejects(raw.query(`DELETE FROM control_node_keys WHERE tenant_id='tenant:owner' AND node_id='node:mac-mini'`), /append-preserving/);
  await raw.close();
});

test("transport rate limits fail closed before signature verification", async () => {
  const raw = await migratedDatabase();
  const db = adaptPglite(raw);
  const keys = keyMaterial();
  await enroll(db, keys.privateKey, keys.spki);
  const authenticator = new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(db), { consume: async () => "accepted" as const }, rateLimiter(1));
  await authenticator.verify(JSON.stringify(helloFrame(keys.privateKey)), verifyOptions());
  const second = helloFrame(keys.privateKey, {
    messageId: "message:rate:2",
    actorId: "node:rotated-unverified-claim",
    nonce: "nonce_rate_12345678901234567890123",
  });
  await expectAuthCode(authenticator.verify(JSON.stringify(second), verifyOptions()), "rate_limited");
  await raw.close();
});

test("nonce replay is rejected across connection identifiers and expired replay rows can be pruned", async () => {
  const raw = await migratedDatabase();
  const db = adaptPglite(raw);
  const keys = keyMaterial();
  await enroll(db, keys.privateKey, keys.spki);
  const guard = new DatabaseReplayGuard(db);
  const authenticator = new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(db), guard, rateLimiter());
  const first = helloFrame(keys.privateKey);
  await authenticator.verify(JSON.stringify(first), verifyOptions());
  await assert.rejects(raw.query(`UPDATE node_protocol_replay SET message_id='message:rewritten' WHERE message_id=$1`, [first.messageId]), /append-only/);
  await assert.rejects(raw.exec(`TRUNCATE node_protocol_replay`), /append-only/);
  const reusedNonce = helloFrame(keys.privateKey, { messageId: "message:hello:new", connectionId: "connection:2" });
  await expectAuthCode(authenticator.verify(JSON.stringify(reusedNonce), verifyOptions()), "replayed");
  assert.equal(await guard.pruneExpired("2026-08-22T18:03:00.000Z"), 1);
  await raw.close();
});
