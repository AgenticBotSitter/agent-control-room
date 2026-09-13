import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createCodexApprovalIntakeV1 } from '../src/harness/codex-v1/approval-intake';
import { CODEX_START_OPERATION, codexTaskDispatchBodySchemaV1,
  codexTaskDispatchReceiptBodySchemaV1, codexTaskPayloadDigestV1,
  matchCodexTaskDispatchReceiptV1 } from '../src/harness/codex-v1/delivery-contract';
import { computeNormalizedOperationDigest } from '../src/node-policy/v1/policy-evaluator';
import { computeEffectClaimKey } from '../src/node-policy/v1/effect-claim';
import { computeArtifactBodyDigest, signArtifact } from '../src/node-policy/v1/crypto';
import type { PinnedApprovalTrustStore } from '../src/node-policy/v1/pinned-approval-trust';
import { NODE_PROTOCOL_V1, signNodeFrame, signedNodeFrameSchema } from '../src/node-protocol/v1';
import { sha256Digest } from '../src/security/canonical-digest';

const now = Date.parse('2026-09-12T20:00:00.000Z'), deadline = now + 60_000;
const keys = generateKeyPairSync('ed25519');
const spki = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const startBase = { schema: 'control-room.codex-task-start/v1' as const,
  tenantId: 'tenant:test', nodeId: 'node:test', projectId: 'project:test', jobId: 'job:test',
  attemptId: 'attempt:test', runId: 'run:test', leaseId: 'lease:test', leaseEpoch: 3,
  effectClaimKey: sha256Digest('placeholder-effect'), operationDigest: sha256Digest('placeholder'),
  inputDigest: sha256Digest({ prompt: 'Do the work', instructions: 'Be exact' }),
  enrollmentDigest: sha256Digest('enrollment'), connectorProfileDigest: sha256Digest('profile'),
  workspaceIntentDigest: sha256Digest('workspace'), prompt: 'Do the work', instructions: 'Be exact', deadline };

function fixture(overrides: { jobId?: string; permitKey?: typeof keys.privateKey } = {}) {
  const start = { ...startBase, jobId: overrides.jobId ?? startBase.jobId };
  const request = { contractVersion: 'control-room-node-policy/v1' as const,
    requestId: `request:codex:${start.jobId}`, tenantId: start.tenantId, nodeId: start.nodeId,
    nodeClass: 'personal-compute', projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, leaseId: start.leaseId, leaseEpoch: start.leaseEpoch,
    executorId: 'executor:codex', operationId: CODEX_START_OPERATION, operationDigest: '',
    payloadDigest: codexTaskPayloadDigestV1(start, sha256Digest('authority')),
    authorityDigest: sha256Digest('authority'), credentialRefs: ['credential:codex'],
    target: { kind: 'filesystem' as const, canonicalPath: '/synthetic/project' }, risk: 'low' as const,
    externalEffect: true, estimatedDurationSeconds: 60, occurredAt: new Date(now).toISOString() };
  request.operationDigest = computeNormalizedOperationDigest(request);
  start.operationDigest = request.operationDigest;
  start.effectClaimKey = computeEffectClaimKey(request);
  start.runId = `run:codex-task:${start.effectClaimKey.slice(7)}`;
  const approvalBody = { schema: 'control-room.owner-approval-attestation/v1' as const,
    tenantId: start.tenantId, nodeId: start.nodeId, projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, operationDigest: request.operationDigest, risk: 'low' as const,
    decision: 'approved' as const, issuedAt: new Date(now).toISOString(), expiresAt: new Date(deadline).toISOString(),
    nonce: 'c3ludGhldGljLWNvZGV4', approvalKeyId: 'approval-key:test' };
  const permit = signArtifact({ ...approvalBody, bodyDigest: computeArtifactBodyDigest(approvalBody) }, overrides.permitKey ?? keys.privateKey);
  const body = codexTaskDispatchBodySchemaV1.parse({ schema: 'control-room.codex-task-dispatch/v1',
    queueId: `native-queue:${sha256Digest({ tenantId: start.tenantId, jobId: start.jobId,
      attemptId: start.attemptId }).slice(7)}`, start, request, permit, permitDigest: sha256Digest(permit) });
  return { body, start, request, permit };
}

function outerFrame(body = fixture().body) {
  return signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
    messageId: 'message:codex-dispatch', correlationId: 'correlation:codex', tenantId: body.start.tenantId,
    actorId: 'control-room:test', senderKind: 'control_room', keyId: 'server-key:test',
    connectionId: 'connection:test', sequence: 8, sentAt: new Date(now).toISOString(),
    expiresAt: new Date(deadline).toISOString(), nonce: 'c3ludGhldGljLWZyYW1l',
    type: 'harness.codex.dispatch', body }, keys.privateKey);
}

test('Codex delivery is a signed, exact-job, effect-free node-protocol message', () => {
  const { body } = fixture(), frame = signedNodeFrameSchema.parse(outerFrame(body));
  const foreignPermit = fixture({ jobId: 'job:other' }).permit;
  assert.equal(frame.type, 'harness.codex.dispatch');
  assert.equal(frame.body.start.jobId, 'job:test');
  assert.equal(frame.body.permitDigest, sha256Digest(frame.body.permit));
  for (const changed of [
    { ...body, queueId: 'native-queue:wrong' },
    { ...body, permitDigest: sha256Digest('wrong') },
    { ...body, start: { ...body.start, inputDigest: sha256Digest('wrong') } },
    { ...body, start: { ...body.start, runId: 'run:other' } },
    { ...body, start: { ...body.start, effectClaimKey: sha256Digest('other-effect') } },
    { ...body, request: { ...body.request, leaseEpoch: 4 } },
    { ...body, permit: foreignPermit, permitDigest: sha256Digest(foreignPermit) },
    { ...body, request: { ...body.request, approval: body.permit } },
  ]) assert.equal(codexTaskDispatchBodySchemaV1.safeParse(changed).success, false);
});

test('authenticated receipt matches the exact delivery and grants no authority', () => {
  const { body } = fixture(), frame = outerFrame(body);
  const receipt = codexTaskDispatchReceiptBodySchemaV1.parse({
    schema: 'control-room.codex-task-dispatch-receipt/v1', queueId: body.queueId,
    dispatchMessageId: frame.messageId, dispatchBodyDigest: sha256Digest(body),
    tenantId: body.start.tenantId, projectId: body.start.projectId, nodeId: body.start.nodeId,
    jobId: body.start.jobId, attemptId: body.start.attemptId, permitDigest: body.permitDigest,
    enrollmentDigest: body.start.enrollmentDigest, recordedAt: new Date(now + 1).toISOString(),
    disposition: 'recorded', safeReason: 'none', startsWork: false, grantsExecutionAuthority: false });
  assert.equal(matchCodexTaskDispatchReceiptV1(receipt, { messageId: frame.messageId, body }).startsWork, false);
  assert.throws(() => matchCodexTaskDispatchReceiptV1({ ...receipt, jobId: 'job:other' },
    { messageId: frame.messageId, body }));
});

test('owner permit intake verifies signature, local bindings, freshness and revocation', async () => {
  const { body } = fixture(); let revision = 'trust-revision:7', currentNow = now + 1;
  const approvals = { binding: () => ({ tenantId: 'tenant:test', nodeId: 'node:test', nodeClass: 'personal-compute' }),
    assertAvailable() {}, async resolveApprovalKey(keyId: string) {
      return keyId === 'approval-key:test' ? new Uint8Array(Buffer.from(spki, 'base64url')) : undefined;
    } } as unknown as PinnedApprovalTrustStore;
  const create = (value = body) => createCodexApprovalIntakeV1({ body: value,
    expectedEnrollmentDigest: body.start.enrollmentDigest,
    expectedConnectorProfileDigest: body.start.connectorProfileDigest,
    expectedWorkspaceIntentDigest: body.start.workspaceIntentDigest }, {
    approvals, security: { currentServerTrustRevision: () => revision }, clock: () => currentNow });
  const accepted = await create()(new AbortController().signal);
  assert.equal(accepted.startsWork, false); assert.equal(accepted.grantsExecutionAuthority, false);
  assert.equal(accepted.permitsRetry, false); assert.equal(accepted.deliveryBodyDigest, sha256Digest(body));
  assert.deepEqual(accepted.request.approval, body.permit);
  revision = 'trust-revision:8'; assert.throws(() => accepted.assertFresh(), /codex_approval_intake_unavailable/);

  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(create()(aborted.signal), /codex_approval_intake_unavailable/);
  const otherKeys = generateKeyPairSync('ed25519'), wrong = fixture({ permitKey: otherKeys.privateKey }).body;
  await assert.rejects(create(wrong)(new AbortController().signal), /codex_approval_intake_unavailable/);
  currentNow = deadline;
  await assert.rejects(create()(new AbortController().signal), /codex_approval_intake_unavailable/);
});

test('protocol refuses wrong direction, identity, timing and oversized delivery', () => {
  const body = fixture().body, base = outerFrame(body);
  for (const changed of [
    { ...base, direction: 'node_to_server' },
    { ...base, tenantId: 'tenant:other' },
    { ...base, expiresAt: new Date(deadline + 1).toISOString() },
  ]) assert.equal(signedNodeFrameSchema.safeParse(changed).success, false);
  const huge = { ...body, start: { ...body.start, prompt: 'x'.repeat(32_769),
    inputDigest: sha256Digest({ prompt: 'x'.repeat(32_769), instructions: body.start.instructions }) } };
  assert.equal(codexTaskDispatchBodySchemaV1.safeParse(huge).success, false);
});
