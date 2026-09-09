import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexReadRecovery } from '../src/harness/codex-v1/read-recovery';

test('read recovery projects only the exact saved turn and never promotes snapshots to authority', () => {
  const binding = { threadId: 'thread:fixture', turnId: 'turn:fixture' };
  const read = createCodexReadRecovery(binding); binding.threadId = 'thread:changed';
  assert.deepEqual(read.request, { method: 'thread/read', params: { threadId: 'thread:fixture', includeTurns: true } });
  assert.equal(Object.isFrozen(read.request.params), true);
  for (const status of ['inProgress', 'completed', 'failed', 'interrupted']) {
    const result = read.project(JSON.stringify({ thread: { id: 'thread:fixture', cwd: '/private/synthetic',
      turns: [{ id: 'turn:other', status: 'completed' }, { id: 'turn:fixture', status,
        items: [{ text: 'PRIVATE TRANSCRIPT' }], tokenUsage: { totalTokens: 100 } }] } }));
    assert.deepEqual(result, { threadId: 'thread:fixture', turnId: 'turn:fixture', status,
      source: 'stored_thread_read', usage: 'unknown', completionVerified: false, cleanupVerified: false, grantsExecutionAuthority: false });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|synthetic|totalTokens/);
  }
  assert.equal(read.project(JSON.stringify({ thread: { id: 'thread:fixture', turns: [] } })).status, 'not_observed');
});

test('read recovery refuses foreign, duplicate, missing and oversized evidence without fallback', () => {
  const read = createCodexReadRecovery({ threadId: 'thread:fixture', turnId: 'turn:fixture' });
  const turn = { id: 'turn:fixture', status: 'completed' };
  for (const value of [{ thread: { id: 'thread:other', turns: [turn] } },
    { thread: { id: 'thread:fixture', turns: [turn, turn] } }, { thread: { id: 'thread:fixture' } },
    { thread: { id: 'thread:fixture', turns: [{ ...turn, status: 'unknown' }] } },
    { thread: { id: 'thread:fixture', turns: [], extra: 'x'.repeat(262_144) } }])
    assert.throws(() => read.project(JSON.stringify(value)), /codex_read_recovery_unavailable/);
  assert.throws(() => createCodexReadRecovery({ threadId: 'thread:fixture', turnId: '' }));
  assert.throws(() => read.project('{'), /codex_read_recovery_unavailable/);
});
