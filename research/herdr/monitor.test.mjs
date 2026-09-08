import test from 'node:test';
import assert from 'node:assert/strict';
import { createHerdrMonitor, projectAgentList } from './monitor.mjs';

const config = { binary: '/disposable/herdr', socket: '/disposable/api.sock', configPath: '/disposable/config.toml',
  configRoot: '/disposable/config', stateRoot: '/disposable/state', machine: 'test-mac', session: 'test-session' };
const agent = { workspace_id: 'w1', tab_id: 't1', pane_id: 'p1', agent_status: 'working',
  agent_session: { source: 'herdr:hermes', agent: 'hermes', kind: 'id', value: 'synthetic-session' },
  cwd: '/private/secret', title: 'sensitive text', tokens: { secret: 'do not retain' } };
const envelope = panes => ({ id: 'cli:pane:list', result: { type: 'pane_list', panes } });

test('projection keeps advisory states and flags duplicate sessions without exposing terminal metadata', () => {
  const rows = projectAgentList(envelope([agent, { ...agent, pane_id: 'p2', agent_status: 'new-state' }]), { ...config, generation: 1 });
  assert.equal(rows[0].duplicateSession, true); assert.equal(rows[1].status, 'unknown');
  assert.notEqual(rows[0].key, rows[1].key); assert.equal(rows[0].executionAuthority, false);
  assert.equal(rows[0].completionVerified, false); assert.equal(rows[0].cleanupVerified, false);
  assert.equal(JSON.stringify(rows).includes('sensitive'), false);
  assert.equal(JSON.stringify(rows).includes('/private'), false);
  assert.equal(JSON.stringify(rows).includes('synthetic-session'), false);
  const other = projectAgentList(envelope([agent]), { ...config, machine: 'other', generation: 1 });
  assert.notEqual(other[0].key, rows[0].key); assert.notEqual(other[0].sessionKey, rows[0].sessionKey);
  assert.deepEqual(projectAgentList(envelope([{ ...agent, agent_session: null }]), { ...config, generation: 1 }), []);
});

test('disconnect, reconnect and replacement distinguish cached observations from new generation', async () => {
  let endpoint = 'socket-1', available = true, time = 0;
  const monitor = createHerdrMonitor(config, { now: () => time, identity: async () => {
    if (!available) throw new Error('offline'); return endpoint;
  }, run: async () => JSON.stringify(envelope([agent])) });
  const first = await monitor.poll(); assert.equal(first.status, 'online');
  available = false; const down = await monitor.poll(); assert.equal(down.status, 'offline');
  assert.deepEqual(down.rows, first.rows);
  available = true; const back = await monitor.poll(); assert.equal(back.generation, first.generation);
  endpoint = 'socket-2'; const restarted = await monitor.poll();
  assert.equal(restarted.generation, first.generation + 1); assert.notEqual(restarted.rows[0].key, first.rows[0].key);
  assert.equal(restarted.rows[0].sessionKey, first.rows[0].sessionKey);
  time = 5001; assert.equal(monitor.view().status, 'offline');
  assert.equal(monitor.view().completionVerified, false);
});

test('disconnect fences an in-flight result; overlapping polls are refused', async () => {
  let resolve, started;
  const ready = new Promise(r => { started = r; });
  const monitor = createHerdrMonitor(config, { identity: async () => 'one', run: () => {
    started(); return new Promise(r => { resolve = r; });
  } });
  const pending = monitor.poll(); await ready;
  await assert.rejects(monitor.poll(), /in_progress/);
  monitor.disconnect(); resolve(JSON.stringify(envelope([agent])));
  assert.equal((await pending).status, 'offline'); assert.deepEqual(monitor.view().rows, []);
});

test('malformed, duplicate and oversized observations cannot clear offline state', async () => {
  for (const response of [envelope([agent, agent]), { ...envelope([]), id: 'wrong' }, envelope(Array(1025).fill(agent)),
    envelope([{ ...agent, pane_id: '\u001bmalformed' }]), { error: { message: 'private diagnostics' } }]) {
    const monitor = createHerdrMonitor(config, { identity: async () => 'one', run: async () => JSON.stringify(response) });
    assert.equal((await monitor.poll()).status, 'offline');
  }
});

test('socket replacement during a poll refuses mixed-generation data', async () => {
  let reads = 0;
  const monitor = createHerdrMonitor(config, { identity: async () => String(++reads), run: async () => JSON.stringify(envelope([agent])) });
  assert.equal((await monitor.poll()).status, 'offline');
});
