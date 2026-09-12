import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { CODEX_DELIVERY_FEATURE, CODEX_START_OPERATION, codexTaskDispatchBodySchemaV1,
  codexTaskPayloadDigestV1 } from '../src/harness/codex-v1/delivery-contract.ts';
import { CodexDispatchIntakeHandlerV1 } from '../src/node-bridge/codex-dispatch-handler.ts';
import { PortableNodeBridge } from '../src/node-bridge/bridge.ts';
import { SqliteBridgeJournal } from '../src/node-bridge/journal.ts';
import { ServerNodeSession } from '../src/node-control/server-node-session.ts';
import { computeArtifactBodyDigest, signArtifact } from '../src/node-policy/v1/crypto.ts';
import { computeEffectClaimKey } from '../src/node-policy/v1/effect-claim.ts';
import type { PinnedApprovalTrustStore } from '../src/node-policy/v1/pinned-approval-trust.ts';
import { computeNormalizedOperationDigest } from '../src/node-policy/v1/policy-evaluator.ts';
import { NODE_PROTOCOL_V1, FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, signNodeFrame,
  type SignedNodeFrame } from '../src/node-protocol/v1/index.ts';
import { sha256Digest } from '../src/security/canonical-digest.ts';

const initial = Date.parse('2026-09-12T21:00:00.000Z');

function codexBody(now: number, approvalPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) {
  const deadline = now + 60_000;
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
  const permit = signArtifact({ ...permitBody, bodyDigest: computeArtifactBodyDigest(permitBody) }, approvalPrivateKey);
  return codexTaskDispatchBodySchemaV1.parse({ schema: 'control-room.codex-task-dispatch/v1',
    queueId: `native-queue:${sha256Digest({ tenantId: start.tenantId, jobId: start.jobId,
      attemptId: start.attemptId }).slice(7)}`, start, request, permit, permitDigest: sha256Digest(permit) });
}

async function connected() {
  let now = initial;
  const approval = generateKeyPairSync('ed25519'), server = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519');
  const approvalSpki = approval.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const serverSpki = server.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const nodeSpki = node.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const body = codexBody(now, approval.privateKey), journal = new SqliteBridgeJournal(':memory:');
  const approvals = { binding: () => ({ tenantId: 'tenant:test', nodeId: 'node:test', nodeClass: 'personal-compute' }),
    assertAvailable() {}, async resolveApprovalKey(id: string) {
      return id === 'approval-key:test' ? new Uint8Array(Buffer.from(approvalSpki, 'base64url')) : undefined;
    } } as unknown as PinnedApprovalTrustStore;
  const handler = new CodexDispatchIntakeHandlerV1({ enrollmentDigest: body.start.enrollmentDigest,
    connectorProfileDigest: body.start.connectorProfileDigest, workspaceIntentDigest: body.start.workspaceIntentDigest }, journal,
  { approvals, security: { currentServerTrustRevision: () => 'trust-revision:1' } }, () => now);
  const toNode: string[] = [], toServer: string[] = [], serverFrames: SignedNodeFrame[] = [];
  const bridge = new PortableNodeBridge({ tenantId: 'tenant:test', nodeId: 'node:test', keyId: 'node-key:test',
    features: [CODEX_DELIVERY_FEATURE] }, journal, { async sign(frame) { return signNodeFrame(frame, node.privateKey); } },
  new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: 'ed25519', publicKeySpki: serverSpki,
    state: 'active', principalState: 'active', validFrom: new Date(now - 1000).toISOString() }; } }, journal,
  new FixedWindowProtocolRateLimiter(100, 60)), undefined, undefined, undefined, handler);
  const session = new ServerNodeSession({ tenantId: 'tenant:test', nodeId: 'node:test', nodeKeyId: 'node-key:test',
    serverId: 'server:test', serverKeyId: 'server-key:test', serverPublicKeySpki: serverSpki,
    transportIdentity: 'transport:test', features: [CODEX_DELIVERY_FEATURE], maxFrameBytes: 131_072,
    heartbeatIntervalSeconds: 30 }, { clock: () => now,
    authentication: new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: 'ed25519',
      publicKeySpki: nodeSpki, state: 'active', principalState: 'active', validFrom: new Date(now - 1000).toISOString() }; } },
    { async consume() { return 'accepted' as const; } }, new FixedWindowProtocolRateLimiter(100, 60)),
    async sign(frame) { return signNodeFrame(frame, server.privateKey); }, async send(raw) { toNode.push(raw); } });
  const timestamp = () => new Date(now).toISOString();
  await bridge.open({ async send(raw) { toServer.push(raw); }, async close() {} }, { now: timestamp(), transportIdentity: 'transport:test' });
  const helloRaw = toServer.shift()!, hello = JSON.parse(helloRaw) as SignedNodeFrame<'connection.hello'>;
  await session.acceptHello(helloRaw);
  while (toNode.length || toServer.length) {
    while (toNode.length) { const raw = toNode.shift()!; serverFrames.push(JSON.parse(raw)); await bridge.receive(raw, timestamp()); }
    while (toServer.length) await session.receive(toServer.shift()!);
  }
  let delayed = 0;
  return { body, bridge, handler, journal, session, toNode, toServer,
    advance: () => { now += 1; }, delayedAck: () => {
      const sequence = ++delayed + 20, acknowledged = serverFrames[0]; assert.ok(acknowledged);
      return JSON.stringify(signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'node_to_server',
        messageId: `message:delayed-ack:${sequence}`, correlationId: 'correlation:delayed-ack',
        tenantId: 'tenant:test', actorId: 'node:test', senderKind: 'node', keyId: 'node-key:test',
        connectionId: hello.connectionId, sequence, sentAt: timestamp(), expiresAt: new Date(now + 30_000).toISOString(),
        nonce: `c3ludGhldGljLWRlbGF5ZWQtYWNrLTA${sequence}`, type: 'protocol.ack',
        body: { acknowledgedMessageIds: [acknowledged.messageId], highestContiguousSequence: acknowledged.sequence,
          disposition: 'accepted' } }, node.privateKey));
    }, close: async () => { session.disconnect(); await bridge.close(); handler.close(); journal.close(); } };
}

test('server reserves, sends and accepts exactly one Codex delivery without starting work', async () => {
  const f = await connected();
  assert.ok(f.session.codexDeliveryChannel()); assert.equal(f.session.nativeDeliveryChannel(), undefined);
  let staged = 0, transmitted = 0, receipts = 0;
  await f.session.stageCodexDispatch(async (sign, channel) => {
    staged++; channel.assertCurrent(); const frame = await sign(f.body, f.body.start.deadline);
    assert.equal(frame.body.start.runId, f.body.start.runId); return { frameDigest: sha256Digest(frame) };
  });
  await f.session.receive(f.delayedAck());
  await assert.rejects(f.session.stageCodexDispatch(async () => undefined));
  await f.session.sendPreparedCodexDispatch(async (frame, channel) => {
    transmitted++; channel.assertCurrent(); assert.equal(frame.body.queueId, f.body.queueId);
    return { value: { messageId: frame.messageId }, assertFresh: channel.assertCurrent };
  });
  await f.session.receive(f.delayedAck());
  await assert.rejects(f.session.sendPreparedCodexDispatch(async () => ({ value: undefined, assertFresh() {} })));
  assert.equal(f.toNode.length, 1); f.advance(); await f.bridge.receive(f.toNode.shift()!, new Date(initial + 1).toISOString());
  assert.equal(f.toServer.length, 1);
  const saved = await f.session.acceptCodexReceipt(f.toServer.shift()!, async (receipt, dispatch, current) => {
    receipts++; current(); assert.equal(receipt.body.startsWork, false); assert.equal(receipt.body.dispatchMessageId, dispatch.messageId);
    return receipt.body;
  });
  assert.equal(saved.disposition, 'recorded'); assert.deepEqual([staged, transmitted, receipts], [1, 1, 1]);
  await assert.rejects(f.session.acceptCodexReceipt('{}', async () => undefined));
  assert.equal(f.journal.acceptedCodexDelivery(f.body.queueId)?.receipt.startsWork, false);
  await f.close();
});

test('Codex transmission requires a completed synchronous freshness check before sending', async () => {
  const checks: Array<() => unknown> = [() => false, async () => {}, () => ({ then() {} })];
  for (const check of checks) {
    const f = await connected();
    await f.session.stageCodexDispatch(async sign => sign(f.body, f.body.start.deadline));
    await assert.rejects(f.session.sendPreparedCodexDispatch(async () => ({ value: undefined,
      assertFresh: check as () => void })));
    assert.equal(f.toNode.length, 0); assert.equal(f.session.codexDeliveryChannel(), undefined);
    await f.close();
  }
});

test('missing or repeated reservation and a lost send close the one-shot session', async () => {
  for (const mode of ['missing', 'repeat', 'lost'] as const) {
    const f = await connected();
    if (mode === 'missing') await assert.rejects(f.session.stageCodexDispatch(async () => 'not-signed'));
    else if (mode === 'repeat') await assert.rejects(f.session.stageCodexDispatch(async sign => {
      await sign(f.body, f.body.start.deadline); return sign(f.body, f.body.start.deadline);
    }));
    else {
      await f.session.stageCodexDispatch(async sign => sign(f.body, f.body.start.deadline));
      f.session.disconnect();
      await assert.rejects(f.session.sendPreparedCodexDispatch(async () => ({ value: undefined, assertFresh() {} })));
    }
    assert.equal(f.session.codexDeliveryChannel(), undefined); await f.close();
  }
});
