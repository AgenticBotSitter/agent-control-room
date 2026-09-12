import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createCodexStartAdmissionV1, createCodexStartResponseDispatcherV1,
  createCodexTurnStartIntentV1 } from '../src/harness/codex-v1/admission-contract.ts';
import { CODEX_APP_SERVER_START_CONTRACT } from '../src/harness/codex-v1/schema-contract.ts';
import { SqliteCodexStartJournalV1 } from '../src/harness/codex-v1/start-journal.ts';
import { sha256Digest } from '../src/security/canonical-digest.ts';

const digest = (value: string) => sha256Digest(value);
let sequence = 0;
function makePair(options: { name?: string; jobId?: string; runId?: string; threadId?: string; turnId?: string } = {}) {
  const name = options.name ?? `journal-${++sequence}`;
  const connection = { connectionAttemptId: `connection-attempt:${name}`,
    initializedConnectionDigest: digest(`connection:${name}`) };
  const admission = createCodexStartAdmissionV1({
    schema: 'control-room.codex-start-admission/v1',
    scope: { tenantId: 'tenant:test', nodeId: 'node:test', projectId: 'project:test',
      jobId: options.jobId ?? `job:${name}`, attemptId: `attempt:${name}`,
      runId: options.runId ?? `run:${name}`, leaseId: `lease:${name}`, leaseEpoch: 1,
      operationDigest: digest(`operation:${name}`) },
    requestMessageId: `message:${name}`, deliveryDigest: digest(`delivery:${name}`),
    enrollmentDigest: digest('enrollment'), permitDigest: digest(`permit:${name}`),
    currentAdmissionDigest: digest(`current:${name}`), inputDigest: digest(`input:${name}`),
    method: 'thread/start', ...connection, threadStartRequestId: 10,
    requestedAt: '2026-09-12T12:00:00.000Z', deadline: '2026-09-12T12:05:00.000Z',
  });
  assert.equal(admission.adapter.generatedBundleSha256, CODEX_APP_SERVER_START_CONTRACT.generatedBundleSha256);
  const dispatcher = createCodexStartResponseDispatcherV1(connection);
  dispatcher.reserveThread(admission);
  const threadId = options.threadId ?? `thr_${name}`;
  const thread = dispatcher.receiveThread(admission, JSON.stringify({ id: 10, result: {
    approvalPolicy: 'never', approvalsReviewer: 'user', cwd: '/synthetic', model: 'model:test',
    modelProvider: 'provider:test', sandbox: { type: 'workspaceWrite' }, instructionSources: [],
    thread: { id: threadId, sessionId: threadId, ephemeral: false, cliVersion: 'test', createdAt: 1,
      cwd: '/synthetic', modelProvider: 'provider:test', preview: '', projectId: null, source: 'appServer',
      status: { type: 'idle' }, turns: [], updatedAt: 1 } } }), '2026-09-12T12:00:01.000Z');
  const intent = createCodexTurnStartIntentV1(thread, { turnStartRequestId: 20,
    inputDigest: admission.inputDigest, requestedAt: '2026-09-12T12:00:02.000Z',
    deadline: '2026-09-12T12:04:00.000Z' });
  dispatcher.reserveTurn(thread, intent);
  const turnId = options.turnId ?? `turn_${name}`;
  const turn = dispatcher.receiveTurn(thread, intent, JSON.stringify({ id: 20,
    result: { turn: { id: turnId, status: 'inProgress', items: [] } } }), '2026-09-12T12:00:03.000Z');
  dispatcher.close();
  return { admission, thread, turn };
}

function withJournalFile(work: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-start-journal-'));
  chmodSync(directory, 0o700);
  try { work(join(directory, 'journal.sqlite')); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const current = () => {};

test('persists the exact start identity across reopen without granting authority', () => withJournalFile(path => {
  const pair = makePair();
  let journal = new SqliteCodexStartJournalV1(path);
  assert.equal(journal.recordThread(pair.thread, current), 'recorded');
  assert.equal(journal.recordTurn(pair.thread, pair.turn, current), 'recorded');
  assert.equal(journal.recordThread(pair.thread, current), 'duplicate');
  assert.equal(journal.recordTurn(pair.thread, pair.turn, current), 'duplicate');
  journal.close();
  journal = new SqliteCodexStartJournalV1(path);
  const restored = journal.load(pair.admission.scope.runId);
  assert.equal(restored.status, 'recorded');
  assert.equal(restored.threadId, pair.thread.threadId);
  assert.equal(restored.turnId, pair.turn.turnId);
  assert.equal(restored.grantsExecutionAuthority, false);
  assert.equal(restored.permitsResume, false);
  assert.equal(restored.permitsRetry, false);
  assert.equal(restored.permitsThreadRead, false);
  journal.close();
}));

test('an interruption after thread storage remains explicit and cannot authorize a read', () => {
  const journal = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  const pair = makePair();
  assert.equal(journal.load(pair.admission.scope.runId).status, 'not_recorded');
  journal.recordThread(pair.thread, current);
  const interrupted = journal.load(pair.admission.scope.runId);
  assert.equal(interrupted.status, 'turn_not_recorded');
  assert.equal(interrupted.turnId, null);
  assert.equal(interrupted.readIdentity, null);
  assert.equal(interrupted.permitsThreadRead, false);
  journal.close();
});

test('rejects a turn without its durable thread and conflicting cross-job bindings', () => {
  const journal = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  const first = makePair({ name: 'first', runId: 'run:shared' });
  const second = makePair({ name: 'second', runId: 'run:shared' });
  assert.throws(() => journal.recordTurn(first.thread, first.turn, current));
  journal.recordThread(first.thread, current);
  assert.throws(() => journal.recordThread(second.thread, current));
  assert.throws(() => journal.recordTurn(second.thread, second.turn, current));
  assert.equal(journal.load('run:shared').status, 'turn_not_recorded');
  journal.close();
});

test('rolls back when current authority disappears at either write boundary', () => {
  const journal = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  const pair = makePair(); let calls = 0;
  assert.throws(() => journal.recordThread(pair.thread, () => { if (++calls === 2) throw new Error('revoked'); }));
  assert.equal(journal.load(pair.admission.scope.runId).status, 'not_recorded');
  journal.recordThread(pair.thread, current); calls = 0;
  assert.throws(() => journal.recordTurn(pair.thread, pair.turn, () => { if (++calls === 2) throw new Error('revoked'); }));
  assert.equal(journal.load(pair.admission.scope.runId).status, 'turn_not_recorded');
  journal.close();
});

test('refuses false, asynchronous and promise-like authority checks without writing', () => {
  const checks = [() => false, async () => {}, () => ({ then: (resolve: () => void) => resolve() })];
  for (const check of checks) {
    const journal = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
    const pair = makePair();
    assert.throws(() => journal.recordThread(pair.thread, check));
    assert.equal(journal.load(pair.admission.scope.runId).status, 'not_recorded');
    journal.close();
  }
});

test('quarantines altered stored identities', () => withJournalFile(path => {
  const pair = makePair(); let journal = new SqliteCodexStartJournalV1(path);
  journal.recordThread(pair.thread, current); journal.recordTurn(pair.thread, pair.turn, current); journal.close();
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE codex_turn_start_receipts SET turn_id=? WHERE run_id=?').run('turn_tampered', pair.admission.scope.runId);
  raw.close();
  journal = new SqliteCodexStartJournalV1(path);
  assert.throws(() => journal.load(pair.admission.scope.runId), /integrity/);
  assert.throws(() => journal.load(pair.admission.scope.runId), /unavailable/);
  journal.close();
}));

test('refuses a journal whose protected schema was changed', () => withJournalFile(path => {
  const journal = new SqliteCodexStartJournalV1(path); journal.close();
  const raw = new DatabaseSync(path); raw.exec('CREATE TABLE unexpected_state (value TEXT)'); raw.close();
  assert.throws(() => new SqliteCodexStartJournalV1(path), /unavailable/);
}));
