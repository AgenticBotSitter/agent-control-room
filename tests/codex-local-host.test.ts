import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createCodexLocalHostV1 } from '../src/harness/codex-v1/local-host';
import { buildCodexTaskActivationV1, CODEX_ACTIVATION_FEATURE } from '../src/harness/codex-v1/activation-contract';
import { CODEX_START_OPERATION, codexTaskDispatchBodySchemaV1,
  codexTaskPayloadDigestV1, codexTaskRunIdV1 } from '../src/harness/codex-v1/delivery-contract';
import { CODEX_APP_SERVER_READ_CONTRACT,
  CODEX_APP_SERVER_START_CONTRACT } from '../src/harness/codex-v1/schema-contract';
import { SqliteCodexStartJournalV1 } from '../src/harness/codex-v1/start-journal';
import { CodexActivationIntakeHandlerV1 } from '../src/node-bridge/codex-activation-handler';
import { CodexDispatchIntakeHandlerV1 } from '../src/node-bridge/codex-dispatch-handler';
import { PortableNodeBridge } from '../src/node-bridge/bridge';
import { SqliteBridgeJournal } from '../src/node-bridge/journal';
import { computeArtifactBodyDigest, signArtifact } from '../src/node-policy/v1/crypto';
import { computeEffectClaimKey } from '../src/node-policy/v1/effect-claim';
import type { PinnedApprovalTrustStore } from '../src/node-policy/v1/pinned-approval-trust';
import { computeNormalizedOperationDigest } from '../src/node-policy/v1/policy-evaluator';
import { NODE_PROTOCOL_V1, NodeProtocolAuthenticator, signNodeFrame,
  type UnsignedNodeFrame } from '../src/node-protocol/v1';
import { sha256Digest } from '../src/security/canonical-digest';

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

async function portableActivation() {
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
  const features = ['harness.codex.dispatch.v1', CODEX_ACTIVATION_FEATURE];
  let id = 0;
  const bridge = new PortableNodeBridge({ tenantId: start.tenantId, nodeId: start.nodeId,
    keyId: 'node-key:test', features }, journal,
  { async sign(frame) { return signNodeFrame(frame, node.privateKey); } },
  new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: 'ed25519',
    publicKeySpki: serverSpki, state: 'active', principalState: 'active',
    validFrom: new Date(baseTime - 1_000).toISOString() }; } }, journal, { async consume() {} }),
  () => `codex-host-bridge-${++id}`, undefined, undefined, dispatchHandler, activationHandler);
  const transport = { async send(value: string) { sent.push(value); }, async close() {} };
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
  await bridge.receive(JSON.stringify(activation), activatedAt);
  await bridge.receive(JSON.stringify(activation), activatedAt);
  assert.equal(journal.acceptedCodexActivation(body.queueId)?.frame.body.runId, workspaceIntent.runId);
  await bridge.disconnected(); dispatchHandler.close(); activationHandler.close();
  return { journal, body, workspaceIntent, activation,
    connectionAttemptId: `connection-attempt:codex-host:${fixtureId}`, clock: () => ++clock };
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
  const host = createCodexLocalHostV1({ mode: 'initial', runId: f.workspaceIntent.runId,
    queueId: f.body.queueId, connectionAttemptId: f.connectionAttemptId,
    initializedConnectionDigest: sha256Digest('codex-host-initialized'), threadStartRequestId: 10,
    turnStartRequestId: 20, workspaceIntent: f.workspaceIntent, bridgeJournal: f.journal,
    startJournal: starts, authority, workspacePort: workspacePort(f.workspaceIntent, effects),
    openStartSession: async () => { opened++; return { async writeLine(line) {
      sent.push(JSON.parse(line).method); await options.write?.(line);
    }, async readLine() { return responses.shift(); }, async close() { closed++; await options.close?.(); } }; },
    startTimeoutMs: 1_000, clock: f.clock });
  return { host, effects, sent, opened: () => opened, closed: () => closed };
}

function recoverHost(starts: SqliteCodexStartJournalV1, rawResult: unknown,
  options: { revoked?: boolean; close?: () => Promise<void> } = {}) {
  let opened = 0, closed = 0, reads = 0;
  const responses = ['{"id":1,"result":{}}', JSON.stringify({ id: 2, result: rawResult })];
  const host = createCodexLocalHostV1({ mode: 'recover', runId: intent().runId, startJournal: starts,
    authority: { assertCurrent() { if (options.revoked) throw new Error('revoked'); } },
    openReadSession(identity) { opened++; assert.equal(identity.threadId, 'thread:durable-host'); return {
      ready: Promise.resolve({ async send(line) {
        const request = JSON.parse(line); if (request.method === 'thread/read') {
          assert.deepEqual(request.params, { threadId: 'thread:durable-host', includeTurns: true });
        }
      }, async readLine() { return responses[reads++]!; } }),
      async close() { closed++; await options.close?.(); },
    }; }, readTimeoutMs: 1_000, cleanupTimeoutMs: 100 });
  return { host, opened: () => opened, closed: () => closed };
}

function completedResult(items: unknown[], itemsView: 'full' | 'summary' = 'full') {
  return { thread: { id: 'thread:durable-host', cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
    turns: [{ id: 'turn:durable-host', status: 'completed', itemsView, items }] } };
}

test('portable activation starts once and recovery reads only the durable thread/turn as a noncanonical observation', async t => {
  const f = await portableActivation(), starts = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  t.after(() => { starts.close(); f.journal.close(); });
  const initial = startHost(f, starts);
  const started = await initial.host.run(new AbortController().signal);
  assert.deepEqual(started.identity, { runId: f.workspaceIntent.runId, threadId: 'thread:durable-host',
    turnId: 'turn:durable-host', source: 'correlated_codex_start_receipts' });
  assert.deepEqual(initial.sent, ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.deepEqual(initial.effects, ['create-workspace']); assert.equal(initial.opened(), 1); assert.equal(initial.closed(), 1);
  assert.equal(started.canonicalPublicationAllowed, false); assert.equal(started.writesResult, false);
  assert.equal(starts.load(f.workspaceIntent.runId).status, 'recorded');
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
