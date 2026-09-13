import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexOwnedStartV1 } from '../src/harness/codex-v1/owned-start.ts';
import { createCodexStartJsonlV1 } from '../src/harness/codex-v1/start-jsonl.ts';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const binding = { connectionAttemptId: 'connection-attempt:start-transport',
  initializedConnectionDigest: `sha256:${'1'.repeat(64)}`, threadStartRequestId: 10, turnStartRequestId: 20 };

test('close is a barrier for a timed-out write that ignores cancellation', async () => {
  const events: string[] = [];
  const transport = createCodexStartJsonlV1({
    timeoutMs: 100,
    connection: {
      writeLine: async () => { await delay(150); events.push('late-write-finished'); },
      readLine: async () => undefined,
      close: async () => { events.push('close-called'); },
    },
  });
  const startedAt = Date.now();
  await assert.rejects(transport.initialize(() => {}), /timeout/);
  await transport.close();
  assert.deepEqual(events, ['close-called', 'late-write-finished']);
  assert.ok(Date.now() - startedAt >= 140);
  await delay(30);
  assert.deepEqual(events, ['close-called', 'late-write-finished']);
});

test('late open is owned and closed before cleanup can succeed', async () => {
  const events: string[] = [];
  const owned = createCodexOwnedStartV1({
    binding, timeoutMs: 100, cleanupMs: 500,
    open: () => {
      const ready = delay(150).then(() => { events.push('late-ready-finished'); return {
        writeLine: async () => {}, readLine: async () => undefined,
        close: async () => { events.push('connection-closed'); },
      }; });
      return { ready, async close() { const wire = await ready; await wire.close(); events.push('owner-closed'); } };
    },
  });
  await assert.rejects(owned.startThread({ activation: {} as never, admission: {} as never,
    assertCurrent: () => {} }), /unavailable/);
  assert.deepEqual(events, ['late-ready-finished', 'connection-closed', 'owner-closed']);
  await owned.close();
  await delay(30);
  assert.deepEqual(events, ['late-ready-finished', 'connection-closed', 'owner-closed']);
});

test('thread and turn failures each await their synchronous owner exactly once', async () => {
  for (const failure of ['thread', 'turn'] as const) {
    const responses = ['{"id":1,"result":{}}', failure === 'thread' ? undefined : '{"id":10,"result":{}}', undefined];
    let wireCloses = 0, ownerCloses = 0;
    const owned = createCodexOwnedStartV1({ binding, timeoutMs: 100, cleanupMs: 200,
      open: () => ({ ready: Promise.resolve({ async writeLine() {}, async readLine() { return responses.shift(); },
        async close() { wireCloses++; } }), async close() { ownerCloses++; } }) });
    const activation = { workspacePath: '/synthetic/workspace', instructions: '', prompt: 'work' } as never;
    const admission = { threadStartRequestId: 10 } as never;
    if (failure === 'thread') {
      await assert.rejects(owned.startThread({ activation, admission, assertCurrent() {} }), /unavailable/);
    } else {
      await owned.startThread({ activation, admission, assertCurrent() {} });
      await assert.rejects(owned.startTurn({ activation, thread: { threadId: 'thread:test' } as never,
        intent: { turnStartRequestId: 20 } as never, assertCurrent() {} }), /unavailable/);
    }
    assert.equal(wireCloses, 1); assert.equal(ownerCloses, 1);
    await owned.close(); assert.equal(wireCloses, 1); assert.equal(ownerCloses, 1);
  }
});
