import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sha256Digest } from '../src/security/canonical-digest.ts';
import { codexReadIdentityFromStartV1, createCodexStartAdmissionV1,
  createCodexStartResponseDispatcherV1, createCodexTurnStartIntentV1 } from
  '../src/harness/codex-v1/admission-contract.ts';
import { CODEX_APP_SERVER_START_CONTRACT } from '../src/harness/codex-v1/schema-contract.ts';

const digest = (value: string) => sha256Digest(value);
const connectionValues = (name = 'test') => ({ connectionAttemptId: `connection-attempt:${name}`,
  initializedConnectionDigest: digest(`initialized-connection:${name}`) });
const base = (name = 'test', scope: { jobId?: string; runId?: string } = {}) => createCodexStartAdmissionV1({
  schema: 'control-room.codex-start-admission/v1',
  scope: { tenantId: 'tenant:test', nodeId: 'node:test', projectId: 'project:test',
    jobId: scope.jobId ?? 'job:test', attemptId: 'attempt:test', runId: scope.runId ?? 'run:test',
    leaseId: 'lease:test', leaseEpoch: 2, operationDigest: digest('operation') },
  queueId: `queue:${name}`, requestMessageId: `message:codex-activation:${name}`,
  activationMessageId: `message:codex-activation:${name}`,
  activationId: `activation:${name}`, activationDigest: digest(`activation:${name}`),
  activationFrameDigest: digest(`activation-frame:${name}`),
  dispatchMessageId: `message:codex-dispatch:${name}`, dispatchFrameDigest: digest(`delivery:${name}`),
  receiptMessageId: `message:codex-receipt:${name}`, receiptFrameDigest: digest(`receipt:${name}`),
  workspacePath: '/synthetic/project',
  deliveryDigest: digest(`delivery:${name}`),
  enrollmentDigest: digest('enrollment'), permitDigest: digest('permit'),
  currentAdmissionDigest: digest('admission'), inputDigest: digest('input'),
  method: 'thread/start', ...connectionValues(name), threadStartRequestId: 10,
  requestedAt: '2026-09-12T12:00:00.000Z', deadline: '2026-09-12T12:05:00.000Z',
});
const threadResponse = (id = 10, threadId = 'thr_123') => JSON.stringify({ id,
  result: { approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: '/synthetic/project', model: 'model:test',
    modelProvider: 'provider:test', sandbox: { type: 'readOnly' }, instructionSources: [],
    thread: { id: threadId, sessionId: threadId, ephemeral: false, cliVersion: '0.150.0-alpha.8',
      createdAt: 1, cwd: '/synthetic/project', modelProvider: 'provider:test', preview: '', projectId: null,
      source: 'appServer', status: { type: 'idle' }, turns: [], updatedAt: 1 } } });
const turnResponse = (id = 30, turnId = 'turn_456', status = 'inProgress') => JSON.stringify({ id,
  result: { turn: { id: turnId, status, items: [], error: null } } });
let connectionSequence = 0;
const startThread = (name = `start-${++connectionSequence}`, admission = base(name), raw = threadResponse()) => {
  const dispatcher = createCodexStartResponseDispatcherV1(connectionValues(name));
  dispatcher.reserveThread(admission);
  const thread = dispatcher.receiveThread(admission, raw, '2026-09-12T12:00:01.000Z');
  return { admission, dispatcher, thread };
};
const makeIntent = (thread: ReturnType<typeof startThread>['thread'], inputDigest = digest('input')) =>
  createCodexTurnStartIntentV1(thread, { turnStartRequestId: 30, inputDigest,
    requestedAt: '2026-09-12T12:00:02.000Z', deadline: '2026-09-12T12:04:00.000Z' });
const startTurn = (started: ReturnType<typeof startThread>, raw = turnResponse()) => {
  const intent = makeIntent(started.thread);
  started.dispatcher.reserveTurn(started.thread, intent);
  const turn = started.dispatcher.receiveTurn(started.thread, intent, raw, '2026-09-12T12:00:03.000Z');
  return { intent, turn };
};

test('start admission is pinned to sanitized exact-package generated schemas', () => {
  const evidence = JSON.parse(readFileSync(new URL(
    '../research/codex-app-server-0.150.0-alpha.8-start-schema-evidence.json', import.meta.url), 'utf8'));
  assert.deepEqual({ package: evidence.package, version: evidence.version,
    generatedBundleSha256: evidence.generatedBundleSha256,
    threadStart: { method: evidence.threadStart.method, paramsSchemaSha256: evidence.threadStart.paramsSchemaSha256,
      responseSchemaSha256: evidence.threadStart.responseSchemaSha256,
      responseRequired: evidence.threadStart.responseRequired,
      threadRequiredForAdmission: evidence.threadStart.threadRequiredForAdmission },
    turnStart: { method: evidence.turnStart.method, paramsSchemaSha256: evidence.turnStart.paramsSchemaSha256,
      responseSchemaSha256: evidence.turnStart.responseSchemaSha256,
      paramsRequired: evidence.turnStart.paramsRequired, responseRequired: evidence.turnStart.responseRequired,
      turnRequiredForAdmission: evidence.turnStart.turnRequiredForAdmission,
      initialStatus: evidence.turnStart.initialStatus } }, CODEX_APP_SERVER_START_CONTRACT);
  assert.equal(evidence.experimentalSchemaIncluded, false);
  assert.match(evidence.scope, /No provider call/);
});

test('binds one owned connection, persistent thread and in-progress turn to one exact job', () => {
  const started = startThread(), { intent, turn } = startTurn(started);
  const identity = codexReadIdentityFromStartV1(started.thread, turn);
  assert.deepEqual({ tenantId: identity.tenantId, projectId: identity.projectId, jobId: identity.jobId,
    runId: identity.runId, threadId: identity.threadId, turnId: identity.turnId },
  { tenantId: 'tenant:test', projectId: 'project:test', jobId: 'job:test', runId: 'run:test',
    threadId: 'thr_123', turnId: 'turn_456' });
  assert.equal(turn.startAccepted, true);
  for (const value of [started.admission, started.thread, intent, turn, identity]) {
    assert.equal(value.grantsExecutionAuthority, false);
    assert.equal(value.permitsResume, false);
    assert.equal(value.permitsRetry, false);
  }
  assert.equal(identity.permitsThreadRead, false);
  assert.equal(identity.completionVerified, false);
});

test('dispatcher consumes bad thread responses once and refuses connection or request reuse', () => {
  const invalid = [threadResponse(11),
    JSON.stringify({ id: 10, result: { thread: { id: 'thr_123', sessionId: 'thr_other', ephemeral: false } } }),
    JSON.stringify({ id: 10, result: { thread: { id: 'thr_123', sessionId: 'thr_123', ephemeral: true } } }),
    '{not-json}', `${threadResponse()}\n`];
  for (const raw of invalid) {
    const name = `bad-${++connectionSequence}`;
    const admission = base(name), dispatcher = createCodexStartResponseDispatcherV1(connectionValues(name));
    dispatcher.reserveThread(admission);
    assert.throws(() => dispatcher.receiveThread(admission, raw, '2026-09-12T12:00:01.000Z'));
    assert.throws(() => dispatcher.receiveThread(admission, threadResponse(), '2026-09-12T12:00:01.000Z'));
  }
  const wrong = createCodexStartResponseDispatcherV1(connectionValues('wrong-connection'));
  assert.throws(() => wrong.reserveThread(base()));
});

test('one connection has one outstanding request and never reuses a JSON-RPC id', () => {
  const dispatcher = createCodexStartResponseDispatcherV1(connectionValues('single-owner'));
  assert.throws(() => createCodexStartResponseDispatcherV1({ ...connectionValues('single-owner') }));
  const first = base('single-owner'), second = base('single-owner', { jobId: 'job:other', runId: 'run:other' });
  dispatcher.reserveThread(first);
  assert.throws(() => dispatcher.reserveThread(second));
  const thread = dispatcher.receiveThread(first, threadResponse(), '2026-09-12T12:00:01.000Z');
  const reused = createCodexTurnStartIntentV1(thread, { turnStartRequestId: 10, inputDigest: digest('input'),
    requestedAt: '2026-09-12T12:00:02.000Z', deadline: '2026-09-12T12:04:00.000Z' });
  assert.throws(() => dispatcher.reserveTurn(thread, reused));
  dispatcher.close();
  assert.throws(() => dispatcher.reserveTurn(thread, makeIntent(thread)));
});

test('rejects uncorrelated, non-started or wrong-input turn responses without retry', () => {
  for (const raw of [turnResponse(31), turnResponse(30, 'turn_456', 'completed'), '{bad-json}']) {
    const started = startThread(), intent = makeIntent(started.thread);
    started.dispatcher.reserveTurn(started.thread, intent);
    assert.throws(() => started.dispatcher.receiveTurn(started.thread, intent, raw, '2026-09-12T12:00:03.000Z'));
    assert.throws(() => started.dispatcher.receiveTurn(started.thread, intent, turnResponse(), '2026-09-12T12:00:03.000Z'));
  }
  const started = startThread(), wrong = makeIntent(started.thread, digest('other-input'));
  assert.throws(() => started.dispatcher.reserveTurn(started.thread, wrong));
});

test('rejects valid receipts copied between jobs or connections', () => {
  const first = startThread(), firstTurn = startTurn(first).turn;
  const secondAdmission = base('other', { jobId: 'job:other', runId: 'run:other' });
  const second = startThread('other', secondAdmission, threadResponse(10, 'thr_other'));
  const secondTurn = startTurn(second, turnResponse(30, 'turn_other')).turn;
  assert.throws(() => codexReadIdentityFromStartV1(first.thread, secondTurn));
  assert.throws(() => codexReadIdentityFromStartV1(second.thread, firstTurn));
});

test('never accepts notifications and rejects recomputed invalid parent or nested lineage', () => {
  const admission = base('notification'), dispatcher = createCodexStartResponseDispatcherV1(connectionValues('notification'));
  dispatcher.reserveThread(admission);
  assert.throws(() => dispatcher.receiveThread(admission,
    JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thr_123' } } }),
  '2026-09-12T12:00:01.000Z'));

  const started = startThread(), intent = makeIntent(started.thread);
  const malformedIntent = { ...intent, requestedAt: '2026-09-12T11:59:00.000Z' };
  const { intentDigest: _intentDigest, ...unsignedIntent } = malformedIntent; void _intentDigest;
  malformedIntent.intentDigest = sha256Digest(unsignedIntent);
  assert.throws(() => started.dispatcher.reserveTurn(started.thread, malformedIntent));

  const turn = structuredClone(startTurn(started).turn);
  turn.threadReceipt.threadId = 'thr_other'; turn.threadReceipt.sessionId = 'thr_other';
  const { receiptDigest: _threadDigest, ...unsignedThread } = turn.threadReceipt; void _threadDigest;
  turn.threadReceipt.receiptDigest = sha256Digest(unsignedThread);
  turn.intent.threadReceiptDigest = turn.threadReceipt.receiptDigest;
  const { intentDigest: _nestedIntentDigest, ...unsignedNestedIntent } = turn.intent; void _nestedIntentDigest;
  turn.intent.intentDigest = sha256Digest(unsignedNestedIntent);
  const { receiptDigest: _turnDigest, ...unsignedTurn } = turn; void _turnDigest;
  turn.receiptDigest = sha256Digest(unsignedTurn);
  assert.throws(() => codexReadIdentityFromStartV1(started.thread, turn));
});
