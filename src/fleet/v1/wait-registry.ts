export type FleetWaitSnapshotV1<T> = Readonly<{
  offers: readonly T[];
  operationsMode: "running" | "paused" | "draining" | "stopped" | "unknown";
}>;

export type FleetWaitRegistryOptionsV1 = Readonly<{
  waitMs?: number;
  pollMs?: number;
  globalMax?: number;
  retryAfterSeconds?: number;
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

/**
 * Process-local long-poll registry. A slot is reserved only after the first
 * database re-query has completed. Parked entries contain no database session,
 * admission lease, task text, or credential.
 */
export class FleetWaitRegistryV1 {
  readonly #waitMs: number;
  readonly #pollMs: number;
  readonly #globalMax: number;
  readonly #retryAfterSeconds: number;
  readonly #workers = new Set<string>();

  constructor(options: FleetWaitRegistryOptionsV1 = {}) {
    this.#waitMs = options.waitMs ?? 25_000;
    this.#pollMs = options.pollMs ?? 250;
    this.#globalMax = options.globalMax ?? 128;
    this.#retryAfterSeconds = options.retryAfterSeconds ?? 1;
    if (![this.#waitMs, this.#pollMs, this.#globalMax, this.#retryAfterSeconds]
      .every(value => Number.isSafeInteger(value) && value > 0) || this.#pollMs > this.#waitMs)
      throw new Error("fleet_wait_registry_invalid");
  }

  get parkedCount() { return this.#workers.size; }

  async wait<T>(workerId: string, requery: () => Promise<FleetWaitSnapshotV1<T>>, signal?: AbortSignal) {
    if (signal?.aborted) throw new FleetWaitAbortedErrorV1();
    // First re-query: do not consume a parked slot when work or a stop state is
    // already visible.
    const initial = await requery();
    if (initial.offers.length > 0 || initial.operationsMode !== "running") return initial;
    if (this.#workers.has(workerId) || this.#workers.size >= this.#globalMax)
      throw new FleetWaitCapacityErrorV1(this.#retryAfterSeconds);
    this.#workers.add(workerId);
    try {
      // Re-query after reserving the slot closes the race between the first
      // read and actually parking the request.
      const beforePark = await requery();
      if (signal?.aborted) throw new FleetWaitAbortedErrorV1();
      if (beforePark.offers.length > 0 || beforePark.operationsMode !== "running") return beforePark;
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
        const schedule = () => { pollTimer = setTimeout(() => { void check(false); }, this.#pollMs); };
        const check = async (mustFinish: boolean) => {
          if (settled) return;
          if (checking) { finishAfterCheck ||= mustFinish; return; }
          checking = true;
          try {
            // Every answer, including the ordinary timeout answer, comes from
            // a fresh full query rather than cached wake data.
            const snapshot = await requery();
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
