import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnedCodexRead, type CodexReadWire } from '../src/harness/codex-v1/owned-read';

const binding = { threadId: 'thread:fixture', turnId: 'turn:fixture' };
const responses = ['{"id":1,"result":{}}', JSON.stringify({ id: 2, result: { thread: { id: binding.threadId,
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
