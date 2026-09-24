import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCodexLocalHostV1 } from '../src/harness/codex-v1/local-host';
import type { CodexLocalInitialHostInputV1, CodexLocalRecoverHostInputV1 } from '../src/harness/codex-v1/local-host';
import { createCodexWorkerCompositionV1 } from '../src/node-bridge/codex-worker-composition';
import { createCodexPhysicalQualificationReceiptBodyV1 } from '../src/harness/codex-v1/result-publication-contract';
import { buildCodexTaskActivationV1, CODEX_ACTIVATION_FEATURE } from '../src/harness/codex-v1/activation-contract';
import { CODEX_START_OPERATION, codexTaskDispatchBodySchemaV1,
  codexTaskPayloadDigestV1, codexTaskRunIdV1 } from '../src/harness/codex-v1/delivery-contract';
import { CODEX_APP_SERVER_READ_CONTRACT,
  CODEX_APP_SERVER_START_CONTRACT, CODEX_APP_SERVER_RESULT_CONTRACT } from '../src/harness/codex-v1/schema-contract';
import { SqliteCodexStartJournalV1 } from '../src/harness/codex-v1/start-journal';
import { CodexActivationIntakeHandlerV1 } from '../src/node-bridge/codex-activation-handler';
import { CodexDispatchIntakeHandlerV1 } from '../src/node-bridge/codex-dispatch-handler';
import { PortableNodeBridge } from '../src/node-bridge/bridge';
import { SqliteBridgeJournal } from '../src/node-bridge/journal';
import { consumePrivateCodexSessionCapabilityV1, createPrivateCodexSessionOwnerV1,
  PRIVATE_CODEX_SESSION_CAPABILITY_V1 } from '../src/node-bridge/private-codex-session-owner';
import { createPrivateCodexInstalledNodeEntryV1 } from '../src/node-bridge/private-codex-installed-node-entry';
import { PinnedApprovalTrustStore } from '../src/node-policy/v1/pinned-approval-trust';
import { PinnedOwnerTrust } from '../src/node-policy/v1/owner-pins';
import { SqliteNodeSecurityStateRepository } from '../src/node-policy/v1/persistent-security-state';
import { EncryptedFileNodePrivateKeyStore, InjectedUnwrapSecretSource,
  sealEncryptedPrivateKey } from '../src/node-policy/v1/encrypted-file-key-store';
import { computeArtifactBodyDigest, signArtifact } from '../src/node-policy/v1/crypto';
import { computeEffectClaimKey } from '../src/node-policy/v1/effect-claim';
import { computeNormalizedOperationDigest } from '../src/node-policy/v1/policy-evaluator';
import { NODE_PROTOCOL_V1, NodeProtocolAuthenticator, signNodeFrame,
  type UnsignedNodeFrame } from '../src/node-protocol/v1';
import { sha256Digest } from '../src/security/canonical-digest';
import { CODEX_CURRENT_ADMISSION_READ_FEATURE_V1 } from '../src/harness/codex-v1/current-admission-read-contract';
import { codexApprovalPacketDigestV1 } from '../src/web/v1/codex-task-queue';
import { createControllerWorkerDeliveryV1 } from '../src/harness/v1/controller-worker-delivery';

const baseTime = Date.parse('2026-09-13T12:00:00.000Z');
const deadline = baseTime + 60_000;
const admissionDigest = sha256Digest('codex-host-current-admission');
let fixtureSequence = 0;

function intent() {
  const runId = codexTaskRunIdV1({ tenantId: 'tenant:test', nodeId: 'node:test', projectId: 'project:test',
    jobId: 'job:test', attemptId: 'attempt:test', leaseId: 'lease:test', leaseEpoch: 1 });
  return { schema: 'control-room.workspace-intent/v1' as const,
    tenantId: 'tenant:test', projectId: 'project:test', nodeId: 'node:test', jobId: 'job:test',
    attemptId: 'attempt:test', runId, leaseId: 'lease:test', leaseEpoch: 1,
    repositoryRoot: '/synthetic/repository', workspaceRoot: '/synthetic/workspaces',
    checkoutPath: `/synthetic/workspaces/codex-${sha256Digest(runId).slice(7, 31)}`,
    revision: 'a'.repeat(40) };
}

async function portableActivation(recordActivation = true, keepConnected = false) {
  const fixtureId = ++fixtureSequence;
  const workspaceIntent = intent();
  const approval = generateKeyPairSync('ed25519'), server = generateKeyPairSync('ed25519');
  const node = generateKeyPairSync('ed25519');
  const approvalSpki = approval.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const serverSpki = server.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const start = { schema: 'control-room.codex-task-start/v1' as const,
    tenantId: workspaceIntent.tenantId, nodeId: workspaceIntent.nodeId, projectId: workspaceIntent.projectId,
    jobId: workspaceIntent.jobId, attemptId: workspaceIntent.attemptId, runId: workspaceIntent.runId,
    leaseId: workspaceIntent.leaseId, leaseEpoch: workspaceIntent.leaseEpoch,
    effectClaimKey: sha256Digest('placeholder-effect'), operationDigest: sha256Digest('placeholder-operation'),
    inputDigest: sha256Digest({ prompt: 'Inspect exactly once', instructions: 'Return bounded evidence' }),
    enrollmentDigest: sha256Digest('enrollment'), connectorProfileDigest: sha256Digest('profile'),
    workspaceIntentDigest: sha256Digest(workspaceIntent), prompt: 'Inspect exactly once',
    instructions: 'Return bounded evidence', deadline };
  const request = { contractVersion: 'control-room-node-policy/v1' as const,
    requestId: 'request:codex-host', tenantId: start.tenantId, nodeId: start.nodeId,
    nodeClass: 'personal-compute', projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, leaseId: start.leaseId, leaseEpoch: start.leaseEpoch,
    executorId: 'executor:codex', operationId: CODEX_START_OPERATION, operationDigest: '',
    payloadDigest: codexTaskPayloadDigestV1(start, sha256Digest('authority')),
    authorityDigest: sha256Digest('authority'), credentialRefs: ['credential:codex'],
    target: { kind: 'filesystem' as const, canonicalPath: workspaceIntent.checkoutPath }, risk: 'low' as const,
    externalEffect: true, estimatedDurationSeconds: 60, occurredAt: new Date(baseTime).toISOString() };
  request.operationDigest = computeNormalizedOperationDigest(request);
  start.operationDigest = request.operationDigest; start.effectClaimKey = computeEffectClaimKey(request);
  const permitBody = { schema: 'control-room.owner-approval-attestation/v1' as const,
    tenantId: start.tenantId, nodeId: start.nodeId, projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, operationDigest: request.operationDigest, risk: 'low' as const,
    decision: 'approved' as const, issuedAt: new Date(baseTime).toISOString(),
    expiresAt: new Date(deadline).toISOString(), nonce: 'c3ludGhldGljLWNvZGV4LWhvc3Q',
    approvalKeyId: 'approval-key:test' };
  const permit = signArtifact({ ...permitBody, bodyDigest: computeArtifactBodyDigest(permitBody) }, approval.privateKey);
  const body = codexTaskDispatchBodySchemaV1.parse({ schema: 'control-room.codex-task-dispatch/v1',
    queueId: `native-queue:${sha256Digest({ tenantId: start.tenantId, jobId: start.jobId,
      attemptId: start.attemptId }).slice(7)}`,
    start, request, permit, permitDigest: sha256Digest(permit) });
  const journal = new SqliteBridgeJournal(':memory:');
  const approvals = { binding: () => ({ tenantId: start.tenantId, nodeId: start.nodeId,
    nodeClass: 'personal-compute' }), assertAvailable() {}, async resolveApprovalKey(keyId: string) {
    return keyId === permitBody.approvalKeyId ? new Uint8Array(Buffer.from(approvalSpki, 'base64url')) : undefined;
  } } as unknown as PinnedApprovalTrustStore;
  let clock = baseTime + 1_000;
  const dispatchHandler = new CodexDispatchIntakeHandlerV1({ enrollmentDigest: start.enrollmentDigest,
    connectorProfileDigest: start.connectorProfileDigest, workspaceIntentDigest: start.workspaceIntentDigest },
  journal, { approvals, security: { currentServerTrustRevision: () => 'trust-revision:1' } }, () => clock);
  const activationHandler = new CodexActivationIntakeHandlerV1(journal, {
    currentAdmissionDigest: () => admissionDigest, assertCurrent() {},
  }, () => clock);
  const sent: string[] = [];
  const features = ['harness.codex.dispatch.v1', CODEX_ACTIVATION_FEATURE, CODEX_CURRENT_ADMISSION_READ_FEATURE_V1];
  let id = 0;
  const bridge = new PortableNodeBridge({ tenantId: start.tenantId, nodeId: start.nodeId,
    keyId: 'node-key:test', features }, journal,
  { async sign(frame) { return signNodeFrame(frame, node.privateKey); } },
  new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: 'ed25519',
    publicKeySpki: serverSpki, state: 'active', principalState: 'active',
    validFrom: new Date(baseTime - 1_000).toISOString() }; } }, journal, { async consume() {} }),
  () => `codex-host-bridge-${++id}`, undefined, undefined, dispatchHandler, activationHandler);
  let admissionResponder: ((request: Record<string, unknown>) => void) | undefined;
  const transport = { async send(value: string) {
    sent.push(value); const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.type === 'harness.codex.current-admission.read') admissionResponder?.(parsed);
  }, async close() {} };
  const at = new Date(clock).toISOString();
  await bridge.open(transport, { now: at, transportIdentity: 'transport:codex-host' });
  const hello = JSON.parse(sent[0]!) as { messageId: string; connectionId: string };
  const frame = (sequence: number, type: UnsignedNodeFrame['type'], frameBody: UnsignedNodeFrame['body'],
    sentAt = at, causationId?: string) => signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
      messageId: `message:codex-host:${sequence}`, correlationId: 'correlation:codex-host',
      ...(causationId ? { causationId } : sequence === 1 ? { causationId: hello.messageId } : {}),
      tenantId: start.tenantId, actorId: 'control-room:test', senderKind: 'control_room',
      keyId: 'server-key:test', connectionId: hello.connectionId, sequence, sentAt,
      expiresAt: new Date(deadline).toISOString(), nonce: `synthetic_codex_host_nonce_${sequence}_123456789`,
      type, body: frameBody } as UnsignedNodeFrame, server.privateKey);
  await bridge.receive(JSON.stringify(frame(1, 'connection.accepted', { selectedProtocol: NODE_PROTOCOL_V1,
    enabledFeatures: features, maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30, serverTime: at })), at);
  await bridge.receive(JSON.stringify(frame(2, 'node.reconciliation.request', {
    lastAcknowledgedNodeSequence: 1, requestedAttemptIds: [] })), at);
  const dispatch = frame(3, 'harness.codex.dispatch', body);
  await bridge.receive(JSON.stringify(dispatch), at);
  const receipt = sent.map(value => JSON.parse(value)).find(value => value.type === 'harness.codex.dispatch.receipt');
  assert.ok(receipt);
  clock = baseTime + 2_000;
  const activatedAt = new Date(clock).toISOString(), receiptReceivedAt = new Date(clock - 100).toISOString();
  const activationBody = buildCodexTaskActivationV1({ dispatch: dispatch as never, receipt,
    currentAdmissionDigest: admissionDigest, receiptReceivedAt, activatedAt,
    activationExpiresAt: new Date(deadline).toISOString() });
  const activation = frame(4, 'harness.codex.dispatch.activation', activationBody, activatedAt, receipt.messageId);
  if (recordActivation) {
    await bridge.receive(JSON.stringify(activation), activatedAt);
    await bridge.receive(JSON.stringify(activation), activatedAt);
    assert.equal(journal.acceptedCodexActivation(body.queueId)?.frame.body.runId, workspaceIntent.runId);
  }
  const closeBridge = async () => {
    await bridge.disconnected(); dispatchHandler.close(); activationHandler.close();
  };
  if (!keepConnected) await closeBridge();
  return { journal, body, workspaceIntent, activation, approval, server, node,
    bridge, closeBridge, setAdmissionResponder(value: (request: Record<string, unknown>) => void) {
      admissionResponder = value;
    }, sent, connectionAttemptId: `connection-attempt:codex-host:${fixtureId}`, clock: () => ++clock };
}

function sharedDelivery(f: Awaited<ReturnType<typeof portableActivation>>) {
  const activation = f.activation.body;
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: activation.tenantId, nodeId: activation.nodeId, projectId: activation.projectId,
      jobId: activation.jobId, attemptId: activation.attemptId, runId: activation.runId },
    worker: { workerId: 'worker:codex-local', adapterId: 'codex-app-server/v1', adapterRevision: 'source-test' },
    input: { prompt: activation.prompt, instructions: activation.instructions },
    authorityDigest: sha256Digest('controller-authority'), connectorProfileDigest: activation.connectorProfileDigest,
    acceptanceProfileId: 'profile:codex', acceptanceProfileDigest: sha256Digest('acceptance'),
    issuedAt: new Date(baseTime).toISOString(), expiresAt: new Date(deadline).toISOString(),
  });
}

function currentAdmissionRequest(f: Awaited<ReturnType<typeof portableActivation>>) {
  const start = f.activation.body;
  return { schema: 'control-room.codex-current-admission-read-request/v1' as const,
    queueId: start.queueId, projectId: start.projectId, jobId: start.jobId, attemptId: start.attemptId,
    nodeId: start.nodeId, inputDigest: start.inputDigest, packetDigest: codexApprovalPacketDigestV1(f.body),
    activationFrameDigest: sha256Digest(f.activation), currentAdmissionDigest: start.currentAdmissionDigest,
    challengeNonce: 'A'.repeat(43), startsWork: false as const, grantsExecutionAuthority: false as const };
}

function currentAdmissionResponse(f: Awaited<ReturnType<typeof portableActivation>>,
  request: ReturnType<typeof signNodeFrame>, change: { causationId?: string; expiresAt?: string } = {}) {
  const body = request.body as ReturnType<typeof currentAdmissionRequest>;
  const checkedAt = new Date(baseTime + 3_000).toISOString();
  const responseBody = { schema: 'control-room.codex-current-admission-read-response/v1' as const,
    queueId: body.queueId, projectId: body.projectId, jobId: body.jobId, attemptId: body.attemptId,
    nodeId: body.nodeId, requestMessageId: request.messageId, requestBodyDigest: request.bodyDigest,
    challengeNonce: body.challengeNonce, activationFrameDigest: body.activationFrameDigest,
    currentAdmissionDigest: body.currentAdmissionDigest, ownerTrustRevisionDigest: sha256Digest('owner-trust:test'),
    checkedAt, expiresAt: change.expiresAt ?? new Date(baseTime + 20_000).toISOString(),
    startsWork: false as const, grantsExecutionAuthority: false as const };
  return signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node', senderKind: 'control_room',
    tenantId: 'tenant:test', actorId: 'control-room:test', keyId: 'server-key:test',
    connectionId: request.connectionId, sequence: 5, messageId: 'message:current-admission-response',
    correlationId: request.correlationId, causationId: change.causationId ?? request.messageId,
    sentAt: checkedAt, expiresAt: responseBody.expiresAt,
    nonce: 'current_admission_response_nonce_123456789',
    type: 'harness.codex.current-admission.read.response', body: responseBody }, f.server.privateKey);
}

const threadResponse = (id: number, cwd: string) => JSON.stringify({ id, result: {
  approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd, model: 'model:test',
  modelProvider: 'provider:test', sandbox: { type: 'readOnly' }, instructionSources: [],
  thread: { id: 'thread:durable-host', sessionId: 'thread:durable-host', ephemeral: false,
    cliVersion: CODEX_APP_SERVER_START_CONTRACT.version, createdAt: 1, cwd,
    modelProvider: 'provider:test', preview: '', projectId: null, source: 'appServer',
    status: { type: 'idle' }, turns: [], updatedAt: 1 } } });
const turnResponse = (id: number) => JSON.stringify({ id, result: {
  turn: { id: 'turn:durable-host', status: 'inProgress', items: [] } } });

function workspacePort(workspaceIntent: ReturnType<typeof intent>, effects: string[]) {
  return { inspectRootIdentities: async () => ({
    repository: { realPath: workspaceIntent.repositoryRoot, device: '1', inode: '2' },
    workspace: { realPath: workspaceIntent.workspaceRoot, device: '1', inode: '3' },
    commonGit: { realPath: `${workspaceIntent.repositoryRoot}/.git`, device: '1', inode: '4' } }),
  inspectExisting: async (path: string) => ({ realPath: path, device: '1', inode: '2' }),
  observeCheckout: async () => ({ state: 'absent' as const }),
  createDetachedWorktree: async () => { effects.push('create-workspace'); return {
    realPath: workspaceIntent.checkoutPath, repositoryRealPath: workspaceIntent.repositoryRoot,
    headRevision: workspaceIntent.revision, device: '1', inode: '5' }; },
  removeWorktree: async () => { effects.push('remove-workspace'); } };
}

function startHost(f: Awaited<ReturnType<typeof portableActivation>>, starts: SqliteCodexStartJournalV1,
  options: { revoked?: () => boolean; write?: (line: string) => Promise<void>; close?: () => Promise<void> } = {}) {
  const effects: string[] = [], sent: string[] = [];
  const responses = ['{"id":1,"result":{}}', threadResponse(10, f.workspaceIntent.checkoutPath), turnResponse(20)];
  let opened = 0, closed = 0;
  const authority = { currentAdmissionDigest: () => admissionDigest,
    assertCurrent() { if (options.revoked?.()) throw new Error('revoked'); } };
  const input: CodexLocalInitialHostInputV1 = { mode: 'initial', runId: f.workspaceIntent.runId,
    queueId: f.body.queueId, connectionAttemptId: f.connectionAttemptId,
    initializedConnectionDigest: sha256Digest('codex-host-initialized'), threadStartRequestId: 10,
    turnStartRequestId: 20, workspaceIntent: f.workspaceIntent, bridgeJournal: f.journal,
    startJournal: starts, authority, workspacePort: workspacePort(f.workspaceIntent, effects),
    workspacePolicy: { allowedPaths: ['src/**'], maximumChangedFiles: 5, maximumChangedBytes: 4096 },
    acquireProcess(binding) {
      opened++; assert.equal(binding.mode, 'initial');
      assert.equal(binding.connectionAttemptId, f.connectionAttemptId);
      assert.equal(binding.initializedConnectionDigest, sha256Digest('codex-host-initialized'));
      let resolveExit!: (value: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { resolveExit = resolve; });
      let resolveStdoutEnd!: (value: undefined) => void;
      const stdoutEnd = new Promise<undefined>(resolve => { resolveStdoutEnd = resolve; });
      return { ready: Promise.resolve({ async writeStdin(bytes) {
        const line = new TextDecoder().decode(bytes); sent.push(JSON.parse(line).method); await options.write?.(line);
      }, async readStdout() { const line = responses.shift();
        return line === undefined ? stdoutEnd : new TextEncoder().encode(`${line}\n`); },
      async readStderr() { return undefined; }, async closeStdin() {},
      async terminate() { resolveStdoutEnd(undefined); resolveExit({ code: null, signal: 'SIGTERM' }); }, exited }),
      async close() { closed++; await options.close?.(); } };
    },
    startTimeoutMs: 1_000, processCleanupTimeoutMs: 100, clock: f.clock };
  const host = createCodexLocalHostV1(input);
  if (host.mode === 'initial') host.bindDelivery(sharedDelivery(f));
  return { input, host, effects, sent, opened: () => opened, closed: () => closed };
}

function recoverHost(starts: SqliteCodexStartJournalV1, rawResult: unknown,
  options: { revoked?: boolean; close?: () => Promise<void> } = {}) {
  let opened = 0, closed = 0, reads = 0;
  const responses = ['{"id":1,"result":{}}', JSON.stringify({ id: 2, result: rawResult })];
  const input: CodexLocalRecoverHostInputV1 = { mode: 'recover', runId: intent().runId, startJournal: starts,
    connectionAttemptId: 'connection-attempt:codex-host-recover',
    initializedConnectionDigest: sha256Digest('codex-host-recover-initialized'),
    authority: { assertCurrent() { if (options.revoked) throw new Error('revoked'); } },
    acquireProcess(binding) {
      opened++; assert.equal(binding.mode, 'recover'); assert.equal(binding.threadId, 'thread:durable-host');
      assert.equal(binding.connectionAttemptId, 'connection-attempt:codex-host-recover');
      let resolveExit!: (value: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { resolveExit = resolve; });
      let resolveStdoutEnd!: (value: undefined) => void;
      const stdoutEnd = new Promise<undefined>(resolve => { resolveStdoutEnd = resolve; });
      return { ready: Promise.resolve({ async writeStdin(bytes) {
        const request = JSON.parse(new TextDecoder().decode(bytes)); if (request.method === 'thread/read') {
          assert.deepEqual(request.params, { threadId: 'thread:durable-host', includeTurns: true });
        }
      }, async readStdout() { const line = responses[reads++];
        return line === undefined ? stdoutEnd : new TextEncoder().encode(`${line}\n`); },
      async readStderr() { return undefined; }, async closeStdin() {},
      async terminate() { resolveStdoutEnd(undefined); resolveExit({ code: null, signal: 'SIGTERM' }); }, exited }),
      async close() { closed++; await options.close?.(); } };
    }, readTimeoutMs: 1_000, cleanupTimeoutMs: 200, processCleanupTimeoutMs: 100 };
  const host = createCodexLocalHostV1(input);
  return { input, host, opened: () => opened, closed: () => closed };
}

function completedResult(items: unknown[], itemsView: 'full' | 'summary' = 'full') {
  return { thread: { id: 'thread:durable-host', cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
    turns: [{ id: 'turn:durable-host', status: 'completed', itemsView, items }] } };
}

function workerQualification() {
  const keys = generateKeyPairSync('ed25519');
  const evidence = <T extends object>(material: T) => ({ ...material, evidenceDigest: sha256Digest(material) });
  const body = createCodexPhysicalQualificationReceiptBodyV1({
    schema: 'control-room.codex-physical-qualification-receipt/v1', qualificationId: 'qualification:test',
    qualificationSignerKeyId: 'qualification-key:test', tenantId: 'tenant:test', nodeId: 'node:test',
    connectorProfileId: 'profile:codex:test', connectorProfileDigest: sha256Digest('profile'),
    exactPackage: { adapterId: 'codex-app-server/v1', packageName: CODEX_APP_SERVER_READ_CONTRACT.package,
      packageVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
      generatedSchemaBundleSha256: CODEX_APP_SERVER_READ_CONTRACT.generatedBundleSha256,
      threadStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.paramsSchemaSha256,
      threadStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256,
      turnStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.paramsSchemaSha256,
      turnStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256,
      threadReadResponseSchemaSha256: CODEX_APP_SERVER_RESULT_CONTRACT.threadReadResponseSchemaSha256,
      agentMessageSourceSha256: CODEX_APP_SERVER_RESULT_CONTRACT.agentMessageSourceSha256 },
    qualifiedAt: new Date(baseTime - 60_000).toISOString(),
    start: evidence({ evidenceId: 'evidence:start', processAttemptId: 'process:start',
      connectionAttemptId: 'connection:start', initializedConnectionDigest: sha256Digest('init:start'),
      threadId: 'thread:qualification', turnId: 'turn:qualification', startObserved: true, cleanupVerified: true }),
    restartRead: evidence({ evidenceId: 'evidence:restart', processAttemptId: 'process:restart',
      connectionAttemptId: 'connection:restart', initializedConnectionDigest: sha256Digest('init:restart'),
      threadId: 'thread:qualification', turnId: 'turn:qualification', itemId: 'item:qualification',
      restartObserved: true, exactReadObserved: true, cleanupVerified: true }),
    oneFreshProcessPerAttempt: true, sameDurableThreadObserved: true, sameDurableTurnObserved: true,
    terminalCleanupVerified: true, processReuseObserved: false, retryObserved: false,
    canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
    permitsRetry: false, permitsResume: false, permitsThreadRead: false,
  });
  return { qualificationReceipt: signArtifact(body, keys.privateKey),
    qualificationPublicKeySpki: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    qualificationMaximumAgeMs: 120_000 };
}

test('legacy worker composition cannot bypass the shared delivery binding', async t => {
  const f = await portableActivation(), starts = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  t.after(() => { starts.close(); f.journal.close(); });
  const initial = startHost(f, starts), recovery = recoverHost(starts, completedResult([
    { type: 'agentMessage', id: 'item:final', phase: 'final_answer', text: 'Worker result.' },
  ]));
  let sends = 0;
  const configuration: Parameters<typeof createCodexWorkerCompositionV1>[0] = { initial: initial.input, recovery: recovery.input,
    binding: { tenantId: 'tenant:test', nodeId: 'node:test', enrollmentDigest: sha256Digest('enrollment'),
      connectorProfileDigest: sha256Digest('profile'), activationFrameDigest: sha256Digest(f.activation) },
    assertSessionCurrent() {}, result: { ...workerQualification(), bridgeEvidence: f.journal,
      bridge: { async sendCodexResultReturn(queueId, body) {
        sends++;
        assert.equal(queueId, f.body.queueId);
        assert.equal(body.identity.runId, f.workspaceIntent.runId);
        assert.equal(body.publication.result.text, 'Worker result.');
        // Transport receipt authentication belongs to PortableNodeBridge and
        // is independently covered by codex-result-sender.test.ts.
        return { testReceipt: true } as never;
      } },
    } };
  const worker = createCodexWorkerCompositionV1(configuration);
  assert.equal(initial.opened(), 0); assert.equal(recovery.opened(), 0); assert.equal(sends, 0);
  await assert.rejects(worker.start(new AbortController().signal), /codex_local_host_unavailable/);
  await assert.rejects(worker.start(new AbortController().signal), /unavailable/);
  assert.equal(initial.opened(), 0); assert.deepEqual(initial.effects, []);
  const reconstructed = createCodexWorkerCompositionV1(configuration);
  await assert.rejects(reconstructed.start(new AbortController().signal), /unavailable/);
  assert.equal(initial.opened(), 0, 'an unbound legacy composition cannot acquire a process');
  await reconstructed.close();
  assert.equal(sends, 0);
  await worker.close();
});

test('private Codex session owner mints one capability only from reconciled bridge and journal evidence', async t => {
  const f = await portableActivation(true, true);
  t.after(async () => { await f.closeBridge(); f.journal.close(); });
  let admission = admissionDigest, trustRevision = 'trust-revision:1', revoked = false;
  const owner = createPrivateCodexSessionOwnerV1({ bridge: f.bridge, journal: f.journal,
    currentPolicy: {
      currentAdmissionDigest() { return admission; },
      currentServerTrustRevision() { return trustRevision; },
      assertCurrent() { if (revoked) throw new Error('revoked'); },
    },
    clock: () => baseTime + 3_000,
  });
  assert.equal(owner.schema, 'control-room.private-codex-session-owner/v1');
  assert.equal(owner.startsWork, false);
  const minted = owner.mint(f.body.queueId);
  assert.equal(minted.schema, PRIVATE_CODEX_SESSION_CAPABILITY_V1);
  assert.equal(minted.binding.tenantId, 'tenant:test');
  assert.equal(minted.binding.nodeId, 'node:test');
  assert.equal(minted.binding.enrollmentDigest, sha256Digest('enrollment'));
  assert.throws(() => owner.mint(f.body.queueId), /private_codex_session_owner_unavailable/,
    'a queue/session is burned at mint even before its capability is consumed');
  const session = consumePrivateCodexSessionCapabilityV1(minted.capability);
  session.assertCurrent();
  trustRevision = 'trust-revision:2';
  assert.throws(() => session.assertCurrent(), /private_codex_session_owner_unavailable/,
    'a changed protected trust state invalidates the captured session');
  assert.throws(() => consumePrivateCodexSessionCapabilityV1(minted.capability), /private_codex_session_owner_unavailable/,
    'a capability cannot be replayed');
  revoked = true;
  assert.throws(() => owner.mint(f.body.queueId), /private_codex_session_owner_unavailable/,
    'minting rechecks the protected revocation fence');
  revoked = false;
  admission = sha256Digest('other-admission');
  assert.throws(() => owner.mint(f.body.queueId), /private_codex_session_owner_unavailable/,
    'a stale current-admission digest cannot mint a session');
});

test('private Codex session owner rejects structural fake bridge/journal inputs', () => {
  assert.throws(() => createPrivateCodexSessionOwnerV1({
    bridge: { codexActivationChannel() { return { assertCurrent() {} }; } } as never,
    journal: { acceptedCodexDelivery() {}, acceptedCodexActivation() {} } as never,
    currentPolicy: { currentAdmissionDigest() { return admissionDigest; }, currentServerTrustRevision() { return 'trust-revision:1'; },
      assertCurrent() {} },
    clock: () => baseTime,
  }), /private_codex_session_owner_unavailable/);
});

test('installed Codex node entry turns one signed current read into one bound session capability', async t => {
  const f = await portableActivation(true, true);
  const directory = await mkdtemp(join(tmpdir(), 'cr-codex-installed-entry-'));
  const root = generateKeyPairSync('ed25519');
  const rootSpki = root.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const rootPin = { keyId: 'owner-root:test', algorithm: 'ed25519' as const, spki: rootSpki,
    fingerprint: `sha256:${createHash('sha256').update(Buffer.from(rootSpki, 'base64url')).digest('hex')}` };
  const security = new SqliteNodeSecurityStateRepository({ artifactDatabasePath: join(directory, 'artifacts.db'),
    highWaterDatabasePath: join(directory, 'water.db') },
  { tenantId: 'tenant:test', nodeId: 'node:test', nodeClass: 'personal-compute' },
  new PinnedOwnerTrust({ ceilingProvisioningKey: rootPin, serverTrustRootKey: rootPin,
    trustShrinkKeys: [rootPin] }), { now: () => new Date(baseTime + 3_000).toISOString() });
  const trustBody = { schema: 'control-room.server-trust-bundle/v1' as const, tenantId: 'tenant:test',
    nodeClass: 'personal-compute', epoch: 1, issuedAt: new Date(baseTime).toISOString(),
    ownerRootKeyId: rootPin.keyId, keys: [{ keyId: 'server-key:test', algorithm: 'ed25519' as const,
      spki: f.server.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), state: 'active' as const }] };
  await security.provisionInitialTrustBundle(signArtifact({ ...trustBody,
    bodyDigest: computeArtifactBodyDigest(trustBody) }, root.privateKey));
  const approvalSpki = f.approval.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const approvals = new PinnedApprovalTrustStore({ schema: 'control-room.owner-approval-pins/v1',
    tenantId: 'tenant:test', nodeId: 'node:test', nodeClass: 'personal-compute',
    validFrom: baseTime, validUntil: deadline,
    keys: [{ keyId: 'approval-key:test', algorithm: 'ed25519', spki: approvalSpki,
      fingerprint: `sha256:${createHash('sha256').update(Buffer.from(approvalSpki, 'base64url')).digest('hex')}` }] },
  { security, clock: () => baseTime + 3_000 });
  const reference = { contractVersion: 'control-room-node-policy/v1' as const,
    keyId: 'node-key:test', referenceId: 'key-reference:test', provider: 'encrypted_file' as const,
    mode: 'encrypted_file' as const, algorithm: 'Ed25519' as const };
  const wrappingKey = Buffer.alloc(32, 7), envelope = sealEncryptedPrivateKey({ privateKey: f.node.privateKey,
    reference, wrappingKey });
  const keys = new EncryptedFileNodePrivateKeyStore(reference,
    { now: () => new Date(baseTime + 3_000).toISOString() },
    { async availability() { return 'available' as const; }, async load() { return envelope; } },
    new InjectedUnwrapSecretSource('platform_secret', async () => Uint8Array.from(wrappingKey)));
  await keys.unlock();
  t.after(async () => { approvals.close(); security.close(); await keys.dispose(); await f.closeBridge(); f.journal.close();
    await rm(directory, { recursive: true, force: true }); });

  assert.throws(() => createPrivateCodexInstalledNodeEntryV1({ bridge: f.bridge, journal: f.journal,
    security, approvals, keys: { reference: () => reference,
      async sign(bytes: Uint8Array) { return new Uint8Array(cryptoSign(null, Buffer.from(bytes), f.node.privateKey)); } } as never,
    clock: () => baseTime + 3_000 }), /private_codex_installed_node_entry_unavailable/,
  'a fake signing port is rejected even when every other protected input is genuine');

  const entry = createPrivateCodexInstalledNodeEntryV1({ bridge: f.bridge, journal: f.journal,
    security, approvals, keys, clock: () => baseTime + 3_000 });
  assert.equal(entry.startsWork, false); assert.equal(entry.grantsExecutionAuthority, false);
  f.setAdmissionResponder(requestValue => {
    const request = requestValue as unknown as ReturnType<typeof signNodeFrame>;
    const requestBody = request.body as Record<string, string>;
    const responseBody = { schema: 'control-room.codex-current-admission-read-response/v1' as const,
      queueId: requestBody.queueId, projectId: requestBody.projectId,
      jobId: requestBody.jobId, attemptId: requestBody.attemptId,
      nodeId: requestBody.nodeId, requestMessageId: request.messageId,
      requestBodyDigest: request.bodyDigest, challengeNonce: requestBody.challengeNonce,
      activationFrameDigest: requestBody.activationFrameDigest,
      currentAdmissionDigest: requestBody.currentAdmissionDigest,
      ownerTrustRevisionDigest: sha256Digest('owner-trust:test'),
      checkedAt: new Date(baseTime + 3_000).toISOString(), expiresAt: new Date(baseTime + 20_000).toISOString(),
      startsWork: false as const, grantsExecutionAuthority: false as const };
    const response = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
      senderKind: 'control_room', tenantId: 'tenant:test', actorId: 'control-room:test', keyId: 'server-key:test',
      connectionId: request.connectionId, sequence: 5, messageId: 'message:installed-entry-response',
      correlationId: request.correlationId, causationId: request.messageId,
      sentAt: responseBody.checkedAt, expiresAt: responseBody.expiresAt,
      nonce: 'installed_entry_response_nonce_1234567890',
      type: 'harness.codex.current-admission.read.response', body: responseBody }, f.server.privateKey);
    queueMicrotask(() => { void f.bridge.receive(JSON.stringify(response), responseBody.checkedAt); });
  });
  const admitted = await entry.exchange(f.body.queueId, new AbortController().signal);
  await assert.rejects(entry.exchange(f.body.queueId, new AbortController().signal),
    /private_codex_installed_node_entry_unavailable/,
    'completed exchange is burned instead of silently duplicated');
  assert.equal(admitted.startsWork, false); assert.equal(admitted.grantsExecutionAuthority, false);
  assert.equal(admitted.binding.tenantId, 'tenant:test'); assert.equal(admitted.binding.nodeId, 'node:test');
  const session = consumePrivateCodexSessionCapabilityV1(admitted.sessionCapability);
  session.assertCurrent();
  assert.throws(() => consumePrivateCodexSessionCapabilityV1(admitted.sessionCapability),
    /private_codex_session_owner_unavailable/, 'installed session capability is one-use');
});

test('installed Codex node entry rejects structural authority substitutes before issuing', () => {
  assert.throws(() => createPrivateCodexInstalledNodeEntryV1({
    bridge: { codexActivationChannel() {} }, journal: {}, security: {}, approvals: {}, keys: {
      reference() {}, async sign() { return new Uint8Array(); } },
  } as never), /private_codex_installed_node_entry_unavailable/);
});

test('bridge-owned Codex admission exchange rejects cross-causation, stale, duplicate and oversized responses', async t => {
  await t.test('altered queue binding before send', async t => {
    const f = await portableActivation(true, true);
    t.after(async () => { await f.closeBridge(); f.journal.close(); });
    await assert.rejects(f.bridge.exchangeCodexCurrentAdmission({ ...currentAdmissionRequest(f), jobId: 'job:other' },
      new Date(baseTime + 3_000).toISOString(), new Date(baseTime + 20_000).toISOString(),
      new AbortController().signal, 50));
    assert.equal(f.sent.filter(value => JSON.parse(value).type === 'harness.codex.current-admission.read').length, 0);
  });

  await t.test('cross-causation', async t => {
    const f = await portableActivation(true, true);
    t.after(async () => { await f.closeBridge(); f.journal.close(); });
    f.setAdmissionResponder(value => {
      const response = currentAdmissionResponse(f, value as unknown as ReturnType<typeof signNodeFrame>,
        { causationId: 'message:unrelated-request' });
      queueMicrotask(() => { void f.bridge.receive(JSON.stringify(response), response.body.checkedAt).catch(() => {}); });
    });
    await assert.rejects(f.bridge.exchangeCodexCurrentAdmission(currentAdmissionRequest(f),
      new Date(baseTime + 3_000).toISOString(), new Date(baseTime + 20_000).toISOString(),
      new AbortController().signal, 50));
  });

  await t.test('stale response', async t => {
    const f = await portableActivation(true, true);
    t.after(async () => { await f.closeBridge(); f.journal.close(); });
    f.setAdmissionResponder(value => {
      const response = currentAdmissionResponse(f, value as unknown as ReturnType<typeof signNodeFrame>,
        { expiresAt: new Date(baseTime + 4_000).toISOString() });
      queueMicrotask(() => { void f.bridge.receive(JSON.stringify(response),
        new Date(baseTime + 5_000).toISOString()).catch(() => {}); });
    });
    await assert.rejects(f.bridge.exchangeCodexCurrentAdmission(currentAdmissionRequest(f),
      new Date(baseTime + 3_000).toISOString(), new Date(baseTime + 20_000).toISOString(),
      new AbortController().signal, 50));
  });

  await t.test('oversized response', async t => {
    const f = await portableActivation(true, true);
    t.after(async () => { await f.closeBridge(); f.journal.close(); });
    f.setAdmissionResponder(() => queueMicrotask(() => {
      void f.bridge.receive('x'.repeat(131_073), new Date(baseTime + 3_000).toISOString()).catch(() => {});
    }));
    await assert.rejects(f.bridge.exchangeCodexCurrentAdmission(currentAdmissionRequest(f),
      new Date(baseTime + 3_000).toISOString(), new Date(baseTime + 20_000).toISOString(),
      new AbortController().signal, 50));
  });

  await t.test('duplicate response and lost reply do not create another send', async t => {
    const f = await portableActivation(true, true);
    t.after(async () => { await f.closeBridge(); f.journal.close(); });
    let response: ReturnType<typeof signNodeFrame> | undefined;
    f.setAdmissionResponder(value => {
      response = currentAdmissionResponse(f, value as unknown as ReturnType<typeof signNodeFrame>);
      queueMicrotask(() => { void f.bridge.receive(JSON.stringify(response),
        new Date(baseTime + 3_000).toISOString()).catch(() => {}); });
    });
    await f.bridge.exchangeCodexCurrentAdmission(currentAdmissionRequest(f),
      new Date(baseTime + 3_000).toISOString(), new Date(baseTime + 20_000).toISOString(),
      new AbortController().signal, 50);
    await assert.rejects(f.bridge.receive(JSON.stringify(response), new Date(baseTime + 3_000).toISOString()));
    assert.equal(f.sent.filter(value => JSON.parse(value).type === 'harness.codex.current-admission.read').length, 1);
  });

  await t.test('lost response burns the queue and stays non-executing', async t => {
    const f = await portableActivation(true, true);
    t.after(async () => { await f.closeBridge(); f.journal.close(); });
    await assert.rejects(f.bridge.exchangeCodexCurrentAdmission(currentAdmissionRequest(f),
      new Date(baseTime + 3_000).toISOString(), new Date(baseTime + 20_000).toISOString(),
      new AbortController().signal, 5));
    assert.equal(f.sent.filter(value => JSON.parse(value).type === 'harness.codex.current-admission.read').length, 1);
    await assert.rejects(f.bridge.exchangeCodexCurrentAdmission(currentAdmissionRequest(f),
      new Date(baseTime + 3_000).toISOString(), new Date(baseTime + 20_000).toISOString(),
      new AbortController().signal, 5));
    assert.equal(f.sent.filter(value => JSON.parse(value).type === 'harness.codex.current-admission.read').length, 1);
  });
});

test('remote worker rejects missing activation, revoked session and changed binding before native start', async t => {
  for (const failure of ['missing-activation', 'revoked', 'wrong-node', 'wrong-enrollment'] as const) {
    await t.test(failure, async t => {
      const f = await portableActivation(failure !== 'missing-activation'), starts = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
      t.after(() => { starts.close(); f.journal.close(); });
      const initial = startHost(f, starts), recovery = recoverHost(starts, completedResult([]));
      if (failure === 'missing-activation') {
        assert.ok(f.journal.acceptedCodexDelivery(f.body.queueId), 'an authenticated dispatch receipt exists');
        assert.equal(f.journal.acceptedCodexActivation(f.body.queueId), undefined);
      }
      const worker = createCodexWorkerCompositionV1({ initial: initial.input, recovery: recovery.input,
        binding: { tenantId: 'tenant:test', nodeId: failure === 'wrong-node' ? 'node:other' : 'node:test',
          enrollmentDigest: sha256Digest(failure === 'wrong-enrollment' ? 'other' : 'enrollment'),
          connectorProfileDigest: sha256Digest('profile'), activationFrameDigest: sha256Digest(f.activation) },
        assertSessionCurrent() { if (failure === 'revoked') throw new Error('revoked'); },
        result: { ...workerQualification(), bridgeEvidence: f.journal,
          bridge: { async sendCodexResultReturn() { throw new Error('must not send'); } } },
      });
      await assert.rejects(worker.start(new AbortController().signal));
      assert.equal(initial.opened(), 0); assert.deepEqual(initial.effects, []);
      await worker.close();
    });
  }
});

test('portable activation starts once and recovery reads only the durable thread/turn as a noncanonical observation', async t => {
  const f = await portableActivation(), starts = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  t.after(() => { starts.close(); f.journal.close(); });
  const initial = startHost(f, starts);
  assert.equal(initial.host.mode, 'initial');
  if (initial.host.mode !== 'initial') throw new Error('expected initial host');
  const activationEvidence = f.journal.acceptedCodexActivation(f.body.queueId)!;
  assert.deepEqual(initial.host.deliveryBinding(), { queueId: f.body.queueId,
    runId: f.workspaceIntent.runId, activationDigest: activationEvidence.frame.body.activationDigest,
    activationFrameDigest: sha256Digest(activationEvidence.frame) });
  assert.equal(initial.opened(), 0, 'reading host binding cannot acquire a process');
  assert.deepEqual(initial.effects, []);
  const started = await initial.host.run(new AbortController().signal);
  assert.deepEqual(started.identity, { runId: f.workspaceIntent.runId, threadId: 'thread:durable-host',
    turnId: 'turn:durable-host', source: 'correlated_codex_start_receipts' });
  assert.deepEqual(initial.sent, ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.deepEqual(initial.effects, ['create-workspace']); assert.equal(initial.opened(), 1); assert.equal(initial.closed(), 1);
  await initial.host.close();
  assert.deepEqual(initial.effects, ['create-workspace'], 'process-session cleanup does not clean the task workspace');
  assert.equal(started.canonicalPublicationAllowed, false); assert.equal(started.writesResult, false);
  assert.equal(starts.load(f.workspaceIntent.runId).status, 'recorded');
  assert.equal(starts.load(f.workspaceIntent.runId).cleanupVerified, true);
  const recovery = recoverHost(starts, completedResult([
    { type: 'agentMessage', id: 'item:commentary', phase: 'commentary', text: 'ignore me' },
    { type: 'reasoning', id: 'item:reasoning', text: 'do not expose' },
    { type: 'agentMessage', id: 'item:final', phase: 'final_answer', text: 'bounded final answer' },
  ]));
  const observed = await recovery.host.run(new AbortController().signal);
  assert.equal(observed.exactPackageResult?.text, 'bounded final answer');
  assert.equal(observed.selectedResultItemSchemaQualified, true);
  assert.equal(observed.nativeReadQualified, false); assert.equal(observed.canonicalPublicationAllowed, false);
  assert.equal(recovery.opened(), 1); assert.equal(recovery.closed(), 1);
  assert.doesNotMatch(JSON.stringify(observed), /do not expose|synthetic\/workspaces/);
});

test('duplicate and missing activation never create a second workspace or JSONL session', async t => {
  const f = await portableActivation(), starts = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  t.after(() => { starts.close(); f.journal.close(); });
  await startHost(f, starts).host.run(new AbortController().signal);
  const duplicate = startHost(f, starts);
  await assert.rejects(duplicate.host.run(new AbortController().signal), /codex_local_host_unavailable/);
  assert.equal(duplicate.opened(), 0); assert.deepEqual(duplicate.effects, []);
  const missing = { ...f, journal: Object.assign(Object.create(f.journal), {
    acceptedCodexActivation: () => undefined,
  }) as SqliteBridgeJournal };
  const missingStarts = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  t.after(() => missingStarts.close());
  const lost = startHost(missing, missingStarts);
  await assert.rejects(lost.host.run(new AbortController().signal), /codex_local_host_unavailable/);
  assert.equal(lost.opened(), 0); assert.deepEqual(lost.effects, []);
});

test('interrupted start writes and revoked authority consume the attempt and complete cleanup without retry', async t => {
  for (const mode of ['write', 'revoked'] as const) {
    const f = await portableActivation(), starts = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
    t.after(() => { starts.close(); f.journal.close(); });
    let revoked = mode === 'revoked';
    const operation = startHost(f, starts, { revoked: () => revoked,
      async write(line) { if (mode === 'write' && JSON.parse(line).method === 'thread/start')
        throw new Error('interrupted write'); } });
    await assert.rejects(operation.host.run(new AbortController().signal), /codex_local_host_unavailable/);
    assert.equal(operation.closed(), mode === 'write' ? 1 : 0);
    const opened = operation.opened(); revoked = false;
    await assert.rejects(operation.host.run(new AbortController().signal), /codex_local_host_unavailable/);
    assert.equal(operation.opened(), opened);
  }
});

test('malformed, summary-only and secret-like completed reads return no selected result and always clean up', async t => {
  const f = await portableActivation(), starts = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  t.after(() => { starts.close(); f.journal.close(); });
  await startHost(f, starts).host.run(new AbortController().signal);
  const candidates = [
    completedResult([{ type: 'agentMessage', id: 'item:bad', text: 42 }]),
    completedResult([{ type: 'agentMessage', id: 'item:summary', text: 'not full' }], 'summary'),
    completedResult([{ type: 'agentMessage', id: 'item:secret',
      text: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature' }]),
  ];
  for (const candidate of candidates) {
    const recovery = recoverHost(starts, candidate);
    const result = await recovery.host.run(new AbortController().signal);
    assert.equal(result.status, 'completed'); assert.equal(result.exactPackageResult, null);
    assert.equal(result.selectedResultItemSchemaQualified, false);
    assert.equal(recovery.opened(), 1); assert.equal(recovery.closed(), 1);
  }
  const revoked = recoverHost(starts, completedResult([
    { type: 'agentMessage', id: 'item:final', text: 'must not read' }]), { revoked: true });
  await assert.rejects(revoked.host.run(new AbortController().signal), /codex_local_host_unavailable/);
  assert.equal(revoked.opened(), 0); assert.equal(revoked.closed(), 0);
  const uncertain = recoverHost(starts, completedResult([
    { type: 'agentMessage', id: 'item:final', text: 'must not escape cleanup' }]), {
    close: () => new Promise<void>(() => {}),
  });
  await assert.rejects(uncertain.host.run(new AbortController().signal), /codex_local_host_unavailable/);
  assert.equal(uncertain.opened(), 1); assert.equal(uncertain.closed(), 1);
});
