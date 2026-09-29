// Concurrency attack helpers for tests/support/attack-kit.
//
// Every helper here exists because the matching defect is invisible in a unit
// test: a pool that self-deadlocks, a read that is not a snapshot, and a
// writer that interleaves with it. Each helper therefore bounds wall-clock
// time rather than retrying, so a defect surfaces as a named failure instead of
// a slow pass.

/** Raised when work did not complete inside its bound. Never a retry signal. */
export class ConcurrencyTimeoutError extends Error {
  /**
   * @param elapsedMs Whole milliseconds waited. Guaranteed `>= boundMs`: the
   *   helper enforced that bound, so a timeout that reported less than the
   *   bound would be reporting a measurement it never made.
   * @param elapsedAtLeastBound Diagnostic only, and `false` when the timer was
   *   dispatched early so the figure is the bound rather than a larger
   *   measurement. It is **not** a signal that anything is wrong and **not** a
   *   reason to retry or re-measure: the bound was still enforced, and the flag
   *   cannot recover the true figure. It exists so a reader investigating a
   *   machine's timer behaviour can see the frequency, not so a caller can
   *   change what it does.
   */
  constructor(
    readonly code: string,
    readonly boundMs: number,
    readonly elapsedMs: number,
    readonly elapsedAtLeastBound: boolean = true,
  ) {
    super(`${code}:no_completion_within_${boundMs}ms_elapsed_${elapsedMs}ms`);
    this.name = "ConcurrencyTimeoutError";
  }
}

/** Raised when reads failed while writes were in flight. Carries every error. */
export class ConcurrentReadRaceError extends Error {
  constructor(readonly failures: readonly { index: number; error: unknown }[]) {
    const first = failures[0]?.error;
    const detail = first instanceof Error ? first.message : String(first);
    super(`concurrent_read_race:${failures.length}_read_failure(s):${detail}`);
    this.name = "ConcurrentReadRaceError";
  }
}

/**
 * Raised when no write ever succeeded.
 *
 * A helper whose whole point is interleaving writes with reads used to return
 * `{writes: 0, reads: 35, writeErrors: 35}` and pass: a writer that always
 * throws, or a role that is denied INSERT, produced no concurrency at all and
 * every read raced against nothing. A read-race test then "passes" against a
 * writer that cannot write, which is the case the test exists to detect.
 */
export class NoWritesSucceededError extends Error {
  constructor(readonly errors: readonly unknown[], readonly elapsedMs: number) {
    const first = errors[0];
    const detail = first instanceof Error ? first.message : String(first);
    super(`concurrent_writers_no_successful_write:${errors.length}_write_error(s):${detail}`
      + `:elapsed=${elapsedMs}ms`);
    this.name = "NoWritesSucceededError";
  }
}

/**
 * A monotonic, sub-millisecond clock.
 *
 * `Date.now()` is the wrong clock for a bound, and the difference is not
 * stylistic. It is integer milliseconds, so subtracting it across a ~200 ms
 * window carries up to 1 ms of quantisation error in EITHER direction —
 * measured here at -0.956 ms to +0.952 ms — and it is not monotonic, so a clock
 * step can move it backwards mid-bound and make a helper report a negative
 * elapsed time. libuv compounds it: the loop clock is integer milliseconds too,
 * so a timer armed for `boundMs` can be dispatched slightly BEFORE the
 * sub-millisecond instant it was asked for. Measured on THIS machine over 500
 * runs of `setTimeout(200)`: 1 fired early, by 0.386 ms. (An independent run
 * over 1500 dispatches on the same host saw 14, by 0.949 ms — so treat the
 * rate as a property of the host's load, not a constant.) Stack a quantised
 * reading with a slightly early dispatch and a fired timer reports 199 for a
 * 200 ms bound.
 *
 * That is not a theory. `concurrently(1, () => new Promise(() => {}),
 * { boundMs: 200 })` reported `elapsedMs: 199` in 2 of 1000 runs under CPU load
 * on this machine, failing `tests/attack-kit.test.ts` in CI on `main`.
 *
 * `performance.now()` is monotonic and fractional, so neither source can reach
 * the figure a caller reads.
 */
const monotonicNowMs = (): number => performance.now();

/**
 * One-shot promise that settles after `ms`, carrying the monotonic time at
 * which it fired.
 *
 * The timer is deliberately NOT unref'd. An unref'd timer lets Node exit while
 * the race is still unsettled, so a deadlocked pool would end the process with
 * an "unsettled top-level await" (exit 13) instead of the
 * `pool_exhaustion_deadlock` failure the caller is waiting for. The defect these
 * helpers detect is precisely "nothing else is keeping the loop alive", so the
 * deadline has to be what keeps it alive. The timer is always cleared in a
 * `finally`, so a successful run still exits immediately.
 *
 * `now` is a seam, defaulting to the real clock. It exists because the early
 * timer dispatch this module has to defend against happens in under 1% of runs,
 * so a test cannot produce it reliably by running the real timer — it would be
 * a test waiting for the machine to be unlucky, which is the same defect one
 * level up. A test that injects a clock can hand back a reading 0.4 ms under the
 * bound every single time, which is the case that actually flaked in CI.
 */
function deadline(
  boundMs: number,
  now: () => number = monotonicNowMs,
): { promise: Promise<number>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<number>(resolve => {
    timer = setTimeout(() => resolve(now()), boundMs);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * The elapsed time to report when a bound fired, in whole milliseconds.
 *
 * The contract is the reason this function exists: **a timeout failure reports
 * an elapsed time at least as large as the bound it enforced.** That is what
 * makes the number evidence — it says the work was still running after the
 * bound had passed — rather than a free-floating measurement that a caller
 * cannot interpret.
 *
 * Two things can make a raw reading smaller than the bound, and both are
 * measured above: libuv's early dispatch, and `Date.now()`'s integer
 * quantisation. The clamp is therefore not a fudge that hides a slow timer — a
 * genuinely early dispatch is a fraction of a millisecond, far below anything a
 * reader could act on — it is the statement of the contract, applied at the one
 * place where the raw measurement is known to be quantised. It is `max`, never a
 * fabricated measurement: a real overrun still reports the real, larger elapsed
 * time, and the caller can tell the two cases apart through
 * `elapsedAtLeastBound`.
 *
 * `Math.round`, not truncation, because `performance.now()` is fractional and a
 * dispatched 199.8 ms must still report 200 rather than 199.
 *
 * The non-finite guard is what makes the guarantee unconditional rather than
 * "unconditional for every reading I could construct". `Math.max` returns `NaN`
 * for a `NaN` input, so without it a non-finite reading would propagate
 * straight through the clamp and report a number that is not a time at all —
 * the same class of defect as the one this function exists to prevent, and it
 * would arrive through the same door: the deadline's settlement value.
 *
 * Exported because the rule is the whole fix, and a rule that can only be
 * checked through a timing race cannot be checked at all.
 */
export function enforcedElapsedMs(measuredMs: number, boundMs: number): number {
  if (!Number.isFinite(measuredMs)) return boundMs;
  return Math.max(Math.round(measuredMs), boundMs);
}

/**
 * Run `fn(index)` for each of `count` indices concurrently and assert that all
 * of them complete inside `boundMs`.
 *
 * The bound is the whole point: a promise that never settles is otherwise
 * indistinguishable from a slow test, so the helper reports it as
 * `concurrency_no_completion` with the elapsed time rather than hanging.
 *
 * `options.now` is a test seam for the deadline's clock; it defaults to the
 * real monotonic clock and exists so a test can reproduce an early timer
 * dispatch on demand rather than waiting for one. See `deadline`.
 */
export async function concurrently<T>(
  count: number,
  fn: (index: number) => Promise<T>,
  options: { boundMs?: number; now?: () => number } = {},
): Promise<T[]> {
  if (!Number.isInteger(count) || count < 1) throw new Error("concurrent_count_invalid");
  const boundMs = options.boundMs ?? 10_000;
  const now = options.now ?? monotonicNowMs;
  // The clock starts where the timer does: both are taken from the same
  // monotonic source, and `started` is stamped immediately BEFORE the deadline
  // is armed so the measured window can only ever be at least as long as the
  // one the timer was given. (The previous shape armed the timer after
  // creating the work, and measured with `Date.now()`. See `monotonicNowMs`.)
  const started = now();
  const work = Promise.all(Array.from({ length: count }, (_, index) => fn(index)));
  const timer = deadline(boundMs, now);
  try {
    const settled = await Promise.race([work, timer.promise]);
    // `timer.promise` settles with the monotonic time the timer fired, so the
    // work's own resolution and the deadline are told apart by TYPE rather than
    // by a sentinel string a result value could collide with. `concurrently` is
    // generic, so a caller returning numbers — or `NaN` — is a normal use.
    if (typeof settled !== "number") return settled as T[];
    // Surface the first rejection instead of an unhandled rejection later.
    work.catch(() => {});
    const measured = settled - started;
    throw new ConcurrencyTimeoutError(
      "concurrency_no_completion", boundMs, enforcedElapsedMs(measured, boundMs), measured >= boundMs,
    );
  } finally {
    timer.cancel();
  }
}

/** The slice of pg.Pool this helper needs; keeps the kit testable without pg. */
export interface PoolLike {
  readonly options?: { max?: number };
  connect(): Promise<{ release: (destroy?: boolean) => void }>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end?(): Promise<void>;
}

export interface ExhaustPoolOptions {
  /** Wall-clock bound for the whole batch. */
  boundMs?: number;
  /**
   * Called when the bound elapses, before the timeout is reported. A handler
   * that is deadlocked on a checkout has to be given a way out, or the pending
   * acquisition keeps the pool alive after the test has failed.
   */
  onBound?: () => void | Promise<void>;
  /** Test seam for the deadline's clock. See `concurrently`. */
  now?: () => number;
}

export interface ExhaustPoolResult<T> {
  readonly results: readonly T[];
  readonly concurrentOperations: number;
  readonly elapsedMs: number;
  readonly boundMs: number;
}

/**
 * Run `poolSize + 1` concurrent operations against a pool of `poolSize` and
 * assert they all complete inside `boundMs`.
 *
 * A correctly bounded handler serves the surplus request from the next
 * released connection. A handler that holds a connection while asking for a
 * second one queues its own surplus request behind itself and never finishes,
 * which is the deadlock this helper is built to catch.
 */
export async function exhaustPool<T = unknown>(
  pool: PoolLike,
  poolSize: number,
  operation: (index: number) => Promise<T> = index => pool.query("SELECT 1", [index]) as Promise<T>,
  options: ExhaustPoolOptions = {},
): Promise<ExhaustPoolResult<T>> {
  if (!Number.isInteger(poolSize) || poolSize < 1) throw new Error("exhaust_pool_size_invalid");
  const declared = pool.options?.max;
  if (typeof declared === "number" && declared !== poolSize) {
    throw new Error(`exhaust_pool_size_mismatch:declared=${declared}:requested=${poolSize}`);
  }
  const boundMs = options.boundMs ?? 10_000;
  const concurrentOperations = poolSize + 1;
  const started = monotonicNowMs();
  const work = concurrently(concurrentOperations, index => operation(index), { boundMs, now: options.now });
  try {
    const results = await work;
    return { results, concurrentOperations, elapsedMs: Math.round(monotonicNowMs() - started), boundMs };
  } catch (error) {
    if (!(error instanceof ConcurrencyTimeoutError)) throw error;
    await options.onBound?.();
    // The elapsed time is passed through from `concurrently` rather than
    // re-measured here: it is the same window, measured once, on the same
    // monotonic clock. Re-measuring would add the `onBound` teardown's own
    // duration to the figure and could report a different number than the one
    // `concurrently` enforced the bound against.
    throw new ConcurrencyTimeoutError(
      "pool_exhaustion_deadlock", boundMs, error.elapsedMs, error.elapsedAtLeastBound,
    );
  }
}

export interface ConcurrentWritersOptions {
  durationMs: number;
  /** Concurrent append streams. One by default. */
  writers?: number;
  /** Concurrent read streams. One by default. */
  readers?: number;
  /** Pause between operations; a deadlocking pool needs a moment to settle. */
  thinkMs?: number;
  boundMs?: number;
  /** Return the failures instead of throwing. Off by default: a read race is a defect. */
  readonly allowReadErrors?: boolean;
  /**
   * Tolerate a WRITE that fails, as long as at least one write succeeded.
   *
   * Off by default, and off is the safe direction: a writer that is denied
   * INSERT, or that throws on every call, means nothing raced. A caller that
   * genuinely expects some write failures — contention, a deliberate
   * constraint — sets this and is still refused by the zero-writes rule below,
   * which is not optional.
   */
  readonly allowWriteErrors?: boolean;
  /** Require at least this many successful writes. One by default. */
  readonly minWrites?: number;
}

export interface ConcurrentWritersResult {
  readonly writes: number;
  readonly reads: number;
  readonly writeErrors: readonly unknown[];
  readonly readErrors: readonly { index: number; error: unknown }[];
  readonly elapsedMs: number;
}

/** Sleep. Not unref'd: it is the only thing keeping a writer loop alive. */
const wait = (ms: number) => new Promise<void>(resolve => {
  setTimeout(resolve, ms);
});

/**
 * Interleave appends and reads for `durationMs` and collect every read error.
 *
 * Reads are the ones that race: a read that is not a snapshot sees a write
 * land between two of its own statements and either tears or throws, and that
 * only happens while a writer is in flight. The helper runs both until the
 * duration elapses, so the window is real rather than simulated.
 */
export async function concurrentWriters(
  write: (index: number) => Promise<unknown>,
  read: (index: number) => Promise<unknown>,
  options: ConcurrentWritersOptions,
): Promise<ConcurrentWritersResult> {
  if (!Number.isInteger(options?.durationMs) || options.durationMs < 1) {
    throw new Error("concurrent_writers_duration_invalid");
  }
  const writers = options.writers ?? 1;
  const readers = options.readers ?? 1;
  if (writers < 1 || readers < 1) throw new Error("concurrent_writers_concurrency_invalid");
  // The duration window is measured on the monotonic clock too, for the same
  // reason as the bound: a wall-clock step backwards mid-run would extend the
  // loop indefinitely, and one forwards would cut it short, and neither is a
  // property of the code under test.
  const started = monotonicNowMs();
  const until = started + options.durationMs;
  const writeErrors: unknown[] = [];
  const readErrors: { index: number; error: unknown }[] = [];
  let writes = 0;
  let reads = 0;
  const alive = () => monotonicNowMs() < until;
  const think = () => (options.thinkMs ? wait(options.thinkMs) : Promise.resolve());

  const writer = (index: number) => (async () => {
    while (alive()) {
      try {
        await write(index);
        writes += 1;
      } catch (error) {
        writeErrors.push(error);
      }
      await think();
    }
  })();
  const reader = (index: number) => (async () => {
    while (alive()) {
      try {
        await read(index);
        reads += 1;
      } catch (error) {
        readErrors.push({ index, error });
      }
      await think();
    }
  })();

  const bound = options.boundMs ?? options.durationMs + 30_000;
  // The deadline is cancelled on every exit path. Retaining it made every
  // SUCCESSFUL run keep Node's event loop alive for the full fallback bound:
  // the test bodies finished in ~2s but the process did not exit until ~31s,
  // so each consumer of this helper paid the deadlock deadline in CI time.
  const timer = deadline(bound);
  try {
    const settled = await Promise.race([
      Promise.all([
        ...Array.from({ length: writers }, (_, index) => writer(index)),
        ...Array.from({ length: readers }, (_, index) => reader(index)),
      ]),
      timer.promise,
    ]);
    // The loops all finished, so `settled` is their combined void, not the
    // monotonic time the deadline fires with. Anything else is a failure to
    // report rather than a result to return: a reader or writer loop that
    // escaped its `while` guard would otherwise be indistinguishable from a
    // clean run.
    if (typeof settled === "number") {
      throw new ConcurrencyTimeoutError(
        "concurrent_writers_no_completion", bound,
        enforcedElapsedMs(settled - started, bound), settled - started >= bound,
      );
    }
    const elapsedMs = Math.round(monotonicNowMs() - started);
    const result: ConcurrentWritersResult = { writes, reads, writeErrors, readErrors, elapsedMs };
    // Nothing raced if nothing was written. Checked FIRST, before the read
    // errors, because a reader against a writer that cannot write is not a
    // read race — it is a test that proved nothing, and reporting it as clean
    // is the defect.
    const minWrites = options.minWrites ?? 1;
    if (writes < minWrites) throw new NoWritesSucceededError(writeErrors, elapsedMs);
    if (writeErrors.length > 0 && !options.allowWriteErrors) {
      const first = writeErrors[0];
      const detail = first instanceof Error ? first.message : String(first);
      throw new Error(`concurrent_writers_write_failed:${writeErrors.length}_write_error(s):${detail}`);
    }
    if (readErrors.length > 0 && !options.allowReadErrors) throw new ConcurrentReadRaceError(readErrors);
    return result;
  } finally {
    timer.cancel();
  }
}
