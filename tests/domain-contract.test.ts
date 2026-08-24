import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DOMAIN_CONTRACT_VERSION,
  approvalStates,
  approvalTransitions,
  artifactStates,
  artifactTransitions,
  attemptStates,
  attemptTransitions,
  authorityEnvelopeSchema,
  buildDomainJsonSchema,
  checkpointStates,
  checkpointTransitions,
  compareDelegatedAuthority,
  domainEntitySchema,
  effectIntentStates,
  effectIntentTransitions,
  incidentStates,
  incidentTransitions,
  jobStates,
  jobTransitions,
  leaseStates,
  leaseTransitions,
  messageEnvelopeSchema,
  nodeStates,
  nodeTransitions,
  requestStates,
  requestTransitions,
  scheduleStates,
  scheduleTransitions,
  serviceStates,
  serviceTransitions,
  workflowStates,
  workflowTransitions,
} from "../src/domain/v1/index.ts";

const now = "2026-08-22T18:00:00.000Z";
const later = "2026-08-22T19:00:00.000Z";
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const base = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: "tenant:owner", version: 0, createdAt: now, updatedAt: now };
const actor = { actorId: "actor:owner", actorType: "human" as const };
const authority = {
  projectId: "project:test",
  allowedExecutor: "executor:test",
  allowedOperations: ["operation:read"],
  credentialRefs: [],
  filesystemRoots: [],
  networkPolicy: "none" as const,
  allowedNetworkDestinations: [],
  effectPolicy: "none" as const,
  maxRisk: "low" as const,
  maxDurationSeconds: 300,
  maxConcurrentEffects: 0,
  expiresAt: later,
  digest: digestA,
};

const entities = [
  { ...base, kind: "request", id: "request:1", title: "Test request", objective: "Prove the contract", state: "draft", priority: 50, requestedBy: actor, idempotencyKey: "request-key-0001" },
  { ...base, kind: "workflow", id: "workflow:1", requestId: "request:1", projectId: "project:test", definitionVersion: "1.0.0", definitionDigest: digestA, authorityMode: "control_room_native", state: "proposed", jobIds: [] },
  { ...base, kind: "job", id: "job:1", workflowId: "workflow:1", projectId: "project:test", jobType: "test:job", specVersion: "1.0.0", inputDigest: digestA, state: "proposed", priority: 50, requiredCapability: "capability:test", dependsOnJobIds: [], authority, retryPolicy: { maxAttempts: 2, backoffSeconds: 10, retryableFailureCodes: ["temporary"], retryAfterOrphan: true, ambiguousEffectPolicy: "attention" } },
  { ...base, kind: "attempt", id: "attempt:1", jobId: "job:1", attemptNumber: 1, state: "offered", offeredAt: now },
  { ...base, kind: "lease", id: "lease:1", jobId: "job:1", attemptId: "attempt:1", nodeId: "node:1", epoch: 1, state: "active", acquiredAt: now, expiresAt: later },
  { ...base, kind: "checkpoint", id: "checkpoint:1", attemptId: "attempt:1", sequence: 0, state: "declared", payloadDigest: digestA, artifactIds: [] },
  { ...base, kind: "effect_intent", id: "effect:1", jobId: "job:1", attemptId: "attempt:1", operation: "operation:read", operationDigest: digestA, destination: "destination:test", idempotencyKey: "effect-key-00001", risk: "low", state: "proposed" },
  { ...base, kind: "approval", id: "approval:1", operationDigest: digestA, scope: "project:test", risk: "high", state: "pending", requestedBy: actor, requiredActorType: "owner", expiresAt: later },
  { ...base, kind: "service", id: "service:1", projectId: "project:test", serviceType: "service:http", desiredStateDigest: digestA, state: "active" },
  { ...base, kind: "schedule", id: "schedule:1", projectId: "project:test", state: "active", scheduleType: "interval", expression: "900", timezone: "UTC", targetType: "service_check", targetId: "service:1", nextRunAt: later, idempotencyWindowSeconds: 900 },
  { ...base, kind: "incident", id: "incident:1", severity: "warning", state: "open", sourceType: "service", sourceId: "service:1", summary: "Synthetic incident", openedAt: now },
  { ...base, kind: "artifact_manifest", id: "artifact:1", projectId: "project:test", jobId: "job:1", attemptId: "attempt:1", state: "declared", contentHash: digestA, sizeBytes: 0, mimeType: "text/plain", logicalRole: "test:result", schemaVersion: "1.0.0", producerId: "node:1", storageClass: "local", retentionClass: "ephemeral" },
  { ...base, kind: "node", id: "node:1", displayName: "Synthetic node", state: "pending_enrollment", platform: "linux", architecture: "x64", identityKeyId: "key:node-1", hardwareFingerprint: digestA, softwareFingerprint: digestB, policyVersion: "1.0.0", minimumProtocolVersion: "control-room-node/v1" },
] as const;

test("all CR-4A canonical entity fixtures satisfy the versioned validators", () => {
  assert.equal(entities.length, 13);
  for (const entity of entities) domainEntitySchema.parse(entity);
});

test("every lifecycle state has an explicit and closed transition row", () => {
  const machines: Array<[readonly string[], Record<string, readonly string[]>]> = [
    [requestStates, requestTransitions], [workflowStates, workflowTransitions], [jobStates, jobTransitions],
    [attemptStates, attemptTransitions], [leaseStates, leaseTransitions], [checkpointStates, checkpointTransitions],
    [effectIntentStates, effectIntentTransitions], [approvalStates, approvalTransitions], [serviceStates, serviceTransitions],
    [scheduleStates, scheduleTransitions], [incidentStates, incidentTransitions], [artifactStates, artifactTransitions],
    [nodeStates, nodeTransitions],
  ];

  for (const [states, transitions] of machines) {
    assert.deepEqual(Object.keys(transitions).sort(), [...states].sort());
    for (const [from, destinations] of Object.entries(transitions)) {
      assert.equal(new Set(destinations).size, destinations.length, `${from} contains duplicate transitions`);
      assert.ok(!destinations.includes(from), `${from} contains a self-transition`);
      for (const destination of destinations) assert.ok(states.includes(destination), `${from} targets unknown ${destination}`);
    }
  }
});

test("job lifecycle permits recovery but keeps terminal states terminal", () => {
  assert.ok(jobTransitions.proposed.includes("ready"));
  assert.ok(jobTransitions.leased.includes("ready"));
  assert.ok(jobTransitions.running.includes("orphaned"));
  assert.ok(jobTransitions.orphaned.includes("ready"));
  assert.deepEqual(jobTransitions.succeeded, []);
  assert.deepEqual(jobTransitions.cancelled, []);
  assert.deepEqual(jobTransitions.rejected, []);
  assert.ok(!jobTransitions.ready.includes("succeeded"));
});

test("delegated authority may narrow but cannot expand its parent", () => {
  authorityEnvelopeSchema.parse(authority);
  const narrowed = { ...authority, allowedOperations: ["operation:read"], maxDurationSeconds: 120, parentDigest: authority.digest, digest: digestB };
  assert.deepEqual(compareDelegatedAuthority(authority, narrowed), { allowed: true, violations: [] });

  const expanded = { ...narrowed, networkPolicy: "allowlist" as const, allowedNetworkDestinations: ["destination:new"], credentialRefs: ["credential:new"], filesystemRoots: ["/outside"], maxRisk: "high" as const, maxDurationSeconds: 600, maxConcurrentEffects: 1 };
  const comparison = compareDelegatedAuthority(authority, expanded);
  assert.equal(comparison.allowed, false);
  assert.deepEqual(comparison.violations.sort(), ["concurrency_expanded", "credential_scope_expanded", "duration_expanded", "filesystem_scope_expanded", "network_destination_expanded", "network_scope_expanded", "risk_expanded"]);
});

test("validators reject mismatched authority and unsafe effect/artifact records", () => {
  const job = entities.find((entity) => entity.kind === "job")!;
  assert.throws(() => domainEntitySchema.parse({ ...job, authority: { ...job.authority, projectId: "project:other" } }), /authority projectId/);

  const effect = entities.find((entity) => entity.kind === "effect_intent")!;
  assert.throws(() => domainEntitySchema.parse({ ...effect, risk: "critical" }), /approvalId/);

  const artifact = entities.find((entity) => entity.kind === "artifact_manifest")!;
  assert.throws(() => domainEntitySchema.parse({ ...artifact, state: "uploaded", opaqueLocator: "https://store.invalid/a?X-Amz-Signature=secret" }), /signed credentials/);
});

test("message envelope requires a bounded validity window", () => {
  const message = { protocol: "control-room-node/v1", messageId: "message:1", correlationId: "correlation:1", actorId: "node:1", tenantId: "tenant:owner", sentAt: now, expiresAt: later, nonce: "1234567890abcdef", type: "job:offer", bodyDigest: digestA, body: {}, signature: "1234567890abcdef" };
  messageEnvelopeSchema.parse(message);
  assert.throws(() => messageEnvelopeSchema.parse({ ...message, expiresAt: now }), /expiresAt/);
});

test("generated JSON Schema exposes all canonical entity variants", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/control-room-domain-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.anyOf.length, 13);
  assert.match(JSON.stringify(schema), /control-room-domain\/v1/);
  assert.match(JSON.stringify(schema), /effect_intent/);
  assert.match(JSON.stringify(schema), /artifact_manifest/);
  assert.deepEqual(schema, buildDomainJsonSchema());
});
