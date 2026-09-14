import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  CODEX_ACTIVATION_FEATURE_V2,
  CODEX_DELIVERY_FEATURE_V2,
  CODEX_LEASE_FEATURE_V2,
  CODEX_RESOURCE_QUEUE_SCHEMA_V2,
  CODEX_START_OPERATION_V2,
  buildCodexTaskActivationV2,
  codexApprovalPacketDigestV2,
  codexCurrentAdmissionDigestV2,
  codexCurrentAdmissionSchemaV2,
  codexResourceLeaseSchemaV2,
  codexResourceQueueSchemaV2,
  codexResourceSubmissionSchemaV2,
  codexExecutionBindingDigestV2,
  codexStartAdmissionSchemaV2,
  codexTaskActivationBodySchemaV2,
  codexTaskDispatchBodySchemaV2,
  codexTaskDispatchReceiptBodySchemaV2,
  codexTaskPayloadDigestV2,
  codexTaskQueueIdV2,
  codexTaskRunIdV2,
  codexTaskStartSchemaV2,
  computeCodexTaskActivationDigestV2,
  computeCodexStartAuthorizationDigestV2,
  createCodexStartAdmissionV2,
  createCodexResourceLeaseV2,
  createCodexResourceQueueV2,
  createCodexResourceSubmissionV2,
  matchCodexCurrentAdmissionV2,
  matchCodexStartAdmissionV2,
  matchCodexTaskActivationV2,
  matchCodexTaskDispatchReceiptV2,
  verifyCodexResourceLeaseV2,
  verifyCodexResourceQueueV2,
  verifyCodexResourceSubmissionV2,
  type CodexActivationFrameV2,
} from '../src/resource-bound-wire/v2/codex-contract.ts';
import { codexTaskDispatchBodySchemaV1 } from '../src/harness/codex-v1/delivery-contract.ts';
import { codexTaskActivationBodySchemaV1 } from '../src/harness/codex-v1/activation-contract.ts';
import { codexStartAdmissionSchemaV1 } from '../src/harness/codex-v1/admission-contract.ts';
import { computeArtifactBodyDigest, signArtifact } from '../src/node-policy/v1/crypto.ts';
import { computeEffectClaimKey } from '../src/node-policy/v1/effect-claim.ts';
import { computeNormalizedOperationDigest } from '../src/node-policy/v1/policy-evaluator.ts';
import { computeAuthorityDigest, sha256Digest } from '../src/security/index.ts';
import { verifyCurrentResourceHolderProofV2 } from '../src/contracts/v1/project-coordination-boundaries.ts';

const now = Date.parse('2026-09-13T18:00:00.000Z');
const deadline = now + 60_000;
const keys = generateKeyPairSync('ed25519');
const pair = Object.freeze({
  resourceAdmissionId: 'resource-admission:test',
  resourceAdmissionDigest: sha256Digest('resource-admission:test'),
});
const authority = {
  projectId: 'project:test', allowedExecutor: 'executor:codex', allowedOperations: [CODEX_START_OPERATION_V2],
  credentialRefs: ['credential:codex'], filesystemRoots: ['/synthetic'], networkPolicy: 'none' as const,
  allowedNetworkDestinations: [], effectPolicy: 'approval_required' as const, maxRisk: 'low' as const,
  maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: new Date(deadline).toISOString(), digest: '',
};
authority.digest = computeAuthorityDigest(authority);

function fixture() {
  const start = {
    schema: 'control-room.codex-task-start/v2' as const,
    tenantId: 'tenant:test', nodeId: 'node:test', projectId: 'project:test', jobId: 'job:test',
    attemptId: 'attempt:test', runId: 'run:placeholder', leaseId: 'lease:test', leaseEpoch: 3,
    ...pair,
    effectClaimKey: sha256Digest('placeholder-effect'), operationDigest: sha256Digest('placeholder-operation'),
    inputDigest: sha256Digest({ prompt: 'Do the work', instructions: 'Be exact' }),
    enrollmentDigest: sha256Digest('enrollment'), connectorProfileDigest: sha256Digest('connector-profile'),
    workspaceIntentDigest: sha256Digest('workspace-intent'),
    prompt: 'Do the work', instructions: 'Be exact', deadline,
  };
  const request = {
    contractVersion: 'control-room-node-policy/v1' as const,
    requestId: 'request:codex:v2', tenantId: start.tenantId, nodeId: start.nodeId,
    nodeClass: 'personal-compute', projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, leaseId: start.leaseId, leaseEpoch: start.leaseEpoch,
    executorId: 'executor:codex', operationId: CODEX_START_OPERATION_V2, operationDigest: '',
    payloadDigest: codexTaskPayloadDigestV2(start, authority.digest),
    authorityDigest: authority.digest, credentialRefs: ['credential:codex'],
    target: { kind: 'filesystem' as const, canonicalPath: '/synthetic/project' },
    risk: 'low' as const, externalEffect: true, estimatedDurationSeconds: 60,
    occurredAt: new Date(now).toISOString(),
  };
  request.operationDigest = computeNormalizedOperationDigest(request);
  start.operationDigest = request.operationDigest;
  start.effectClaimKey = computeEffectClaimKey(request);
  start.runId = codexTaskRunIdV2(start);
  const approvalBody = {
    schema: 'control-room.owner-approval-attestation/v1' as const,
    tenantId: start.tenantId, nodeId: start.nodeId, projectId: start.projectId,
    jobId: start.jobId, attemptId: start.attemptId, operationDigest: request.operationDigest,
    risk: 'low' as const, decision: 'approved' as const,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(deadline).toISOString(),
    nonce: 'c3ludGhldGljLWNvZGV4LXYy', approvalKeyId: 'approval-key:test',
  };
  const permit = signArtifact({
    ...approvalBody, bodyDigest: computeArtifactBodyDigest(approvalBody),
  }, keys.privateKey);
  const queue = createCodexResourceQueueV2({
    schema: CODEX_RESOURCE_QUEUE_SCHEMA_V2, tenantId: start.tenantId, nodeId: start.nodeId,
    projectId: start.projectId, jobId: start.jobId, attemptId: start.attemptId,
    leaseId: start.leaseId, leaseEpoch: start.leaseEpoch, ...pair, start, request,
  });
  const submission = createCodexResourceSubmissionV2(queue);
  const lease = createCodexResourceLeaseV2(submission, {
    offerId: 'offer:codex:test', nodeId: start.nodeId, jobId: start.jobId, attemptId: start.attemptId,
    leaseId: start.leaseId, leaseEpoch: start.leaseEpoch, acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(deadline).toISOString(), authorityDigest: authority.digest, authority,
  });
  const body = codexTaskDispatchBodySchemaV2.parse({
    schema: 'control-room.codex-task-dispatch/v2',
    queueId: codexTaskQueueIdV2(start), tenantId: start.tenantId, nodeId: start.nodeId,
    projectId: start.projectId, jobId: start.jobId, attemptId: start.attemptId,
    leaseId: start.leaseId, leaseEpoch: start.leaseEpoch, ...pair, queue, queueDigest: queue.queueDigest,
    submission, submissionDigest: submission.payloadDigest, lease, leaseDigest: lease.payloadDigest,
    start, request, permit, permitDigest: sha256Digest(permit),
  });
  const dispatch = {
    type: 'harness.codex.dispatch' as const, direction: 'server_to_node' as const,
    senderKind: 'control_room' as const, messageId: 'message:codex-dispatch:v2',
    tenantId: start.tenantId, actorId: 'control-room:test', keyId: 'server-key:test',
    connectionId: 'connection:test', sentAt: new Date(now).toISOString(),
    expiresAt: new Date(deadline).toISOString(), body,
  };
  const receiptBody = codexTaskDispatchReceiptBodySchemaV2.parse({
    schema: 'control-room.codex-task-dispatch-receipt/v2', queueId: body.queueId,
    dispatchMessageId: dispatch.messageId, dispatchBodyDigest: sha256Digest(body),
    tenantId: start.tenantId, projectId: start.projectId, nodeId: start.nodeId,
    jobId: start.jobId, attemptId: start.attemptId, ...pair,
    permitDigest: body.permitDigest, enrollmentDigest: start.enrollmentDigest,
    recordedAt: new Date(now + 1_000).toISOString(), disposition: 'recorded', safeReason: 'none',
    startsWork: false, grantsExecutionAuthority: false,
  });
  const receipt = {
    type: 'harness.codex.dispatch.receipt' as const, direction: 'node_to_server' as const,
    senderKind: 'node' as const, messageId: 'message:codex-receipt:v2', causationId: dispatch.messageId,
    tenantId: start.tenantId, actorId: start.nodeId, keyId: 'node-key:test',
    connectionId: dispatch.connectionId, sentAt: new Date(now + 1_100).toISOString(),
    expiresAt: new Date(deadline).toISOString(), body: receiptBody,
  };
  const currentAdmission = codexCurrentAdmissionSchemaV2.parse({
    schema: 'control-room.codex-current-admission/v2',
    tenantId: start.tenantId, projectId: start.projectId, projectVersion: 4, projectLifecycle: 'active',
    jobId: start.jobId, jobVersion: 5, jobState: 'leased', attemptId: start.attemptId,
    attemptVersion: 6, attemptState: 'leased', leaseId: start.leaseId, leaseVersion: 7,
    leaseEpoch: start.leaseEpoch, leaseState: 'active', leaseExpiresAt: new Date(deadline).toISOString(),
    nodeId: start.nodeId, nodeVersion: 8, nodeState: 'active', nodeKeyId: 'node-key:test',
    nodeKeyState: 'active', nodeKeyValidFrom: new Date(now - 1_000).toISOString(), nodeKeyValidUntil: null,
    authorityDigest: request.authorityDigest, authorityExpiresAt: new Date(deadline).toISOString(),
    approvalKeyId: permit.body.approvalKeyId, approvalExpiresAt: permit.body.expiresAt,
    ownerTrustRevisionDigest: sha256Digest('owner-trust'), queueId: body.queueId,
    dispatchMessageId: dispatch.messageId, dispatchFrameDigest: sha256Digest(dispatch),
    receiptMessageId: receipt.messageId, receiptFrameDigest: sha256Digest(receipt), ...pair,
    permitDigest: body.permitDigest, inputDigest: start.inputDigest,
    operationDigest: start.operationDigest, effectClaimKey: start.effectClaimKey,
    enrollmentDigest: start.enrollmentDigest, connectorProfileDigest: start.connectorProfileDigest,
    workspaceIntentDigest: start.workspaceIntentDigest,
    configurationExpiresAt: new Date(deadline).toISOString(), connectionId: dispatch.connectionId,
    checkedAt: new Date(now + 1_150).toISOString(), admissionExpiresAt: new Date(now + 45_000).toISOString(),
  });
  const receiptReceivedAt = new Date(now + 1_200).toISOString();
  const activationBody = buildCodexTaskActivationV2({
    dispatch, receipt, currentAdmission, receiptReceivedAt,
    activatedAt: new Date(now + 1_300).toISOString(), activationExpiresAt: new Date(now + 30_000).toISOString(),
  });
  const activation: CodexActivationFrameV2 = {
    type: 'harness.codex.dispatch.activation', direction: 'server_to_node', senderKind: 'control_room',
    messageId: 'message:codex-activation:v2', causationId: receipt.messageId,
    tenantId: start.tenantId, actorId: dispatch.actorId, keyId: dispatch.keyId,
    connectionId: dispatch.connectionId, sentAt: activationBody.activatedAt,
    expiresAt: activationBody.activationExpiresAt, body: activationBody,
  };
  const admission = createCodexStartAdmissionV2({
    schema: 'control-room.codex-start-admission/v2',
    scope: { tenantId: start.tenantId, nodeId: start.nodeId, projectId: start.projectId,
      jobId: start.jobId, attemptId: start.attemptId, runId: start.runId,
      leaseId: start.leaseId, leaseEpoch: start.leaseEpoch, operationDigest: start.operationDigest },
    queueId: body.queueId, ...pair,
    requestMessageId: activation.messageId, activationMessageId: activation.messageId,
    activationId: activationBody.activationId, activationDigest: activationBody.activationDigest,
    activationFrameDigest: sha256Digest(activation), dispatchMessageId: dispatch.messageId,
    dispatchFrameDigest: sha256Digest(dispatch), receiptMessageId: receipt.messageId,
    receiptFrameDigest: sha256Digest(receipt), workspacePath: activationBody.workspacePath,
    deliveryDigest: sha256Digest(dispatch), enrollmentDigest: start.enrollmentDigest,
    permitDigest: body.permitDigest, currentAdmissionDigest: codexCurrentAdmissionDigestV2(currentAdmission),
    inputDigest: start.inputDigest, method: 'thread/start', connectionAttemptId: 'connection-attempt:test',
    initializedConnectionDigest: sha256Digest('initialized-connection'), threadStartRequestId: 10,
    requestedAt: new Date(now + 1_400).toISOString(), deadline: new Date(now + 25_000).toISOString(),
  });
  return { start, request, queue, submission, lease, body, dispatch, receiptBody, receipt, currentAdmission,
    receiptReceivedAt, activationBody, activation, admission };
}

test('v2 Codex dispatch binds the resource pair before operation/effect authorization', () => {
  const f = fixture();
  assert.equal(CODEX_DELIVERY_FEATURE_V2, 'harness.codex.dispatch.v2');
  assert.equal(CODEX_ACTIVATION_FEATURE_V2, 'harness.codex.activation.v2');
  assert.equal(f.request.payloadDigest, codexTaskPayloadDigestV2(f.start, f.request.authorityDigest));
  assert.equal(f.request.operationDigest, computeNormalizedOperationDigest(f.request));
  assert.equal(f.start.effectClaimKey, computeEffectClaimKey(f.request));
  assert.notEqual(codexTaskPayloadDigestV2(f.start, f.request.authorityDigest),
    codexTaskPayloadDigestV2({ ...f.start, resourceAdmissionDigest: sha256Digest('other') }, f.request.authorityDigest));
  assert.match(codexApprovalPacketDigestV2(f.body), /^sha256:/);
  assert.match(codexExecutionBindingDigestV2(f.body), /^sha256:/);
  for (const value of [f.receiptBody, f.activationBody, f.admission]) {
    assert.equal(value.resourceAdmissionId, pair.resourceAdmissionId);
    assert.equal(value.resourceAdmissionDigest, pair.resourceAdmissionDigest);
    assert.equal(value.grantsExecutionAuthority, false);
  }
  assert.equal(f.activationBody.startsWork, false);
  assert.equal(f.activationBody.permitsRetry, false);
  assert.equal(f.activationBody.permitsResume, false);
  assert.equal(f.activationBody.permitsThreadRead, false);
  assert.match(f.admission.startAuthorizationDigest, /^sha256:/);
});

test('v2 receipt, current admission, activation and start admission reject resource substitution', () => {
  const f = fixture();
  assert.equal(matchCodexTaskDispatchReceiptV2(f.receiptBody,
    { messageId: f.dispatch.messageId, body: f.body }).resourceAdmissionId, pair.resourceAdmissionId);
  assert.throws(() => matchCodexTaskDispatchReceiptV2({
    ...f.receiptBody, resourceAdmissionDigest: sha256Digest('other'),
  }, { messageId: f.dispatch.messageId, body: f.body }), /mismatch/);
  assert.equal(matchCodexCurrentAdmissionV2(f.currentAdmission,
    { dispatch: f.dispatch, receipt: f.receipt }).resourceAdmissionId, pair.resourceAdmissionId);
  assert.throws(() => matchCodexCurrentAdmissionV2({
    ...f.currentAdmission, resourceAdmissionDigest: sha256Digest('other'),
  }, { dispatch: f.dispatch, receipt: f.receipt }), /mismatch/);
  assert.equal(matchCodexTaskActivationV2(f.activation, f).activationId, f.activationBody.activationId);
  const changedMaterial = { ...f.activationBody, resourceAdmissionDigest: sha256Digest('other') };
  const { activationId: _id, activationDigest: _digest, ...material } = changedMaterial;
  void _id; void _digest;
  const activationDigest = computeCodexTaskActivationDigestV2(material);
  const changedActivation = { ...f.activation, body: { ...material,
    activationId: `codex-activation-v2:${activationDigest.slice(7)}`, activationDigest } };
  assert.throws(() => matchCodexTaskActivationV2(changedActivation, f), /mismatch/);
  assert.equal(matchCodexStartAdmissionV2(f.admission,
    { activationFrame: f.activation, currentAdmission: f.currentAdmission }).admissionId, f.admission.admissionId);
  const { admissionId: _admissionId, adapter: _adapter, startAuthorizationDigest: _startAuthorizationDigest,
    contractDigest: _contractDigest, startsWork: _startsWork, grantsExecutionAuthority: _grants,
    permitsResume: _resume, permitsRetry: _retry, permitsThreadRead: _read, ...admissionInput } = f.admission;
  void _admissionId; void _adapter; void _startAuthorizationDigest; void _contractDigest;
  void _startsWork; void _grants; void _resume; void _retry; void _read;
  const substitutedAdmission = createCodexStartAdmissionV2({
    ...admissionInput, resourceAdmissionDigest: sha256Digest('other'),
  });
  assert.throws(() => matchCodexStartAdmissionV2(substitutedAdmission,
    { activationFrame: f.activation, currentAdmission: f.currentAdmission }), /mismatch/);
  assert.notEqual(substitutedAdmission.startAuthorizationDigest, f.admission.startAuthorizationDigest);
  assert.throws(() => matchCodexStartAdmissionV2({
    ...f.admission, startAuthorizationDigest: sha256Digest('other-authorization'),
  }, { activationFrame: f.activation, currentAdmission: f.currentAdmission }), /unavailable/);
  const { contractDigest: _contract, startAuthorizationDigest: _authorization, ...authorizationMaterial } = f.admission;
  void _contract; void _authorization;
  assert.equal(computeCodexStartAuthorizationDigestV2(authorizationMaterial), f.admission.startAuthorizationDigest);
  const lateAdmission = createCodexStartAdmissionV2({ ...admissionInput, deadline: new Date(now + 50_000).toISOString() });
  assert.throws(() => matchCodexStartAdmissionV2(lateAdmission,
    { activationFrame: f.activation, currentAdmission: f.currentAdmission }), /mismatch/);
});

test('v2 Codex queue, submission reference, and lease envelope preserve exact resource and authority identity', () => {
  const f = fixture();
  const { queue, submission, lease } = f;
  assert.equal(CODEX_LEASE_FEATURE_V2, 'harness.codex.lease.v2');
  assert.equal(verifyCodexResourceQueueV2(queue).queueId, f.body.queueId);
  assert.equal(verifyCodexResourceSubmissionV2(submission).requestId, f.request.requestId);
  assert.equal(verifyCodexResourceLeaseV2(lease).leaseGrant.authorityDigest, f.request.authorityDigest);
  assert.equal(lease.resourceAdmissionDigest, pair.resourceAdmissionDigest);
  assert.equal(lease.startsWork, false);
  const { resourceAdmissionId: _id, ...missingPair } = queue;
  void _id;
  assert.equal(codexResourceQueueSchemaV2.safeParse({ ...queue,
    schema: 'control-room.resource-bound-codex-queue/v1' }).success, false);
  assert.equal(codexResourceQueueSchemaV2.safeParse(missingPair).success, false);
  assert.equal(codexResourceQueueSchemaV2.safeParse({ ...queue,
    resourceAdmissionDigest: sha256Digest('substituted-resource') }).success, false);
  assert.equal(codexResourceSubmissionSchemaV2.safeParse({ ...submission,
    queueDigest: sha256Digest('substituted-queue') }).success, false);
  assert.equal(codexResourceLeaseSchemaV2.safeParse({ ...lease,
    leaseGrant: { ...lease.leaseGrant, authorityDigest: sha256Digest('substituted-authority') } }).success, false);
});

test('v1 and v2 Codex top-level contracts remain parse-separated and strict', () => {
  const f = fixture();
  assert.equal(codexTaskDispatchBodySchemaV1.safeParse(f.body).success, false);
  assert.equal(codexTaskActivationBodySchemaV1.safeParse(f.activationBody).success, false);
  assert.equal(codexStartAdmissionSchemaV1.safeParse(f.admission).success, false);
  for (const schema of [codexTaskStartSchemaV2, codexTaskDispatchBodySchemaV2,
    codexTaskDispatchReceiptBodySchemaV2, codexCurrentAdmissionSchemaV2,
    codexTaskActivationBodySchemaV2, codexStartAdmissionSchemaV2]) {
    assert.equal(schema.safeParse({}).success, false);
  }
  assert.equal(codexTaskDispatchBodySchemaV2.safeParse({ ...f.body,
    schema: 'control-room.codex-task-dispatch/v1' }).success, false);
  assert.equal(codexTaskDispatchBodySchemaV2.safeParse({ ...f.body,
    resourceAdmissionId: undefined }).success, false);
  assert.equal(codexTaskDispatchBodySchemaV2.safeParse({ ...f.body, unexpected: true }).success, false);
});

test('Codex v2 current-holder proof maps the exact admission, run, and start authorization', () => {
  const f = fixture();
  const proof = {
    schema: 'control-room.current-resource-holder/v2' as const, tenantId: f.start.tenantId, projectId: f.start.projectId,
    jobId: f.start.jobId, attemptId: f.start.attemptId, leaseId: f.start.leaseId, nodeId: f.start.nodeId,
    runId: f.start.runId, admissionId: pair.resourceAdmissionId, resourceAdmissionDigest: pair.resourceAdmissionDigest,
    startAuthorizationDigest: f.admission.startAuthorizationDigest, admissionVersion: 1, state: 'held' as const,
    checkedAt: new Date(now + 1_500).toISOString(), expiresAt: new Date(now + 10_000).toISOString(),
  };
  assert.equal(verifyCurrentResourceHolderProofV2(proof, proof, now + 2_000).admissionId, pair.resourceAdmissionId);
  assert.throws(() => verifyCurrentResourceHolderProofV2(proof,
    { ...proof, admissionId: 'resource-admission:other' }, now + 2_000));
  assert.throws(() => verifyCurrentResourceHolderProofV2(proof, { ...proof, runId: 'run:other' }, now + 2_000));
  assert.throws(() => verifyCurrentResourceHolderProofV2(proof,
    { ...proof, startAuthorizationDigest: sha256Digest('other-authorization') }, now + 2_000));
});
