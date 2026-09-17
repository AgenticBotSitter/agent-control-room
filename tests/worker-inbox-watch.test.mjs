import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboxPoller } from '../scripts/worker-inbox-watch.mjs';
import { queueHealth } from '../scripts/worker-queue-health.mjs';

test('watcher deduplicates, reports outage once, recovers and emits new corrections', async () => {
  const output = [];
  let actions = [];
  let failure = false;
  const poll = createInboxPoller({ workerId: 'worker-01', emit: text => output.push(text), read: async () => {
    if (failure) throw new Error('private-token-must-not-appear');
    return actions;
  } });
  assert.equal(await poll(), true);
  assert.equal(await poll(), false);
  failure = true;
  await poll(); await poll();
  assert.equal(output.length, 2);
  assert.doesNotMatch(output.join(''), /private-token/);
  failure = false;
  await poll();
  actions = [{ issue: 1, state: 'changes-required', trust: 'controller-record', disposition: 'action', action: 'Correct work', acknowledged: false }];
  await poll(); await poll();
  assert.equal(output.length, 4);
  actions = [{ ...actions[0], acknowledged: true }];
  assert.equal(await poll(), true);
});

test('configured broker failure does not emit or replace the last good fingerprint', async () => {
  const output = [];
  let fail = false;
  const broker = { url: 'http://127.0.0.1:9999/v1/worker-operations', token: 'synthetic-token' };
  const poll = createInboxPoller({ workerId: 'worker-01', broker, emit: text => output.push(text), read: async options => {
    assert.equal(options.broker, broker);
    if (fail) throw new Error('worker_inbox_broker_unavailable');
    return [];
  } });
  assert.equal(await poll(), true);
  fail = true;
  assert.equal(await poll(), false);
  fail = false;
  assert.equal(await poll(), false);
  assert.equal(output.length, 1);
});

test('health distinguishes stalled correction, review, stop, conflict and fresh work', () => {
  const old = { requestedAt: '2026-01-01T00:00:00Z', workerId: 'worker-01' };
  const alerts = queueHealth([
    { ...old, issue: 1, markerState: 'changes-required', acknowledged: false },
    { ...old, issue: 2, markerState: 'changes-required', acknowledged: true },
    { ...old, issue: 3, disposition: 'waiting' },
    { ...old, issue: 4, disposition: 'attention' },
    { ...old, issue: 5, disposition: 'stop' },
    { ...old, issue: 6, markerState: 'changes-required', requestedAt: '2026-01-01T01:59:00Z' },
  ], { now: Date.parse('2026-01-01T02:00:00Z') });
  assert.deepEqual(alerts.map(a => a.issue), [1, 3, 4, 5]);
});
