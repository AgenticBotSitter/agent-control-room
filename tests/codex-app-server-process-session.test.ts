import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexAppServerProcessSessionV1, type CodexAppServerProcessBytePortV1,
  type CodexAppServerProcessBindingV1 } from '../src/harness/codex-v1/app-server-process-session';
import type { OwnedCodexStartConnectionV1 } from '../src/harness/codex-v1/owned-start';

const encoder = new TextEncoder();
const binding = Object.freeze({ mode: 'initial' as const,
  connectionAttemptId: 'connection-attempt:process-session',
  initializedConnectionDigest: `sha256:${'1'.repeat(64)}`,
  threadStartRequestId: 10, turnStartRequestId: 20 });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function processFixture(options: {
  stdout?: Uint8Array[];
  stderr?: Uint8Array[];
  write?: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  closeStdin?: (signal: AbortSignal) => Promise<void>;
  stdoutRead?: (signal: AbortSignal) => Promise<Uint8Array | undefined>;
  stderrRead?: (signal: AbortSignal) => Promise<Uint8Array | undefined>;
  prematureStdoutEof?: boolean;
  terminate?: () => Promise<void>;
  exit?: Promise<{ code: number | null; signal: string | null }>;
} = {}) {
  const terminal = deferred<{ code: number | null; signal: string | null }>();
  const stdoutEnd = deferred<Uint8Array | undefined>();
  const events: string[] = [], writes: Uint8Array[] = [];
  const stdout = [...(options.stdout ?? [])], stderr = [...(options.stderr ?? [])];
  const port: CodexAppServerProcessBytePortV1 = {
    async writeStdin(bytes, signal) {
      writes.push(Uint8Array.from(bytes)); events.push('write');
      await (options.write?.(bytes, signal) ?? Promise.resolve());
    },
    async readStdout(signal) {
      if (options.stdoutRead) return options.stdoutRead(signal);
      const chunk = stdout.shift();
      if (chunk !== undefined) return chunk;
      return options.prematureStdoutEof ? undefined : stdoutEnd.promise;
    },
    async readStderr(signal) { return options.stderrRead ? options.stderrRead(signal) : stderr.shift(); },
    async closeStdin(signal) { events.push('close-stdin'); await options.closeStdin?.(signal); },
    async terminate() { events.push('terminate'); await options.terminate?.();
      stdoutEnd.resolve(undefined);
      terminal.resolve({ code: null, signal: 'SIGTERM' }); },
    exited: options.exit ?? terminal.promise,
  };
  return { port, events, writes, terminal };
}

function session(fixture: ReturnType<typeof processFixture>, options: {
  selectedBinding?: CodexAppServerProcessBindingV1;
  cleanupMs?: number;
  ownerClose?: () => Promise<void>;
} = {}) {
  let acquired = 0, ownerCloses = 0; let observedBinding: CodexAppServerProcessBindingV1 | undefined;
  const value = createCodexAppServerProcessSessionV1({ binding: options.selectedBinding ?? binding,
    signal: new AbortController().signal, cleanupMs: options.cleanupMs ?? 100,
    acquire(selected) { acquired++; observedBinding = selected; return {
      ready: Promise.resolve(fixture.port), async close() { ownerCloses++; await options.ownerClose?.(); },
    }; } }) as OwnedCodexStartConnectionV1;
  return { value, acquired: () => acquired, ownerCloses: () => ownerCloses,
    observedBinding: () => observedBinding };
}

test('owned process session binds one attempt and frames fragmented UTF-8 JSONL without exposing stderr', async () => {
  const response = encoder.encode('{"id":1,"result":{"text":"café"}}\n');
  const split = response.indexOf(0xc3) + 1;
  const f = processFixture({ stdout: [response.slice(0, split), response.slice(split)],
    stderr: [encoder.encode('synthetic secret-like stderr is discarded\n')] });
  const operation = session(f), wire = await operation.value.ready;
  assert.deepEqual(operation.observedBinding(), binding); assert.equal(operation.acquired(), 1);
  await wire.writeLine('{"id":1,"method":"initialize","params":{}}\n', new AbortController().signal);
  assert.equal(await wire.readLine(new AbortController().signal), '{"id":1,"result":{"text":"café"}}');
  await operation.value.close(); await operation.value.close();
  assert.deepEqual(f.events, ['write', 'close-stdin', 'terminate']);
  assert.equal(operation.ownerCloses(), 1);
  assert.equal(new TextDecoder().decode(f.writes[0]), '{"id":1,"method":"initialize","params":{}}\n');
  assert.doesNotMatch(JSON.stringify({ events: f.events }), /secret-like/);
});

test('process session rejects CR, invalid UTF-8, overlong, aggregate and unterminated stdout', async () => {
  const overlong = new Uint8Array(262_146).fill(97); overlong[overlong.length - 1] = 10;
  const faults = [
    encoder.encode('{"id":1}\r\n'),
    Uint8Array.from([0xc3, 0x28, 0x0a]),
    overlong,
    new Uint8Array(524_289).fill(10),
    encoder.encode('{"id":1}'),
  ];
  for (const stdout of faults) {
    const f = processFixture({ stdout: [stdout], prematureStdoutEof: true });
    const operation = session(f, { cleanupMs: 200 });
    const wire = await operation.value.ready;
    await assert.rejects(wire.readLine(new AbortController().signal), /process_session_unavailable/);
    await assert.rejects(operation.value.close(), /cleanup_uncertain/);
    assert.deepEqual(f.events, ['close-stdin', 'terminate']);
    assert.equal(operation.acquired(), 1); assert.equal(operation.ownerCloses(), 1);
  }
});

test('stdout EOF before owned close withholds even an otherwise complete response line', async () => {
  const f = processFixture({ stdout: [encoder.encode('{"id":1}\n')], prematureStdoutEof: true });
  const operation = session(f, { cleanupMs: 200 }), wire = await operation.value.ready;
  await assert.rejects(wire.readLine(new AbortController().signal), /process_session_unavailable/);
  await assert.rejects(operation.value.close(), /cleanup_uncertain/);
  assert.deepEqual(f.events, ['close-stdin', 'terminate']);
});

test('stderr is bounded, validated, discarded and cannot escape through errors', async () => {
  for (const bytes of [new Uint8Array(65_537).fill(115), Uint8Array.from([0xc3, 0x28])]) {
    const f = processFixture({ stderr: [bytes] }), operation = session(f, { cleanupMs: 200 });
    const wire = await operation.value.ready;
    await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(wire.readLine(new AbortController().signal), error => {
      assert.doesNotMatch(String(error), /ssss|Ã|synthetic/); return true;
    });
    await assert.rejects(operation.value.close(), /cleanup_uncertain/);
    assert.equal(operation.ownerCloses(), 1);
  }
});

test('stdout and stderr reader rejection during close makes cleanup uncertain', async () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const pending = deferred<Uint8Array | undefined>();
    const f = processFixture({
      ...(stream === 'stdout' ? { stdoutRead: async () => pending.promise }
        : { stderrRead: async () => pending.promise }),
      terminate: async () => { pending.reject(new Error('synthetic reader failure')); },
    });
    const operation = session(f, { cleanupMs: 200 });
    await operation.value.ready;
    await assert.rejects(operation.value.close(), /cleanup_uncertain/);
    assert.equal(operation.ownerCloses(), 1);
    assert.deepEqual(f.events, ['close-stdin', 'terminate']);
  }
});

test('ordinary close immediately rejects a pending line wait and still proves process retirement', async () => {
  const stdout = deferred<Uint8Array | undefined>();
  const f = processFixture({ stdoutRead: async () => stdout.promise,
    terminate: async () => { stdout.resolve(undefined); } });
  const operation = session(f, { cleanupMs: 200 }), wire = await operation.value.ready;
  const reading = wire.readLine(new AbortController().signal);
  const closing = operation.value.close();
  await assert.rejects(reading, /process_session_unavailable/);
  await closing;
  assert.deepEqual(f.events, ['close-stdin', 'terminate']); assert.equal(operation.ownerCloses(), 1);
});

test('unexpected or malformed process exit is fatal and malformed exit makes cleanup uncertain', async () => {
  const early = processFixture({ exit: Promise.resolve({ code: 0, signal: null }) });
  const stopped = session(early), stoppedWire = await stopped.value.ready;
  await assert.rejects(stoppedWire.readLine(new AbortController().signal), /process_session_unavailable/);
  await stopped.value.close(); assert.equal(stopped.ownerCloses(), 1);

  for (const evidence of [
    { code: 1.5, signal: null },
    { code: null, signal: null },
    { code: 1, signal: 'SIGTERM' },
  ]) {
    const malformed = processFixture({ exit: Promise.resolve(evidence as never) });
    const invalid = session(malformed), invalidWire = await invalid.value.ready;
    await assert.rejects(invalidWire.readLine(new AbortController().signal), /process_session_unavailable/);
    await assert.rejects(invalid.value.close(), /cleanup_uncertain/);
    assert.equal(invalid.ownerCloses(), 1);
  }
});

test('aborted backpressure and stalled cleanup are terminal, terminate is attempted, and output is withheld', async () => {
  const pending = deferred<void>();
  const f = processFixture({ write: async () => pending.promise,
    closeStdin: async () => new Promise<void>(() => {}) });
  const operation = session(f, { cleanupMs: 40 }), wire = await operation.value.ready;
  const abort = new AbortController(), writing = wire.writeLine('{"id":1}\n', abort.signal);
  abort.abort();
  await assert.rejects(writing, /process_session_unavailable/);
  await assert.rejects(operation.value.close(), /cleanup_uncertain/);
  assert.ok(f.events.includes('terminate')); assert.equal(operation.ownerCloses(), 1);
  assert.equal(operation.acquired(), 1);
  pending.resolve();
});

test('recover binding carries one fresh process connection and the exact durable thread and turn', async () => {
  const recover = Object.freeze({ mode: 'recover' as const, runId: 'run:test',
    connectionAttemptId: 'connection-attempt:recover-process',
    initializedConnectionDigest: `sha256:${'2'.repeat(64)}`,
    threadId: 'thread:durable', turnId: 'turn:durable' });
  const f = processFixture({ stdout: [encoder.encode('{"id":1,"result":{}}\n')] });
  const operation = session(f, { selectedBinding: recover });
  await operation.value.ready;
  assert.deepEqual(operation.observedBinding(), recover); assert.equal(operation.acquired(), 1);
  await operation.value.close();
});
