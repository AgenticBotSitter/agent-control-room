import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { CODEX_APP_SERVER_ADAPTER, CODEX_APP_SERVER_CAPABILITY, CODEX_APP_SERVER_JOB_TYPE,
  CODEX_DELIVERY_FEATURE, CODEX_START_OPERATION } from "../src/harness/codex-v1/delivery-contract";
import { createCodexOwnerPermitIssuer } from "../src/harness/codex-v1/owner-permit";
import type { PinnedApprovalTrustStore } from "../src/node-policy/v1/pinned-approval-trust";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { CanonicalStore } from "../src/persistence/canonical-store";
import type { NativeTaskSubmissionReference } from "../src/persistence/native-task-submission";
import { jobRecordSchema } from "../src/domain/v1";
import { readNativeTaskQueueIntentInSession } from "../src/web/v1/native-task-queue";
import { readCodexDeliveryEnvelopeReceipt } from "../src/web/v1/codex-delivery-envelope";
import { readCodexTransmissionIntentReceipt } from "../src/web/v1/codex-transmission-intent";
import { readCodexDeliveryReceipt } from "../src/web/v1/codex-delivery-receipt";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { TaskAssignmentCoordinator, type TaskAssignmentRoute } from "../src/web/v1/task-assignment-coordinator";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { ServerNodeSession } from "../src/node-control/server-node-session";
import { ManagedNativeSessions, type ManagedNativeSessionSettings } from "../src/web/v1/managed-native-sessions";
import { FixedWindowProtocolRateLimiter, NODE_PROTOCOL_V1, NodeProtocolAuthenticator, signNodeFrame,
  type SignedNodeFrame } from "../src/node-protocol/v1";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";

async function setup() {
  const f = await ownerReviewFixture();
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:codex",
    allowedOperations: [CODEX_START_OPERATION], credentialRefs: ["credential:codex"], filesystemRoots: ["/synthetic/project"],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:codex", adapter: CODEX_APP_SERVER_ADAPTER, authority,
    instructions: "Use the assigned workspace only and return bounded text evidence.",
    connectorProfileDigest: sha256Digest("codex-profile"), workspaceIntentDigest: sha256Digest("codex-workspace"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(81),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "codex-planning-source-001");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const route: TaskAssignmentRoute = { nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: CODEX_APP_SERVER_CAPABILITY, maxConcurrentTasks: 8, requiredScratchBytes: 100, leaseSeconds: 60 };
  const signals = new FleetSignalStore(f.db);
  const common = { schemaVersion: "1.0.0" as const, tenantId: binding.tenantId, nodeId: binding.nodeId, sequence: 1,
    observedAt: at(6000), expiresAt: at(120_000), trust: "reported" as const };
  const telemetry: FleetSignalEnvelope = { ...common, fingerprint: sha256Digest("codex-telemetry"), kind: "telemetry",
    source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 20 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { ...common, expiresAt: at(300_000), fingerprint: sha256Digest("codex-capability"),
    kind: "capability", source: "probe_runner", payload: { probeId: CODEX_APP_SERVER_CAPABILITY,
      probeVersion: "1.0.0", outcome: "pass", reasonCode: "reported_only" } };
  await signals.ingestAuthenticated(telemetry, at(6000), binding);
  await signals.ingestAuthenticated(capability, at(6000), binding);
  const approvalKeys = generateKeyPairSync("ed25519"), approvalKeyId = "approval-key:codex-test";
  const publicKeySpki = approvalKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const approvals = { binding: () => ({ tenantId: binding.tenantId, nodeId: binding.nodeId, nodeClass: "personal-compute" }),
    assertAvailable() {}, async resolveApprovalKey(keyId: string) {
      return keyId === approvalKeyId ? new Uint8Array(Buffer.from(publicKeySpki, "base64url")) : undefined;
    } } as unknown as PinnedApprovalTrustStore;
  const codexIntegrityKey = new Uint8Array(32).fill(83);
  const codexConfig = { integrityKey: codexIntegrityKey, enrollments: [{ tenantId: binding.tenantId, nodeId: binding.nodeId, nodeClass: "personal-compute",
      enrollmentDigest: sha256Digest("codex-enrollment"), connectorProfileDigest: template.connectorProfileDigest!,
      workspaceIntentDigest: template.workspaceIntentDigest!, credentialRef: authority.credentialRefs[0],
      filesystemRoot: authority.filesystemRoots[0], validUntil: instant + 180_000, approvalKeyId, approvals,
      security: { currentServerTrustRevision: () => "trust-revision:codex-test" } }] };
  const submissions: NativeTaskSubmissionReference[] = [];
  const submission = { async enqueueInSession(_tx: unknown, reference: NativeTaskSubmissionReference) {
    submissions.push(structuredClone(reference));
  } };
  const assignment = new TaskAssignmentCoordinator(f.db, f.scope, planner, [route], () => instant + 8000,
    [], undefined, submission, codexConfig);
  return { ...f, authority, template, planner, planned, route, assignment, approvalKeys, publicKeySpki,
    codexIntegrityKey, codexConfig, submissions };
}

async function connectedCodexSession(f: Awaited<ReturnType<typeof setup>>, nodeKeyId = "key:test") {
  const server = generateKeyPairSync("ed25519");
  const serverSpki = server.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const nodeSpki = f.keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const toNode: string[] = [];
  const authentication = new NodeProtocolAuthenticator({ async resolve(value) {
    return { ...value, algorithm: "ed25519" as const, publicKeySpki: nodeSpki, state: "active" as const,
      principalState: "active" as const, validFrom: at(-60_000) };
  } }, { async consume() { return "accepted" as const; } }, new FixedWindowProtocolRateLimiter(100, 60));
  const session = new ServerNodeSession({ tenantId: binding.tenantId, nodeId: binding.nodeId, nodeKeyId,
    serverId: "server:codex-test", serverKeyId: "server-key:codex-test", serverPublicKeySpki: serverSpki,
    transportIdentity: "transport:codex-test", features: [CODEX_DELIVERY_FEATURE], maxFrameBytes: 131_072,
    heartbeatIntervalSeconds: 30 }, { authentication, clock: () => instant + 8000,
    async sign(frame) { return signNodeFrame(frame, server.privateKey); }, async send(raw) { toNode.push(raw); } });
  const connectionId = "connection:codex-canonical";
  const hello = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
    tenantId: binding.tenantId, actorId: binding.nodeId, keyId: nodeKeyId, connectionId, sequence: 1,
    messageId: "message:codex-canonical-hello", correlationId: "correlation:codex-canonical",
    nonce: "codex_canonical_hello_nonce_123456789", sentAt: at(8000), expiresAt: at(120_000),
    type: "connection.hello", body: { supportedProtocols: [NODE_PROTOCOL_V1], features: [CODEX_DELIVERY_FEATURE],
      requestedMaxFrameBytes: 131_072, lastAcknowledgedServerSequence: 0, unresolvedAttemptIds: [] } }, f.keys.privateKey);
  await session.acceptHello(JSON.stringify(hello));
  const sent = toNode.map(raw => JSON.parse(raw) as SignedNodeFrame);
  const lastSequence = Math.max(...sent.map(frame => frame.sequence));
  const report = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
    tenantId: binding.tenantId, actorId: binding.nodeId, keyId: nodeKeyId, connectionId, sequence: 2,
    messageId: "message:codex-canonical-reconcile", correlationId: "correlation:codex-canonical",
    nonce: "codex_canonical_reconcile_nonce_123456", sentAt: at(8000), expiresAt: at(120_000),
    type: "node.reconciliation.report", body: { lastAcknowledgedServerSequence: lastSequence, attempts: [] } }, f.keys.privateKey);
  await session.receive(JSON.stringify(report));
  toNode.length = 0;
  return { session, toNode, connectionId, serverSpki };
}

async function assignAndQueue(f: Awaited<ReturnType<typeof setup>>) {
  const saved = await f.planner.read(f.planned.receipt.jobId);
  if (!saved || saved.schema !== "control-room.task-execution-plan/v3") throw new Error("missing Codex plan");
  const assigned = await f.assignment.assign(f.identity, binding.projectId, saved.job.id, binding.nodeId, saved.job.inputDigest);
  const approval = await f.assignment.prepareCodexOwnerPermit(f.identity, binding.projectId, saved.job.id, saved.job.inputDigest);
  const issuer = createCodexOwnerPermitIssuer(approval.input, { publicKeySpki: f.publicKeySpki, timeoutMs: 1000,
    clock: () => instant + 8000, assertOwnerConsentCurrent: () => approval.assertCurrent(),
    sign: async bytes => sign(null, bytes, f.approvalKeys.privateKey) });
  const permit = await issuer.issue(new AbortController().signal);
  await f.assignment.enqueueCodexTask(f.identity, binding.projectId, saved.job.id, saved.job.inputDigest,
    permit, new AbortController().signal);
  return { saved, assigned, permit, reference: f.submissions[0]! };
}

test("owner planning and assignment produce one canonical Codex reservation without starting work", async () => {
  const f = await setup();
  try {
    const saved = await f.planner.read(f.planned.receipt.jobId);
    assert.equal(saved?.schema, "control-room.task-execution-plan/v3");
    assert.equal(saved?.job.jobType, CODEX_APP_SERVER_JOB_TYPE);
    assert.equal(saved?.job.requiredCapability, CODEX_APP_SERVER_CAPABILITY);
    assert.equal(saved?.job.authority.digest, f.authority.digest);
    if (saved?.schema !== "control-room.task-execution-plan/v3") assert.fail("missing Codex plan");
    assert.equal(saved.connectorProfileDigest, f.template.connectorProfileDigest);
    assert.equal(saved.workspaceIntentDigest, f.template.workspaceIntentDigest);
    const options = await f.assignment.options(f.identity, binding.projectId, saved!.job.id);
    assert.deepEqual(options.candidates.map(candidate => candidate.nodeId), [binding.nodeId]);
    const assigned = await f.assignment.assign(f.identity, binding.projectId, saved!.job.id, binding.nodeId, saved!.job.inputDigest);
    assert.equal(assigned.receipt.leaseState, "active");
    assert.equal(assigned.receipt.startsWork, false);
    assert.equal(assigned.receipt.grantsExecutionAuthority, false);
    const current = jobRecordSchema.parse(await new CanonicalStore(f.db).get(binding.tenantId, "job", saved!.job.id));
    assert.equal(current.state, "leased");
    const replay = await f.assignment.assign(f.identity, binding.projectId, saved.job.id, binding.nodeId, saved.job.inputDigest);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, assigned.receipt);
    const approval = await f.assignment.prepareCodexOwnerPermit(f.identity, binding.projectId, saved.job.id, saved.job.inputDigest);
    const issuer = createCodexOwnerPermitIssuer(approval.input, { publicKeySpki: f.publicKeySpki, timeoutMs: 1000,
      clock: () => instant + 8000, assertOwnerConsentCurrent: () => approval.assertCurrent(),
      sign: async bytes => sign(null, bytes, f.approvalKeys.privateKey) });
    assert.match(issuer.reviewDigest, /^sha256:[a-f0-9]{64}$/);
    const permit = await issuer.issue(new AbortController().signal);
    const queued = await f.assignment.enqueueCodexTask(f.identity, binding.projectId, saved.job.id, saved.job.inputDigest,
      permit, new AbortController().signal);
    assert.equal(queued.startsWork, false); assert.equal(queued.grantsExecutionAuthority, false);
    assert.equal(f.submissions.length, 1);
    assert.deepEqual(f.submissions[0], { schema: "control-room.native-task-submission/v1",
      tenantId: binding.tenantId, projectId: binding.projectId, jobId: saved.job.id,
      attemptId: assigned.receipt.attemptId, queueId: queued.queueId,
      inputDigest: saved.job.inputDigest, packetDigest: queued.packetDigest });
    const intent = await f.db.transaction(tx => readNativeTaskQueueIntentInSession(tx, f.codexIntegrityKey,
      { tenantId: binding.tenantId, projectId: binding.projectId, jobId: saved.job.id,
        attemptId: assigned.receipt.attemptId, inputDigest: saved.job.inputDigest }));
    assert.equal(intent?.jobId, saved.job.id);
    const reference = f.submissions[0]!;
    const routed = await f.assignment.locateApprovedCodexQueueDelivery(reference, new AbortController().signal);
    assert.deepEqual({ kind: routed.kind, nodeId: routed.nodeId, startsWork: routed.startsWork },
      { kind: "codex", nodeId: binding.nodeId, startsWork: false });
    const link = await connectedCodexSession(f);
    const staged = await f.assignment.stageApprovedCodexQueueDelivery(reference, link.session, new AbortController().signal);
    assert.equal(staged.startsWork, false);
    const sent = await f.assignment.transmitApprovedCodexQueueDelivery(reference, link.session, new AbortController().signal);
    assert.equal(sent.deliveryConfirmed, false); assert.equal(link.toNode.length, 1);
    const dispatch = JSON.parse(link.toNode.shift()!) as SignedNodeFrame<"harness.codex.dispatch">;
    const receiptBody = { schema: "control-room.codex-task-dispatch-receipt/v1" as const,
      queueId: dispatch.body.queueId, dispatchMessageId: dispatch.messageId, dispatchBodyDigest: dispatch.bodyDigest,
      tenantId: dispatch.body.start.tenantId, projectId: dispatch.body.start.projectId, nodeId: dispatch.body.start.nodeId,
      jobId: dispatch.body.start.jobId, attemptId: dispatch.body.start.attemptId, permitDigest: dispatch.body.permitDigest,
      enrollmentDigest: dispatch.body.start.enrollmentDigest, recordedAt: at(8000), disposition: "recorded" as const,
      safeReason: "none" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
    const nodeReceipt = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
      tenantId: binding.tenantId, actorId: binding.nodeId, keyId: "key:test", connectionId: link.connectionId,
      sequence: 3, messageId: "message:codex-canonical-receipt", correlationId: "correlation:codex-canonical",
      causationId: dispatch.messageId, nonce: "codex_canonical_receipt_nonce_123456789", sentAt: at(8000),
      expiresAt: at(120_000), type: "harness.codex.dispatch.receipt", body: receiptBody }, f.keys.privateKey);
    const received = await f.assignment.receiveCodexDeliveryReceipt(link.session, JSON.stringify(nodeReceipt),
      new AbortController().signal);
    assert.equal(received.executionConfirmed, false); assert.equal(received.startsWork, false);
    const scope = { tenantId: binding.tenantId, projectId: binding.projectId, jobId: saved.job.id,
      attemptId: assigned.receipt.attemptId, inputDigest: saved.job.inputDigest };
    const evidence = await f.db.transaction(async tx => Promise.all([
      readCodexDeliveryEnvelopeReceipt(tx, f.codexIntegrityKey, scope),
      readCodexTransmissionIntentReceipt(tx, f.codexIntegrityKey, scope),
      readCodexDeliveryReceipt(tx, f.codexIntegrityKey, scope),
    ]));
    assert.ok(evidence.every(Boolean));
    assert.equal((await f.db.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND job_id=$2",
      [binding.tenantId, saved.job.id])).rows.length, 0);
    assert.equal(jobRecordSchema.parse(await new CanonicalStore(f.db).get(binding.tenantId, "job", saved.job.id)).state, "leased");
    await assert.rejects(f.assignment.enqueueCodexTask(f.identity, binding.projectId, saved.job.id, saved.job.inputDigest,
      permit, new AbortController().signal));
  } finally { await f.close(); }
});

test("shared managed queue routes Codex once and completes only after its authenticated receipt", async () => {
  const f = await setup();
  let nativeStageCalls = 0, nativeReceiptCalls = 0, nativeRegistrations = 0;
  const server = generateKeyPairSync("ed25519");
  const serverSpki = server.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const toNode: string[] = [], transport = { available: true, async send(raw: string) { toNode.push(raw); },
    async close() { transport.available = false; }, isAvailable: () => transport.available };
  const settings: ManagedNativeSessionSettings = { nodes: [{ tenantId: binding.tenantId, nodeId: binding.nodeId,
    nodeKeyId: "key:test", serverId: "server:managed-codex", serverKeyId: "key:managed-codex",
    serverPublicKeySpki: serverSpki, transportIdentity: "transport:managed-codex", features: [CODEX_DELIVERY_FEATURE],
    maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 }], async sign(frame) { return signNodeFrame(frame, server.privateKey); } };
  const routes: ConstructorParameters<typeof ManagedNativeSessions>[3] = {
    queue: { locate: f.assignment.locateQueuedHarnessDelivery.bind(f.assignment),
      stage: async (...args) => { nativeStageCalls++; return f.assignment.stageApprovedQueueDelivery(...args); },
      transmit: f.assignment.transmitApprovedQueueDelivery.bind(f.assignment),
      codexStage: f.assignment.stageApprovedCodexQueueDelivery.bind(f.assignment),
      codexTransmit: f.assignment.transmitApprovedCodexQueueDelivery.bind(f.assignment) },
    stage: f.assignment.stageQueuedNativeDelivery.bind(f.assignment),
    transmit: f.assignment.transmitQueuedNativeDelivery.bind(f.assignment),
    receipt: async () => { nativeReceiptCalls++; throw new Error("native receipt must not run"); },
    codexReceipt: f.assignment.receiveCodexDeliveryReceipt.bind(f.assignment),
    progress: async () => { throw new Error("Codex progress must not use native snapshots"); },
    recover: async () => { throw new Error("Codex must not use native recovery"); },
    register: async () => { nativeRegistrations++; throw new Error("Codex must not register a native run"); },
  };
  const manager = new ManagedNativeSessions(f.db, settings, f.scope, routes, work => work(), () => {}, () => instant + 8000);
  try {
    const handle = await manager.attachInput(binding.nodeId, transport, { mode: "initial", assignment: "queue" });
    const connectionId = "connection:managed-codex";
    const hello = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
      tenantId: binding.tenantId, actorId: binding.nodeId, keyId: "key:test", connectionId, sequence: 1,
      messageId: "message:managed-codex-hello", correlationId: "correlation:managed-codex",
      nonce: "managed_codex_hello_nonce_123456789", sentAt: at(8000), expiresAt: at(120_000),
      type: "connection.hello", body: { supportedProtocols: [NODE_PROTOCOL_V1], features: [CODEX_DELIVERY_FEATURE],
        requestedMaxFrameBytes: 131_072, lastAcknowledgedServerSequence: 0, unresolvedAttemptIds: [] } }, f.keys.privateKey);
    await handle.receive(JSON.stringify(hello), undefined, new AbortController().signal);
    const handshake = toNode.map(raw => JSON.parse(raw) as SignedNodeFrame), last = Math.max(...handshake.map(frame => frame.sequence));
    const report = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
      tenantId: binding.tenantId, actorId: binding.nodeId, keyId: "key:test", connectionId, sequence: 2,
      messageId: "message:managed-codex-report", correlationId: "correlation:managed-codex",
      nonce: "managed_codex_report_nonce_123456789", sentAt: at(8000), expiresAt: at(120_000),
      type: "node.reconciliation.report", body: { lastAcknowledgedServerSequence: last, attempts: [] } }, f.keys.privateKey);
    await handle.receive(JSON.stringify(report), undefined, new AbortController().signal); toNode.length = 0;
    const { reference } = await assignAndQueue(f);
    let settled = false;
    const delivery = manager.deliverApproved(reference, new AbortController().signal).finally(() => { settled = true; });
    for (let i = 0; i < 20 && toNode.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(toNode.length, 1); assert.equal(settled, false); assert.equal(nativeStageCalls, 0);
    const dispatch = JSON.parse(toNode[0]) as SignedNodeFrame<"harness.codex.dispatch">;
    assert.equal(dispatch.type, "harness.codex.dispatch");
    const receiptBody = { schema: "control-room.codex-task-dispatch-receipt/v1" as const,
      queueId: dispatch.body.queueId, dispatchMessageId: dispatch.messageId, dispatchBodyDigest: dispatch.bodyDigest,
      tenantId: dispatch.body.start.tenantId, projectId: dispatch.body.start.projectId, nodeId: dispatch.body.start.nodeId,
      jobId: dispatch.body.start.jobId, attemptId: dispatch.body.start.attemptId, permitDigest: dispatch.body.permitDigest,
      enrollmentDigest: dispatch.body.start.enrollmentDigest, recordedAt: at(8000), disposition: "recorded" as const,
      safeReason: "none" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
    const receipt = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
      tenantId: binding.tenantId, actorId: binding.nodeId, keyId: "key:test", connectionId, sequence: 3,
      messageId: "message:managed-codex-receipt", correlationId: "correlation:managed-codex",
      causationId: dispatch.messageId, nonce: "managed_codex_receipt_nonce_123456789", sentAt: at(8000),
      expiresAt: at(120_000), type: "harness.codex.dispatch.receipt", body: receiptBody }, f.keys.privateKey);
    await handle.receive(JSON.stringify(receipt), undefined, new AbortController().signal);
    const completed = await delivery;
    assert.equal(completed.kind, "codex"); assert.equal(completed.deliveryConfirmed, true);
    assert.equal(nativeReceiptCalls, 0); assert.equal(nativeRegistrations, 0);
    assert.equal((await f.db.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND job_id=$2",
      [binding.tenantId, dispatch.body.start.jobId])).rows.length, 0);
  } finally { await manager.close(); await f.close(); }
});

test("Codex authority callbacks are captured before caller mutation", async () => {
  const f = await setup();
  try {
    const configured = f.codexConfig.enrollments[0];
    configured.approvals.binding = () => ({ tenantId: "tenant:changed", nodeId: "node:changed", nodeClass: "changed" });
    configured.approvals.assertAvailable = () => { throw new Error("mutated authority callback"); };
    configured.approvals.resolveApprovalKey = async () => undefined;
    configured.security.currentServerTrustRevision = () => "trust-revision:changed";
    const queued = await assignAndQueue(f);
    assert.equal(queued.reference.jobId, queued.saved.job.id);
  } finally { await f.close(); }
});

test("Codex delivery refuses a connection using a non-canonical node key", async () => {
  const f = await setup();
  try {
    const { reference } = await assignAndQueue(f);
    const link = await connectedCodexSession(f, "key:alternate");
    await assert.rejects(f.assignment.stageApprovedCodexQueueDelivery(reference, link.session,
      new AbortController().signal));
    assert.equal(link.toNode.length, 0);
    assert.equal((await f.db.query("SELECT message_id FROM control_codex_delivery_envelopes")).rows.length, 0);
  } finally { await f.close(); }
});

test("Codex templates cannot borrow Hermes network authority or bypass explicit assignment", async () => {
  const f = await setup();
  try {
    const wrong = structuredClone(f.template);
    wrong.authority.networkPolicy = "allowlist";
    wrong.authority.allowedNetworkDestinations = ["https://agent.example.test:443"];
    wrong.authority.filesystemRoots = [];
    wrong.authority.digest = computeAuthorityDigest(wrong.authority);
    assert.throws(() => new TaskExecutionPlanner(f.db, f.scope, { template: wrong,
      integrityKey: new Uint8Array(32).fill(82), reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }),
    /unsupported native task template/);
    await assert.rejects(f.assignment.assign(f.identity, binding.projectId, f.planned.receipt.jobId,
      "node:other", f.planned.receipt.inputDigest));
    assert.equal((await f.planner.read(f.planned.receipt.jobId))?.job.state, "proposed");
    const assigned = await f.assignment.assign(f.identity, binding.projectId, f.planned.receipt.jobId,
      binding.nodeId, f.planned.receipt.inputDigest);
    const wrongConfig = { ...f.codexConfig, enrollments: f.codexConfig.enrollments.map(value => ({ ...value,
      connectorProfileDigest: sha256Digest("wrong-connector") })) };
    const wrongCoordinator = new TaskAssignmentCoordinator(f.db, f.scope, f.planner, [f.route], () => instant + 8000,
      [], undefined, undefined, wrongConfig);
    await assert.rejects(wrongCoordinator.prepareCodexOwnerPermit(f.identity, binding.projectId, assigned.receipt.jobId,
      assigned.receipt.inputDigest));
  } finally { await f.close(); }
});
