import { createCodexReadJsonl } from './read-jsonl';
import { assertSynchronousFence } from '../../security/synchronous-fence';

export interface CodexReadWire {
  send(line: string, signal: AbortSignal): Promise<void>;
  readLine(signal: AbortSignal): Promise<string>;
}
export interface OwnedCodexReadConnection {
  ready: Promise<CodexReadWire>;
  /** Must retire the acquisition, eventual connection and pending I/O before resolving. */
  close(): Promise<void>;
}

/** One-shot owned read, adapting the existing owned-signing acquisition pattern.
 * open returns ownership synchronously, including when readiness is pending.
 * Throwing open must leave no resource. No default native connector is supplied.
 */
export function createOwnedCodexRead(options: {
  binding: { threadId: string; turnId: string };
  open(signal: AbortSignal): OwnedCodexReadConnection;
  assertCurrent(): void;
  timeoutMs: number;
  cleanupMs: number;
}) {
  const session = createCodexReadJsonl(options.binding);
  const open = options.open.bind(options), check = options.assertCurrent.bind(options);
  const { timeoutMs, cleanupMs } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 5000) throw new Error('codex_read_config_invalid');
  let attempted = false;
  const unavailable = (): never => { throw new Error('codex_read_unavailable'); };
  return Object.freeze({ async read(signal: AbortSignal) {
    if (attempted) return unavailable(); attempted = true;
    if (!(signal instanceof AbortSignal) || signal.aborted) return unavailable();
    const controller = new AbortController(), deadline = performance.now() + timeoutMs;
    const stop = () => controller.abort();
    let rejectStopped!: () => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = () => reject(new Error('codex_read_unavailable')); });
    void stopped.catch(() => {});
    controller.signal.addEventListener('abort', rejectStopped, { once: true });
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    const current = () => {
      if (signal.aborted || controller.signal.aborted || performance.now() >= deadline) unavailable();
      assertSynchronousFence(check, unavailable);
    };
    const wait = async <T>(work: () => Promise<T>) => {
      current(); const result = await Promise.race([Promise.resolve().then(() => { current(); return work(); }), stopped]);
      current(); return result;
    };
    let connection: OwnedCodexReadConnection | undefined;
    try {
      current(); connection = open(controller.signal);
      const readiness = Promise.resolve(connection.ready); void readiness.catch(() => {});
      const wire = await wait(() => readiness);
      await wait(() => wire.send(session.initialize(), controller.signal));
      while (session.receive(await wait(() => wire.readLine(controller.signal))).kind !== 'initialized') { /* bounded notifications */ }
      await wait(() => wire.send(session.initialized(), controller.signal));
      await wait(() => wire.send(session.read(), controller.signal));
      for (;;) {
        const event = session.receive(await wait(() => wire.readLine(controller.signal)));
        if (event.kind === 'observation') { current(); return event.observation; }
      }
    } catch { return unavailable(); }
    finally {
      stop(); session.disconnect(); clearTimeout(timer);
      signal.removeEventListener('abort', stop); controller.signal.removeEventListener('abort', rejectStopped);
      if (connection) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([Promise.resolve().then(() => connection!.close()), new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(() => reject(new Error()), cleanupMs);
          })]);
        } catch { throw new Error('codex_read_cleanup_uncertain'); }
        finally { clearTimeout(cleanupTimer); }
      }
      if (signal.aborted) unavailable();
      try { assertSynchronousFence(check, unavailable); } catch { unavailable(); }
    }
  } });
}
