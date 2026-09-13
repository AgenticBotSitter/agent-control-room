import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { buildCodexTaskActivationV1 } from '../src/harness/codex-v1/activation-contract.ts';
import { createCodexLocalStartRuntimeV1 } from '../src/harness/codex-v1/local-start-runtime.ts';
import { createCodexStartAdmissionV1 } from '../src/harness/codex-v1/admission-contract.ts';
import { createCodexOwnedStartV1 } from '../src/harness/codex-v1/owned-start.ts';
import { CODEX_START_OPERATION, codexTaskDispatchBodySchemaV1,
  codexTaskDispatchReceiptBodySchemaV1, codexTaskPayloadDigestV1 } from '../src/harness/codex-v1/delivery-contract.ts';
import { computeEffectClaimKey } from '../src/node-policy/v1/effect-claim.ts';
import { computeNormalizedOperationDigest } from '../src/node-policy/v1/policy-evaluator.ts';
import { computeArtifactBodyDigest, signArtifact } from '../src/node-policy/v1/crypto.ts';
import { NODE_PROTOCOL_V1, signNodeFrame } from '../src/node-protocol/v1/index.ts';
import { sha256Digest } from '../src/security/canonical-digest.ts';

const baseTime = Date.parse('2026-09-12T20:00:00.000Z');
const deadline = baseTime + 60_000;
const keys = generateKeyPairSync('ed25519');

function activationFixture() {
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
    risk: 'low' as const, externalEffect: true, estimatedDurationSeconds: 60, occurredAt: new Date(baseTime).toISOString() };
  request.operationDigest = computeNormalizedOperationDigest(request);
  start.operationDigest = request.operationDigest;
  start.effectClaimKey = computeEffectClaimKey(request);
  start.runId = `run:codex-task:${start.effectClaimKey.slice(7)}`;
  const approvalBody = { schema: 'control-room.owner-approval-attestation/v1' as const,
    tenantId: start.tenantId, nodeId: start.nodeId, projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, operationDigest: request.operationDigest, risk: 'low' as const,
    decision: 'approved' as const, issuedAt: new Date(baseTime).toISOString(), expiresAt: new Date(deadline).toISOString(),
    nonce: 'c3ludGhldGljLWNvZGV4', approvalKeyId: 'approval-key:test' };
  const permit = signArtifact({ ...approvalBody, bodyDigest: computeArtifactBodyDigest(approvalBody) }, keys.privateKey);
  const body = codexTaskDispatchBodySchemaV1.parse({ schema: 'control-room.codex-task-dispatch/v1',
    queueId: `native-queue:${sha256Digest({ tenantId: start.tenantId, jobId: start.jobId, attemptId: start.attemptId }).slice(7)}`,
    start, request, permit, permitDigest: sha256Digest(permit) });
  const dispatch = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
    messageId: 'message:codex-dispatch', correlationId: 'correlation:codex', tenantId: start.tenantId,
    actorId: 'control-room:test', senderKind: 'control_room', keyId: 'server-key:test', connectionId: 'connection:test',
    sequence: 8, sentAt: new Date(baseTime).toISOString(), expiresAt: new Date(deadline).toISOString(),
    nonce: 'c3ludGhldGljLWZyYW1l', type: 'harness.codex.dispatch', body }, keys.privateKey);
  const receiptBody = codexTaskDispatchReceiptBodySchemaV1.parse({
    schema: 'control-room.codex-task-dispatch-receipt/v1', queueId: body.queueId,
    dispatchMessageId: dispatch.messageId, dispatchBodyDigest: sha256Digest(body), tenantId: start.tenantId,
    projectId: start.projectId, nodeId: start.nodeId, jobId: start.jobId, attemptId: start.attemptId,
    permitDigest: body.permitDigest, enrollmentDigest: start.enrollmentDigest, recordedAt: new Date(baseTime + 1_000).toISOString(),
    disposition: 'recorded', safeReason: 'none', startsWork: false, grantsExecutionAuthority: false });
  const receipt = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'node_to_server',
    messageId: 'message:codex-receipt', correlationId: 'correlation:codex', causationId: dispatch.messageId,
    tenantId: start.tenantId, actorId: start.nodeId, senderKind: 'node', keyId: 'node-key:test', connectionId: dispatch.connectionId,
    sequence: 9, sentAt: new Date(baseTime + 1_100).toISOString(), expiresAt: new Date(deadline).toISOString(),
    nonce: 'c3ludGhldGljLWNvZGV4LXJlY2VpcHQ', type: 'harness.codex.dispatch.receipt', body: receiptBody }, keys.privateKey);
  const receiptReceivedAt = new Date(baseTime + 1_200).toISOString();
  const activationBody = buildCodexTaskActivationV1({ dispatch, receipt, currentAdmissionDigest: sha256Digest('current-admission'),
    receiptReceivedAt, activatedAt: new Date(baseTime + 1_300).toISOString(), activationExpiresAt: new Date(baseTime + 30_000).toISOString() });
  const activation = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
    messageId: 'message:codex-activation', correlationId: 'correlation:codex', causationId: receipt.messageId,
    tenantId: start.tenantId, actorId: dispatch.actorId, senderKind: 'control_room', keyId: dispatch.keyId,
    connectionId: dispatch.connectionId, sequence: 10, sentAt: activationBody.activatedAt,
    expiresAt: activationBody.activationExpiresAt, nonce: 'c3ludGhldGljLWNvZGV4LWFjdGl2YXRpb24',
    type: 'harness.codex.dispatch.activation', body: activationBody }, keys.privateKey);
  return { activation, activationReceivedAt: new Date(baseTime + 1_400).toISOString(),
    currentAdmissionDigest: activationBody.currentAdmissionDigest };
}

const threadResponse = (id: number) => JSON.stringify({ id, result: {
  approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: '/synthetic/project', model: 'model:test',
  modelProvider: 'provider:test', sandbox: { type: 'readOnly' }, instructionSources: [],
  thread: { id: 'thr_synthetic', sessionId: 'thr_synthetic', ephemeral: false, cliVersion: 'test',
    createdAt: 1, cwd: '/synthetic/project', modelProvider: 'provider:test', preview: '', projectId: null,
    source: 'appServer', status: { type: 'idle' }, turns: [], updatedAt: 1 } } });
const turnResponse = (id: number) => JSON.stringify({ id, result: {
  turn: { id: 'turn_synthetic', status: 'inProgress', items: [] } } });

function runtimeFixture(options: { authority?: 'current' | 'false' | 'stale'; failWorkspace?: boolean;
  revokeAfterWorkspace?: boolean; duplicateReservation?: boolean; differentAdmission?: boolean } = {}) {
  const saved = activationFixture();
  let clock = baseTime + 2_000;
  let revoked = false;
  const calls: string[] = [];
  const written: unknown[] = [];
  const responses = [JSON.stringify({ id: 1, result: {} }), threadResponse(10), turnResponse(20)];
  const ownedStart = createCodexOwnedStartV1({
    open: async () => {
      calls.push('open');
      return {
        writeLine: async (line: string) => {
          const parsed = JSON.parse(line); written.push(parsed); calls.push(`write:${parsed.method}`);
        },
        readLine: async () => responses.shift(),
        close: async () => { calls.push('close'); },
      };
    },
  });
  const runtime = createCodexLocalStartRuntimeV1({
    queueId: saved.activation.body.queueId, connectionAttemptId: 'connection-attempt:local-start',
    initializedConnectionDigest: sha256Digest('initialized-local-start'), threadStartRequestId: 10, turnStartRequestId: 20,
    activationEvidence: { acceptedCodexActivation: () => ({ frame: saved.activation, receivedAt: saved.activationReceivedAt }) },
    authority: {
      assertCurrent: () => options.authority === 'false' ? false : undefined,
      currentAdmissionDigest: () => options.authority === 'stale' || revoked ? sha256Digest('stale') : saved.currentAdmissionDigest,
    },
    reservation: { reserveExactStart: (_value, _reservedAt, assertCurrent) => {
      calls.push('reserve'); assertCurrent(); return options.duplicateReservation ? 'duplicate' : 'recorded';
    } },
    workspace: { prepare: async (_binding, assertCurrent) => {
      calls.push('workspace'); assertCurrent();
      if (options.revokeAfterWorkspace) revoked = true;
      if (options.failWorkspace) throw new Error('synthetic workspace failure');
    } },
    ownedStart,
    receipts: {
      recordThread: async (_value, assertCurrent) => { calls.push('thread-receipt'); assertCurrent(); return 'recorded' as const; },
      recordTurn: async (_thread, _turn, assertCurrent) => { calls.push('turn-receipt'); assertCurrent(); return 'recorded' as const; },
    },
    admissionFactory: { create: binding => {
      assert.equal(binding.activationMessageId, saved.activation.messageId);
      assert.equal(binding.activationFrameDigest, sha256Digest(saved.activation));
      assert.equal(binding.dispatchFrameDigest, saved.activation.body.dispatchFrameDigest);
      assert.equal(binding.receiptFrameDigest, saved.activation.body.receiptFrameDigest);
      return createCodexStartAdmissionV1({
        schema: 'control-room.codex-start-admission/v1',
        scope: { tenantId: binding.activation.tenantId, nodeId: binding.activation.nodeId,
          projectId: binding.activation.projectId, jobId: binding.activation.jobId,
          attemptId: binding.activation.attemptId, runId: binding.activation.runId,
          leaseId: binding.activation.leaseId, leaseEpoch: binding.activation.leaseEpoch,
          operationDigest: binding.activation.operationDigest },
        queueId: binding.queueId, requestMessageId: binding.activationMessageId,
        activationMessageId: binding.activationMessageId, activationId: binding.activationId,
        activationDigest: binding.activationDigest, activationFrameDigest: binding.activationFrameDigest,
        dispatchMessageId: binding.dispatchMessageId, dispatchFrameDigest: binding.dispatchFrameDigest,
        receiptMessageId: binding.receiptMessageId, receiptFrameDigest: binding.receiptFrameDigest,
        workspacePath: options.differentAdmission ? '/synthetic/other' : binding.activation.workspacePath,
        deliveryDigest: binding.dispatchFrameDigest,
        enrollmentDigest: binding.activation.enrollmentDigest, permitDigest: binding.activation.permitDigest,
        currentAdmissionDigest: binding.currentAdmissionDigest, inputDigest: binding.activation.inputDigest,
        method: 'thread/start', connectionAttemptId: binding.connectionAttemptId,
        initializedConnectionDigest: binding.initializedConnectionDigest,
        threadStartRequestId: binding.threadStartRequestId, requestedAt: binding.requestedAt, deadline: binding.deadline,
      });
    } },
    clock: () => clock++,
  });
  return { runtime, calls, written };
}

test('uses exact current activation and a one-shot local reservation before bound effects', async () => {
  const { runtime, calls, written } = runtimeFixture();
  const result = await runtime.start();
  assert.deepEqual(calls, ['reserve', 'workspace', 'open', 'write:initialize', 'write:initialized',
    'write:thread/start', 'thread-receipt', 'write:turn/start', 'turn-receipt', 'close']);
  assert.equal(result.thread.threadId, 'thr_synthetic');
  assert.equal(result.turn.turnId, 'turn_synthetic');
  assert.equal(result.grantsExecutionAuthority, false);
  assert.equal(result.permitsRetry, false);
  assert.equal(result.permitsResume, false);
  assert.equal(result.permitsThreadRead, false);
  assert.deepEqual(written[2], { id: 10, method: 'thread/start', params: {
    cwd: result.activation.workspacePath, approvalPolicy: 'on-request', approvalsReviewer: 'user',
    sandbox: 'readOnly', developerInstructions: result.activation.instructions, ephemeral: false,
  } });
  assert.deepEqual(written[3], { id: 20, method: 'turn/start', params: {
    threadId: result.thread.threadId, input: [{ type: 'text', text: result.activation.prompt }],
  } });
  await assert.rejects(runtime.start(), /unavailable/);
});

test('refuses stale or non-synchronous local authority before reservation or effects', async () => {
  for (const authority of ['false', 'stale'] as const) {
    const { runtime, calls } = runtimeFixture({ authority });
    await assert.rejects(runtime.start(), /unavailable/);
    assert.deepEqual(calls, []);
  }
});

test('a failed workspace effect consumes this runtime and never opens a replacement session', async () => {
  const { runtime, calls } = runtimeFixture({ failWorkspace: true });
  await assert.rejects(runtime.start(), /unavailable/);
  assert.deepEqual(calls, ['reserve', 'workspace']);
  await assert.rejects(runtime.start(), /unavailable/);
  assert.deepEqual(calls, ['reserve', 'workspace']);
});

test('rechecks authority after an awaited workspace preparation before opening App Server', async () => {
  const { runtime, calls } = runtimeFixture({ revokeAfterWorkspace: true });
  await assert.rejects(runtime.start(), /unavailable/);
  assert.deepEqual(calls, ['reserve', 'workspace']);
});

test('refuses an already-reserved start before workspace or App Server effects', async () => {
  const { runtime, calls } = runtimeFixture({ duplicateReservation: true });
  await assert.rejects(runtime.start(), /unavailable/);
  assert.deepEqual(calls, ['reserve']);
});

test('refuses a valid but differently bound admission before reservation or effects', async () => {
  const { runtime, calls } = runtimeFixture({ differentAdmission: true });
  await assert.rejects(runtime.start(), /unavailable/);
  assert.deepEqual(calls, []);
});
