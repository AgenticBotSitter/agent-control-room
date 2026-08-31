import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PortableNodeBridge, SqliteBridgeJournal, type BridgeTransport } from "../src/node-bridge";
import { NodeFleetSignalIngress, NodeJobEventIngress } from "../src/node-control";
import { NodeJobEventError, NodeJobEventService } from "../src/node-control/job-event-service";
import { buildArtifactLineageRecord, buildTextArtifactBundle } from "../src/node-executor";
import {
  DatabaseNodeKeyResolver,
  DatabaseReplayGuard,
  FixedWindowProtocolRateLimiter,
  NODE_PROTOCOL_V1,
  NodeProtocolAuthenticator,
  publicKeyFingerprint,
  signNodeFrame,
  type JobEventBody,
  type SignedNodeFrame,
  type TrustedKeyResolver,
  type UnsignedNodeFrame,
} from "../src/node-protocol/v1";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { adaptPglite } from "../src/persistence/database";
import { computeAuthorityDigest } from "../src/security";
import { DOMAIN_CONTRACT_VERSION, type JobRecord, type NodeRecord, type RequestRecord, type WorkflowRecord } from "../src/domain/v1";

const t0 = "2026-08-26T12:00:00.000Z";
const t1 = "2026-08-26T12:01:00.000Z";
const t2 = "2026-08-26T12:02:00.000Z";
const t3 = "2026-08-26T12:03:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;

async function fixture() {
  const db = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort()) {
    await db.exec(await readFile(resolve("db/migrations", file), "utf8"));
  }
  await db.query(`INSERT INTO tenants (id,display_name) VALUES ('tenant:owner','Owner')`);
  await db.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:ingest','tenant:owner','Ingest')`);
  await db.query(
    `INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,redaction_policy_version,cursor_retention_days)
     VALUES ('adapter:ingest','tenant:owner','fixture','1.0.0','control_room_native','1.0.0',1)`,
  );
  await db.query(
    `INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
     VALUES ('project:ingest','tenant:owner','workspace:ingest','adapter:ingest','source:ingest','1','Ingest','ready','ready','healthy','control_room_native',$1,'{}'::jsonb)`, [t0],
  );
  const store = new CanonicalStore(adaptPglite(db));
  const projectId = "project:ingest";
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: "tenant:owner", version: 0, createdAt: t0, updatedAt: t0 } as const;
  const request: RequestRecord = {
    ...common, kind: "request", id: "request:ingest", projectId, title: "Ingest", objective: "Ingest signed node evidence",
    state: "draft", priority: 50, requestedBy: { actorId: "identity:owner", actorType: "human" }, idempotencyKey: "request-ingest-0001",
  };
  const workflow: WorkflowRecord = {
    ...common, kind: "workflow", id: "workflow:ingest", requestId: request.id, projectId,
    definitionVersion: "1.0.0", definitionDigest: hashA, authorityMode: "control_room_native", state: "proposed", jobIds: ["job:ingest"],
  };
  const authority: JobRecord["authority"] = {
    projectId, allowedExecutor: "executor:synthetic", allowedOperations: ["operation:synthetic"],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "none",
    maxRisk: "low", maxDurationSeconds: 3_600, maxConcurrentEffects: 0, expiresAt: "2026-08-26T13:00:00.000Z", digest: hashB,
  };
  authority.digest = computeAuthorityDigest(authority);
  const job: JobRecord = {
    ...common, kind: "job", id: "job:ingest", workflowId: workflow.id, projectId, jobType: "synthetic", specVersion: "1.0.0",
    inputDigest: hashA, state: "proposed", priority: 50, requiredCapability: "capability:synthetic", dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 1, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" },
  };
  const node: NodeRecord = {
    ...common, kind: "node", id: "node:ingest", displayName: "Ingest node", state: "pending_enrollment", platform: "linux", architecture: "x64",
    identityKeyId: "key:ingest", hardwareFingerprint: hashA, softwareFingerprint: hashB, policyVersion: "1.0.0", minimumProtocolVersion: NODE_PROTOCOL_V1,
  };
  await store.create(request);
  await store.create(workflow);
  await store.create(job);
  await store.create(node);
  const actor = { actorId: "identity:owner", actorType: "human" as const };
  const active = await store.transition({ tenantId: node.tenantId, kind: "node", entityId: node.id, expectedVersion: 0, toState: "active", transitionId: "node-active", idempotencyKey: "node-active-0001", actor, occurredAt: t1, recordPatch: { enrolledAt: t1 } });
  const ready = await store.transition({ tenantId: job.tenantId, kind: "job", entityId: job.id, expectedVersion: 0, toState: "ready", transitionId: "job-ready", idempotencyKey: "job-ready-0001", actor, occurredAt: t1 });
  await store.claimReadyJob({ tenantId: job.tenantId, jobId: job.id, expectedJobVersion: ready.entity.version, nodeId: node.id, attemptId: "attempt:ingest", leaseId: "lease:ingest", transitionId: "job-lease", idempotencyKey: "job-lease-0001", actor, acquiredAt: t1, expiresAt: "2026-08-26T12:30:00.000Z" });
  assert.equal(active.entity.state, "active");
  return { db, store, service: new NodeJobEventService(adaptPglite(db)) };
}

function frame(
  body: JobEventBody,
  messageId: string,
  privateKey = generateKeyPairSync("ed25519").privateKey,
  connectionId = "connection:ingest",
  protocolSequence = body.sequence,
): SignedNodeFrame<"job.event"> {
  return signNodeFrame({
    protocol: NODE_PROTOCOL_V1, direction: "node_to_server", messageId, correlationId: "correlation:ingest", tenantId: "tenant:owner",
    actorId: "node:ingest", senderKind: "node", keyId: "key:ingest", connectionId, sequence: protocolSequence,
    sentAt: body.occurredAt, expiresAt: "2026-08-26T12:06:00.000Z", nonce: `nonce_ingest_${body.sequence}_12345678901234567890`, type: "job.event", body,
  } as UnsignedNodeFrame<"job.event">, privateKey);
}

test("authenticated job events bind the exact lease, retain lineage, append audit, and replay safely", async () => {
  const { db, service } = await fixture();
  try {
    const started = frame({ jobId: "job:ingest", attemptId: "attempt:ingest", leaseId: "lease:ingest", leaseEpoch: 1, event: "started", sequence: 1, occurredAt: t2, artifactManifestIds: [] }, "message:ingest:1");
    assert.deepEqual(await service.ingestAuthenticated(started, t2), { event: "started", attemptId: "attempt:ingest", sequence: 1, replayed: false });

    const bundle = buildTextArtifactBundle({
      artifactId: "artifact:ingest", claimId: "claim:ingest", tenantId: "tenant:owner", projectId: "project:ingest", workflowId: "workflow:ingest",
      jobId: "job:ingest", attemptId: "attempt:ingest", producerId: "node:ingest", logicalRole: "synthetic-result", schemaVersion: "1.0.0",
      storageClass: "local", retentionClass: "test", opaqueLocator: "memory://artifact/artifact%3Aingest", text: "result\n", createdAt: t3,
    });
    const lineage = buildArtifactLineageRecord(bundle);
    const completed = frame({
      jobId: "job:ingest", attemptId: "attempt:ingest", leaseId: "lease:ingest", leaseEpoch: 1, event: "completed", sequence: 2,
      occurredAt: t3, artifactManifestIds: [lineage.artifactId], artifactLineage: lineage,
    }, "message:ingest:2");
    assert.deepEqual(await service.ingestAuthenticated(completed, t3), { event: "completed", attemptId: "attempt:ingest", sequence: 2, replayed: false });
    assert.equal((await service.ingestAuthenticated(completed, t3)).replayed, true);

    const events = await db.query<{ event_kind: string; artifact_id: string | null }>(`SELECT event_kind,artifact_id FROM control_node_job_events ORDER BY event_sequence`);
    assert.deepEqual(events.rows, [{ event_kind: "started", artifact_id: null }, { event_kind: "completed", artifact_id: "artifact:ingest" }]);
    const evidence = await db.query<{ lineage_digest: string; independent_verification_state: string }>(`SELECT lineage_digest,independent_verification_state FROM control_artifact_lineage`);
    assert.deepEqual(evidence.rows[0], { lineage_digest: lineage.lineageDigest, independent_verification_state: "not_run" });
    const audit = await db.query<{ action: string }>(`SELECT action FROM audit_events WHERE target_id='attempt:ingest' ORDER BY occurred_at`);
    assert.deepEqual(audit.rows.map((row) => row.action), ["node.job_event.started", "node.job_event.completed"]);
    const projected = await db.query<{ attempt_state: string; job_state: string; started_at: string; finished_at: string }>(
      `SELECT a.state AS attempt_state,j.state AS job_state,a.payload->>'startedAt' AS started_at,a.payload->>'finishedAt' AS finished_at
       FROM control_attempts a JOIN control_jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id WHERE a.id='attempt:ingest'`,
    );
    assert.deepEqual(projected.rows[0], { attempt_state: "succeeded", job_state: "succeeded", started_at: t2, finished_at: t3 });

    const wrongLease = frame({ ...started.body, leaseId: "lease:other" }, "message:ingest:wrong");
    await assert.rejects(service.ingestAuthenticated(wrongLease, t3), (error: unknown) => error instanceof NodeJobEventError && error.safeCode === "identity_mismatch");
  } finally {
    await db.close();
  }
});

test("ingress authenticates raw frames before retaining job evidence and only then acknowledges them", async () => {
  const { db } = await fixture();
  try {
    const keys = generateKeyPairSync("ed25519");
    const spki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    await db.query(
      `INSERT INTO control_node_keys (id,tenant_id,node_id,algorithm,public_key_spki,fingerprint,state,valid_from,created_at)
       VALUES ('key:ingest','tenant:owner','node:ingest','ed25519',$1,$2,'active',$3,$3)`,
      [spki, publicKeyFingerprint(spki), t0],
    );
    const authenticator = new NodeProtocolAuthenticator(
      new DatabaseNodeKeyResolver(adaptPglite(db)),
      new DatabaseReplayGuard(adaptPglite(db)),
      new FixedWindowProtocolRateLimiter(20, 60),
    );
    const ingress = new NodeJobEventIngress(authenticator, adaptPglite(db));
    const connectionId = "connection:central-ingest";
    const hello = signNodeFrame({
      protocol: NODE_PROTOCOL_V1, direction: "node_to_server", messageId: "message:ingress:hello", correlationId: "correlation:ingest",
      tenantId: "tenant:owner", actorId: "node:ingest", senderKind: "node", keyId: "key:ingest", connectionId, sequence: 1,
      sentAt: t2, expiresAt: "2026-08-26T12:06:00.000Z", nonce: "nonce_ingress_hello_12345678901234567890", type: "connection.hello",
      body: { supportedProtocols: [NODE_PROTOCOL_V1], features: [], requestedMaxFrameBytes: 4096, lastAcknowledgedServerSequence: 0, unresolvedAttemptIds: [] },
    }, keys.privateKey);
    await authenticator.verify(JSON.stringify(hello), { expectedDirection: "node_to_server", transportIdentity: "transport:fixture", receivedAt: t2 });

    const started = frame(
      { jobId: "job:ingest", attemptId: "attempt:ingest", leaseId: "lease:ingest", leaseEpoch: 1, event: "started", sequence: 1, occurredAt: t2, artifactManifestIds: [] },
      "message:ingress:started", keys.privateKey, connectionId, 2,
    );
    const accepted = await ingress.receive(JSON.stringify(started), { transportIdentity: "transport:fixture", receivedAt: t2, expectedConnectionId: connectionId });
    assert.equal(accepted.event.replayed, false);
    assert.deepEqual(accepted.acknowledgement, { acknowledgedMessageIds: [started.messageId], highestContiguousSequence: 2, disposition: "accepted" });

    const duplicate = await ingress.receive(JSON.stringify(started), { transportIdentity: "transport:fixture", receivedAt: t2, expectedConnectionId: connectionId });
    assert.equal(duplicate.event.replayed, true);
    assert.equal(duplicate.acknowledgement.disposition, "duplicate");
    const events = await db.query<{ message_id: string }>(`SELECT message_id FROM control_node_job_events`);
    assert.deepEqual(events.rows, [{ message_id: "message:ingress:started" }]);
  } finally {
    await db.close();
  }
});

test("fleet ingress authenticates the raw frame, binds node identity, persists, and acknowledges after storage", async () => {
  const { db } = await fixture();
  try {
    const keys = generateKeyPairSync("ed25519");
    const spki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    await db.query(`INSERT INTO control_node_keys (id,tenant_id,node_id,algorithm,public_key_spki,fingerprint,state,valid_from,created_at) VALUES ('key:fleet','tenant:owner','node:ingest','ed25519',$1,$2,'active',$3,$3)`, [spki, publicKeyFingerprint(spki), t0]);
    const authenticator = new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(adaptPglite(db)), new DatabaseReplayGuard(adaptPglite(db)), new FixedWindowProtocolRateLimiter(20, 60));
    const ingress = new NodeFleetSignalIngress(authenticator, adaptPglite(db));
    const hello = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", messageId: "message:fleet:hello", correlationId: "correlation:fleet", tenantId: "tenant:owner", actorId: "node:ingest", senderKind: "node", keyId: "key:fleet", connectionId: "connection:fleet", sequence: 1, sentAt: t2, expiresAt: "2026-08-26T12:06:00.000Z", nonce: "nonce_fleet_hello_1234567890123456", type: "connection.hello", body: { supportedProtocols: [NODE_PROTOCOL_V1], features: ["fleet-signals"], requestedMaxFrameBytes: 4096, lastAcknowledgedServerSequence: 0, unresolvedAttemptIds: [] } } as UnsignedNodeFrame<"connection.hello">, keys.privateKey);
    await authenticator.verify(JSON.stringify(hello), { expectedDirection: "node_to_server", transportIdentity: "transport:fleet", receivedAt: t2 });
    const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", messageId: "message:fleet:1", correlationId: "correlation:fleet", tenantId: "tenant:owner", actorId: "node:ingest", senderKind: "node", keyId: "key:fleet", connectionId: "connection:fleet", sequence: 2, sentAt: t2, expiresAt: "2026-08-26T12:06:00.000Z", nonce: "nonce_fleet_123456789012345678901", type: "node.fleet.signal", body: { schemaVersion: "1.0.0", tenantId: "tenant:owner", nodeId: "node:ingest", kind: "telemetry", source: "telemetry_port", sequence: 1, observedAt: t2, expiresAt: "2026-08-26T12:05:00.000Z", trust: "reported", fingerprint: hashA, payload: { samplingIntervalSeconds: 60, cpuUtilizationPercent: { quality: "observed", value: 5 }, availableMemoryBytes: { quality: "observed", value: 1000 }, availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } } } as UnsignedNodeFrame<"node.fleet.signal">, keys.privateKey);
    const accepted = await ingress.receive(JSON.stringify(frame), { transportIdentity: "transport:fleet", receivedAt: t2, expectedConnectionId: "connection:fleet" });
    assert.equal(accepted.acknowledgement.disposition, "accepted");
    assert.equal((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_node_fleet_signals`)).rows[0]?.count, "1");
  } finally { await db.close(); }
});

test("inactive leases, malformed bodies, future claims, and backwards event time fail without partial truth", async () => {
  const first = await fixture();
  try {
    await first.store.expireLease({
      tenantId: "tenant:owner", leaseId: "lease:ingest", jobId: "job:ingest", attemptId: "attempt:ingest",
      expectedLeaseVersion: 0, expectedJobVersion: 2, expectedAttemptVersion: 1, epoch: 1,
      transitionId: "lease-expired:review", idempotencyKey: "lease-expired-review-0001",
      actor: { actorId: "identity:owner", actorType: "human" }, occurredAt: "2026-08-26T12:31:00.000Z",
    });
    const late = frame({ jobId: "job:ingest", attemptId: "attempt:ingest", leaseId: "lease:ingest", leaseEpoch: 1, event: "started", sequence: 1, occurredAt: t2, artifactManifestIds: [] }, "message:late");
    await assert.rejects(first.service.ingestAuthenticated(late, t3), (error: unknown) => error instanceof NodeJobEventError && error.safeCode === "identity_mismatch");
    assert.equal((await first.db.query(`SELECT 1 FROM control_node_job_events`)).rows.length, 0);
  } finally {
    await first.db.close();
  }

  const second = await fixture();
  try {
    const started = frame({ jobId: "job:ingest", attemptId: "attempt:ingest", leaseId: "lease:ingest", leaseEpoch: 1, event: "started", sequence: 1, occurredAt: t2, artifactManifestIds: [] }, "message:ordered:1");
    await second.service.ingestAuthenticated(started, t2);
    assert.throws(() => frame({ ...started.body, event: "progress", sequence: 2 }, "message:malformed"));
    const backwards = frame({ ...started.body, event: "progress", sequence: 2, occurredAt: t1, progressPercent: 50 }, "message:ordered:2");
    await assert.rejects(second.service.ingestAuthenticated(backwards, t3), (error: unknown) => error instanceof NodeJobEventError && error.safeCode === "sequence_conflict");
    const future = signNodeFrame({
      protocol: NODE_PROTOCOL_V1, direction: "node_to_server", messageId: "message:future", correlationId: "correlation:ingest",
      tenantId: "tenant:owner", actorId: "node:ingest", senderKind: "node", keyId: "key:ingest", connectionId: "connection:future", sequence: 2,
      sentAt: t2, expiresAt: "2026-08-26T12:06:00.000Z", nonce: "nonce_future_123456789012345678901234", type: "job.event",
      body: { ...started.body, event: "progress", sequence: 2, occurredAt: t3, progressPercent: 50 },
    }, generateKeyPairSync("ed25519").privateKey);
    await assert.rejects(second.service.ingestAuthenticated(future, t3), (error: unknown) => error instanceof NodeJobEventError && error.safeCode === "invalid_event");
    const retained = await second.db.query<{ event_kind: string }>(`SELECT event_kind FROM control_node_job_events ORDER BY event_sequence`);
    assert.deepEqual(retained.rows, [{ event_kind: "started" }]);
    assert.equal((await second.db.query<{ state: string }>(`SELECT state FROM control_jobs WHERE id='job:ingest'`)).rows[0].state, "running");
  } finally {
    await second.db.close();
  }
});

test("a completed durable bridge event reaches central truth before its signed acknowledgement retires it", async () => {
  const { db } = await fixture();
  const journal = new SqliteBridgeJournal(":memory:");
  try {
    const nodeKeys = generateKeyPairSync("ed25519");
    const nodeSpki = nodeKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    await db.query(
      `INSERT INTO control_node_keys (id,tenant_id,node_id,algorithm,public_key_spki,fingerprint,state,valid_from,created_at)
       VALUES ('key:ingest','tenant:owner','node:ingest','ed25519',$1,$2,'active',$3,$3)`,
      [nodeSpki, publicKeyFingerprint(nodeSpki), t0],
    );
    const centralAuthenticator = new NodeProtocolAuthenticator(
      new DatabaseNodeKeyResolver(adaptPglite(db)), new DatabaseReplayGuard(adaptPglite(db)), new FixedWindowProtocolRateLimiter(50, 60),
    );
    const ingress = new NodeJobEventIngress(centralAuthenticator, adaptPglite(db));
    const serverKeys = generateKeyPairSync("ed25519");
    const serverSpki = serverKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    const serverResolver: TrustedKeyResolver = { async resolve(input) {
      if (input.tenantId !== "tenant:owner" || input.actorId !== "control-room:server" || input.senderKind !== "control_room" || input.keyId !== "server-key:1") return undefined;
      return { tenantId: input.tenantId, actorId: input.actorId, senderKind: input.senderKind, keyId: input.keyId,
        algorithm: "ed25519", publicKeySpki: serverSpki, state: "active", principalState: "active", validFrom: t0 };
    } };
    const sent: SignedNodeFrame[] = [];
    const transport: BridgeTransport = { async send(raw) { sent.push(JSON.parse(raw) as SignedNodeFrame); }, async close() {} };
    const bridge = new PortableNodeBridge(
      { tenantId: "tenant:owner", nodeId: "node:ingest", keyId: "key:ingest", features: [] }, journal,
      { async sign(unsigned) { return signNodeFrame(unsigned, nodeKeys.privateKey); } },
      new NodeProtocolAuthenticator(serverResolver, journal, new FixedWindowProtocolRateLimiter(50, 60)),
      (() => { let value = 0; return () => `bridge-${++value}`; })(),
    );
    const bundle = buildTextArtifactBundle({
      artifactId: "artifact:e2e", claimId: "claim:e2e", tenantId: "tenant:owner", projectId: "project:ingest", workflowId: "workflow:ingest",
      jobId: "job:ingest", attemptId: "attempt:ingest", producerId: "node:ingest", logicalRole: "synthetic-result", schemaVersion: "1.0.0",
      storageClass: "local", retentionClass: "test", opaqueLocator: "memory://artifact/artifact%3Ae2e", text: "end-to-end\n", createdAt: t3,
    });
    const lineage = buildArtifactLineageRecord(bundle);
    journal.appendJobEvent({ jobId: "job:ingest", attemptId: "attempt:ingest", leaseId: "lease:ingest", leaseEpoch: 1, event: "started", sequence: 1, occurredAt: t2, artifactManifestIds: [] }, t2);
    journal.appendJobEvent({ jobId: "job:ingest", attemptId: "attempt:ingest", leaseId: "lease:ingest", leaseEpoch: 1, event: "completed", sequence: 2, occurredAt: t3, artifactManifestIds: [lineage.artifactId], artifactLineage: lineage }, t3, lineage);

    await bridge.open(transport, { now: t3, transportIdentity: "tls:central" });
    const connectionId = bridge.status().connectionId as string;
    await centralAuthenticator.verify(JSON.stringify(sent[0]), { expectedDirection: "node_to_server", transportIdentity: "tls:node", receivedAt: t3 });
    const serverFrame = (sequence: number, type: "connection.accepted" | "node.reconciliation.request" | "protocol.ack", body: SignedNodeFrame["body"]): SignedNodeFrame => signNodeFrame({
      protocol: NODE_PROTOCOL_V1, direction: "server_to_node", messageId: `message:server:${sequence}`, correlationId: "correlation:e2e",
      tenantId: "tenant:owner", actorId: "control-room:server", senderKind: "control_room", keyId: "server-key:1", connectionId, sequence,
      sentAt: t3, expiresAt: "2026-08-26T12:06:00.000Z", nonce: `nonce_server_${sequence}_12345678901234567890`, type, body,
    } as UnsignedNodeFrame, serverKeys.privateKey);
    await bridge.receive(JSON.stringify(serverFrame(1, "connection.accepted", {
      selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: [], maxFrameBytes: 65_536, heartbeatIntervalSeconds: 30, serverTime: t2,
    })), t3);
    await centralAuthenticator.verify(JSON.stringify(sent[1]), { expectedDirection: "node_to_server", transportIdentity: "tls:node", receivedAt: t3 });
    await bridge.receive(JSON.stringify(serverFrame(2, "node.reconciliation.request", { lastAcknowledgedNodeSequence: 1, requestedAttemptIds: ["attempt:ingest"] })), t3);
    const report = sent.find((candidate) => candidate.type === "node.reconciliation.report");
    assert.ok(report);
    await centralAuthenticator.verify(JSON.stringify(report), { expectedDirection: "node_to_server", transportIdentity: "tls:node", receivedAt: t3 });
    const jobFrames = sent.filter((candidate): candidate is SignedNodeFrame<"job.event"> => candidate.type === "job.event");
    assert.equal(jobFrames.length, 2);
    const started = await ingress.receive(JSON.stringify(jobFrames[0]), { transportIdentity: "tls:node", receivedAt: t3, expectedConnectionId: connectionId });
    await bridge.receive(JSON.stringify(serverFrame(3, "protocol.ack", started.acknowledgement)), t3);
    const completed = await ingress.receive(JSON.stringify(jobFrames[1]), { transportIdentity: "tls:node", receivedAt: t3, expectedConnectionId: connectionId });
    assert.equal(journal.jobEventStatus("attempt:ingest", 2), "staged", "the completed record stays durable until its acknowledgement arrives");
    await bridge.receive(JSON.stringify(serverFrame(4, "protocol.ack", completed.acknowledgement)), t3);
    assert.equal(journal.jobEventStatus("attempt:ingest", 2), "acknowledged");
    const state = await db.query<{ state: string }>(`SELECT state FROM control_jobs WHERE id='job:ingest'`);
    assert.equal(state.rows[0].state, "succeeded");
  } finally {
    journal.close();
    await db.close();
  }
});
