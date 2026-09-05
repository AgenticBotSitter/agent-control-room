import { generateKeyPairSync } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { adaptPglite } from "../src/persistence/database";
import { DOMAIN_CONTRACT_VERSION, type JobRecord, type NodeRecord, type RequestRecord, type WorkflowRecord } from "../src/domain/v1";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { nativeTaskObservation, nativeTaskRegistration } from "../src/harness/hermes-native-v1/task-observation";
import type { NativeSnapshot } from "../src/harness/hermes-native-v1/contracts";
import { NativeTaskSnapshotService } from "../src/node-control/native-task-snapshot-service";
import { DatabaseNodeKeyResolver, DatabaseReplayGuard, FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator,
  NODE_PROTOCOL_V1, publicKeyFingerprint, signNodeFrame, type SignedNodeFrame } from "../src/node-protocol/v1";
import { binding, digest, input, instant, nativeRunId } from "./hermes-native-fixture";

export const at = (offset = 0) => new Date(instant + offset).toISOString();
export const inputDigest = sha256Digest({ prompt: input.prompt, instructions: input.instructions });
export const registration = nativeTaskRegistration(binding, inputDigest, "lease:test", 1, at());
export function snapshot(patch: Partial<NativeSnapshot> = {}): NativeSnapshot {
  return { binding, version: 3, state: "queued", nativeRunId, observedAt: instant + 1000, upstreamUpdatedAt: null,
    availability: "current", streamAttempted: false, stopAttempted: false, resultText: null, usage: null,
    lastActivity: "none", safeReason: "none", ...patch };
}
export const observation = (patch: Partial<NativeSnapshot> = {}) => nativeTaskObservation(snapshot(patch), registration.nativeTask!);

export async function nativeTaskFixture() {
  const raw = new PGlite();
  for (const name of (await readdir(resolve("db/migrations"))).filter(name => name.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve("db/migrations", name), "utf8"));
  }
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:test','Synthetic task'),('tenant:other','Other')`);
  const db = adaptPglite(raw), canonical = new CanonicalStore(db);
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: "tenant:test", version: 0, createdAt: at(-60_000), updatedAt: at(-60_000) } as const;
  const request: RequestRecord = { ...common, kind: "request", id: "request:test", projectId: binding.projectId,
    title: "Native evidence fixture", objective: "Record synthetic native observations without executing work", state: "draft", priority: 50,
    requestedBy: { actorId: "identity:test", actorType: "human" }, idempotencyKey: "native-task-fixture-request" };
  const workflow: WorkflowRecord = { ...common, kind: "workflow", id: "workflow:test", requestId: request.id, projectId: binding.projectId,
    definitionVersion: "1.0.0", definitionDigest: digest(), authorityMode: "control_room_native", state: "proposed", jobIds: [binding.jobId] };
  const authority: JobRecord["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:fixture",
    allowedOperations: ["operation:fixture"], credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [],
    effectPolicy: "none", maxRisk: "low", maxDurationSeconds: 600, maxConcurrentEffects: 0, expiresAt: at(600_000), digest: digest() };
  authority.digest = computeAuthorityDigest(authority);
  const job: JobRecord = { ...common, kind: "job", id: binding.jobId, workflowId: workflow.id, projectId: binding.projectId,
    jobType: "hermes-native-evidence-fixture", specVersion: "1.0.0", inputDigest, state: "proposed", priority: 50,
    requiredCapability: "capability:fixture", dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 1, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } };
  const node: NodeRecord = { ...common, kind: "node", id: binding.nodeId, displayName: "Synthetic node", state: "pending_enrollment",
    platform: "linux", architecture: "x64", identityKeyId: "key:test", hardwareFingerprint: digest(), softwareFingerprint: digest("b"),
    policyVersion: "1.0.0", minimumProtocolVersion: NODE_PROTOCOL_V1 };
  await canonical.create(request); await canonical.create(workflow); await canonical.create(job); await canonical.create(node);
  const actor = { actorId: "identity:test", actorType: "human" as const };
  await canonical.transition({ tenantId: node.tenantId, kind: "node", entityId: node.id, expectedVersion: 0, toState: "active",
    transitionId: "transition:node", idempotencyKey: "native-fixture-node-active", actor, occurredAt: at(), recordPatch: { enrolledAt: at() } });
  const ready = await canonical.transition({ tenantId: job.tenantId, kind: "job", entityId: job.id, expectedVersion: 0, toState: "ready",
    transitionId: "transition:job", idempotencyKey: "native-fixture-job-ready", actor, occurredAt: at() });
  await canonical.claimReadyJob({ tenantId: job.tenantId, jobId: job.id, expectedJobVersion: ready.entity.version, nodeId: node.id,
    attemptId: binding.attemptId, leaseId: "lease:test", transitionId: "transition:claim", idempotencyKey: "native-fixture-job-claim",
    actor, acquiredAt: at(), expiresAt: at(300_000) });
  const keys = generateKeyPairSync("ed25519"), spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  await db.query(`INSERT INTO control_node_keys(id,tenant_id,node_id,algorithm,public_key_spki,fingerprint,state,valid_from,created_at)
    VALUES('key:test','tenant:test','node:test','ed25519',$1,$2,'active',$3,$3)`, [spki, publicKeyFingerprint(spki), at(-60_000)]);
  const auth = new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(db), new DatabaseReplayGuard(db), new FixedWindowProtocolRateLimiter(100, 60));
  const runs = new HarnessRunStoreV1(db, new Uint8Array(32).fill(17)), service = new NativeTaskSnapshotService(auth, runs);
  const hello = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node", tenantId: binding.tenantId,
    actorId: binding.nodeId, keyId: "key:test", connectionId: "connection:test", sequence: 1, messageId: "message:hello", correlationId: "correlation:test",
    nonce: "fixture_hello_nonce_1234567890123456", sentAt: at(), expiresAt: at(60_000), type: "connection.hello",
    body: { supportedProtocols: [NODE_PROTOCOL_V1], features: ["harness.native.snapshot.v1"], requestedMaxFrameBytes: 16_384,
      lastAcknowledgedServerSequence: 0, unresolvedAttemptIds: [] } }, keys.privateKey);
  await auth.verify(JSON.stringify(hello), { expectedDirection: "node_to_server", receivedAt: at(), transportIdentity: "transport:fixture" });
  let sequence = 1;
  function frame(body = observation(), patch: Partial<SignedNodeFrame<"harness.native.snapshot">> = {}): SignedNodeFrame<"harness.native.snapshot"> {
    sequence++;
    return signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node", tenantId: binding.tenantId,
      actorId: binding.nodeId, keyId: "key:test", connectionId: "connection:test", sequence, messageId: `message:observation:${sequence}`,
      correlationId: "correlation:test", nonce: `fixture_observation_${sequence}_1234567890123456`, sentAt: body.observedAt,
      expiresAt: new Date(Date.parse(body.observedAt) + 60_000).toISOString(), type: "harness.native.snapshot", body, ...patch }, keys.privateKey);
  }
  const options = (receivedAt = at(1000)) => ({ receivedAt, transportIdentity: "transport:fixture", expectedConnectionId: "connection:test" });
  return { raw, db, canonical, runs, service, auth, keys, frame, options, close: () => raw.close() };
}
