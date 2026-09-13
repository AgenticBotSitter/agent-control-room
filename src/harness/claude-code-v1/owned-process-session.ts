import { z } from "zod";
import { digestSchema, localId } from "../v1/native-run-identifiers";
import { sha256Digest } from "../../security/canonical-digest";
import { CLAUDE_CODE_MAX_LINE_BYTES_V1 } from "./stream-json-decode";

export const CLAUDE_CODE_SESSION_DISPOSITION_SCHEMA_V1 =
  "control-room.claude-code-session-disposition/v1" as const;

const MAX_BUFFERED_STDOUT_BYTES = 524_288;
const MAX_STDERR_BYTES = 65_536;

const bindingSchema = z.object({
  /** One fresh process per attempt; never reused across attempts. */
  processAttemptId: localId,
  runId: localId,
  attemptId: localId,
  /** Digest of the invocation the caller already decided on. This module decides nothing. */
  invocationDigest: digestSchema,
}).strict();

export type ClaudeCodeProcessBindingV1 = z.infer<typeof bindingSchema>;

export interface ClaudeCodeProcessBytePortV1 {
  /** Resolves only after the bytes are accepted and any backpressure has cleared. */
  readStdout(signal: AbortSignal): Promise<Uint8Array | undefined>;
  readStderr(signal: AbortSignal): Promise<Uint8Array | undefined>;
  closeStdin(signal: AbortSignal): Promise<void>;
  terminate(signal: AbortSignal): Promise<void>;
  /** Settles only after the process is terminal. */
  exited: Promise<Readonly<{ code: number | null; signal: string | null }>>;
}

export interface OwnedClaudeCodeProcessV1 {
  ready: Promise<ClaudeCodeProcessBytePortV1>;
  /** Must retire the pending acquisition and any eventual process. */
  close(): Promise<void>;
}

export type AcquireClaudeCodeProcessV1 = (binding: ClaudeCodeProcessBindingV1,
  signal: AbortSignal) => OwnedClaudeCodeProcessV1;

export interface ClaudeCodeStreamWireV1 {
  /** One decoded stdout line, or undefined once stdout ended during a bounded close. */
  readLine(signal: AbortSignal): Promise<string | undefined>;
}

export interface ClaudeCodeSessionDispositionV1 {
  readonly schema: typeof CLAUDE_CODE_SESSION_DISPOSITION_SCHEMA_V1;
  readonly processAttemptId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly closed: boolean;
  readonly cleanupUncertain: boolean;
  readonly exitObserved: boolean;
  readonly exitMalformed: boolean;
  /** Set by the caller once it has independently decoded a terminal result frame. */
  readonly terminalResultConfirmed: boolean;
  /** Always false here. This connector never authorises resubmission of a run. */
  readonly resubmissionSafe: false;
  readonly reasonCode: string;
  readonly grantsExecutionAuthority: false;
  readonly canonicalPublicationAllowed: false;
  readonly permitsRetry: false;
  readonly permitsResume: false;
}

export interface OwnedClaudeCodeProcessSessionV1 {
  ready: Promise<ClaudeCodeStreamWireV1>;
  /** Caller states that it independently decoded a terminal result frame on this stream. */
  recordTerminalResultObserved(): void;
  close(): Promise<void>;
  disposition(): ClaudeCodeSessionDispositionV1;
}

const unavailable = () => new Error("claude_code_process_session_unavailable");
const duplicateBinding = () => new Error("claude_code_process_session_duplicate_binding");
const cleanupUncertainError = () => new Error("claude_code_process_session_cleanup_uncertain");

/**
 * One binding may be started exactly once, ever. A restart must mint a fresh
 * processAttemptId, which keeps "one fresh process per attempt" checkable rather
 * than assumed. The registry is bounded so a caller cannot grow it without limit.
 */
const startedBindings = new Set<string>();
const MAX_TRACKED_BINDINGS = 65_536;

/** Test-only reset for the bounded duplicate-start registry. Never called by connector code. */
export function resetClaudeCodeProcessBindingRegistryV1(): void {
  startedBindings.clear();
}

function validatePort(value: ClaudeCodeProcessBytePortV1): ClaudeCodeProcessBytePortV1 {
  if (!value || typeof value !== "object" || typeof value.readStdout !== "function"
    || typeof value.readStderr !== "function" || typeof value.closeStdin !== "function"
    || typeof value.terminate !== "function" || !value.exited
    || typeof (value.exited as Promise<unknown>).then !== "function") throw unavailable();
  return Object.freeze({
    readStdout: value.readStdout.bind(value),
    readStderr: value.readStderr.bind(value),
    closeStdin: value.closeStdin.bind(value),
    terminate: value.terminate.bind(value),
    exited: Promise.resolve(value.exited),
  });
}

function validExit(value: unknown): value is Readonly<{ code: number | null; signal: string | null }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("code") || !keys.includes("signal")) return false;
  const exit = value as { code?: unknown; signal?: unknown };
  const exitedByCode = Number.isSafeInteger(exit.code) && exit.signal === null;
  const exitedBySignal = exit.code === null && typeof exit.signal === "string"
    && exit.signal.length > 0 && exit.signal.length <= 64;
  return exitedByCode || exitedBySignal;
}

type LineWaiter = {
  resolve(value: string | undefined): void;
  reject(error: Error): void;
  signal: AbortSignal;
  abort(): void;
};

/**
 * Adapts one synchronously owned, injected Claude Code byte process into bounded
 * stdout line framing. It never selects or spawns an executable, constructs an
 * argument vector, supplies environment or credentials, reads a configuration
 * file, retries, resumes, or returns stderr content. Cleanup is deadline bounded
 * and reports uncertainty instead of silently claiming success.
 */
export function createClaudeCodeOwnedProcessSessionV1(input: {
  binding: ClaudeCodeProcessBindingV1;
  signal: AbortSignal;
  acquire: AcquireClaudeCodeProcessV1;
  cleanupMs: number;
}): OwnedClaudeCodeProcessSessionV1 {
  const binding = Object.freeze(bindingSchema.parse(input.binding));
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || !Number.isSafeInteger(input.cleanupMs) || input.cleanupMs < 1 || input.cleanupMs > 5_000
    || typeof input.acquire !== "function") throw unavailable();

  const bindingKey = sha256Digest(binding);
  if (startedBindings.has(bindingKey)) throw duplicateBinding();
  if (startedBindings.size >= MAX_TRACKED_BINDINGS) throw unavailable();
  startedBindings.add(bindingKey);

  const operation = new AbortController(), readers = new AbortController();
  let owner: OwnedClaudeCodeProcessV1;
  try {
    owner = input.acquire(binding, operation.signal);
    if (!owner || typeof owner !== "object" || typeof owner.close !== "function"
      || !owner.ready || typeof (owner.ready as Promise<unknown>).then !== "function") throw unavailable();
  } catch { throw unavailable(); }
  const ownerReady = Promise.resolve(owner.ready), ownerClose = owner.close.bind(owner);
  void ownerReady.catch(() => {});

  let port: ClaudeCodeProcessBytePortV1 | undefined;
  let stdoutPump: Promise<void> | undefined, stderrPump: Promise<void> | undefined;
  let exit: Promise<Readonly<{ code: number | null; signal: string | null }>> | undefined;
  let closing = false, closed = false, fatal = false;
  let exitMalformed = false, exitEvidence = false, cleanupUncertain = false;
  let terminalResultConfirmed = false;
  let closingPromise: Promise<void> | undefined;
  let stdoutEnded = false, buffered = new Uint8Array(0), queuedBytes = 0;
  const lines: { value: string; bytes: number }[] = [], waiters: LineWaiter[] = [];

  const wake = () => {
    while (waiters.length && (closing || closed || fatal || lines.length || stdoutEnded)) {
      const waiter = waiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      // Already-decoded lines are drained first: a result frame that arrived just
      // before a natural stdout EOF stays readable even while the session closes.
      if (lines.length && !closed && !fatal) {
        const line = lines.shift()!;
        queuedBytes -= line.bytes;
        waiter.resolve(line.value);
      } else if (stdoutEnded && !closed && !fatal) {
        // A drained, naturally ended stream is end-of-stream, not a failure.
        waiter.resolve(undefined);
      } else waiter.reject(unavailable());
    }
  };
  const fail = () => {
    if (fatal) return;
    fatal = true;
    operation.abort();
    readers.abort();
    wake();
  };
  const stop = () => { fail(); void close().catch(() => {}); };
  input.signal.addEventListener("abort", stop, { once: true });

  const decodeLine = (bytes: Uint8Array) => {
    if (!bytes.byteLength || bytes.byteLength > CLAUDE_CODE_MAX_LINE_BYTES_V1) throw unavailable();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  const acceptStdout = (chunk: Uint8Array) => {
    if (!(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.includes(13)
      || buffered.byteLength + queuedBytes + chunk.byteLength > MAX_BUFFERED_STDOUT_BYTES) throw unavailable();
    const next = new Uint8Array(buffered.byteLength + chunk.byteLength);
    next.set(buffered);
    next.set(chunk, buffered.byteLength);
    let start = 0;
    for (let index = 0; index < next.byteLength; index++) {
      if (next[index] !== 10) continue;
      const bytes = next.slice(start, index), value = decodeLine(bytes);
      lines.push({ value, bytes: bytes.byteLength });
      queuedBytes += bytes.byteLength;
      start = index + 1;
    }
    buffered = next.slice(start);
    if (buffered.byteLength > CLAUDE_CODE_MAX_LINE_BYTES_V1
      || buffered.byteLength + queuedBytes > MAX_BUFFERED_STDOUT_BYTES) throw unavailable();
    wake();
  };
  const pumpStdout = async (selected: ClaudeCodeProcessBytePortV1) => {
    try {
      for (;;) {
        const chunk = await selected.readStdout(readers.signal);
        if (chunk === undefined) {
          // A trailing partial line means truncated output and stays fatal; an EOF on a
          // clean line boundary ends the stream so queued frames remain consumable.
          if (buffered.byteLength) throw unavailable();
          stdoutEnded = true;
          wake();
          return;
        }
        acceptStdout(chunk);
      }
    } catch { if (!closing) fail(); throw unavailable(); }
  };
  const pumpStderr = async (selected: ClaudeCodeProcessBytePortV1) => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await selected.readStderr(readers.signal);
        if (chunk === undefined) { decoder.decode(); return; }
        if (!(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.includes(13)
          || (bytes += chunk.byteLength) > MAX_STDERR_BYTES) throw unavailable();
        // Counted and discarded. Diagnostic text is never surfaced or retained.
        decoder.decode(chunk, { stream: true });
      }
    } catch { if (!closing) fail(); throw unavailable(); }
  };

  const readLine = async (signal: AbortSignal): Promise<string | undefined> => {
    if (!(signal instanceof AbortSignal) || signal.aborted || closed || fatal) throw unavailable();
    if (lines.length) {
      const line = lines.shift()!;
      queuedBytes -= line.bytes;
      return line.value;
    }
    if (stdoutEnded) return undefined;
    if (closing) throw unavailable();
    return new Promise<string | undefined>((resolve, reject) => {
      const waiter: LineWaiter = {
        resolve, reject, signal,
        abort: () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(unavailable());
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      waiters.push(waiter);
      wake();
    });
  };

  const close = async () => {
    if (closingPromise) return closingPromise;
    closing = true;
    operation.abort();
    wake();
    const run = async () => {
      const deadline = performance.now() + input.cleanupMs;
      const step = async <T>(work: Promise<T>, cap = Math.max(1, Math.floor(deadline - performance.now()))) => {
        if (cap < 1) throw cleanupUncertainError();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([work, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(cleanupUncertainError()), cap);
          })]);
        } finally { clearTimeout(timer); }
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
          const pending = [stdoutPump, stderrPump, exit].filter(Boolean) as Promise<unknown>[];
          const settled = await step(Promise.allSettled(pending));
          const stdoutIndex = pending.indexOf(stdoutPump!);
          const stderrIndex = pending.indexOf(stderrPump!);
          const exitIndex = pending.indexOf(exit!);
          if (stdoutIndex < 0 || settled[stdoutIndex]?.status !== "fulfilled"
            || stderrIndex < 0 || settled[stderrIndex]?.status !== "fulfilled"
            || exitIndex < 0 || settled[exitIndex]?.status !== "fulfilled"
            || !exitEvidence || exitMalformed) uncertain = true;
        } catch { readers.abort(); uncertain = true; }
      } else {
        readers.abort();
        uncertain = true;
      }
      try { await step(Promise.resolve().then(ownerClose)); } catch { uncertain = true; }
      readers.abort();
      buffered.fill(0);
      buffered = new Uint8Array(0);
      lines.splice(0);
      queuedBytes = 0;
      input.signal.removeEventListener("abort", stop);
      closed = true;
      cleanupUncertain = uncertain;
      if (uncertain) throw cleanupUncertainError();
    };
    closingPromise = run().catch(() => {
      closed = true;
      cleanupUncertain = true;
      throw cleanupUncertainError();
    });
    return closingPromise;
  };

  const ready = ownerReady.then(value => {
    if (closing || closed) throw unavailable();
    port = validatePort(value);
    stdoutPump = pumpStdout(port); void stdoutPump.catch(() => {});
    stderrPump = pumpStderr(port); void stderrPump.catch(() => {});
    exit = Promise.resolve(port.exited).then(observed => {
      if (!validExit(observed)) { exitMalformed = true; throw unavailable(); }
      exitEvidence = true;
      // A well formed natural exit is ordinary completion. The stdout pump reports the
      // stream end once stdout drains; discarding queued frames here would lose an
      // already-emitted final result.
      wake();
      return observed;
    });
    void exit.catch(() => { if (!closing) fail(); });
    const wire: ClaudeCodeStreamWireV1 = Object.freeze({
      async readLine(signal: AbortSignal) { return readLine(signal); },
    });
    return wire;
  }).catch(() => { if (!closing) fail(); throw unavailable(); });
  void ready.catch(() => {});

  return Object.freeze({
    ready,
    recordTerminalResultObserved() { terminalResultConfirmed = true; },
    close,
    disposition(): ClaudeCodeSessionDispositionV1 {
      const reasonCode = !closed
        ? "session_open"
        : cleanupUncertain
          ? "cleanup_uncertain_result_unproven"
          : terminalResultConfirmed
            ? "closed_with_decoded_terminal_result"
            : "closed_without_terminal_result";
      return Object.freeze({
        schema: CLAUDE_CODE_SESSION_DISPOSITION_SCHEMA_V1,
        processAttemptId: binding.processAttemptId,
        runId: binding.runId,
        attemptId: binding.attemptId,
        closed,
        cleanupUncertain,
        exitObserved: exitEvidence,
        exitMalformed,
        terminalResultConfirmed,
        resubmissionSafe: false,
        reasonCode,
        grantsExecutionAuthority: false,
        canonicalPublicationAllowed: false,
        permitsRetry: false,
        permitsResume: false,
      });
    },
  });
}
