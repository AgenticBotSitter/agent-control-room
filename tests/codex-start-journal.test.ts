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
    queueId: `queue:${name}`, requestMessageId: `message:activation:${name}`,
    activationMessageId: `message:activation:${name}`, activationId: `activation:${name}`,
    activationDigest: digest(`activation:${name}`), activationFrameDigest: digest(`activation-frame:${name}`),
    dispatchMessageId: `message:dispatch:${name}`, dispatchFrameDigest: digest(`delivery:${name}`),
    receiptMessageId: `message:receipt:${name}`, receiptFrameDigest: digest(`receipt:${name}`),
    workspacePath: '/synthetic/project',
    deliveryDigest: digest(`delivery:${name}`),
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
    approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: '/synthetic/project', model: 'model:test',
    modelProvider: 'provider:test', sandbox: { type: 'readOnly' }, instructionSources: [],
    thread: { id: threadId, sessionId: threadId, ephemeral: false, cliVersion: 'test', createdAt: 1,
      cwd: '/synthetic/project', modelProvider: 'provider:test', preview: '', projectId: null, source: 'appServer',
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
const reserve = (journal: SqliteCodexStartJournalV1, pair: ReturnType<typeof makePair>, check = current) =>
  journal.reserveStart(pair.admission, pair.admission.requestedAt, check);

test('persists the exact start identity across reopen without granting authority', () => withJournalFile(path => {
  const pair = makePair();
  let journal = new SqliteCodexStartJournalV1(path);
  assert.equal(reserve(journal, pair), 'recorded');
  assert.equal(reserve(journal, pair), 'duplicate');
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
  assert.equal(journal.load(pair.admission.scope.runId).status, 'not_reserved');
  reserve(journal, pair);
  assert.equal(journal.load(pair.admission.scope.runId).status, 'start_reserved');
  journal.recordThread(pair.thread, current);
  const interrupted = journal.load(pair.admission.scope.runId);
  assert.equal(interrupted.status, 'thread_recorded_turn_unknown');
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
  reserve(journal, first);
  journal.recordThread(first.thread, current);
  assert.throws(() => reserve(journal, second));
  assert.throws(() => journal.recordThread(second.thread, current));
  assert.throws(() => journal.recordTurn(second.thread, second.turn, current));
  assert.equal(journal.load('run:shared').status, 'thread_recorded_turn_unknown');
  journal.close();
});

test('rolls back when current authority disappears at either write boundary', () => {
  const journal = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
  const pair = makePair(); let calls = 0;
  assert.throws(() => reserve(journal, pair, () => { if (++calls === 2) throw new Error('revoked'); }));
  assert.equal(journal.load(pair.admission.scope.runId).status, 'not_reserved');
  reserve(journal, pair); calls = 0;
  assert.throws(() => journal.recordThread(pair.thread, () => { if (++calls === 2) throw new Error('revoked'); }));
  assert.equal(journal.load(pair.admission.scope.runId).status, 'start_reserved');
  journal.recordThread(pair.thread, current); calls = 0;
  assert.throws(() => journal.recordTurn(pair.thread, pair.turn, () => { if (++calls === 2) throw new Error('revoked'); }));
  assert.equal(journal.load(pair.admission.scope.runId).status, 'thread_recorded_turn_unknown');
  journal.close();
});

test('refuses false, asynchronous and promise-like authority checks without writing', () => {
  const checks = [() => false, async () => {}, () => ({ then: (resolve: () => void) => resolve() })];
  for (const check of checks) {
    const journal = new SqliteCodexStartJournalV1(':memory:', { testOnlyAllowEphemeral: true });
    const pair = makePair();
    assert.throws(() => reserve(journal, pair, check));
    assert.equal(journal.load(pair.admission.scope.runId).status, 'not_reserved');
    journal.close();
  }
});

test('quarantines altered stored identities', () => withJournalFile(path => {
  const pair = makePair(); let journal = new SqliteCodexStartJournalV1(path);
  reserve(journal, pair); journal.recordThread(pair.thread, current);
  journal.recordTurn(pair.thread, pair.turn, current); journal.close();
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

test('upgrades the receipt-only schema without treating old evidence as start authority', () => withJournalFile(path => {
  let journal = new SqliteCodexStartJournalV1(path); journal.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE codex_start_reservations; PRAGMA user_version=1;'); raw.close();
  journal = new SqliteCodexStartJournalV1(path);
  const pair = makePair({ name: 'migrated' });
  assert.equal(journal.load(pair.admission.scope.runId).status, 'not_reserved');
  assert.equal(reserve(journal, pair), 'recorded');
  journal.close();
}));

test('a populated receipt-only journal cannot reserve or send the historical start again', () => withJournalFile(path => {
  const pair = makePair({ name: 'historical' });
  let journal = new SqliteCodexStartJournalV1(path);
  reserve(journal, pair); journal.recordThread(pair.thread, current);
  journal.recordTurn(pair.thread, pair.turn, current); journal.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE codex_start_reservations; PRAGMA user_version=1;'); raw.close();
  journal = new SqliteCodexStartJournalV1(path);
  assert.equal(journal.load(pair.admission.scope.runId).status, 'not_reserved');
  assert.throws(() => reserve(journal, pair));
  assert.equal(journal.load(pair.admission.scope.runId).status, 'not_reserved');
  journal.close();
}));

test('quarantines altered reservation timing', () => withJournalFile(path => {
  const pair = makePair({ name: 'reservation-tamper' });
  let journal = new SqliteCodexStartJournalV1(path);
  reserve(journal, pair); journal.close();
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE codex_start_reservations SET reserved_at=? WHERE run_id=?')
    .run('2020-01-01T00:00:00.000Z', pair.admission.scope.runId);
  raw.close();
  journal = new SqliteCodexStartJournalV1(path);
  assert.throws(() => journal.load(pair.admission.scope.runId), /integrity/);
  journal.close();
}));
