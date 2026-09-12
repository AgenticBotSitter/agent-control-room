import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedNativeSessions } from '../src/web/v1/managed-native-sessions';

test('session admission requires a completed synchronous availability check', async () => {
  let effects = 0;
  const unexpected = async (): Promise<never> => { effects++; throw new Error('unexpected effect'); };
  const scope = { tenantId: 'tenant:fixture', workspaceId: 'workspace:fixture' };
  const settings = { nodes: [{ ...scope, nodeId: 'node:fixture', nodeKeyId: 'key:fixture', serverId: 'server:fixture',
    serverKeyId: 'key:server', serverPublicKeySpki: 'synthetic-public-key', transportIdentity: 'transport:fixture',
    features: [], maxFrameBytes: 4096, heartbeatIntervalSeconds: 30 }], sign: unexpected };
  // Configuration does not accept workspaceId on the node descriptor.
  const { workspaceId: omitted, ...node } = settings.nodes[0]; void omitted;
  for (const check of [undefined, () => false, () => Promise.resolve(), () => Promise.reject(new Error('synthetic pending check'))]) {
    const manager = new ManagedNativeSessions({ query: unexpected, transaction: unexpected, transactionWithPreCommitCheck: unexpected },
      { ...settings, nodes: [node] }, scope,
      { stage: unexpected, transmit: unexpected, receipt: unexpected, progress: unexpected },
      unexpected, check ?? (() => {}), () => 1);
    if (check) assert.throws(() => manager.queueAttention());
    else assert.equal(manager.queueAttention().unavailableNodes, 1);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  for (const state of [true, false, undefined, 'ready', 'fulfilled', 'rejected']) {
    let closes = 0;
    const manager = new ManagedNativeSessions({ query: unexpected, transaction: unexpected, transactionWithPreCommitCheck: unexpected },
      { ...settings, nodes: [node] }, scope,
      { stage: unexpected, transmit: unexpected, receipt: unexpected, progress: unexpected },
      async work => work(), () => {}, () => 1);
    const transport = { send: unexpected, async close() { closes++; },
      isAvailable: (() => state === 'fulfilled' ? Promise.resolve(true)
        : state === 'rejected' ? Promise.reject(new Error('synthetic transport uncertainty')) : state) as () => boolean };
    if (state === true) await manager.attach(node.nodeId, transport);
    else await assert.rejects(manager.attach(node.nodeId, transport));
    await manager.close();
    assert.equal(closes, 1);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.throws(() => new ManagedNativeSessions(
    { query: unexpected, transaction: unexpected, transactionWithPreCommitCheck: unexpected },
    { ...settings, nodes: [node] }, scope,
    { queue: { locate: unexpected, stage: unexpected, transmit: unexpected, codexStage: unexpected },
      stage: unexpected, transmit: unexpected, receipt: unexpected, progress: unexpected },
    unexpected, () => {}, () => 1), /native_sessions_config_invalid/);
  assert.equal(effects, 0);
});
