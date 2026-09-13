import type { CodexStartAdmissionV1, CodexThreadStartReceiptV1,
  CodexTurnStartIntentV1 } from './admission-contract';
import type { CodexTaskActivationBodyV1 } from './activation-contract';
import { assertSynchronousFence } from '../../security/synchronous-fence';
import { createCodexStartJsonlV1, type CodexStartJsonlConnectionV1 } from './start-jsonl';

export interface CodexOwnedStartV1 {
  startThread(input: Readonly<{ activation: CodexTaskActivationBodyV1; admission: CodexStartAdmissionV1; assertCurrent: () => void }>): Promise<string>;
  startTurn(input: Readonly<{ activation: CodexTaskActivationBodyV1; thread: CodexThreadStartReceiptV1; intent: CodexTurnStartIntentV1; assertCurrent: () => void }>): Promise<string>;
  close(): Promise<void>;
}

/** Opens at most one injected App Server connection, initializes it once, then
 * permits exactly thread/start followed by turn/start. It has no retry, resume,
 * read or arbitrary JSON-RPC entry point, and its caller must close it. */
export function createCodexOwnedStartV1(input: {
  open(signal: AbortSignal): Promise<CodexStartJsonlConnectionV1>;
  timeoutMs?: number;
}): CodexOwnedStartV1 {
  let state: 'new' | 'thread_started' | 'turn_started' | 'closed' = 'new';
  let session: ReturnType<typeof createCodexStartJsonlV1> | undefined;
  let opening: Promise<CodexStartJsonlConnectionV1> | undefined;
  let connectionCloseAttempted = false;
  const timeoutMs = input.timeoutMs ?? 5_000;
  const unavailable = (): never => { state = 'closed'; throw new Error('codex_owned_start_unavailable'); };
  const assertCurrent = (check: () => void) => assertSynchronousFence(check, unavailable);
  const boundedOpen = async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      opening = input.open(controller.signal);
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('codex_owned_start_open_timeout'));
      }, timeoutMs); });
      return await Promise.race([opening, timeout]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const awaitOpening = async () => {
    if (!opening) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        reject(new Error('codex_owned_start_close_timeout'));
      }, timeoutMs); });
      return await Promise.race([opening, timeout]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const get = async (check: () => void) => {
    if (session) return session;
    if (state !== 'new') unavailable();
    assertCurrent(check);
    const connection = await boundedOpen();
    session = createCodexStartJsonlV1({ connection, timeoutMs });
    assertCurrent(check);
    await session.initialize(check); assertCurrent(check); return session;
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
      catch { state = 'closed'; throw new Error('codex_owned_start_unavailable'); }
    },
    async startTurn(value: Readonly<{ activation: CodexTaskActivationBodyV1;
      thread: CodexThreadStartReceiptV1; intent: CodexTurnStartIntentV1; assertCurrent: () => void }>) {
      if (state !== 'thread_started') unavailable();
      try {
        const current = await get(value.assertCurrent); assertCurrent(value.assertCurrent);
        const result = await current.startTurn(value); assertCurrent(value.assertCurrent);
        state = 'turn_started'; return result;
      }
      catch { state = 'closed'; throw new Error('codex_owned_start_unavailable'); }
    },
    async close() {
      state = 'closed';
      if (connectionCloseAttempted) return;
      connectionCloseAttempted = true;
      try {
        if (!session && opening) {
          const connection = await awaitOpening();
          if (!connection) throw new Error('codex_owned_start_unavailable');
          session = createCodexStartJsonlV1({ connection, timeoutMs });
        }
        await session?.close();
      } catch { throw new Error('codex_owned_start_unavailable'); }
    },
  });
}
