import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexOwnedStartV1 } from '../src/harness/codex-v1/owned-start.ts';
import { createCodexStartJsonlV1 } from '../src/harness/codex-v1/start-jsonl.ts';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

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
    timeoutMs: 100,
    open: async () => {
      await delay(150); events.push('late-open-finished');
      return {
        writeLine: async () => {}, readLine: async () => undefined,
        close: async () => { events.push('connection-closed'); },
      };
    },
  });
  await assert.rejects(owned.startThread({ activation: {} as never, admission: {} as never,
    assertCurrent: () => {} }), /unavailable/);
  await owned.close();
  assert.deepEqual(events, ['late-open-finished', 'connection-closed']);
  await delay(30);
  assert.deepEqual(events, ['late-open-finished', 'connection-closed']);
});
