/**
 * Polling discipline for the owner website, independent of React.
 *
 * Every recurring read in the owner UI used to schedule its own timer, and most
 * of them used `setInterval`, which starts the next request on a fixed schedule
 * whether or not the previous one has finished. Against a remote database every
 * read is a network round trip, so a read that takes longer than its own
 * interval overlaps itself, and ten open clients multiply that overlap.
 *
 * This scheduler is the single policy for every recurring read:
 *
 *  - It schedules with a recursive timeout armed *after* the previous read
 *    settles, so a read can never overlap itself.
 *  - A trigger that arrives while a read is in flight is coalesced into exactly
 *    one follow-up rather than starting a second request.
 *  - It never reads a hidden tab. Returning to the tab (visibility change or
 *    window focus) refreshes immediately at the base interval.
 *  - A failed read backs off exponentially, so a server that is unavailable is
 *    not hammered at the full interval forever.
 *  - A read that returns data equal to the previous successful read backs off
 *    progressively, so an idle page settles to a low read rate. The stretch is
 *    bounded, and any focus or visibility return resets it to the base interval,
 *    so a returned-to tab is never shown data that is merely cheap.
 *
 * The scheduler reads nothing, trusts nothing and holds no secrets: `read` is
 * supplied by the caller and receives an AbortSignal that is aborted on stop.
 */

export type PolledReadIntervalReason = "base" | "quiet" | "error";

export interface PolledReadSchedulerOptions<T> {
  /** Performs one protected read. Rejected promises are failures, not results. */
  read: (signal: AbortSignal) => Promise<T>;
  /** Called with a value the caller has accepted as the current presentation. */
  accept: (value: T) => void;
  /** Called for every failed read, including aborts caused by `stop`. */
  failed: (reason: unknown) => void;
  /** The ordinary interval. Backoff and quiet stretching are multiples of it. */
  baseIntervalMs: number;
  /** True while the tab is not visible. Supplied so tests need no DOM. */
  hidden: () => boolean;
  /** Timer injection, matching the existing expiry-scheduler idiom in this repo. */
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (timer: unknown) => void;
  /** Equality for the no-change backoff. Defaults to a structural compare. */
  unchanged?: (previous: T, next: T) => boolean;
  /** Ceiling for the quiet stretch. Default 4x base. */
  maxQuietMultiplier?: number;
  /** Ceiling for the error backoff. Default 8x base. */
  maxErrorMultiplier?: number;
  /** Reports the chosen delay and reason. Used by the load test and tests. */
  observe?: (delayMs: number, reason: PolledReadIntervalReason) => void;
}

export interface PolledReadScheduler {
  /** Begins polling. `startDelayMs` defers the first read (default 0). */
  start(startDelayMs?: number): void;
  /** Owner pressed refresh, or the tab became visible or focused. */
  trigger(): void;
  /** Ends polling and aborts any read still in flight. Safe to call twice. */
  stop(): void;
  readonly stopped: boolean;
}

const structuralEqual = (previous: unknown, next: unknown): boolean => {
  if (Object.is(previous, next)) return true;
  if (typeof previous !== "object" || typeof next !== "object" || previous === null || next === null) return false;
  if (Array.isArray(previous) !== Array.isArray(next)) return false;
  const left = previous as Record<string, unknown>, right = next as Record<string, unknown>;
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => Object.hasOwn(right, key) && structuralEqual(left[key], right[key]));
};

export function createPolledReadScheduler<T>(options: PolledReadSchedulerOptions<T>): PolledReadScheduler {
  const base = options.baseIntervalMs;
  if (!Number.isFinite(base) || base <= 0) throw new Error("polled_read_interval_invalid");
  const maxQuiet = options.maxQuietMultiplier ?? 4;
  const maxError = options.maxErrorMultiplier ?? 8;
  const same = options.unchanged ?? structuralEqual;
  const abort = new AbortController();
  let stopped = false, reading = false, coalesced = false, quiet = 0, failures = 0;
  let timer: unknown, latest: { value: T } | undefined;

  function clearTimer(): void {
    if (timer !== undefined) { options.cancel(timer); timer = undefined; }
  }

  function arm(reason: PolledReadIntervalReason): void {
    if (stopped) return;
    const multiplier = reason === "error"
      ? Math.min(2 ** failures, maxError)
      : reason === "quiet" ? Math.min(2 ** quiet, maxQuiet) : 1;
    const delayMs = base * multiplier;
    options.observe?.(delayMs, reason);
    timer = options.schedule(() => { timer = undefined; void run(); }, delayMs);
  }

  async function run(): Promise<void> {
    // A hidden tab never reads. A trigger that arrived while hidden is honoured
    // the moment the tab is visible again, so nothing is silently dropped.
    if (stopped || reading || options.hidden()) return;
    reading = true;
    clearTimer();
    try {
      const value = await options.read(abort.signal);
      if (stopped) return;
      const unchanged = latest !== undefined && same(latest.value, value);
      latest = { value };
      failures = 0;
      // Only a read that changed nothing lengthens the gap. The first changed
      // read returns the page to the ordinary interval immediately.
      quiet = unchanged ? quiet + 1 : 0;
      options.accept(value);
    } catch (reason) {
      if (stopped) return;
      failures = failures + 1;
      options.failed(reason);
    } finally {
      reading = false;
      // A trigger that arrived during the read is served now, at the base
      // interval, rather than being folded into the next scheduled poll.
      if (!stopped && coalesced) { coalesced = false; clearTimer(); void run(); return; }
      if (stopped) return;
      arm(failures > 0 ? "error" : quiet > 0 ? "quiet" : "base");
    }
  }

  return {
    start(startDelayMs = 0) {
      if (stopped || timer !== undefined || reading) return;
      if (startDelayMs > 0) timer = options.schedule(() => { timer = undefined; void run(); }, startDelayMs);
      else void run();
    },
    trigger() {
      if (stopped) return;
      if (options.hidden()) { coalesced = true; return; }
      // A focus or visibility return always earns the base interval, so a tab
      // the owner came back to is never served a stretched interval.
      quiet = 0;
      if (reading) { coalesced = true; return; }
      clearTimer();
      void run();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      coalesced = false;
      clearTimer();
      abort.abort();
    },
    get stopped() { return stopped; },
  };
}
