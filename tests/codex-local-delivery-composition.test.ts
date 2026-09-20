import assert from 'node:assert/strict';
import test from 'node:test';
import { createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from '../src/harness/v1/controller-worker-delivery';
import { deliverCodexLocalTaskV1 } from '../src/harness/codex-v1/local-delivery-composition';
import { sha256Digest } from '../src/security';
import { at, nativeTaskFixture, registration } from './native-task-fixture';
import { binding, input } from './hermes-native-fixture';

const integrityKey = new Uint8Array(32).fill(73);
const worker = { workerId: 'worker:codex-local', adapterId: 'codex-app-server/v1', adapterRevision: 'source-123' } as const;
const authorityDigest = sha256Digest('controller-authority');
const admissionDigest = sha256Digest('current-codex-admission');
const acceptanceProfileDigest = sha256Digest('codex-acceptance-profile');

function delivery(patch: Partial<Parameters<typeof createControllerWorkerDeliveryV1>[0]> = {}): ControllerWorkerDeliveryV1 {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
      attemptId: binding.attemptId, runId: registration.id, nodeId: binding.nodeId },
    worker, input: { prompt: input.prompt, instructions: input.instructions }, authorityDigest,
    connectorProfileDigest: sha256Digest('codex-profile'), acceptanceProfileId: 'profile:codex', acceptanceProfileDigest,
    issuedAt: at(1000), expiresAt: at(120_000), ...patch,
  });
}

function activation(packet: ControllerWorkerDeliveryV1) {
  const queueId = `native-queue:${sha256Digest({ tenantId: packet.identity.tenantId,
    jobId: packet.identity.jobId, attemptId: packet.identity.attemptId }).slice(7)}`;
  const material = { schema: 'control-room.codex-task-activation/v1' as const,
    tenantId: packet.identity.tenantId, projectId: packet.identity.projectId, nodeId: packet.identity.nodeId,
    jobId: packet.identity.jobId, attemptId: packet.identity.attemptId, runId: packet.identity.runId,
    leaseId: 'lease:codex', leaseEpoch: 1, queueId, connectionId: 'connection:codex',
    connection: { connectionAttemptId: 'connection:codex', initializedConnectionDigest: sha256Digest('initialized') },
    dispatchMessageId: 'message:dispatch', dispatchFrameDigest: sha256Digest('dispatch-frame'),
    dispatchBodyDigest: sha256Digest('dispatch-body'), receiptMessageId: 'message:receipt',
    receiptFrameDigest: sha256Digest('receipt-frame'), receiptBodyDigest: sha256Digest('receipt-body'),
    permitDigest: sha256Digest('permit'), inputDigest: packet.inputDigest, operationDigest: sha256Digest('operation'),
    effectClaimKey: sha256Digest('claim'), enrollmentDigest: sha256Digest('enrollment'),
    connectorProfileDigest: packet.connectorProfileDigest, workspaceIntentDigest: sha256Digest('workspace-intent'),
    currentAdmissionDigest: admissionDigest, workspacePath: '/synthetic/codex-workspace',
    prompt: packet.input.prompt, instructions: packet.input.instructions, receiptRecordedAt: at(1500),
    receiptReceivedAt: at(1600), activatedAt: at(1700), activationExpiresAt: at(110_000),
    startsWork: false as const, authorizesExactStart: true as const, grantsExecutionAuthority: false as const,
    permitsRetry: false as const, permitsResume: false as const, permitsThreadRead: false as const };
  const activationDigest = sha256Digest(material);
  const body = { ...material, activationId: `codex-activation:${activationDigest.slice(7)}`, activationDigest };
  return { type: 'harness.codex.dispatch.activation' as const, direction: 'server_to_node' as const,
    senderKind: 'control_room' as const, messageId: 'message:activation', causationId: 'message:receipt',
    tenantId: packet.identity.tenantId, actorId: 'control-room', keyId: 'key:controller',
    connectionId: 'connection:codex', sentAt: at(1700), expiresAt: at(110_000), body };
}

function receipt(packet: ControllerWorkerDeliveryV1, receivedAt = at(2000)) {
  const material = { schema: 'control-room.controller-worker-delivery-receipt/v1' as const,
    deliveryId: packet.deliveryId, deliveryDigest: packet.deliveryDigest, workerId: packet.worker.workerId,
    route: { kind: 'local' as const, workerId: packet.worker.workerId }, receivedAt,
    disposition: 'accepted' as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return { ...material, receiptDigest: sha256Digest(material) };
}

function composition(f: Awaited<ReturnType<typeof nativeTaskFixture>>, packet: ControllerWorkerDeliveryV1,
  state: { revoked: boolean; receives: number; starts: number }) {
  const frame = activation(packet);
  return { db: f.db, integrityKey, binding: { ...worker, authorityDigest, acceptanceProfileId: 'profile:codex', acceptanceProfileDigest },
    authority: { currentAdmissionDigest: () => admissionDigest, assertCurrent() { if (state.revoked) throw new Error('revoked'); } },
    activationEvidence: { acceptedCodexActivation(queueId: string) {
      return queueId === frame.body.queueId ? { frame, receivedAt: at(1800) } : undefined;
    } },
    receiptPort: { async receive(value: ControllerWorkerDeliveryV1) { state.receives++; return receipt(value); } },
    host: { async run() { state.starts++; return { status: 'started' as const }; } } };
}

test('Codex local delivery persists the shared receipt before one injected host observation and exact replay never starts again', async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(), state = { revoked: false, receives: 0, starts: 0 }, config = composition(f, packet, state);
  const first = await deliverCodexLocalTaskV1(config, packet, { kind: 'local', workerId: worker.workerId }, at(2000));
  assert.equal(first.state, 'started_observation'); assert.equal(state.receives, 1); assert.equal(state.starts, 1);
  state.revoked = true;
  const replay = await deliverCodexLocalTaskV1(config, packet, { kind: 'local', workerId: worker.workerId }, at(2000));
  assert.equal(replay.state, 'already_delivered'); assert.equal(state.receives, 1); assert.equal(state.starts, 1);
});

test('wrong, changed, expired, and revoked deliveries refuse before receipt handling or host acquisition', async t => {
  const cases = [
    { name: 'wrong worker', packet: () => delivery({ worker: { ...worker, workerId: 'worker:wrong' } }), route: (p: ControllerWorkerDeliveryV1) => ({ kind: 'local' as const, workerId: p.worker.workerId }) },
    { name: 'expired', packet: () => delivery({ expiresAt: at(1900) }), route: () => ({ kind: 'local' as const, workerId: worker.workerId }) },
  ];
  for (const item of cases) {
    const f = await nativeTaskFixture(); const packet = item.packet(), state = { revoked: false, receives: 0, starts: 0 };
    t.after(f.close);
    await assert.rejects(deliverCodexLocalTaskV1(composition(f, packet, state), packet, item.route(packet), at(2000)), /codex_local_delivery_unavailable/);
    assert.deepEqual({ receives: state.receives, starts: state.starts }, { receives: 0, starts: 0 }, item.name);
  }
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(), state = { revoked: true, receives: 0, starts: 0 };
  await assert.rejects(deliverCodexLocalTaskV1(composition(f, packet, state), packet,
    { kind: 'local', workerId: worker.workerId }, at(2000)), /codex_local_delivery_unavailable/);
  assert.deepEqual({ receives: state.receives, starts: state.starts }, { receives: 0, starts: 0 }, 'revoked');

  const first = delivery(), second = delivery({ input: { prompt: 'Changed exact task.', instructions: input.instructions } });
  const f2 = await nativeTaskFixture(); t.after(f2.close); const stored = { revoked: false, receives: 0, starts: 0 };
  await deliverCodexLocalTaskV1(composition(f2, first, stored), first, { kind: 'local', workerId: worker.workerId }, at(2000));
  await assert.rejects(deliverCodexLocalTaskV1(composition(f2, second, stored), second,
    { kind: 'local', workerId: worker.workerId }, at(2000)), /codex_local_delivery_unavailable/);
  assert.equal(stored.starts, 1, 'changed replay cannot acquire a second host');
});

test('a failure after durable receipt is uncertainty and cannot be retried into another host acquisition', async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(), state = { revoked: false, receives: 0, starts: 0 }, config = composition(f, packet, state);
  config.host = { async run() { state.starts++; throw new Error('lost host response'); } };
  const first = await deliverCodexLocalTaskV1(config, packet, { kind: 'local', workerId: worker.workerId }, at(2000));
  assert.equal(first.state, 'delivery_uncertain'); assert.equal(state.starts, 1);
  const replay = await deliverCodexLocalTaskV1(config, packet, { kind: 'local', workerId: worker.workerId }, at(2000));
  assert.equal(replay.state, 'already_delivered'); assert.equal(state.starts, 1);
});
