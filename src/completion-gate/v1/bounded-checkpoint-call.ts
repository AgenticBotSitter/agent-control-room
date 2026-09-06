/** Bridges an existing unary RPC into our deadline/cancellation contract.
 * No connection creation, retry, response trust, or remote rollback is implied.
 */
export class CheckpointCallError extends Error {
  constructor(readonly outcome: "not_dispatched" | "uncertain") {
    super(`Checkpoint request ${outcome}`);
    this.name = "CheckpointCallError";
  }
}

export function boundedCheckpointCall<T>(input: {
  signal: AbortSignal;
  timeoutMs: number;
  dispatch: (deadline: number, callback: (error: unknown, response?: T) => void) => { cancel(): void };
}): Promise<T> {
  const { signal, timeoutMs, dispatch } = input;
  if (!signal || signal.aborted || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return Promise.reject(new CheckpointCallError("not_dispatched"));
  }
  const deadline = Date.now() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let dispatched = false;
    let cancelRequested = false;
    let handle: { cancel(): void } | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const cancel = () => {
      cancelRequested = true;
      try { handle?.cancel(); } catch { /* Cancellation cannot establish remote outcome. */ }
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CheckpointCallError(dispatched ? "uncertain" : "not_dispatched"));
      cancel();
    };
    const abort = () => fail();
    const timer = setTimeout(fail, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { fail(); return; }
    dispatched = true;
    try {
      handle = dispatch(deadline, (error, response) => {
        // Also supports a synchronous diagnostic callback without settling before
        // dispatch returns its handle. Late and duplicate callbacks are ignored.
        queueMicrotask(() => {
          if (settled) return;
          if (signal.aborted || Date.now() >= deadline || error != null || response === undefined) {
            fail(); return;
          }
          settled = true;
          cleanup();
          resolve(response);
        });
      });
      if (!handle || typeof handle.cancel !== "function") { fail(); return; }
      if (cancelRequested) {
        try { handle.cancel(); } catch { /* Preserve uncertain outcome. */ }
      }
    } catch { fail(); }
  });
}
