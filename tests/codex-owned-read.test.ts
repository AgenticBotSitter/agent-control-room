import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnedCodexRead, type CodexReadWire } from '../src/harness/codex-v1/owned-read';
import { createCodexLocalReadCompositionV1, type CodexLocalReadIdentityV1 } from '../src/harness/codex-v1/local-read-composition';
import { CODEX_APP_SERVER_READ_CONTRACT } from '../src/harness/codex-v1/schema-contract';

const binding = { threadId: 'thread:fixture', turnId: 'turn:fixture' };
const responses = ['{"id":1,"result":{}}', JSON.stringify({ id: 2, result: { thread: { id: binding.threadId,
  cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
  turns: [{ id: binding.turnId, status: 'completed' }] } } })];
test('disconnect, restarted protocol and duplicate acknowledgement retire without retry or observation', async () => {
  for (const fault of ['disconnect', 'restart', 'duplicate'] as const) {
    let opens = 0, closes = 0, reads = 0;
    const sent: string[] = [];
    const operation = createOwnedCodexRead({ binding, timeoutMs: 1000, cleanupMs: 100, assertCurrent() {},
      open() {
        opens++;
        return { ready: Promise.resolve({
          async send(line: string) { sent.push(JSON.parse(line).method); },
          async readLine() {
            if (reads++ === 0) return responses[0];
            if (fault === 'disconnect') throw new Error('synthetic lost read acknowledgement');
            if (fault === 'restart') return '{"id":99,"result":{}}';
            return responses[0];
          },
        }), async close() { closes++; } };
      } });
    await assert.rejects(operation.read(new AbortController().signal), /codex_read_unavailable/);
    assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(reads, 2);
    assert.deepEqual(sent, ['initialize', 'initialized', 'thread/read']);
    await assert.rejects(operation.read(new AbortController().signal), /codex_read_unavailable/);
    assert.equal(opens, 1); assert.equal(closes, 1);
  }
});
test('owned read emits only initialization and exact read, withholding success until cleanup', async () => {
  const sent: string[] = []; let closed = 0, reads = 0;
  const operation = createOwnedCodexRead({ binding, timeoutMs: 1000, cleanupMs: 100, assertCurrent() {},
    open: () => ({ ready: Promise.resolve({ async send(line) { sent.push(JSON.parse(line).method); },
      async readLine() { return responses[reads++]; } }), async close() { closed++; } }) });
  const result = await operation.read(new AbortController().signal);
  assert.equal(result.status, 'completed'); assert.equal(result.completionVerified, false);
  assert.deepEqual(sent, ['initialize', 'initialized', 'thread/read']); assert.equal(closed, 1);
  await assert.rejects(operation.read(new AbortController().signal)); assert.equal(closed, 1);
});
test('timeout and cancellation retire pending acquisition without sending or retrying', async () => {
  for (const mode of ['timeout', 'abort'] as const) {
    const abort = new AbortController(); let closed = 0, opened = 0;
    const operation = createOwnedCodexRead({ binding, timeoutMs: 10, cleanupMs: 100, assertCurrent() {},
      open: () => { opened++; return { ready: new Promise<CodexReadWire>(() => {}), async close() { closed++; } }; } });
    const reading = operation.read(abort.signal); if (mode === 'abort') abort.abort();
    await assert.rejects(reading, /codex_read_unavailable/);
    assert.equal(closed, 1); assert.equal(opened, 1);
    await assert.rejects(operation.read(new AbortController().signal)); assert.equal(opened, 1);
  }
});
test('revocation prevents acquisition and failed cleanup prevents a successful observation', async () => {
  let opened = 0;
  const revoked = createOwnedCodexRead({ binding, timeoutMs: 100, cleanupMs: 20,
    assertCurrent() { throw new Error('revoked'); }, open() { opened++; throw new Error(); } });
  await assert.rejects(revoked.read(new AbortController().signal)); assert.equal(opened, 0);
  let index = 0;
  const uncertain = createOwnedCodexRead({ binding, timeoutMs: 1000, cleanupMs: 10, assertCurrent() {},
    open: () => ({ ready: Promise.resolve({ async send() {}, async readLine() { return responses[index++]; } }),
      close: () => new Promise<void>(() => {}) }) });
  await assert.rejects(uncertain.read(new AbortController().signal), /codex_read_cleanup_uncertain/);
  index = 0; let current = true;
  const duringClose = createOwnedCodexRead({ binding, timeoutMs: 1000, cleanupMs: 100,
    assertCurrent() { if (!current) throw new Error('synthetic revoked during close'); },
    open: () => ({ ready: Promise.resolve({ async send() {}, async readLine() { return responses[index++]; } }),
      async close() { current = false; } }) });
  await assert.rejects(duringClose.read(new AbortController().signal));
});

test('synchronous cancellation during open observes rejected readiness and closes its owned attempt', async () => {
  const abort = new AbortController(); let closes = 0;
  const operation = createOwnedCodexRead({ binding, timeoutMs: 100, cleanupMs: 100, assertCurrent() {},
    open() {
      abort.abort();
      return { ready: Promise.reject(new Error('synthetic readiness rejection')), async close() { closes++; } };
    } });
  await assert.rejects(operation.read(abort.signal), /codex_read_unavailable/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
});

test('cancelled pending send cannot advance to another protocol message after settling late', async () => {
  const abort = new AbortController(); let closes = 0, sends = 0, reads = 0;
  let release!: () => void, entered!: () => void;
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const operation = createOwnedCodexRead({ binding, timeoutMs: 1000, cleanupMs: 100, assertCurrent() {},
    open: () => ({ ready: Promise.resolve({ send() { sends++; entered(); return new Promise<void>(resolve => { release = resolve; }); },
      async readLine() { reads++; return responses[0]; } }), async close() { closes++; } }) });
  const reading = operation.read(abort.signal); await sending; abort.abort();
  await assert.rejects(reading, /codex_read_unavailable/);
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(sends, 1); assert.equal(reads, 0); assert.equal(closes, 1);
});

test('admission callbacks cannot cancel reentrantly and still permit acquisition or publication', async () => {
  const early = new AbortController(); let opens = 0;
  const beforeOpen = createOwnedCodexRead({ binding, timeoutMs: 1000, cleanupMs: 100,
    assertCurrent() { early.abort(); }, open() { opens++; throw new Error('unexpected open'); } });
  await assert.rejects(beforeOpen.read(early.signal), /codex_read_unavailable/); assert.equal(opens, 0);
  const late = new AbortController(); let closed = false, index = 0;
  const afterClose = createOwnedCodexRead({ binding, timeoutMs: 1000, cleanupMs: 100,
    assertCurrent() { if (closed) late.abort(); },
    open: () => ({ ready: Promise.resolve({ async send() {}, async readLine() { return responses[index++]; } }),
      async close() { closed = true; } }) });
  await assert.rejects(afterClose.read(late.signal), /codex_read_unavailable/); assert.equal(closed, true);
});

const composedIdentity = Object.freeze({
  tenantId: 'tenant:test', nodeId: 'node:test', projectId: 'project:test', jobId: 'job:test',
  attemptId: 'attempt:test', runId: 'run:test', leaseId: 'lease:test', leaseEpoch: 1,
  operationDigest: 'sha256:' + '1'.repeat(64), enrollmentDigest: 'sha256:' + '2'.repeat(64),
  queueId: 'queue:test', activationId: 'activation:test', activationMessageId: 'message:activation',
  activationDigest: 'sha256:' + '3'.repeat(64), activationFrameDigest: 'sha256:' + '4'.repeat(64),
  dispatchMessageId: 'message:dispatch', dispatchFrameDigest: 'sha256:' + '5'.repeat(64),
  receiptMessageId: 'message:receipt', receiptFrameDigest: 'sha256:' + '6'.repeat(64),
  workspacePath: '/synthetic/workspace', deliveryDigest: 'sha256:' + '5'.repeat(64),
  permitDigest: 'sha256:' + '7'.repeat(64), currentAdmissionDigest: 'sha256:' + '8'.repeat(64),
  connectionAttemptId: 'connection-attempt:test', threadId: binding.threadId, turnId: binding.turnId,
  source: 'correlated_codex_start_receipts' as const, grantsExecutionAuthority: false as const,
  permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const,
  completionVerified: false as const,
}) satisfies CodexLocalReadIdentityV1;

test('fixed read composition inspects only the exact durable start identity and cannot publish a result', async () => {
  let opened = 0, closed = 0, checked = 0, index = 0;
  const operation = createCodexLocalReadCompositionV1({ runId: composedIdentity.runId,
    startEvidence: { load: () => ({ status: 'recorded' as const, ...composedIdentity,
      threadReceiptDigest: 'sha256:' + '9'.repeat(64), turnReceiptDigest: 'sha256:' + 'a'.repeat(64),
      readIdentity: composedIdentity }) },
    authority: { assertCurrent(identity) { checked++; assert.equal(identity.runId, composedIdentity.runId); } },
    open(identity) { opened++; assert.equal(identity.threadId, binding.threadId); return {
      ready: Promise.resolve({ async send() {}, async readLine() { return responses[index++]; } }),
      async close() { closed++; },
    }; } });
  const result = await operation.read(new AbortController().signal);
  assert.equal(result.status, 'completed'); assert.notEqual(result.identity, composedIdentity);
  assert.deepEqual(result.identity, composedIdentity);
  assert.equal(result.canonicalPublicationAllowed, false);
  assert.equal(result.exactPackageResultQualified, false);
  assert.equal(result.permitsResume, false); assert.equal(result.permitsNewTurn, false);
  assert.equal(opened, 1); assert.equal(closed, 1); assert.ok(checked > 2);
  await assert.rejects(operation.read(new AbortController().signal), /unavailable/);
  assert.equal(opened, 1);
});

test('fixed read composition refuses missing durable identity before opening a process', async () => {
  let opened = 0;
  const operation = createCodexLocalReadCompositionV1({ runId: 'run:missing',
    startEvidence: { load: runId => ({ status: 'not_reserved' as const, runId, readIdentity: null,
      grantsExecutionAuthority: false as const, permitsResume: false as const,
      permitsRetry: false as const, permitsThreadRead: false as const }) },
    authority: { assertCurrent() { throw new Error('must not check'); } },
    open() { opened++; throw new Error('must not open'); } });
  await assert.rejects(operation.read(new AbortController().signal), /unavailable/);
  assert.equal(opened, 0);
});

test('fixed read composition rejects asynchronous authority before opening a process', async () => {
  let opened = 0;
  const operation = createCodexLocalReadCompositionV1({ runId: composedIdentity.runId,
    startEvidence: { load: () => ({ status: 'recorded' as const, ...composedIdentity,
      threadReceiptDigest: 'sha256:' + '9'.repeat(64), turnReceiptDigest: 'sha256:' + 'a'.repeat(64),
      readIdentity: composedIdentity }) },
    authority: { assertCurrent: (() => Promise.resolve()) as never },
    open() { opened++; throw new Error('must not open'); } });
  await assert.rejects(operation.read(new AbortController().signal), /unavailable/);
  assert.equal(opened, 0);
});
