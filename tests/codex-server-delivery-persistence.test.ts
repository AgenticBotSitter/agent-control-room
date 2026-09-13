import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { codexTaskDispatchBodySchemaV1, codexTaskPayloadDigestV1, CODEX_START_OPERATION } from "../src/harness/codex-v1/delivery-contract";
import { buildCodexTaskActivationV1 } from "../src/harness/codex-v1/activation-contract";
import { createCodexApprovalIntakeV1 } from "../src/harness/codex-v1/approval-intake";
import { computeArtifactBodyDigest, signArtifact } from "../src/node-policy/v1/crypto";
import { computeEffectClaimKey } from "../src/node-policy/v1/effect-claim";
import { computeNormalizedOperationDigest } from "../src/node-policy/v1/policy-evaluator";
import type { PinnedApprovalTrustStore } from "../src/node-policy/v1/pinned-approval-trust";
import { NODE_PROTOCOL_V1, signNodeFrame, type SignedNodeFrame } from "../src/node-protocol/v1";
import { adaptPglite } from "../src/persistence/database";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { persistCodexDeliveryEnvelope, readCodexDeliveryEnvelopeReceipt } from "../src/web/v1/codex-delivery-envelope";
import { persistCodexDeliveryReceipt, readCodexDeliveryReceipt } from "../src/web/v1/codex-delivery-receipt";
import { persistCodexTransmissionIntent, readCodexTransmissionIntentReceipt } from "../src/web/v1/codex-transmission-intent";
import { codexCurrentAdmissionSchemaV1, persistCodexActivationTransmissionIntent,
  readCodexActivationTransmissionIntentReceipt } from "../src/web/v1/codex-activation-transmission-intent";
import { codexApprovalPacketDigestV1, codexExecutionBindingDigestV1,
  enqueueCodexTaskInSession, readCodexApprovalPacketInSession } from "../src/web/v1/codex-task-queue";
import { readNativeTaskQueueIntentInSession } from "../src/web/v1/native-task-queue";
import { instant } from "./hermes-native-fixture";
import { nativeTaskFixture } from "./native-task-fixture";

const now = instant;

function deliveryBody(approvalPrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], authorityDigest: string) {
  const deadline = now + 60_000;
  const start = { schema: "control-room.codex-task-start/v1" as const,
    tenantId: "tenant:test", nodeId: "node:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test",
    runId: "run:pending", leaseId: "lease:test", leaseEpoch: 1, effectClaimKey: sha256Digest("pending"), operationDigest: sha256Digest("pending"),
    inputDigest: sha256Digest({ prompt: "Inspect exact persistence", instructions: "Record evidence only" }),
    enrollmentDigest: sha256Digest("enrollment"), connectorProfileDigest: sha256Digest("profile"), workspaceIntentDigest: sha256Digest("workspace"),
    prompt: "Inspect exact persistence", instructions: "Record evidence only", deadline };
  const request = { contractVersion: "control-room-node-policy/v1" as const, requestId: "request:codex:persistence",
    tenantId: start.tenantId, nodeId: start.nodeId, nodeClass: "personal-compute", projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, leaseId: start.leaseId, leaseEpoch: start.leaseEpoch, executorId: "executor:codex",
    operationId: CODEX_START_OPERATION, operationDigest: "", payloadDigest: codexTaskPayloadDigestV1(start, authorityDigest),
    authorityDigest, credentialRefs: ["credential:codex"], target: { kind: "filesystem" as const, canonicalPath: "/synthetic/project" },
    risk: "low" as const, externalEffect: true, estimatedDurationSeconds: 60, occurredAt: new Date(now).toISOString() };
  request.operationDigest = computeNormalizedOperationDigest(request); start.operationDigest = request.operationDigest;
  start.effectClaimKey = computeEffectClaimKey(request); start.runId = `run:codex-task:${start.effectClaimKey.slice(7)}`;
  const approval = { schema: "control-room.owner-approval-attestation/v1" as const, tenantId: start.tenantId, nodeId: start.nodeId,
    projectId: start.projectId, jobId: start.jobId, attemptId: start.attemptId, operationDigest: request.operationDigest, risk: "low" as const,
    decision: "approved" as const, issuedAt: new Date(now).toISOString(), expiresAt: new Date(deadline).toISOString(),
    nonce: "codex-persistence-nonce", approvalKeyId: "approval-key:test" };
  const permit = signArtifact({ ...approval, bodyDigest: computeArtifactBodyDigest(approval) }, approvalPrivateKey);
  return codexTaskDispatchBodySchemaV1.parse({ schema: "control-room.codex-task-dispatch/v1",
    queueId: `native-queue:${sha256Digest({ tenantId: start.tenantId, jobId: start.jobId, attemptId: start.attemptId }).slice(7)}`,
    start, request, permit, permitDigest: sha256Digest(permit) });
}

async function persistedFixture(dataDir: string, enqueue = true) {
  const owner = generateKeyPairSync("ed25519"), server = generateKeyPairSync("ed25519");
  const jobAuthority = { projectId: "project:test", allowedExecutor: "executor:codex",
    allowedOperations: [CODEX_START_OPERATION], credentialRefs: ["credential:codex"], filesystemRoots: ["/synthetic/project"],
    networkPolicy: "none" as const, allowedNetworkDestinations: [] as string[], effectPolicy: "approval_required" as const,
    maxRisk: "low" as const, maxDurationSeconds: 300, maxConcurrentEffects: 1,
    expiresAt: new Date(now + 300_000).toISOString(), digest: sha256Digest("pending-authority") };
  jobAuthority.digest = computeAuthorityDigest(jobAuthority);
  const body = deliveryBody(owner.privateKey, jobAuthority.digest), key = new Uint8Array(32).fill(29);
  const fixture = await nativeTaskFixture({ dataDir, inputDigest: body.start.inputDigest, authority: jobAuthority,
    jobType: "codex-native-task", requiredCapability: "harness.codex.app-server.v1" });
  const approvalSpki = owner.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const approvals = { binding: () => ({ tenantId: "tenant:test", nodeId: "node:test", nodeClass: "personal-compute" }),
    assertAvailable() {}, async resolveApprovalKey(id: string) {
      return id === "approval-key:test" ? new Uint8Array(Buffer.from(approvalSpki, "base64url")) : undefined;
    } } as unknown as PinnedApprovalTrustStore;
  const authority = await createCodexApprovalIntakeV1({ body,
    expectedEnrollmentDigest: body.start.enrollmentDigest, expectedConnectorProfileDigest: body.start.connectorProfileDigest,
    expectedWorkspaceIntentDigest: body.start.workspaceIntentDigest }, { approvals,
    security: { currentServerTrustRevision: () => "trust-revision:1" }, clock: () => now })(new AbortController().signal);
  const serverSpki = server.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  if (enqueue) await fixture.db.transaction(async tx => {
    await enqueueCodexTaskInSession(tx, key, body, authority, "server:test", now - 1);
  });
  const channel = (connectionId = "connection:test") => ({ tenantId: "tenant:test", nodeId: "node:test", nodeKeyId: "key:test", connectionId,
    maxFrameBytes: 131_072, expiresAt: new Date(now + 60_000).toISOString(), grantsExecutionAuthority: false as const,
    serverId: "server:test", serverKeyId: "server-key:test", serverPublicKeySpki: serverSpki, assertCurrent() {} });
  const dispatch = (connectionId = "connection:test", messageId = "message:codex-persist") => signNodeFrame({
    protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room", tenantId: "tenant:test", actorId: "server:test",
    keyId: "server-key:test", connectionId, sequence: 4, messageId, correlationId: `correlation:${messageId}`, nonce: `nonce_${sha256Digest(messageId).slice(7, 39)}`,
    sentAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), type: "harness.codex.dispatch", body }, server.privateKey);
  return { ...fixture, key, body, server, channel, dispatch, authority };
}

function nodeReceipt(dispatch: SignedNodeFrame<"harness.codex.dispatch">,
  nodePrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  const start = dispatch.body.start, body = { schema: "control-room.codex-task-dispatch-receipt/v1" as const, queueId: dispatch.body.queueId,
    dispatchMessageId: dispatch.messageId, dispatchBodyDigest: sha256Digest(dispatch.body), tenantId: start.tenantId, projectId: start.projectId,
    nodeId: start.nodeId, jobId: start.jobId, attemptId: start.attemptId, permitDigest: dispatch.body.permitDigest,
    enrollmentDigest: start.enrollmentDigest, recordedAt: new Date(now + 3).toISOString(), disposition: "recorded" as const,
    safeReason: "none" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node", tenantId: start.tenantId,
    actorId: start.nodeId, keyId: "key:test", connectionId: dispatch.connectionId, sequence: 9, messageId: "message:codex-receipt",
    correlationId: "correlation:codex-receipt", causationId: dispatch.messageId, nonce: "nonce_codex_receipt_01234567890123456789",
    sentAt: new Date(now + 3).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), type: "harness.codex.dispatch.receipt", body }, nodePrivateKey);
}

async function currentAdmission(f: Awaited<ReturnType<typeof persistedFixture>>,
  dispatch: SignedNodeFrame<"harness.codex.dispatch">, receipt: SignedNodeFrame<"harness.codex.dispatch.receipt">) {
  const [job, attempt, lease, node] = await Promise.all([
    f.canonical.get("tenant:test", "job", "job:test"), f.canonical.get("tenant:test", "attempt", "attempt:test"),
    f.canonical.get("tenant:test", "lease", "lease:test"), f.canonical.get("tenant:test", "node", "node:test"),
  ]);
  assert.ok(job && job.kind === "job"); assert.ok(attempt && attempt.kind === "attempt");
  assert.ok(lease && lease.kind === "lease"); assert.ok(node && node.kind === "node");
  const project = (await f.raw.query<{ lifecycle: string; version: number }>(
    "SELECT lifecycle,version FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2",
    ["tenant:test", "project:test"])).rows[0]!;
  const key = (await f.raw.query<{ state: string; valid_from: string | Date; valid_until: string | Date | null }>(
    "SELECT state,valid_from,valid_until FROM control_node_keys WHERE tenant_id=$1 AND node_id=$2 AND id=$3",
    ["tenant:test", "node:test", "key:test"])).rows[0]!;
  return codexCurrentAdmissionSchemaV1.parse({ schema: "control-room.codex-current-admission/v1",
    tenantId: "tenant:test", projectId: "project:test", projectVersion: Number(project.version), projectLifecycle: project.lifecycle,
    jobId: job.id, jobVersion: job.version, jobState: job.state, attemptId: attempt.id,
    attemptVersion: attempt.version, attemptState: attempt.state, leaseId: lease.id, leaseVersion: lease.version,
    leaseEpoch: lease.epoch, leaseState: lease.state, leaseExpiresAt: lease.expiresAt,
    nodeId: node.id, nodeVersion: node.version, nodeState: node.state, nodeKeyId: node.identityKeyId,
    nodeKeyState: key.state, nodeKeyValidFrom: new Date(key.valid_from).toISOString(),
    nodeKeyValidUntil: key.valid_until ? new Date(key.valid_until).toISOString() : null,
    authorityDigest: job.authority.digest, authorityExpiresAt: job.authority.expiresAt,
    approvalKeyId: dispatch.body.permit.body.approvalKeyId, approvalExpiresAt: dispatch.body.permit.body.expiresAt,
    ownerTrustRevisionDigest: sha256Digest("trust-revision:1"), queueId: dispatch.body.queueId,
    dispatchMessageId: dispatch.messageId, dispatchFrameDigest: sha256Digest(dispatch),
    receiptMessageId: receipt.messageId, receiptFrameDigest: sha256Digest(receipt), permitDigest: dispatch.body.permitDigest,
    inputDigest: dispatch.body.start.inputDigest, operationDigest: dispatch.body.start.operationDigest,
    effectClaimKey: dispatch.body.start.effectClaimKey, enrollmentDigest: dispatch.body.start.enrollmentDigest,
    connectorProfileDigest: dispatch.body.start.connectorProfileDigest,
    workspaceIntentDigest: dispatch.body.start.workspaceIntentDigest, connectionId: dispatch.connectionId,
    configurationExpiresAt: new Date(dispatch.body.start.deadline).toISOString(), checkedAt: new Date(now + 4).toISOString(),
    admissionExpiresAt: new Date(dispatch.body.start.deadline).toISOString() });
}

test("Codex durable evidence reopens with one exact post-receipt activation intent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "control-room-codex-delivery-"));
  try {
    const f = await persistedFixture(dataDir), dispatch = f.dispatch();
    const scope = { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test", inputDigest: f.body.start.inputDigest };
    const queued = await f.db.transaction(tx => readNativeTaskQueueIntentInSession(tx, f.key, scope));
    assert.equal(queued?.packetDigest, codexApprovalPacketDigestV1(f.body));
    assert.equal(queued?.bindingDigest, codexExecutionBindingDigestV1(f.body));
    assert.notEqual(queued?.packetDigest, f.body.permitDigest);
    await f.db.transaction(tx => persistCodexDeliveryEnvelope(tx, f.key, dispatch, f.channel(), "server:test", now, f.authority));
    await f.db.transaction(tx => persistCodexTransmissionIntent(tx, f.key, dispatch, f.channel(), "server:test", now + 2, f.authority));
    const response = nodeReceipt(dispatch, f.keys.privateKey);
    await f.db.transaction(tx => persistCodexDeliveryReceipt(tx, f.key, response, dispatch, () => now + 4, () => {}));
    await f.raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Codex activation')");
    const adapterId = `adapter:manual:${sha256Digest({ tenantId: "tenant:test", workspaceId: "workspace:test" }).slice(7, 39)}`;
    await f.raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
      VALUES($1,'tenant:test','control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [adapterId]);
    await f.raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES('project:test','tenant:test','workspace:test',$1,'project:test','1','Codex activation','Synthetic evidence',
      'planned','manual_project_active','healthy','control_room_native',$2,'{}'::jsonb,$2)`,
    [adapterId, new Date(now).toISOString()]);
    await f.raw.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      VALUES($1,$2,'active',1,$3,$3)`, ["tenant:test", "project:test", new Date(now).toISOString()]);
    const admission = await currentAdmission(f, dispatch, response);
    const activationBody = buildCodexTaskActivationV1({ dispatch: dispatch as never, receipt: response as never,
      currentAdmissionDigest: sha256Digest(admission), receiptReceivedAt: new Date(now + 4).toISOString(),
      activatedAt: new Date(now + 5).toISOString(), activationExpiresAt: new Date(f.body.start.deadline).toISOString() });
    const activation = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
      tenantId: "tenant:test", actorId: "server:test", keyId: "server-key:test", connectionId: dispatch.connectionId,
      sequence: 10, messageId: "message:codex-activation", correlationId: "correlation:codex-activation",
      causationId: response.messageId, nonce: "nonce_codex_activation_012345678901234567",
      sentAt: activationBody.activatedAt, expiresAt: activationBody.activationExpiresAt,
      type: "harness.codex.dispatch.activation", body: activationBody }, f.server.privateKey);
    await f.db.transaction(tx => persistCodexActivationTransmissionIntent(tx, f.key, activation, dispatch, response,
      admission, { ...f.channel(), activation: true as const }, "server:test", now + 5, f.authority));
    await assert.rejects(f.db.transaction(tx => persistCodexActivationTransmissionIntent(tx, f.key, activation,
      dispatch, response, admission, { ...f.channel(), activation: true as const }, "server:test", now + 6, f.authority)),
    /codex_activation_transmission_intent_unavailable/);
    assert.equal((await f.raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_codex_activation_transmission_intents")).rows[0]?.count, "1");
    await f.close();

    const reopened = new PGlite(dataDir), db = adaptPglite(reopened);
    const [envelope, intent, receipt, activationIntent] = await Promise.all([
      db.transaction(tx => readCodexDeliveryEnvelopeReceipt(tx, f.key, scope)),
      db.transaction(tx => readCodexTransmissionIntentReceipt(tx, f.key, scope)),
      db.transaction(tx => readCodexDeliveryReceipt(tx, f.key, scope)),
      db.transaction(tx => readCodexActivationTransmissionIntentReceipt(tx, f.key, scope)),
    ]);
    assert.equal(envelope?.messageId, dispatch.messageId); assert.equal(intent?.frameDigest, sha256Digest(dispatch));
    assert.equal(receipt?.dispatchMessageId, dispatch.messageId); assert.equal(receipt?.startsWork, false);
    assert.equal(receipt?.grantsExecutionAuthority, false); assert.equal(activationIntent?.activationId, activation.body.activationId);
    assert.equal(activationIntent?.receiptFrameDigest, sha256Digest(response)); await reopened.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("Codex durable evidence refuses append tampering and duplicate receipt records", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "control-room-codex-delivery-"));
  try {
    const f = await persistedFixture(dataDir), dispatch = f.dispatch();
    await f.db.transaction(tx => persistCodexDeliveryEnvelope(tx, f.key, dispatch, f.channel(), "server:test", now, f.authority));
    const scope = { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test", inputDigest: f.body.start.inputDigest };
    await assert.rejects(f.db.transaction(tx => readCodexDeliveryEnvelopeReceipt(tx, new Uint8Array(32).fill(30), scope)),
      /codex_delivery_envelope_unavailable/);
    await assert.rejects(f.raw.query("UPDATE control_codex_delivery_envelopes SET auth_tag=$1", [`hmac-sha256:${"f".repeat(64)}`]), /append-only/);
    await assert.rejects(f.db.transaction(tx => persistCodexDeliveryEnvelope(tx, f.key, dispatch, f.channel(), "server:test", now + 1, f.authority)),
      /codex_delivery_envelope_unavailable/);
    await f.db.transaction(tx => persistCodexTransmissionIntent(tx, f.key, dispatch, f.channel(), "server:test", now + 2, f.authority));
    const response = nodeReceipt(dispatch, f.keys.privateKey);
    await f.db.transaction(tx => persistCodexDeliveryReceipt(tx, f.key, response, dispatch, () => now + 4, () => {}));
    await assert.rejects(f.db.transaction(tx => persistCodexDeliveryReceipt(tx, f.key, response, dispatch, () => now + 5, () => {})),
      /codex_delivery_receipt_unavailable/);
    await f.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a replacement connection cannot create a second Codex transmission intent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "control-room-codex-delivery-"));
  try {
    const f = await persistedFixture(dataDir), original = f.dispatch();
    await f.db.transaction(tx => persistCodexDeliveryEnvelope(tx, f.key, original, f.channel(), "server:test", now, f.authority));
    await f.db.transaction(tx => persistCodexTransmissionIntent(tx, f.key, original, f.channel(), "server:test", now + 2, f.authority));
    const replacement = f.dispatch("connection:replacement", "message:codex-replacement");
    await assert.rejects(f.db.transaction(tx => persistCodexDeliveryEnvelope(tx, f.key, replacement, f.channel("connection:replacement"), "server:test", now + 3, f.authority)),
      /codex_delivery_envelope_unavailable/);
    await assert.rejects(f.db.transaction(tx => persistCodexTransmissionIntent(tx, f.key, replacement, f.channel("connection:replacement"), "server:test", now + 3, f.authority)),
      /codex_transmission_intent_unavailable/);
    const count = await f.raw.query<{ count: string }>("SELECT count(*)::text AS count FROM control_codex_transmission_intents");
    assert.equal(count.rows[0]?.count, "1"); await f.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("Codex persistence requires exact owner authority and completed synchronous fences", async () => {
  const checks: Array<() => unknown> = [() => false, async () => {}, () => ({ then() {} })];
  for (const check of checks) {
    const dataDir = await mkdtemp(join(tmpdir(), "control-room-codex-delivery-"));
    try {
      const f = await persistedFixture(dataDir), dispatch = f.dispatch();
      const channel = { ...f.channel(), assertCurrent: check as () => void };
      await assert.rejects(f.db.transaction(tx => persistCodexDeliveryEnvelope(tx, f.key, dispatch, channel,
        "server:test", now, f.authority)), /codex_delivery_envelope_unavailable/);
      assert.equal((await f.raw.query<{ count: string }>("SELECT count(*)::text AS count FROM control_codex_delivery_envelopes")).rows[0]?.count, "0");
      await f.close();
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  }
  const dataDir = await mkdtemp(join(tmpdir(), "control-room-codex-delivery-"));
  try {
    const f = await persistedFixture(dataDir), dispatch = f.dispatch();
    const wrong = { ...f.authority, permitDigest: sha256Digest("different-owner-permit") };
    await assert.rejects(f.db.transaction(tx => persistCodexDeliveryEnvelope(tx, f.key, dispatch, f.channel(),
      "server:test", now, wrong)), /codex_delivery_envelope_unavailable/);
    for (const check of checks) {
      const unfinished = { ...f.authority, assertFresh: check as () => void };
      await assert.rejects(f.db.transaction(tx => persistCodexDeliveryEnvelope(tx, f.key, dispatch, f.channel(),
        "server:test", now, unfinished)), /codex_delivery_envelope_unavailable/);
    }
    assert.equal((await f.raw.query<{ count: string }>("SELECT count(*)::text AS count FROM control_codex_delivery_envelopes")).rows[0]?.count, "0");
    await f.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("Codex queue refuses altered canonical authority without writing evidence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "control-room-codex-delivery-"));
  try {
    const f = await persistedFixture(dataDir, false);
    const stored = await f.canonical.get("tenant:test", "job", "job:test");
    assert.equal(stored?.kind, "job");
    if (!stored || stored.kind !== "job") throw new Error("missing fixture job");
    const altered = structuredClone(stored);
    altered.authority.maxDurationSeconds += 1;
    await f.raw.query("UPDATE control_jobs SET payload=$1 WHERE tenant_id=$2 AND id=$3", [altered, "tenant:test", "job:test"]);
    await assert.rejects(f.db.transaction(tx => enqueueCodexTaskInSession(tx, f.key, f.body, f.authority,
      "server:test", now - 1)), /codex_task_queue_unavailable/);
    const counts = await f.raw.query<{ approvals: string; queued: string }>(`SELECT
      (SELECT count(*) FROM control_native_approval_packets)::text AS approvals,
      (SELECT count(*) FROM control_native_task_queue)::text AS queued`);
    assert.deepEqual(counts.rows[0], { approvals: "0", queued: "0" });
    await f.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("Codex approval readback refuses the wrong integrity key", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "control-room-codex-delivery-"));
  try {
    const f = await persistedFixture(dataDir);
    const scope = { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test",
      attemptId: "attempt:test", inputDigest: f.body.start.inputDigest };
    assert.equal((await f.db.transaction(tx => readCodexApprovalPacketInSession(tx, f.key, scope)))?.body.queueId,
      f.body.queueId);
    await assert.rejects(f.db.transaction(tx => readCodexApprovalPacketInSession(tx,
      new Uint8Array(32).fill(30), scope)),
      /codex_task_queue_unavailable/);
    await f.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
