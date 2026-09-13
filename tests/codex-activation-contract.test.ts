import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { buildCodexTaskActivationV1, CODEX_ACTIVATION_FEATURE,
  codexTaskActivationBodySchemaV1, matchCodexTaskActivationV1, parseCodexTaskActivationV1 } from '../src/harness/codex-v1/activation-contract';
import { CODEX_START_OPERATION, codexTaskDispatchBodySchemaV1,
  codexTaskDispatchReceiptBodySchemaV1, codexTaskPayloadDigestV1 } from '../src/harness/codex-v1/delivery-contract';
import { computeEffectClaimKey } from '../src/node-policy/v1/effect-claim';
import { computeNormalizedOperationDigest } from '../src/node-policy/v1/policy-evaluator';
import { computeArtifactBodyDigest, signArtifact } from '../src/node-policy/v1/crypto';
import { NODE_PROTOCOL_V1, serverToNodeTypes, signNodeFrame, signedNodeFrameSchema } from '../src/node-protocol/v1';
import { sha256Digest } from '../src/security/canonical-digest';

const now = Date.parse('2026-09-12T20:00:00.000Z');
const deadline = now + 60_000;
const keys = generateKeyPairSync('ed25519');

function fixture() {
  const start = { schema: 'control-room.codex-task-start/v1' as const,
    tenantId: 'tenant:test', nodeId: 'node:test', projectId: 'project:test', jobId: 'job:test',
    attemptId: 'attempt:test', runId: 'run:placeholder', leaseId: 'lease:test', leaseEpoch: 3,
    effectClaimKey: sha256Digest('placeholder-effect'), operationDigest: sha256Digest('placeholder'),
    inputDigest: sha256Digest({ prompt: 'Do the work', instructions: 'Be exact' }),
    enrollmentDigest: sha256Digest('enrollment'), connectorProfileDigest: sha256Digest('profile'),
    workspaceIntentDigest: sha256Digest('workspace'), prompt: 'Do the work', instructions: 'Be exact', deadline };
  const request = { contractVersion: 'control-room-node-policy/v1' as const,
    requestId: 'request:codex:test', tenantId: start.tenantId, nodeId: start.nodeId,
    nodeClass: 'personal-compute', projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, leaseId: start.leaseId, leaseEpoch: start.leaseEpoch,
    executorId: 'executor:codex', operationId: CODEX_START_OPERATION, operationDigest: '',
    payloadDigest: codexTaskPayloadDigestV1(start, sha256Digest('authority')), authorityDigest: sha256Digest('authority'),
    credentialRefs: ['credential:codex'], target: { kind: 'filesystem' as const, canonicalPath: '/synthetic/project' },
    risk: 'low' as const, externalEffect: true, estimatedDurationSeconds: 60, occurredAt: new Date(now).toISOString() };
  request.operationDigest = computeNormalizedOperationDigest(request);
  start.operationDigest = request.operationDigest;
  start.effectClaimKey = computeEffectClaimKey(request);
  start.runId = `run:codex-task:${start.effectClaimKey.slice(7)}`;
  const approvalBody = { schema: 'control-room.owner-approval-attestation/v1' as const,
    tenantId: start.tenantId, nodeId: start.nodeId, projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, operationDigest: request.operationDigest, risk: 'low' as const,
    decision: 'approved' as const, issuedAt: new Date(now).toISOString(), expiresAt: new Date(deadline).toISOString(),
    nonce: 'c3ludGhldGljLWNvZGV4', approvalKeyId: 'approval-key:test' };
  const permit = signArtifact({ ...approvalBody, bodyDigest: computeArtifactBodyDigest(approvalBody) }, keys.privateKey);
  const body = codexTaskDispatchBodySchemaV1.parse({ schema: 'control-room.codex-task-dispatch/v1',
    queueId: `native-queue:${sha256Digest({ tenantId: start.tenantId, jobId: start.jobId, attemptId: start.attemptId }).slice(7)}`,
    start, request, permit, permitDigest: sha256Digest(permit) });
  const dispatch = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
    messageId: 'message:codex-dispatch', correlationId: 'correlation:codex', tenantId: start.tenantId,
    actorId: 'control-room:test', senderKind: 'control_room', keyId: 'server-key:test', connectionId: 'connection:test',
    sequence: 8, sentAt: new Date(now).toISOString(), expiresAt: new Date(deadline).toISOString(),
    nonce: 'c3ludGhldGljLWZyYW1l', type: 'harness.codex.dispatch', body }, keys.privateKey);
  const receiptBody = codexTaskDispatchReceiptBodySchemaV1.parse({
    schema: 'control-room.codex-task-dispatch-receipt/v1', queueId: body.queueId,
    dispatchMessageId: dispatch.messageId, dispatchBodyDigest: sha256Digest(body), tenantId: start.tenantId,
    projectId: start.projectId, nodeId: start.nodeId, jobId: start.jobId, attemptId: start.attemptId,
    permitDigest: body.permitDigest, enrollmentDigest: start.enrollmentDigest, recordedAt: new Date(now + 1_000).toISOString(),
    disposition: 'recorded', safeReason: 'none', startsWork: false, grantsExecutionAuthority: false });
  const receipt = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'node_to_server',
    messageId: 'message:codex-receipt', correlationId: 'correlation:codex', causationId: dispatch.messageId,
    tenantId: start.tenantId, actorId: start.nodeId, senderKind: 'node', keyId: 'node-key:test', connectionId: dispatch.connectionId,
    sequence: 9, sentAt: new Date(now + 1_100).toISOString(), expiresAt: new Date(deadline).toISOString(),
    nonce: 'c3ludGhldGljLWNvZGV4LXJlY2VpcHQ', type: 'harness.codex.dispatch.receipt', body: receiptBody }, keys.privateKey);
  const receiptReceivedAt = new Date(now + 1_200).toISOString();
  const bodyActivation = buildCodexTaskActivationV1({ dispatch, receipt, currentAdmissionDigest: sha256Digest('current-admission'),
    receiptReceivedAt, activatedAt: new Date(now + 1_300).toISOString(), activationExpiresAt: new Date(now + 30_000).toISOString() });
  const activation = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
    messageId: 'message:codex-activation', correlationId: 'correlation:codex', causationId: receipt.messageId,
    tenantId: start.tenantId, actorId: dispatch.actorId, senderKind: 'control_room', keyId: dispatch.keyId,
    connectionId: dispatch.connectionId, sequence: 10, sentAt: bodyActivation.activatedAt,
    expiresAt: bodyActivation.activationExpiresAt, nonce: 'c3ludGhldGljLWNvZGV4LWFjdGl2YXRpb24',
    type: 'harness.codex.dispatch.activation', body: bodyActivation }, keys.privateKey);
  return { dispatch, receipt, activation, receiptReceivedAt, currentAdmissionDigest: sha256Digest('current-admission') };
}

test('activation binds one exact dispatch receipt and remains effect-free', () => {
  const value = fixture();
  assert.equal(CODEX_ACTIVATION_FEATURE, 'harness.codex.activation.v1');
  assert.equal(serverToNodeTypes.has('harness.codex.dispatch.activation'), true);
  assert.equal(signedNodeFrameSchema.parse(value.activation).type, 'harness.codex.dispatch.activation');
  assert.equal(parseCodexTaskActivationV1(value.activation.body).activationId, value.activation.body.activationId);
  const activation = matchCodexTaskActivationV1(value.activation, value);
  assert.equal(activation.authorizesExactStart, true);
  assert.equal(activation.startsWork, false);
  assert.equal(activation.grantsExecutionAuthority, false);
  assert.equal(activation.permitsRetry, false);
  assert.equal(activation.permitsResume, false);
  assert.equal(activation.permitsThreadRead, false);
});

test('activation rejects altered digests, identity, timing, and causation', () => {
  const value = fixture();
  assert.equal(codexTaskActivationBodySchemaV1.safeParse({ ...value.activation.body, authorizesExactStart: false }).success, false);
  assert.equal(codexTaskActivationBodySchemaV1.safeParse({ ...value.activation.body, activationDigest: sha256Digest('wrong') }).success, false);
  assert.throws(() => matchCodexTaskActivationV1({ ...value.activation, causationId: value.dispatch.messageId }, value));
  assert.throws(() => matchCodexTaskActivationV1({ ...value.activation, connectionId: 'connection:other' }, value));
  assert.throws(() => matchCodexTaskActivationV1(value.activation, { ...value, receiptReceivedAt: new Date(now + 1_201).toISOString() }));
});
