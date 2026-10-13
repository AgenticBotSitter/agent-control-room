import assert from 'node:assert/strict';
import test from 'node:test';
import { queueHealth } from '../scripts/worker-queue-health.mjs';

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
