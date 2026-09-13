import { assertSynchronousFence } from '../../security/synchronous-fence';
import type { CodexStartAdmissionV1, CodexThreadStartReceiptV1,
  CodexTurnStartIntentV1 } from './admission-contract';
import type { CodexTaskActivationBodyV1 } from './activation-contract';

export interface CodexStartJsonlConnectionV1 {
  writeLine(line: string, signal: AbortSignal): Promise<void>;
  readLine(signal: AbortSignal): Promise<string | undefined>;
  close(signal: AbortSignal): Promise<void>;
}

const unavailable = (): never => { throw new Error('codex_start_jsonl_unavailable'); };
const boundedLine = (value: string) => {
  if (typeof value !== 'string' || !value.length || value.includes('\n') || value.includes('\r')
    || Buffer.byteLength(value, 'utf8') > 262_144) unavailable();
  try { return JSON.parse(value) as unknown; } catch { return unavailable(); }
};
const exactRequest = (line: string, id: number, method: 'thread/start' | 'turn/start') => {
  const value = boundedLine(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'id' && key !== 'method' && key !== 'params')
    || (value as { id?: unknown }).id !== id || (value as { method?: unknown }).method !== method
    || !Object.hasOwn(value, 'params')) unavailable();
  return `${line}\n`;
};
const requestLine = (id: number, method: 'thread/start' | 'turn/start', params: unknown) =>
  exactRequest(JSON.stringify({ id, method, params }), id, method);
const matchingResponse = (line: string, id: number) => {
  const value = boundedLine(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'id' && key !== 'result')
    || (value as { id?: unknown }).id !== id || !Object.hasOwn(value, 'result')) unavailable();
  return line;
};

async function within<T>(milliseconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new Error('codex_start_jsonl_timeout'));
    }, milliseconds); });
    return await Promise.race([work(controller.signal), timeout]);
  } finally { if (timer) clearTimeout(timer); }
}

/** A one-session, fixed-order JSONL exchange. It owns close and rejects all
 * response IDs/methods except initialize, thread/start and turn/start. */
export function createCodexStartJsonlV1(input: {
  connection: CodexStartJsonlConnectionV1;
  timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) unavailable();
  let state: 'new' | 'ready' | 'thread_started' | 'turn_started' | 'closed' = 'new';
  let connectionCloseAttempted = false;
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    inFlight.add(operation);
    void operation.finally(() => inFlight.delete(operation)).catch(() => {});
    return operation;
  };
  const fail = (): never => { state = 'closed'; return unavailable(); };
  const write = async (line: string, assertCurrent: () => void) => {
    assertSynchronousFence(assertCurrent, fail);
    await within(timeoutMs, signal => track(input.connection.writeLine(line, signal)));
  };
  const receive = async (id: number, assertCurrent: () => void) => {
    const line = await within(timeoutMs, signal => track(input.connection.readLine(signal)));
    assertSynchronousFence(assertCurrent, fail);
    if (line === undefined) fail(); return matchingResponse(line, id);
  };
  return Object.freeze({
    async initialize(assertCurrent: () => void) {
      if (state !== 'new') fail();
      await write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_control_room_start', version: '0.1.0' } } })}\n`, assertCurrent);
      assertSynchronousFence(assertCurrent, fail);
      await receive(1, assertCurrent);
      await write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`, assertCurrent);
      assertSynchronousFence(assertCurrent, fail);
      state = 'ready';
    },
    async startThread(inputValue: { activation: CodexTaskActivationBodyV1; admission: CodexStartAdmissionV1; assertCurrent: () => void }) {
      if (state !== 'ready') fail();
      const request = requestLine(inputValue.admission.threadStartRequestId, 'thread/start', {
        cwd: inputValue.activation.workspacePath,
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'readOnly',
        developerInstructions: inputValue.activation.instructions, ephemeral: false,
      });
      await write(request, inputValue.assertCurrent);
      assertSynchronousFence(inputValue.assertCurrent, fail);
      const response = await receive(inputValue.admission.threadStartRequestId, inputValue.assertCurrent);
      assertSynchronousFence(inputValue.assertCurrent, fail); state = 'thread_started'; return response;
    },
    async startTurn(inputValue: { activation: CodexTaskActivationBodyV1; thread: CodexThreadStartReceiptV1; intent: CodexTurnStartIntentV1; assertCurrent: () => void }) {
      if (state !== 'thread_started') fail();
      const request = requestLine(inputValue.intent.turnStartRequestId, 'turn/start', {
        threadId: inputValue.thread.threadId,
        input: [{ type: 'text', text: inputValue.activation.prompt }],
      });
      await write(request, inputValue.assertCurrent);
      assertSynchronousFence(inputValue.assertCurrent, fail);
      const response = await receive(inputValue.intent.turnStartRequestId, inputValue.assertCurrent);
      assertSynchronousFence(inputValue.assertCurrent, fail); state = 'turn_started'; return response;
    },
    async close() {
      state = 'closed';
      if (connectionCloseAttempted) return;
      connectionCloseAttempted = true;
      try {
        await within(timeoutMs, signal => input.connection.close(signal));
        const unsettled = [...inFlight];
        if (unsettled.length) await within(timeoutMs, async () => { await Promise.allSettled(unsettled); });
      } catch { unavailable(); }
    },
  });
}
