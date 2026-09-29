// Concurrency attack helpers for tests/support/attack-kit.
//
// Every helper here exists because the matching defect is invisible in a unit
// test: a pool that self-deadlocks, a read that is not a snapshot, and a
// writer that interleaves with it. Each helper therefore bounds wall-clock
// time rather than retrying, so a defect surfaces as a named failure instead of
// a slow pass.

/** Raised when work did not complete inside its bound. Never a retry signal. */
export class ConcurrencyTimeoutError extends Error {
  constructor(readonly code: string, readonly boundMs: number, readonly elapsedMs: number) {
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

const DEADLINE_PADDING_MS = 50;

/**
 * One-shot promise that settles after `ms`.
 *
 * The timer is deliberately NOT unref'd. An unref'd timer lets Node exit while
 * the race is still unsettled, so a deadlocked pool would end the process with
 * an "unsettled top-level await" (exit 13) instead of the
 * `pool_exhaustion_deadlock` failure the caller is waiting for. The defect these
 * helpers detect is precisely "nothing else is keeping the loop alive", so the
 * deadline has to be what keeps it alive. The timer is always cleared in a
 * `finally`, so a successful run still exits immediately.
 */
function deadline(boundMs: number): { promise: Promise<"timeout">; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<"timeout">(resolve => {
    timer = setTimeout(() => resolve("timeout"), boundMs);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Run `fn(index)` for each of `count` indices concurrently and assert that all
 * of them complete inside `boundMs`.
 *
 * The bound is the whole point: a promise that never settles is otherwise
 * indistinguishable from a slow test, so the helper reports it as
 * `concurrency_no_completion` with the elapsed time rather than hanging.
 */
export async function concurrently<T>(
  count: number,
  fn: (index: number) => Promise<T>,
  options: { boundMs?: number } = {},
): Promise<T[]> {
  if (!Number.isInteger(count) || count < 1) throw new Error("concurrent_count_invalid");
  const boundMs = options.boundMs ?? 10_000;
  const started = Date.now();
  const work = Promise.all(Array.from({ length: count }, (_, index) => fn(index)));
  const timer = deadline(boundMs);
  try {
    const settled = await Promise.race([work, timer.promise]);
    if (settled === "timeout") {
      // Surface the first rejection instead of an unhandled rejection later.
      work.catch(() => {});
      throw new ConcurrencyTimeoutError("concurrency_no_completion", boundMs, Date.now() - started);
    }
    return settled as T[];
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
  const started = Date.now();
  const work = concurrently(concurrentOperations, index => operation(index), { boundMs });
  try {
    const results = await work;
    return { results, concurrentOperations, elapsedMs: Date.now() - started, boundMs };
  } catch (error) {
    if (!(error instanceof ConcurrencyTimeoutError)) throw error;
    await options.onBound?.();
    throw new ConcurrencyTimeoutError("pool_exhaustion_deadlock", boundMs, error.elapsedMs);
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
  const started = Date.now();
  const until = started + options.durationMs;
  const writeErrors: unknown[] = [];
  const readErrors: { index: number; error: unknown }[] = [];
  let writes = 0;
  let reads = 0;
  const alive = () => Date.now() < until;
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
    if (settled === "timeout") {
      throw new ConcurrencyTimeoutError("concurrent_writers_no_completion", bound, Date.now() - started);
    }
    const elapsedMs = Date.now() - started;
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
