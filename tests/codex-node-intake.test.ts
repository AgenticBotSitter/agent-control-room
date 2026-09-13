import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { CODEX_START_OPERATION, codexTaskDispatchBodySchemaV1,
  codexTaskPayloadDigestV1 } from '../src/harness/codex-v1/delivery-contract.ts';
import { buildCodexTaskActivationV1, CODEX_ACTIVATION_FEATURE } from '../src/harness/codex-v1/activation-contract.ts';
import { CodexActivationIntakeHandlerV1 } from '../src/node-bridge/codex-activation-handler.ts';
import { CodexDispatchIntakeHandlerV1 } from '../src/node-bridge/codex-dispatch-handler.ts';
import { PortableNodeBridge } from '../src/node-bridge/bridge.ts';
import { SqliteBridgeJournal } from '../src/node-bridge/journal.ts';
import { computeArtifactBodyDigest, signArtifact } from '../src/node-policy/v1/crypto.ts';
import { computeEffectClaimKey } from '../src/node-policy/v1/effect-claim.ts';
import type { PinnedApprovalTrustStore } from '../src/node-policy/v1/pinned-approval-trust.ts';
import { computeNormalizedOperationDigest } from '../src/node-policy/v1/policy-evaluator.ts';
import { NODE_PROTOCOL_V1, NodeProtocolAuthenticator, signNodeFrame,
  type UnsignedNodeFrame } from '../src/node-protocol/v1/index.ts';
import { sha256Digest } from '../src/security/canonical-digest.ts';

const now = Date.parse('2026-09-12T20:00:00.000Z'), deadline = now + 60_000;
const approvalKeys = generateKeyPairSync('ed25519');
const approvalSpki = approvalKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

function fixture() {
  const start = { schema: 'control-room.codex-task-start/v1' as const,
    tenantId: 'tenant:test', nodeId: 'node:test', projectId: 'project:test', jobId: 'job:test',
    attemptId: 'attempt:test', runId: 'run:pending', leaseId: 'lease:test', leaseEpoch: 3,
    effectClaimKey: sha256Digest('pending'), operationDigest: sha256Digest('pending'),
    inputDigest: sha256Digest({ prompt: 'Inspect the project', instructions: 'Return bounded evidence' }),
    enrollmentDigest: sha256Digest('enrollment'), connectorProfileDigest: sha256Digest('profile'),
    workspaceIntentDigest: sha256Digest('workspace'), prompt: 'Inspect the project',
    instructions: 'Return bounded evidence', deadline };
  const request = { contractVersion: 'control-room-node-policy/v1' as const,
    requestId: 'request:codex:test', tenantId: start.tenantId, nodeId: start.nodeId,
    nodeClass: 'personal-compute', projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, leaseId: start.leaseId, leaseEpoch: start.leaseEpoch,
    executorId: 'executor:codex', operationId: CODEX_START_OPERATION, operationDigest: '',
    payloadDigest: codexTaskPayloadDigestV1(start, sha256Digest('authority')),
    authorityDigest: sha256Digest('authority'), credentialRefs: ['credential:codex'],
    target: { kind: 'filesystem' as const, canonicalPath: '/synthetic/project' }, risk: 'low' as const,
    externalEffect: true, estimatedDurationSeconds: 60, occurredAt: new Date(now).toISOString() };
  request.operationDigest = computeNormalizedOperationDigest(request); start.operationDigest = request.operationDigest;
  start.effectClaimKey = computeEffectClaimKey(request); start.runId = `run:codex-task:${start.effectClaimKey.slice(7)}`;
  const permitBody = { schema: 'control-room.owner-approval-attestation/v1' as const,
    tenantId: start.tenantId, nodeId: start.nodeId, projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, operationDigest: request.operationDigest, risk: 'low' as const,
    decision: 'approved' as const, issuedAt: new Date(now).toISOString(), expiresAt: new Date(deadline).toISOString(),
    nonce: 'c3ludGhldGljLWNvZGV4', approvalKeyId: 'approval-key:test' };
  const permit = signArtifact({ ...permitBody, bodyDigest: computeArtifactBodyDigest(permitBody) }, approvalKeys.privateKey);
  const body = codexTaskDispatchBodySchemaV1.parse({ schema: 'control-room.codex-task-dispatch/v1',
    queueId: `native-queue:${sha256Digest({ tenantId: start.tenantId, jobId: start.jobId,
      attemptId: start.attemptId }).slice(7)}`, start, request, permit, permitDigest: sha256Digest(permit) });
  const server = generateKeyPairSync('ed25519');
  const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
    messageId: 'message:codex-dispatch', correlationId: 'correlation:codex', tenantId: start.tenantId,
    actorId: 'control-room:test', senderKind: 'control_room', keyId: 'server-key:test',
    connectionId: 'connection:test', sequence: 3, sentAt: new Date(now).toISOString(),
    expiresAt: new Date(deadline).toISOString(), nonce: 'c3ludGhldGljLWZyYW1l',
    type: 'harness.codex.dispatch', body }, server.privateKey);
  return { body, frame };
}

function setup(overrides: { enrollmentDigest?: string } = {}) {
  const value = fixture(), journal = new SqliteBridgeJournal(':memory:');
  let revision = 'trust-revision:1', current = now + 1, channelCurrent = true;
  const approvals = { binding: () => ({ tenantId: 'tenant:test', nodeId: 'node:test', nodeClass: 'personal-compute' }),
    assertAvailable() {}, async resolveApprovalKey(keyId: string) {
      return keyId === 'approval-key:test' ? new Uint8Array(Buffer.from(approvalSpki, 'base64url')) : undefined;
    } } as unknown as PinnedApprovalTrustStore;
  const handler = new CodexDispatchIntakeHandlerV1({
    enrollmentDigest: overrides.enrollmentDigest ?? value.body.start.enrollmentDigest,
    connectorProfileDigest: value.body.start.connectorProfileDigest,
    workspaceIntentDigest: value.body.start.workspaceIntentDigest }, journal,
  { approvals, security: { currentServerTrustRevision: () => revision } }, () => current);
  const channel = { tenantId: 'tenant:test', nodeId: 'node:test', connectionId: 'connection:test',
    maxFrameBytes: 131_072, grantsExecutionAuthority: false as const,
    assertCurrent() { if (!channelCurrent) throw new Error('channel_stale'); } };
  return { ...value, journal, handler, channel,
    revoke: () => { revision = 'trust-revision:2'; }, expire: () => { current = deadline; },
    disconnect: () => { channelCurrent = false; } };
}

test('node intake records one exact signed Codex delivery without starting work', async () => {
  const f = setup();
  const receipt = await f.handler.accept(f.frame, f.channel);
  assert.equal(receipt.disposition, 'recorded'); assert.equal(receipt.startsWork, false);
  assert.equal(receipt.grantsExecutionAuthority, false);
  const saved = f.journal.acceptedCodexDelivery(f.body.queueId);
  assert.equal(saved?.frame.body.start.runId, f.body.start.runId);
  assert.equal(saved?.receipt.dispatchMessageId, f.frame.messageId);
  await assert.rejects(f.handler.accept(f.frame, f.channel));
  f.handler.close(); f.journal.close();
});

test('wrong local binding, stale channel and expired authority record nothing', async () => {
  const cases = [
    { wrongEnrollment: true, prepare: (_f: ReturnType<typeof setup>) => {} },
    { prepare: (f: ReturnType<typeof setup>) => f.disconnect() },
    { prepare: (f: ReturnType<typeof setup>) => f.expire() },
  ];
  for (const currentCase of cases) {
    const f = setup({ enrollmentDigest: currentCase.wrongEnrollment ? sha256Digest('wrong') : undefined });
    currentCase.prepare(f);
    await assert.rejects(f.handler.accept(f.frame, f.channel));
    assert.equal(f.journal.acceptedCodexDelivery(f.body.queueId), undefined);
    f.handler.close(); f.journal.close();
  }
});

test('portable bridge negotiates Codex delivery, records it, and returns one signed receipt', async () => {
  const f = setup(), server = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519');
  const serverSpki = server.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const sent: string[] = []; let id = 0;
  const bridge = new PortableNodeBridge({ tenantId: 'tenant:test', nodeId: 'node:test', keyId: 'node-key:test',
    features: ['harness.codex.dispatch.v1'] }, f.journal,
  { async sign(frame) { return signNodeFrame(frame, node.privateKey); } },
  new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: 'ed25519',
    publicKeySpki: serverSpki, state: 'active', principalState: 'active',
    validFrom: new Date(now - 1000).toISOString() }; } }, f.journal, { async consume() {} }),
  () => `bridge-test-${++id}`, undefined, undefined, f.handler);
  const transport = { async send(value: string) { sent.push(value); }, async close() {} };
  const at = new Date(now + 1).toISOString();
  await bridge.open(transport, { now: at, transportIdentity: 'transport:test' });
  const hello = JSON.parse(sent[0]) as { messageId: string; connectionId: string };
  const serverFrame = (sequence: number, type: UnsignedNodeFrame['type'], body: UnsignedNodeFrame['body']) =>
    signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
      messageId: `message:server:${sequence}`, correlationId: 'correlation:server',
      ...(sequence === 1 ? { causationId: hello.messageId } : {}), tenantId: 'tenant:test',
      actorId: 'control-room:test', senderKind: 'control_room', keyId: 'server-key:test',
      connectionId: hello.connectionId, sequence, sentAt: at, expiresAt: new Date(deadline).toISOString(),
      nonce: `synthetic_server_nonce_${sequence}_123456789012345`, type, body } as UnsignedNodeFrame, server.privateKey);
  await bridge.receive(JSON.stringify(serverFrame(1, 'connection.accepted', {
    selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: ['harness.codex.dispatch.v1'],
    maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30, serverTime: at })), at);
  await bridge.receive(JSON.stringify(serverFrame(2, 'node.reconciliation.request', {
    lastAcknowledgedNodeSequence: 1, requestedAttemptIds: [] })), at);
  const dispatch = serverFrame(3, 'harness.codex.dispatch', f.body);
  await bridge.receive(JSON.stringify(dispatch), at);
  const receipts = sent.map(value => JSON.parse(value)).filter(value => value.type === 'harness.codex.dispatch.receipt');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].body.dispatchMessageId, dispatch.messageId);
  assert.equal(receipts[0].body.startsWork, false); assert.equal(bridge.status().state, 'online');
  assert.equal(f.journal.acceptedCodexDelivery(f.body.queueId)?.frame.messageId, dispatch.messageId);
  await bridge.disconnected();
  const reconnected: string[] = [], transport2 = { async send(value: string) { reconnected.push(value); }, async close() {} };
  await bridge.open(transport2, { now: at, transportIdentity: 'transport:test' });
  const hello2 = JSON.parse(reconnected[0]) as { messageId: string; connectionId: string };
  const resumed = (sequence: number, type: UnsignedNodeFrame['type'], body: UnsignedNodeFrame['body']) =>
    signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
      messageId: `message:reconnected:${sequence}`, correlationId: 'correlation:reconnected',
      ...(sequence === 1 ? { causationId: hello2.messageId } : {}), tenantId: 'tenant:test',
      actorId: 'control-room:test', senderKind: 'control_room', keyId: 'server-key:test',
      connectionId: hello2.connectionId, sequence, sentAt: at, expiresAt: new Date(deadline).toISOString(),
      nonce: `synthetic_reconnect_nonce_${sequence}_123456789012`, type, body } as UnsignedNodeFrame, server.privateKey);
  await bridge.receive(JSON.stringify(resumed(1, 'connection.accepted', {
    selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: ['harness.codex.dispatch.v1'],
    maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30, serverTime: at })), at);
  await bridge.receive(JSON.stringify(resumed(2, 'node.reconciliation.request', {
    lastAcknowledgedNodeSequence: 1, requestedAttemptIds: [] })), at);
  assert.equal(reconnected.some(value => JSON.parse(value).type === 'harness.codex.dispatch.receipt'), false);
  await bridge.disconnected(); f.handler.close(); f.journal.close();
});

test('portable bridge records the exact post-receipt activation without starting work', async () => {
  const f = setup(), server = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519');
  const serverSpki = server.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const sent: string[] = []; let id = 0;
  const admissionDigest = sha256Digest('current-admission');
  const activationHandler = new CodexActivationIntakeHandlerV1(f.journal, {
    currentAdmissionDigest: () => admissionDigest,
    assertCurrent() {},
  }, () => now + 4);
  const features = ['harness.codex.dispatch.v1', CODEX_ACTIVATION_FEATURE];
  const bridge = new PortableNodeBridge({ tenantId: 'tenant:test', nodeId: 'node:test', keyId: 'node-key:test', features },
    f.journal, { async sign(frame) { return signNodeFrame(frame, node.privateKey); } },
    new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: 'ed25519',
      publicKeySpki: serverSpki, state: 'active', principalState: 'active',
      validFrom: new Date(now - 1000).toISOString() }; } }, f.journal, { async consume() {} }),
    () => `activation-test-${++id}`, undefined, undefined, f.handler, activationHandler);
  const transport = { async send(value: string) { sent.push(value); }, async close() {} };
  const at = new Date(now + 1).toISOString();
  await bridge.open(transport, { now: at, transportIdentity: 'transport:test' });
  const hello = JSON.parse(sent[0]) as { messageId: string; connectionId: string };
  const serverFrame = (sequence: number, type: UnsignedNodeFrame['type'], body: UnsignedNodeFrame['body'],
    sentAt = at, causationId?: string) => signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
      messageId: `message:activation-server:${sequence}`, correlationId: 'correlation:activation',
      ...(causationId ? { causationId } : sequence === 1 ? { causationId: hello.messageId } : {}),
      tenantId: 'tenant:test', actorId: 'control-room:test', senderKind: 'control_room', keyId: 'server-key:test',
      connectionId: hello.connectionId, sequence, sentAt, expiresAt: new Date(deadline).toISOString(),
      nonce: `synthetic_activation_nonce_${sequence}_123456789012`, type, body } as UnsignedNodeFrame, server.privateKey);
  await bridge.receive(JSON.stringify(serverFrame(1, 'connection.accepted', {
    selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: features,
    maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30, serverTime: at })), at);
  await bridge.receive(JSON.stringify(serverFrame(2, 'node.reconciliation.request', {
    lastAcknowledgedNodeSequence: 1, requestedAttemptIds: [] })), at);
  const dispatch = serverFrame(3, 'harness.codex.dispatch', f.body);
  await bridge.receive(JSON.stringify(dispatch), at);
  const receipt = sent.map(value => JSON.parse(value) as ReturnType<typeof signNodeFrame>)
    .find(value => value.type === 'harness.codex.dispatch.receipt');
  assert.ok(receipt && receipt.type === 'harness.codex.dispatch.receipt');
  const receiptReceivedAt = new Date(now + 3).toISOString();
  const activatedAt = new Date(now + 4).toISOString();
  const activationBody = buildCodexTaskActivationV1({ dispatch: dispatch as never, receipt: receipt as never,
    currentAdmissionDigest: admissionDigest, receiptReceivedAt, activatedAt,
    activationExpiresAt: new Date(deadline).toISOString() });
  const activation = serverFrame(4, 'harness.codex.dispatch.activation', activationBody, activatedAt, receipt.messageId);
  let rejectedWrites = 0;
  const rejectingHandler = new CodexActivationIntakeHandlerV1({
    recordCodexActivation() { rejectedWrites += 1; throw new Error('unexpected_activation_write'); },
  } as never, {
    currentAdmissionDigest: () => admissionDigest,
    assertCurrent: (() => false) as unknown as () => void,
  }, () => now + 4);
  await assert.rejects(rejectingHandler.accept(activation as never, {
    tenantId: 'tenant:test', nodeId: 'node:test', connectionId: hello.connectionId,
    maxFrameBytes: 131_072, grantsExecutionAuthority: false, assertCurrent() {},
  }), /codex_activation_intake_unavailable/);
  assert.equal(rejectedWrites, 0);
  rejectingHandler.close();
  await bridge.receive(JSON.stringify(activation), activatedAt);
  await bridge.receive(JSON.stringify(activation), activatedAt);
  const saved = f.journal.acceptedCodexActivation(f.body.queueId);
  assert.equal(saved?.frame.body.activationId, activationBody.activationId);
  assert.equal(saved?.frame.body.startsWork, false);
  assert.equal(saved?.frame.body.grantsExecutionAuthority, false);
  assert.equal(saved?.frame.body.permitsRetry, false);
  assert.equal(saved?.frame.body.permitsResume, false);
  assert.equal(saved?.frame.body.permitsThreadRead, false);
  assert.equal(sent.map(value => JSON.parse(value)).filter(value => value.type === 'protocol.ack'
    && value.body.acknowledgedMessageIds.includes(activation.messageId)).length, 2);
  await bridge.disconnected(); activationHandler.close(); f.handler.close(); f.journal.close();
});
