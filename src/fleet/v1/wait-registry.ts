export type FleetWaitSnapshotV1<T> = Readonly<{
  offers: readonly T[];
  operationsMode: "running" | "paused" | "draining" | "stopped" | "unknown";
}>;

export type FleetWaitRegistryOptionsV1 = Readonly<{
  waitMs?: number;
  pollMs?: number;
  globalMax?: number;
  maxConcurrentPolls?: number;
  retryAfterSeconds?: number;
  random?: () => number;
}>;

export class FleetWaitCapacityErrorV1 extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("fleet_wait_capacity");
    this.name = "FleetWaitCapacityErrorV1";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class FleetWaitAbortedErrorV1 extends Error {
  constructor() { super("fleet_wait_aborted"); this.name = "FleetWaitAbortedErrorV1"; }
}

type QueuedQueryV1 = Readonly<{ start(): void; abort(): void }>;

/**
 * Process-local long-poll registry. The per-worker and global slot is reserved
 * synchronously, before any wait-route database work. Re-queries are jittered
 * and share a small concurrency gate, so a reconnecting fleet cannot align a
 * burst of polls against the bounded database pool. Parked entries contain no
 * database session, admission lease, task text, or credential.
 */
export class FleetWaitRegistryV1 {
  readonly #waitMs: number;
  readonly #pollMs: number;
  readonly #globalMax: number;
  readonly #maxConcurrentPolls: number;
  readonly #retryAfterSeconds: number;
  readonly #random: () => number;
  readonly #workers = new Set<string>();
  readonly #queryQueue: QueuedQueryV1[] = [];
  #activeQueries = 0;

  constructor(options: FleetWaitRegistryOptionsV1 = {}) {
    this.#waitMs = options.waitMs ?? 25_000;
    this.#pollMs = options.pollMs ?? 1_000;
    this.#globalMax = options.globalMax ?? 32;
    this.#maxConcurrentPolls = options.maxConcurrentPolls ?? 4;
    this.#retryAfterSeconds = options.retryAfterSeconds ?? 1;
    this.#random = options.random ?? Math.random;
    if (![this.#waitMs, this.#pollMs, this.#globalMax, this.#maxConcurrentPolls, this.#retryAfterSeconds]
      .every(value => Number.isSafeInteger(value) && value > 0) || this.#pollMs > this.#waitMs)
      throw new Error("fleet_wait_registry_invalid");
  }

  get parkedCount() { return this.#workers.size; }

  #pollDelay() {
    const random = Math.max(0, Math.min(1, this.#random()));
    return Math.max(1, Math.floor(this.#pollMs * (0.75 + random * 0.5)));
  }

  #drainQueries() {
    while (this.#activeQueries < this.#maxConcurrentPolls) {
      const next = this.#queryQueue.shift();
      if (!next) return;
      next.start();
    }
  }

  #query<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new FleetWaitAbortedErrorV1());
    return new Promise<T>((resolve, reject) => {
      let started = false, settled = false;
      const removeAbort = () => signal?.removeEventListener("abort", queued.abort);
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true; removeAbort(); complete();
      };
      const queued: QueuedQueryV1 = {
        start: () => {
          if (settled) return;
          started = true; this.#activeQueries += 1;
          Promise.resolve().then(work).then(
            value => finish(() => resolve(value)),
            error => finish(() => reject(error)),
          ).finally(() => { this.#activeQueries -= 1; this.#drainQueries(); });
        },
        abort: () => {
          if (started || settled) return;
          const index = this.#queryQueue.indexOf(queued);
          if (index >= 0) this.#queryQueue.splice(index, 1);
          finish(() => reject(new FleetWaitAbortedErrorV1()));
        },
      };
      signal?.addEventListener("abort", queued.abort, { once: true });
      this.#queryQueue.push(queued);
      this.#drainQueries();
    });
  }

  async wait<T>(workerId: string, requery: () => Promise<FleetWaitSnapshotV1<T>>, signal?: AbortSignal,
    beforeQuery?: () => Promise<unknown>) {
    if (signal?.aborted) throw new FleetWaitAbortedErrorV1();
    if (this.#workers.has(workerId) || this.#workers.size >= this.#globalMax)
      throw new FleetWaitCapacityErrorV1(this.#retryAfterSeconds);
    // No await occurs before this reservation: a duplicate request cannot
    // reach presence recording or a work query for this worker.
    this.#workers.add(workerId);
    try {
      if (beforeQuery) await this.#query(beforeQuery, signal);
      const initial = await this.#query(requery, signal);
      if (signal?.aborted) throw new FleetWaitAbortedErrorV1();
      if (initial.offers.length > 0 || initial.operationsMode !== "running") return initial;
      return await new Promise<FleetWaitSnapshotV1<T>>((resolve, reject) => {
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let settled = false, checking = false, finishAfterCheck = false;
        const cleanup = () => {
          if (pollTimer) clearTimeout(pollTimer);
          if (deadlineTimer) clearTimeout(deadlineTimer);
          signal?.removeEventListener("abort", abort);
        };
        const finish = (snapshot: FleetWaitSnapshotV1<T>) => {
          if (settled) return;
          settled = true; cleanup(); resolve(snapshot);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true; cleanup(); reject(error);
        };
        const schedule = () => { pollTimer = setTimeout(() => { void check(false); }, this.#pollDelay()); };
        const check = async (mustFinish: boolean) => {
          if (settled) return;
          if (checking) { finishAfterCheck ||= mustFinish; return; }
          checking = true;
          try {
            // Every answer, including the ordinary timeout answer, comes from
            // a fresh full query rather than cached wake data.
            const snapshot = await this.#query(requery, signal);
            const shouldFinish = mustFinish || finishAfterCheck || snapshot.offers.length > 0
              || snapshot.operationsMode !== "running";
            finishAfterCheck = false;
            if (shouldFinish) finish(snapshot);
            else schedule();
          } catch (error) { fail(error); }
          finally { checking = false; }
        };
        const abort = () => fail(new FleetWaitAbortedErrorV1());
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        deadlineTimer = setTimeout(() => { void check(true); }, this.#waitMs);
        schedule();
      });
    } finally {
      this.#workers.delete(workerId);
    }
  }
}
