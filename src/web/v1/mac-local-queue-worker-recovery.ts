import type { PgBossRuntimeTerminalV1 } from "../../persistence/pg-boss-bounded-runtime";

/** Nominal capability held only by the queue-recovery owner returned below. */
export const MAC_LOCAL_QUEUE_RECOVERY_OWNER = Symbol("mac-local-queue-recovery-owner");

export interface RecoverableMacLocalQueueWorkerV1 {
  status(): { accepting: boolean };
  close(): Promise<void>;
  whenTerminated(): Promise<PgBossRuntimeTerminalV1>;
}

const failure = (message: string) => { const value = new Error(message); value.stack = undefined; return value; };

/** Mac-local queue lifecycle. Delivery replay remains exclusively pg-boss and
 * recovery-verifier owned; this supervisor only replaces a fully closed runtime. */
export async function startRecoveringMacLocalQueueWorkerV1(startOne: () => Promise<RecoverableMacLocalQueueWorkerV1>,
  options: { delaysMs?: readonly number[]; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}) {
  if (typeof startOne !== "function") throw failure("mac_local_queue_recovery_config_invalid");
  const delays = [...(options.delaysMs ?? [250, 500, 1_000, 2_000, 5_000])];
  if (delays.length < 1 || delays.length > 16
    || delays.some(value => !Number.isSafeInteger(value) || value < 1 || value > 30_000))
    throw failure("mac_local_queue_recovery_config_invalid");
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(failure("mac_local_queue_recovery_closed")); return; }
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(failure("mac_local_queue_recovery_closed")); }
    signal.addEventListener("abort", aborted, { once: true });
  }));
  if (typeof sleep !== "function") throw failure("mac_local_queue_recovery_config_invalid");
  type State = "running" | "reconnecting" | "closing" | "closed" | "uncertain";
  let state: State = "reconnecting", faulted = false, closeRequested = false;
  let worker: RecoverableMacLocalQueueWorkerV1 | undefined;
  let closing: Promise<void> | undefined;
  const shutdown = new AbortController();
  const cleanupUncertain = (error: unknown) => error instanceof Error && error.message.endsWith("_cleanup_uncertain");
  const startCandidate = async () => {
    const candidate = await startOne();
    if (!candidate || typeof candidate.status !== "function" || typeof candidate.close !== "function"
      || typeof candidate.whenTerminated !== "function" || candidate.status().accepting !== true) {
      if (!candidate || typeof candidate.close !== "function") throw failure("mac_local_queue_recovery_cleanup_uncertain");
      try { await candidate.close(); } catch { throw failure("mac_local_queue_recovery_cleanup_uncertain"); }
      throw failure("mac_local_queue_recovery_start_failed");
    }
    return candidate;
  };
  try { worker = await startCandidate(); state = "running"; }
  catch (error) {
    faulted = true;
    if (cleanupUncertain(error)) throw error;
  }
  const monitor = (async () => {
    while (!closeRequested) {
      if (worker) {
        const observed: RecoverableMacLocalQueueWorkerV1 = worker;
        const terminal = await observed.whenTerminated();
        if (closeRequested || observed !== worker) continue;
        worker = undefined;
        if (terminal.cause !== "fault") { state = "closed"; return; }
        faulted = true;
        if (terminal.cleanup !== "closed") { state = "uncertain"; return; }
        state = "reconnecting";
      }
      let attempt = 0;
      while (!closeRequested && !worker) {
        try { await sleep(delays[Math.min(attempt, delays.length - 1)]!, shutdown.signal); }
        catch { return; }
        if (closeRequested) return;
        try {
          const candidate = await startCandidate();
          if (closeRequested) {
            try { await candidate.close(); } catch { state = "uncertain"; }
            return;
          }
          worker = candidate; state = "running"; faulted = false; break;
        } catch (error) {
          if (cleanupUncertain(error)) { state = "uncertain"; return; }
          attempt++;
        }
      }
    }
  })().catch(() => { state = "uncertain"; });
  const isUncertain = () => state === "uncertain";
  return Object.freeze({
    [MAC_LOCAL_QUEUE_RECOVERY_OWNER]: true as const,
    status: () => Object.freeze({ state, faulted, accepting: state === "running" && worker?.status().accepting === true }),
    close: () => closing ??= (async () => {
      closeRequested = true;
      let uncertain = state === "uncertain";
      state = "closing"; shutdown.abort();
      if (worker) { try { await worker.close(); } catch { uncertain = true; } }
      await monitor;
      if (isUncertain()) uncertain = true;
      state = uncertain ? "uncertain" : "closed";
      if (uncertain) throw failure("mac_local_queue_recovery_close_uncertain");
    })(),
  });
}
