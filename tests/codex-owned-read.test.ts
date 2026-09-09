import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnedCodexRead, type CodexReadWire } from '../src/harness/codex-v1/owned-read';

const binding = { threadId: 'thread:fixture', turnId: 'turn:fixture' };
const responses = ['{"id":1,"result":{}}', JSON.stringify({ id: 2, result: { thread: { id: binding.threadId,
  turns: [{ id: binding.turnId, status: 'completed' }] } } })];
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
