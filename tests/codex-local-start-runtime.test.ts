import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { buildCodexTaskActivationV1, computeCodexTaskActivationDigestV1 } from '../src/harness/codex-v1/activation-contract.ts';
import { createCodexLocalStartRuntimeV1 } from '../src/harness/codex-v1/local-start-runtime.ts';
import { createCodexLocalStartCompositionV1 } from '../src/harness/codex-v1/local-start-composition.ts';
import { createCodexStartAdmissionV1 } from '../src/harness/codex-v1/admission-contract.ts';
import { createCodexOwnedStartV1 } from '../src/harness/codex-v1/owned-start.ts';
import { CODEX_APP_SERVER_START_CONTRACT } from '../src/harness/codex-v1/schema-contract.ts';
import { SqliteCodexStartJournalV1 } from '../src/harness/codex-v1/start-journal.ts';
import { SqliteBridgeJournal } from '../src/node-bridge/journal.ts';
import { CODEX_START_OPERATION, codexTaskDispatchBodySchemaV1,
  codexTaskDispatchReceiptBodySchemaV1, codexTaskPayloadDigestV1,
  codexTaskRunIdV1 } from '../src/harness/codex-v1/delivery-contract.ts';
import { computeEffectClaimKey } from '../src/node-policy/v1/effect-claim.ts';
import { computeNormalizedOperationDigest } from '../src/node-policy/v1/policy-evaluator.ts';
import { computeArtifactBodyDigest, signArtifact } from '../src/node-policy/v1/crypto.ts';
import { NODE_PROTOCOL_V1, signNodeFrame } from '../src/node-protocol/v1/index.ts';
import { sha256Digest } from '../src/security/canonical-digest.ts';
import { createControllerWorkerDeliveryV1 } from '../src/harness/v1/controller-worker-delivery.ts';

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
  start.runId = codexTaskRunIdV1(start);
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

function sharedDelivery(saved: ReturnType<typeof activationFixture>) {
  const activation = saved.activation.body;
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: activation.tenantId, nodeId: activation.nodeId, projectId: activation.projectId,
      jobId: activation.jobId, attemptId: activation.attemptId, runId: activation.runId },
    worker: { workerId: 'worker:codex-local', adapterId: 'codex-app-server/v1', adapterRevision: 'source-test' },
    input: { prompt: activation.prompt, instructions: activation.instructions },
    authorityDigest: sha256Digest('controller-authority'),
    connectorProfileDigest: activation.connectorProfileDigest,
    acceptanceProfileId: 'profile:codex', acceptanceProfileDigest: sha256Digest('acceptance'),
    issuedAt: new Date(baseTime).toISOString(), expiresAt: new Date(deadline).toISOString(),
  });
}

const threadResponse = (id: number, cwd = '/synthetic/project') => JSON.stringify({ id, result: {
  approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd, model: 'model:test',
  modelProvider: 'provider:test', sandbox: { type: 'readOnly' }, instructionSources: [],
  thread: { id: 'thr_synthetic', sessionId: 'thr_synthetic', ephemeral: false,
    cliVersion: CODEX_APP_SERVER_START_CONTRACT.version,
    createdAt: 1, cwd, modelProvider: 'provider:test', preview: '', projectId: null,
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
    binding: { connectionAttemptId: 'connection-attempt:local-start',
      initializedConnectionDigest: sha256Digest('initialized-local-start'),
      threadStartRequestId: 10, turnStartRequestId: 20 }, timeoutMs: 1_000, cleanupMs: 100,
    open: () => {
      calls.push('open');
      const wire = {
        writeLine: async (line: string) => {
          const parsed = JSON.parse(line); written.push(parsed); calls.push(`write:${parsed.method}`);
        },
        readLine: async () => responses.shift(),
        close: async () => { calls.push('close'); },
      };
      return { ready: Promise.resolve(wire), async close() {} };
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
      recordCleanup: async (_thread, _turn, assertCurrent) => { calls.push('cleanup-receipt'); assertCurrent(); return 'recorded' as const; },
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
    'write:thread/start', 'thread-receipt', 'write:turn/start', 'turn-receipt', 'close', 'cleanup-receipt']);
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

test('fixed composition binds protected activation, workspace and durable start records', async () => {
  let saved = activationFixture();
  const intent = { schema: 'control-room.workspace-intent/v1' as const,
    tenantId: saved.activation.body.tenantId, nodeId: saved.activation.body.nodeId,
    projectId: saved.activation.body.projectId, jobId: saved.activation.body.jobId,
    attemptId: saved.activation.body.attemptId, runId: saved.activation.body.runId,
    leaseId: saved.activation.body.leaseId, leaseEpoch: saved.activation.body.leaseEpoch,
    repositoryRoot: '/synthetic/repository', workspaceRoot: '/synthetic/workspaces',
    checkoutPath: `/synthetic/workspaces/codex-${sha256Digest(saved.activation.body.runId).slice(7, 31)}`,
    revision: 'a'.repeat(40) };
  const { activationId: _activationId, activationDigest: _activationDigest, ...priorMaterial } = saved.activation.body;
  void _activationId; void _activationDigest;
  const material = { ...priorMaterial, workspacePath: intent.checkoutPath,
    workspaceIntentDigest: sha256Digest(intent) };
  const activationDigest = computeCodexTaskActivationDigestV1(material);
  const activation = { ...saved.activation, body: { ...material,
    activationId: `codex-activation:${activationDigest.slice(7)}`, activationDigest } };
  saved = { ...saved, activation } as typeof saved;
  const bridgeJournal = new SqliteBridgeJournal(':memory:');
  const startJournal = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  let clock = baseTime + 2_000, workspaceEffects = 0;
  const responses = [JSON.stringify({ id: 1, result: {} }), threadResponse(10, intent.checkoutPath), turnResponse(20)];
  const ownedStart = createCodexOwnedStartV1({ binding: { connectionAttemptId: 'connection-attempt:composed',
    initializedConnectionDigest: sha256Digest('composed'), threadStartRequestId: 10, turnStartRequestId: 20 },
  timeoutMs: 1_000, cleanupMs: 100, open: () => {
    const wire = { writeLine: async () => {}, readLine: async () => responses.shift(), close: async () => {} };
    return { ready: Promise.resolve(wire), async close() {} };
  } });
  const workspacePort = {
    inspectRootIdentities: async () => ({
      repository: { realPath: intent.repositoryRoot, device: '1', inode: '2' },
      workspace: { realPath: intent.workspaceRoot, device: '1', inode: '3' },
      commonGit: { realPath: `${intent.repositoryRoot}/.git`, device: '1', inode: '4' },
    }),
    inspectExisting: async (path: string) => ({ realPath: path, device: '1', inode: path === intent.repositoryRoot ? '2' : '3' }),
    observeCheckout: async () => ({ state: 'absent' as const }),
    createDetachedWorktree: async () => { workspaceEffects += 1; return {
      realPath: intent.checkoutPath, repositoryRealPath: intent.repositoryRoot,
      headRevision: intent.revision, device: '1', inode: '5',
    }; },
    removeWorktree: async () => { throw new Error('unexpected removal'); },
  };
  try {
    const runtime = createCodexLocalStartCompositionV1({ queueId: saved.activation.body.queueId,
      connectionAttemptId: 'connection-attempt:composed', initializedConnectionDigest: sha256Digest('composed'),
      threadStartRequestId: 10, turnStartRequestId: 20, workspaceIntent: intent,
      bridgeJournal: Object.assign(bridgeJournal, {
        acceptedCodexActivation: () => ({ frame: saved.activation, receivedAt: saved.activationReceivedAt }),
      }), startJournal, workspacePort,
      workspacePolicy: { allowedPaths: ['src/**'], maximumChangedFiles: 5, maximumChangedBytes: 4096 },
      authority: { assertCurrent: () => {}, currentAdmissionDigest: () => saved.currentAdmissionDigest },
      ownedStart, clock: () => clock++ });
    runtime.bindDelivery(sharedDelivery(saved));
    const result = await runtime.start();
    assert.equal(result.thread.threadId, 'thr_synthetic');
    assert.equal(result.turn.turnId, 'turn_synthetic');
    assert.equal(workspaceEffects, 1);
    assert.equal(bridgeJournal.workspaceIntentInventory()[0]?.creation?.realPath, intent.checkoutPath);
    const recorded = startJournal.load(intent.runId);
    assert.equal(recorded.status, 'recorded');
    assert.equal(recorded.threadId, result.thread.threadId);
    assert.equal(recorded.turnId, result.turn.turnId);
  } finally { startJournal.close(); bridgeJournal.close(); }
});

test('fixed composition refuses mismatched workspace intent before effects or start reservation', async () => {
  const saved = activationFixture();
  const bridgeJournal = new SqliteBridgeJournal(':memory:');
  const startJournal = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  let effects = 0, opens = 0, clock = baseTime + 2_000;
  const runId = saved.activation.body.runId;
  const intent = { schema: 'control-room.workspace-intent/v1' as const,
    tenantId: saved.activation.body.tenantId, nodeId: saved.activation.body.nodeId,
    projectId: saved.activation.body.projectId, jobId: 'job:different', attemptId: saved.activation.body.attemptId,
    runId, leaseId: saved.activation.body.leaseId, leaseEpoch: saved.activation.body.leaseEpoch,
    repositoryRoot: '/synthetic/repository', workspaceRoot: '/synthetic/workspaces',
    checkoutPath: `/synthetic/workspaces/codex-${sha256Digest(runId).slice(7, 31)}`, revision: 'a'.repeat(40) };
  try {
    const runtime = createCodexLocalStartCompositionV1({ queueId: saved.activation.body.queueId,
      connectionAttemptId: 'connection-attempt:composed-mismatch', initializedConnectionDigest: sha256Digest('composed-mismatch'),
      threadStartRequestId: 10, turnStartRequestId: 20, workspaceIntent: intent,
      bridgeJournal: Object.assign(bridgeJournal, {
        acceptedCodexActivation: () => ({ frame: saved.activation, receivedAt: saved.activationReceivedAt }),
      }), startJournal,
      workspacePolicy: { allowedPaths: ['src/**'], maximumChangedFiles: 5, maximumChangedBytes: 4096 },
      workspacePort: { inspectRootIdentities: async () => { effects += 1; throw new Error(); },
        observeCheckout: async () => { effects += 1; throw new Error(); },
        inspectExisting: async () => { effects += 1; throw new Error(); },
        createDetachedWorktree: async () => { effects += 1; throw new Error(); },
        removeWorktree: async () => { effects += 1; } },
      authority: { assertCurrent: () => {}, currentAdmissionDigest: () => saved.currentAdmissionDigest },
      ownedStart: createCodexOwnedStartV1({ binding: { connectionAttemptId: 'connection-attempt:composed-mismatch',
        initializedConnectionDigest: sha256Digest('composed-mismatch'), threadStartRequestId: 10, turnStartRequestId: 20 },
        timeoutMs: 1_000, cleanupMs: 100, open: () => { opens += 1; throw new Error(); } }),
      clock: () => clock++ });
    assert.throws(() => runtime.bindDelivery(sharedDelivery(saved)), /unavailable/);
    await assert.rejects(runtime.start(), /unavailable/);
    assert.equal(effects, 0); assert.equal(opens, 0);
    assert.equal(startJournal.load(runId).status, 'not_reserved');
  } finally { startJournal.close(); bridgeJournal.close(); }
});
