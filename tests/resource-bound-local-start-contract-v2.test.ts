import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexCurrentAdmissionDigestV2,
  codexCurrentAdmissionSchemaV2,
  computeCodexTaskActivationDigestV2,
  createCodexStartAdmissionV2,
  type CodexActivationFrameV2,
} from '../src/resource-bound-wire/v2/codex-contract.ts';
import {
  CODEX_LOCAL_START_BINDING_SCHEMA_V2,
  codexLocalStartBindingSchemaV2,
  createCodexLocalStartBindingV2,
  verifyCodexLocalStartBindingV2,
} from '../src/resource-bound-wire/v2/local-start-contract.ts';
import { sha256Digest } from '../src/security/canonical-digest.ts';

const digest = (value: string) => sha256Digest(value);
const pair = {
  resourceAdmissionId: 'resource-admission:local-start',
  resourceAdmissionDigest: digest('resource-admission:local-start'),
};
const at = (milliseconds: number) => new Date(Date.parse('2026-09-13T19:00:00.000Z') + milliseconds).toISOString();

function fixture() {
  const currentAdmission = codexCurrentAdmissionSchemaV2.parse({
    schema: 'control-room.codex-current-admission/v2', tenantId: 'tenant:test', projectId: 'project:test',
    projectVersion: 1, projectLifecycle: 'active', jobId: 'job:test', jobVersion: 2, jobState: 'leased',
    attemptId: 'attempt:test', attemptVersion: 3, attemptState: 'leased', leaseId: 'lease:test',
    leaseVersion: 4, leaseEpoch: 5, leaseState: 'active', leaseExpiresAt: at(60_000),
    nodeId: 'node:test', nodeVersion: 6, nodeState: 'active', nodeKeyId: 'node-key:test',
    nodeKeyState: 'active', nodeKeyValidFrom: at(-1_000), nodeKeyValidUntil: null,
    authorityDigest: digest('authority'), authorityExpiresAt: at(60_000), approvalKeyId: 'approval-key:test',
    approvalExpiresAt: at(60_000), ownerTrustRevisionDigest: digest('owner-trust'),
    queueId: 'native-queue:test', dispatchMessageId: 'message:dispatch', dispatchFrameDigest: digest('dispatch-frame'),
    receiptMessageId: 'message:receipt', receiptFrameDigest: digest('receipt-frame'), ...pair,
    permitDigest: digest('permit'), inputDigest: digest('input'), operationDigest: digest('operation'),
    effectClaimKey: digest('effect'), enrollmentDigest: digest('enrollment'),
    connectorProfileDigest: digest('connector-profile'), workspaceIntentDigest: digest('workspace-intent'),
    configurationExpiresAt: at(60_000), connectionId: 'connection:test', checkedAt: at(1_000),
    admissionExpiresAt: at(50_000),
  });
  const activationMaterial = {
    schema: 'control-room.codex-task-activation/v2' as const,
    tenantId: currentAdmission.tenantId, projectId: currentAdmission.projectId,
    nodeId: currentAdmission.nodeId, jobId: currentAdmission.jobId, attemptId: currentAdmission.attemptId,
    runId: 'run:test', leaseId: currentAdmission.leaseId, leaseEpoch: currentAdmission.leaseEpoch,
    queueId: currentAdmission.queueId, connectionId: currentAdmission.connectionId, ...pair,
    dispatchMessageId: currentAdmission.dispatchMessageId, dispatchFrameDigest: currentAdmission.dispatchFrameDigest,
    dispatchBodyDigest: digest('dispatch-body'), receiptMessageId: currentAdmission.receiptMessageId,
    receiptFrameDigest: currentAdmission.receiptFrameDigest, receiptBodyDigest: digest('receipt-body'),
    permitDigest: currentAdmission.permitDigest, inputDigest: digest({ prompt: 'Prompt', instructions: 'Instructions' } as never),
    operationDigest: currentAdmission.operationDigest, effectClaimKey: currentAdmission.effectClaimKey,
    enrollmentDigest: currentAdmission.enrollmentDigest, connectorProfileDigest: currentAdmission.connectorProfileDigest,
    workspaceIntentDigest: currentAdmission.workspaceIntentDigest,
    currentAdmissionDigest: codexCurrentAdmissionDigestV2(currentAdmission), workspacePath: '/synthetic/project',
    prompt: 'Prompt', instructions: 'Instructions', receiptRecordedAt: at(1_000), receiptReceivedAt: at(1_100),
    activatedAt: at(1_200), activationExpiresAt: at(40_000), startsWork: false as const,
    authorizesExactStart: true as const, grantsExecutionAuthority: false as const,
    permitsRetry: false as const, permitsResume: false as const, permitsThreadRead: false as const,
  };
  activationMaterial.inputDigest = sha256Digest({ prompt: activationMaterial.prompt, instructions: activationMaterial.instructions });
  const activationDigest = computeCodexTaskActivationDigestV2(activationMaterial);
  const activation = {
    ...activationMaterial, activationId: `codex-activation-v2:${activationDigest.slice(7)}`, activationDigest,
  };
  const activationFrame: CodexActivationFrameV2 = {
    type: 'harness.codex.dispatch.activation', direction: 'server_to_node', senderKind: 'control_room',
    messageId: 'message:activation', causationId: activation.receiptMessageId,
    tenantId: activation.tenantId, actorId: 'control-room:test', keyId: 'server-key:test',
    connectionId: activation.connectionId, sentAt: activation.activatedAt,
    expiresAt: activation.activationExpiresAt, body: activation,
  };
  const startAdmission = createCodexStartAdmissionV2({
    schema: 'control-room.codex-start-admission/v2', scope: {
      tenantId: activation.tenantId, nodeId: activation.nodeId, projectId: activation.projectId,
      jobId: activation.jobId, attemptId: activation.attemptId, runId: activation.runId,
      leaseId: activation.leaseId, leaseEpoch: activation.leaseEpoch, operationDigest: activation.operationDigest,
    },
    queueId: activation.queueId, ...pair, requestMessageId: activationFrame.messageId,
    activationMessageId: activationFrame.messageId, activationId: activation.activationId,
    activationDigest: activation.activationDigest, activationFrameDigest: sha256Digest(activationFrame),
    dispatchMessageId: activation.dispatchMessageId, dispatchFrameDigest: activation.dispatchFrameDigest,
    receiptMessageId: activation.receiptMessageId, receiptFrameDigest: activation.receiptFrameDigest,
    workspacePath: activation.workspacePath, deliveryDigest: activation.dispatchFrameDigest,
    enrollmentDigest: activation.enrollmentDigest, permitDigest: activation.permitDigest,
    currentAdmissionDigest: activation.currentAdmissionDigest, inputDigest: activation.inputDigest,
    method: 'thread/start', connectionAttemptId: 'connection-attempt:test',
    initializedConnectionDigest: digest('initialized-connection'), threadStartRequestId: 10,
    requestedAt: at(1_300), deadline: at(30_000),
  });
  const binding = createCodexLocalStartBindingV2({
    activationFrame, currentAdmission, startAdmission,
    connectionAttemptId: startAdmission.connectionAttemptId,
    initializedConnectionDigest: startAdmission.initializedConnectionDigest,
    threadStartRequestId: startAdmission.threadStartRequestId, turnStartRequestId: 20,
    requestedAt: startAdmission.requestedAt, deadline: startAdmission.deadline,
  });
  return { currentAdmission, activationFrame, startAdmission, binding };
}

test('local-start v2 is strict inert evidence with one exact resource-bound authorization value', () => {
  const f = fixture();
  assert.equal(CODEX_LOCAL_START_BINDING_SCHEMA_V2, 'control-room.codex-local-start-binding/v2');
  assert.equal(verifyCodexLocalStartBindingV2(f.binding, f.activationFrame).bindingId, f.binding.bindingId);
  assert.equal(f.binding.resourceAdmissionId, pair.resourceAdmissionId);
  assert.equal(f.binding.resourceAdmissionDigest, pair.resourceAdmissionDigest);
  assert.equal(f.binding.startAuthorizationDigest, f.startAdmission.startAuthorizationDigest);
  assert.equal(f.binding.startsWork, false);
  assert.equal(f.binding.grantsExecutionAuthority, false);
  assert.equal(f.binding.permitsRetry, false);
  assert.equal(f.binding.permitsResume, false);
  assert.equal(f.binding.permitsThreadRead, false);
  assert.equal(Object.hasOwn(f.binding, 'resourceHolderProof'), false);
});

test('local-start v2 detects pair, authorization, activation and admission substitution', () => {
  const f = fixture();
  for (const changed of [
    { ...f.binding, resourceAdmissionDigest: digest('other-resource') },
    { ...f.binding, startAuthorizationDigest: digest('other-authorization') },
    { ...f.binding, activationId: 'codex-activation-v2:other' },
    { ...f.binding, startAdmission: { ...f.binding.startAdmission, resourceAdmissionDigest: digest('other-resource') } },
    { ...f.binding, currentAdmission: { ...f.binding.currentAdmission, resourceAdmissionDigest: digest('other-resource') } },
  ]) assert.equal(codexLocalStartBindingSchemaV2.safeParse(changed).success, false);
  assert.throws(() => verifyCodexLocalStartBindingV2(f.binding, {
    ...f.activationFrame, messageId: 'message:activation:other',
  }), /unavailable/);
});

test('local-start v2 rejects v1 labels, omitted resource claims and unknown fields', () => {
  const f = fixture();
  assert.equal(codexLocalStartBindingSchemaV2.safeParse({
    ...f.binding, schema: 'control-room.codex-local-start-binding/v1',
  }).success, false);
  const { resourceAdmissionId: _id, ...missing } = f.binding;
  void _id;
  assert.equal(codexLocalStartBindingSchemaV2.safeParse(missing).success, false);
  assert.equal(codexLocalStartBindingSchemaV2.safeParse({ ...f.binding, runtime: 'start-now' }).success, false);
});
