import type { CodexStartAdmissionV1, CodexThreadStartReceiptV1,
  CodexTurnStartIntentV1 } from './admission-contract';
import type { CodexTaskActivationBodyV1 } from './activation-contract';
import { assertSynchronousFence } from '../../security/synchronous-fence';
import { createCodexStartJsonlV1, type CodexStartJsonlConnectionV1 } from './start-jsonl';
import { digestSchema, localId } from '../v1/native-run-identifiers';

export interface CodexStartConnectionBindingV1 {
  connectionAttemptId: string;
  initializedConnectionDigest: string;
  threadStartRequestId: number;
  turnStartRequestId: number;
}

export interface OwnedCodexStartConnectionV1 {
  ready: Promise<CodexStartJsonlConnectionV1>;
  /** Retires acquisition, any eventual connection and all pending I/O. */
  close(): Promise<void>;
}

export interface CodexOwnedStartV1 {
  startThread(input: Readonly<{ activation: CodexTaskActivationBodyV1; admission: CodexStartAdmissionV1; assertCurrent: () => void }>): Promise<string>;
  startTurn(input: Readonly<{ activation: CodexTaskActivationBodyV1; thread: CodexThreadStartReceiptV1; intent: CodexTurnStartIntentV1; assertCurrent: () => void }>): Promise<string>;
  close(): Promise<void>;
}

/** Opens at most one injected App Server connection, initializes it once, then
 * permits exactly thread/start followed by turn/start. It has no retry, resume,
 * read or arbitrary JSON-RPC entry point, and its caller must close it. */
export function createCodexOwnedStartV1(input: {
  binding: CodexStartConnectionBindingV1;
  open(binding: CodexStartConnectionBindingV1, signal: AbortSignal): OwnedCodexStartConnectionV1;
  timeoutMs: number;
  cleanupMs: number;
}): CodexOwnedStartV1 {
  let state: 'new' | 'thread_started' | 'turn_started' | 'closed' = 'new';
  let session: ReturnType<typeof createCodexStartJsonlV1> | undefined;
  let connection: OwnedCodexStartConnectionV1 | undefined;
  let closing: Promise<void> | undefined;
  const timeoutMs = input.timeoutMs, cleanupMs = input.cleanupMs;
  const binding = Object.freeze({ connectionAttemptId: localId.parse(input.binding.connectionAttemptId),
    initializedConnectionDigest: digestSchema.parse(input.binding.initializedConnectionDigest),
    threadStartRequestId: input.binding.threadStartRequestId, turnStartRequestId: input.binding.turnStartRequestId });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 5_000
    || !Number.isSafeInteger(binding.threadStartRequestId) || binding.threadStartRequestId < 1
    || !Number.isSafeInteger(binding.turnStartRequestId) || binding.turnStartRequestId < 1
    || binding.threadStartRequestId === binding.turnStartRequestId) throw new Error('codex_owned_start_invalid');
  const controller = new AbortController();
  const unavailable = (): never => { state = 'closed'; throw new Error('codex_owned_start_unavailable'); };
  const assertCurrent = (check: () => void) => assertSynchronousFence(check, unavailable);
  const bounded = async <T>(milliseconds: number, work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('codex_owned_start_timeout'));
      }, milliseconds); });
      return await Promise.race([work, timeout]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const get = async (check: () => void) => {
    if (session) return session;
    if (state !== 'new') unavailable();
    assertCurrent(check);
    connection = input.open(binding, controller.signal);
    const readiness = Promise.resolve(connection.ready); void readiness.catch(() => {});
    const wire = await bounded(timeoutMs, readiness);
    if (controller.signal.aborted) unavailable();
    session = createCodexStartJsonlV1({ connection: wire, timeoutMs });
    assertCurrent(check);
    await session.initialize(check); assertCurrent(check); return session;
  };
  const close = async () => {
    state = 'closed';
    if (closing) return closing;
    controller.abort();
    closing = bounded(cleanupMs, (async () => {
      let failed = false;
      try { await session?.close(); } catch { failed = true; }
      try { await connection?.close(); } catch { failed = true; }
      if (failed) throw new Error('codex_owned_start_cleanup_uncertain');
    })()).catch(() => { throw new Error('codex_owned_start_cleanup_uncertain'); });
    return closing;
  };
  const failAfterClose = async (): Promise<never> => {
    try { await close(); } catch { /* start failure remains unavailable */ }
    throw new Error('codex_owned_start_unavailable');
  };
  return Object.freeze({
    async startThread(value: Readonly<{ activation: CodexTaskActivationBodyV1;
      admission: CodexStartAdmissionV1; assertCurrent: () => void }>) {
      if (state !== 'new') unavailable();
      try {
        const current = await get(value.assertCurrent); assertCurrent(value.assertCurrent);
        const result = await current.startThread(value); assertCurrent(value.assertCurrent);
        state = 'thread_started'; return result;
      }
      catch { return failAfterClose(); }
    },
    async startTurn(value: Readonly<{ activation: CodexTaskActivationBodyV1;
      thread: CodexThreadStartReceiptV1; intent: CodexTurnStartIntentV1; assertCurrent: () => void }>) {
      if (state !== 'thread_started') unavailable();
      try {
        const current = await get(value.assertCurrent); assertCurrent(value.assertCurrent);
        const result = await current.startTurn(value); assertCurrent(value.assertCurrent);
        state = 'turn_started'; return result;
      }
      catch { return failAfterClose(); }
    },
    close,
  });
}
