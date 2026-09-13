import { z } from 'zod';
import { digestSchema, localId } from '../v1/native-run-identifiers';
import type { CodexStartJsonlConnectionV1 } from './start-jsonl';
import type { CodexReadWire, OwnedCodexReadConnection } from './owned-read';
import type { CodexStartConnectionBindingV1, OwnedCodexStartConnectionV1 } from './owned-start';

const MAX_LINE_BYTES = 262_144;
const MAX_BUFFERED_STDOUT_BYTES = 524_288;
const MAX_STDERR_BYTES = 65_536;

const initialBindingSchema = z.object({ mode: z.literal('initial'),
  connectionAttemptId: localId, initializedConnectionDigest: digestSchema,
  threadStartRequestId: z.number().int().positive(), turnStartRequestId: z.number().int().positive(),
}).strict().refine(value => value.threadStartRequestId !== value.turnStartRequestId);
const recoverBindingSchema = z.object({ mode: z.literal('recover'), runId: localId,
  connectionAttemptId: localId, initializedConnectionDigest: digestSchema,
  threadId: localId, turnId: localId,
}).strict();
const bindingSchema = z.discriminatedUnion('mode', [initialBindingSchema, recoverBindingSchema]);

export type CodexAppServerProcessBindingV1 = z.infer<typeof bindingSchema>;
export function parseCodexAppServerProcessBindingV1(value: unknown): CodexAppServerProcessBindingV1 {
  return Object.freeze(bindingSchema.parse(value));
}

export interface CodexAppServerProcessBytePortV1 {
  /** Resolves only after the bytes are accepted and any backpressure has cleared. */
  writeStdin(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  readStdout(signal: AbortSignal): Promise<Uint8Array | undefined>;
  readStderr(signal: AbortSignal): Promise<Uint8Array | undefined>;
  closeStdin(signal: AbortSignal): Promise<void>;
  terminate(signal: AbortSignal): Promise<void>;
  /** Settles only after the process is terminal. */
  exited: Promise<Readonly<{ code: number | null; signal: string | null }>>;
}

export interface OwnedCodexAppServerProcessV1 {
  ready: Promise<CodexAppServerProcessBytePortV1>;
  /** Must retire the pending acquisition and any eventual process. */
  close(): Promise<void>;
}

export type AcquireCodexAppServerProcessV1 = (binding: CodexAppServerProcessBindingV1,
  signal: AbortSignal) => OwnedCodexAppServerProcessV1;

interface ProcessJsonlWire {
  send(line: string, signal: AbortSignal): Promise<void>;
  writeLine(line: string, signal: AbortSignal): Promise<void>;
  readLine(signal: AbortSignal): Promise<string | undefined>;
  close(signal?: AbortSignal): Promise<void>;
}
type LineWaiter = { resolve(value: string | undefined): void; reject(error: Error): void;
  signal: AbortSignal; abort(): void };

const unavailable = () => new Error('codex_app_server_process_session_unavailable');
const cleanupUncertain = () => new Error('codex_app_server_process_session_cleanup_uncertain');

function validatePort(value: CodexAppServerProcessBytePortV1): CodexAppServerProcessBytePortV1 {
  if (!value || typeof value !== 'object' || typeof value.writeStdin !== 'function'
    || typeof value.readStdout !== 'function' || typeof value.readStderr !== 'function'
    || typeof value.closeStdin !== 'function' || typeof value.terminate !== 'function'
    || !value.exited || typeof (value.exited as Promise<unknown>).then !== 'function') throw unavailable();
  return Object.freeze({ writeStdin: value.writeStdin.bind(value), readStdout: value.readStdout.bind(value),
    readStderr: value.readStderr.bind(value), closeStdin: value.closeStdin.bind(value),
    terminate: value.terminate.bind(value), exited: Promise.resolve(value.exited) });
}

function validExit(value: unknown): value is Readonly<{ code: number | null; signal: string | null }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('code') || !keys.includes('signal')) return false;
  const exit = value as { code?: unknown; signal?: unknown };
  const exitedByCode = Number.isSafeInteger(exit.code) && exit.signal === null;
  const exitedBySignal = exit.code === null && typeof exit.signal === 'string'
    && exit.signal.length > 0 && exit.signal.length <= 64;
  return exitedByCode || exitedBySignal;
}

/**
 * Adapts one synchronously owned, injected App Server byte process into the
 * existing fixed JSONL profiles. It never selects or spawns an executable,
 * supplies environment or credentials, retries, logs stderr, or returns it.
 */
export function createCodexAppServerProcessSessionV1(input: {
  binding: CodexAppServerProcessBindingV1;
  signal: AbortSignal;
  acquire: AcquireCodexAppServerProcessV1;
  cleanupMs: number;
}): OwnedCodexStartConnectionV1 | OwnedCodexReadConnection {
  const binding = parseCodexAppServerProcessBindingV1(input.binding);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || !Number.isSafeInteger(input.cleanupMs) || input.cleanupMs < 1 || input.cleanupMs > 5_000
    || typeof input.acquire !== 'function') throw unavailable();

  const operation = new AbortController(), readers = new AbortController();
  let owner: OwnedCodexAppServerProcessV1;
  try {
    owner = input.acquire(binding, operation.signal);
    if (!owner || typeof owner !== 'object' || typeof owner.close !== 'function'
      || !owner.ready || typeof (owner.ready as Promise<unknown>).then !== 'function') throw unavailable();
  } catch { throw unavailable(); }
  const ownerReady = Promise.resolve(owner.ready), ownerClose = owner.close.bind(owner);
  void ownerReady.catch(() => {});

  let port: CodexAppServerProcessBytePortV1 | undefined;
  let stdoutPump: Promise<void> | undefined, stderrPump: Promise<void> | undefined;
  let exit: Promise<Readonly<{ code: number | null; signal: string | null }>> | undefined;
  let closing = false, closed = false, fatal = false, exitMalformed = false, exitEvidence = false;
  let closingPromise: Promise<void> | undefined;
  let stdoutEnded = false, buffered = new Uint8Array(0), queuedBytes = 0;
  const lines: { value: string; bytes: number }[] = [], waiters: LineWaiter[] = [];
  const writes = new Set<Promise<unknown>>();
  let rejectFatal!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => { rejectFatal = reject; });
  void failed.catch(() => {});

  const wake = () => {
    while (waiters.length && (closing || closed || fatal || lines.length || stdoutEnded)) {
      const waiter = waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (closing || closed || fatal) waiter.reject(unavailable());
      else if (lines.length) {
        const line = lines.shift()!; queuedBytes -= line.bytes; waiter.resolve(line.value);
      } else waiter.resolve(undefined);
    }
  };
  const fail = () => {
    if (fatal) return;
    fatal = true; operation.abort(); readers.abort(); rejectFatal(unavailable()); wake();
  };
  const stop = () => { fail(); void close().catch(() => {}); };
  input.signal.addEventListener('abort', stop, { once: true });

  const decodeLine = (bytes: Uint8Array) => {
    if (!bytes.byteLength || bytes.byteLength > MAX_LINE_BYTES) throw unavailable();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
  const acceptStdout = (chunk: Uint8Array) => {
    if (!(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.includes(13)
      || buffered.byteLength + queuedBytes + chunk.byteLength > MAX_BUFFERED_STDOUT_BYTES) throw unavailable();
    const next = new Uint8Array(buffered.byteLength + chunk.byteLength);
    next.set(buffered); next.set(chunk, buffered.byteLength);
    let start = 0;
    for (let index = 0; index < next.byteLength; index++) {
      if (next[index] !== 10) continue;
      const bytes = next.slice(start, index), value = decodeLine(bytes);
      lines.push({ value, bytes: bytes.byteLength }); queuedBytes += bytes.byteLength;
      start = index + 1;
    }
    buffered = next.slice(start);
    if (buffered.byteLength > MAX_LINE_BYTES || buffered.byteLength + queuedBytes > MAX_BUFFERED_STDOUT_BYTES) throw unavailable();
    wake();
  };
  const pumpStdout = async (selected: CodexAppServerProcessBytePortV1) => {
    try {
      for (;;) {
        const chunk = await selected.readStdout(readers.signal);
        if (chunk === undefined) {
          if (!closing || buffered.byteLength) throw unavailable();
          stdoutEnded = true; wake(); return;
        }
        acceptStdout(chunk);
      }
    } catch { if (!closing) fail(); throw unavailable(); }
  };
  const pumpStderr = async (selected: CodexAppServerProcessBytePortV1) => {
    const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0;
    try {
      for (;;) {
        const chunk = await selected.readStderr(readers.signal);
        if (chunk === undefined) { decoder.decode(); return; }
        if (!(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.includes(13)
          || (bytes += chunk.byteLength) > MAX_STDERR_BYTES) throw unavailable();
        decoder.decode(chunk, { stream: true });
      }
    } catch { if (!closing) fail(); throw unavailable(); }
  };
  const abortRace = (signal: AbortSignal) => {
    let rejectAbort!: (error: Error) => void;
    const abort = () => rejectAbort(unavailable());
    const promise = new Promise<never>((_, reject) => { rejectAbort = reject; });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    void promise.catch(() => {});
    return { promise, dispose: () => signal.removeEventListener('abort', abort) };
  };
  const send = async (line: string, signal: AbortSignal) => {
    if (closing || closed || fatal || !(signal instanceof AbortSignal) || signal.aborted || !port) throw unavailable();
    if (typeof line !== 'string' || !line.endsWith('\n') || line.slice(0, -1).includes('\n') || line.includes('\r')) throw unavailable();
    const bytes = new TextEncoder().encode(line);
    if (bytes.byteLength < 2 || bytes.byteLength > MAX_LINE_BYTES + 1) throw unavailable();
    const combined = AbortSignal.any([signal, operation.signal]);
    const pending = Promise.resolve(port.writeStdin(Uint8Array.from(bytes), combined));
    writes.add(pending); void pending.finally(() => writes.delete(pending)).catch(() => {});
    const aborted = abortRace(combined);
    try { await Promise.race([pending, failed, aborted.promise]); }
    catch { fail(); throw unavailable(); }
    finally { aborted.dispose(); }
    if (combined.aborted || fatal || closing) throw unavailable();
  };
  const readLine = async (signal: AbortSignal): Promise<string | undefined> => {
    if (closing || closed || fatal || !(signal instanceof AbortSignal) || signal.aborted) throw unavailable();
    if (lines.length) { const line = lines.shift()!; queuedBytes -= line.bytes; return line.value; }
    if (stdoutEnded) return undefined;
    return new Promise<string | undefined>((resolve, reject) => {
      const waiter: LineWaiter = { resolve, reject, signal, abort: () => {
        const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(unavailable());
      } };
      signal.addEventListener('abort', waiter.abort, { once: true }); waiters.push(waiter); wake();
    });
  };
  const close = async () => {
    if (closingPromise) return closingPromise;
    closing = true; operation.abort(); wake();
    const run = async () => {
      const deadline = performance.now() + input.cleanupMs;
      const step = async <T>(work: Promise<T>, cap = Math.max(1, Math.floor(deadline - performance.now()))) => {
        if (cap < 1) throw cleanupUncertain();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => {
          reject(cleanupUncertain());
        }, cap); })]); }
        finally { clearTimeout(timer); }
      };
      let uncertain = false;
      if (port) {
        const closeSignal = new AbortController();
        try { await step(Promise.resolve(port.closeStdin(closeSignal.signal)), Math.max(1, Math.floor(input.cleanupMs / 4))); }
        catch { closeSignal.abort(); uncertain = true; }
        const terminateSignal = new AbortController();
        try { await step(Promise.resolve(port.terminate(terminateSignal.signal))); }
        catch { terminateSignal.abort(); uncertain = true; }
        try {
          const pending = [stdoutPump, stderrPump, exit, ...writes].filter(Boolean) as Promise<unknown>[];
          const settled = await step(Promise.allSettled(pending));
          const stdoutIndex = pending.indexOf(stdoutPump!);
          const stderrIndex = pending.indexOf(stderrPump!);
          const exitIndex = pending.indexOf(exit!);
          if (stdoutIndex < 0 || settled[stdoutIndex]?.status !== 'fulfilled'
            || stderrIndex < 0 || settled[stderrIndex]?.status !== 'fulfilled'
            || exitIndex < 0 || settled[exitIndex]?.status !== 'fulfilled'
            || !exitEvidence || exitMalformed) uncertain = true;
        } catch { readers.abort(); uncertain = true; }
      } else readers.abort();
      try { await step(Promise.resolve().then(ownerClose)); } catch { uncertain = true; }
      readers.abort(); buffered.fill(0); buffered = new Uint8Array(0); lines.splice(0); queuedBytes = 0;
      input.signal.removeEventListener('abort', stop); closed = true;
      if (uncertain) throw cleanupUncertain();
    };
    closingPromise = run().catch(() => { throw cleanupUncertain(); });
    return closingPromise;
  };

  const ready = ownerReady.then(value => {
    if (closing || closed) throw unavailable();
    port = validatePort(value);
    stdoutPump = pumpStdout(port); void stdoutPump.catch(() => {});
    stderrPump = pumpStderr(port); void stderrPump.catch(() => {});
    exit = Promise.resolve(port.exited).then(value => {
      if (!validExit(value)) { exitMalformed = true; throw unavailable(); }
      exitEvidence = true;
      if (!closing) fail();
      return value;
    });
    void exit.catch(() => { if (!closing) fail(); });
    const wire: ProcessJsonlWire = Object.freeze({
      send,
      writeLine: send,
      async readLine(signal: AbortSignal) { return readLine(signal); },
      async close() { await close(); },
    });
    return wire;
  }).catch(() => { if (!closing) fail(); throw unavailable(); });
  void ready.catch(() => {});

  if (binding.mode === 'initial') {
    return Object.freeze({ ready: ready as Promise<CodexStartJsonlConnectionV1>, close });
  }
  const readReady = ready.then(wire => Object.freeze({ send: wire.send,
    async readLine(signal: AbortSignal) {
      const line = await wire.readLine(signal); if (line === undefined) throw unavailable(); return line;
    } }));
  void readReady.catch(() => {});
  return Object.freeze({ ready: readReady, close });
}

export function codexInitialProcessBindingV1(value: CodexStartConnectionBindingV1):
  Extract<CodexAppServerProcessBindingV1, { mode: 'initial' }> {
  return Object.freeze(initialBindingSchema.parse({ mode: 'initial', ...value }));
}
