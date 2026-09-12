import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createCodexReadRecovery } from '../src/harness/codex-v1/read-recovery';
import { CODEX_APP_SERVER_READ_CONTRACT } from '../src/harness/codex-v1/schema-contract';

test('read recovery is pinned to the sanitized exact-package schema evidence', () => {
  const evidence = JSON.parse(readFileSync(
    new URL('../research/codex-app-server-0.150.0-alpha.8-schema-evidence.json', import.meta.url), 'utf8'));
  assert.equal(evidence.schema, 'agent-control-room.codex-app-server-schema-evidence/v1');
  assert.equal(evidence.platformArtifactVersion, '0.150.0-alpha.8-darwin-arm64');
  assert.equal(evidence.generatedBundle, 'codex_app_server_protocol.v2.schemas.json');
  assert.equal(evidence.generatedBundleBytes, 545742);
  assert.deepEqual(evidence.threadRead.paramsRequired, ['threadId']);
  assert.equal(evidence.threadRead.includeTurnsType, 'boolean');
  assert.deepEqual({
    package: evidence.package,
    version: evidence.version,
    generatedBundleSha256: evidence.generatedBundleSha256,
    method: evidence.threadRead.method,
    includeTurns: true,
    resultRequired: evidence.threadRead.responseRequired,
    threadRequiredForProjection: evidence.threadRead.threadRequiredForProjection,
    turnRequiredForProjection: evidence.threadRead.turnRequiredForProjection,
    turnStatuses: evidence.threadRead.turnStatuses,
  }, CODEX_APP_SERVER_READ_CONTRACT);
  assert.equal(evidence.experimentalSchemaIncluded, false);
  assert.match(evidence.scope, /No provider call/);
  assert.match(evidence.scope, /no.*process-restart test/i);
});

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
