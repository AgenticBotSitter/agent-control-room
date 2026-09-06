import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { databaseOperationSignal, withDatabaseOperationSignal } from "../../persistence/operation-signal";

export const privateDatabaseLimits = Object.freeze({ connections: 8, checkoutMs: 5000,
  statementMs: 5000, transactionMs: 10000, closeMs: 5000 });
export class PrivateDatabaseError extends Error {
  constructor(readonly code: "database_unavailable" | "database_outcome_uncertain" | "database_close_uncertain") { super(code); }
}
export interface PrivateDatabaseLease extends DatabaseSession { release(): void }
/** Trusted, explicitly supplied transport. No ambient driver or fallback is selected here. */
export interface PrivateDatabaseDriver {
  acquire(): Promise<PrivateDatabaseLease>;
  /** Must terminate connections and queued work, not just abandon their promises. Called once. */
  terminate(): Promise<void>;
}

export function boundPrivateDatabase(driver: PrivateDatabaseDriver,
  limits: { [K in keyof typeof privateDatabaseLimits]: number } = privateDatabaseLimits) {
  limits = Object.freeze({ ...limits });
  if (Object.keys(limits).length !== Object.keys(privateDatabaseLimits).length) throw new Error("invalid_database_limits");
  for (const key of Object.keys(privateDatabaseLimits) as (keyof typeof limits)[]) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > privateDatabaseLimits[key])
      throw new Error("invalid_database_limits");
  }
  let stopped = false, active = 0;
  let closing: Promise<void> | undefined;
  const invalidations = new Set<() => void>();
  function stop(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    for (const invalidate of invalidations) invalidate();
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.resolve().then(() => driver.terminate()), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PrivateDatabaseError("database_close_uncertain")), limits.closeMs);
        })]);
      } catch { throw new PrivateDatabaseError("database_close_uncertain"); }
      finally { clearTimeout(timer); }
    })();
    // A deadline may terminate the pool before a shutdown caller awaits its outcome.
    void closing.catch(() => {});
    return closing;
  }
  async function run<T>(transaction: boolean, callback: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>): Promise<T> {
    if (stopped || active >= limits.connections) throw new PrivateDatabaseError("database_unavailable");
    active++;
    const operation = new AbortController(), parent = databaseOperationSignal();
    const signal = parent ? AbortSignal.any([parent, operation.signal]) : operation.signal;
    let valid = true, busy = false, queryFailed = false;
    let invalidate!: () => void;
    const invalidated = new Promise<never>((_, reject) => { invalidate = () => {
      valid = false; operation.abort(); reject(new PrivateDatabaseError("database_outcome_uncertain"));
    }; });
    invalidations.add(invalidate);
    const assertActive = () => { if (!valid || stopped || signal.aborted) throw new PrivateDatabaseError("database_outcome_uncertain"); };
    const deadline = async <U>(work: Promise<U>, ms: number): Promise<U> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([work, invalidated, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { void stop().catch(() => {}); reject(new PrivateDatabaseError("database_outcome_uncertain")); }, ms);
      })]); } finally { clearTimeout(timer); }
    };
    const checkoutTimer = setTimeout(() => { void stop().catch(() => {}); }, limits.checkoutMs);
    const work = withDatabaseOperationSignal(signal, async () => {
      // Late checkout can never enter user code; its lease is still released.
      const lease = await driver.acquire();
      clearTimeout(checkoutTimer);
      let began = false, commitAttempted = false;
      const query = async <U = Record<string, unknown>>(statement: string, params: unknown[] = []) => {
        assertActive();
        if (busy) { queryFailed = true; throw new PrivateDatabaseError("database_unavailable"); }
        busy = true;
        try {
          const result = await deadline(Promise.resolve().then(() => { assertActive(); return lease.query<U>(statement, params); }), limits.statementMs);
          assertActive(); return result;
        } catch (error) { queryFailed = true; throw error; }
        finally { busy = false; }
      };
      try {
        assertActive();
        if (transaction) { await query("BEGIN"); began = true; }
        const result = await callback(Object.freeze({ query }));
        assertActive();
        if (busy || queryFailed) throw new PrivateDatabaseError("database_outcome_uncertain");
        await check(); assertActive();
        if (busy || queryFailed) throw new PrivateDatabaseError("database_outcome_uncertain");
        if (transaction) { commitAttempted = true; await query("COMMIT"); began = false; }
        return result;
      } catch (error) {
        // A missing COMMIT acknowledgement is not evidence of rollback. Quarantine even on a fast rejection.
        if (commitAttempted || error instanceof PrivateDatabaseError && error.code === "database_outcome_uncertain") {
          await stop(); throw new PrivateDatabaseError("database_outcome_uncertain");
        }
        // On timeout the driver is already quarantined; never enqueue a late rollback/write.
        if (began && valid && !stopped) {
          try { await query("ROLLBACK"); }
          catch { await stop(); throw new PrivateDatabaseError("database_outcome_uncertain"); }
        }
        throw error;
      } finally { valid = false; lease.release(); }
    });
    try {
      // Acquire has its own ceiling even when the encompassing transaction has time left.
      // It is measured separately by the wrapper below, before any statement can be issued.
      return await deadline(work, transaction ? limits.transactionMs : limits.statementMs);
    } catch (error) {
      // Invalidating active operations is immediate; reporting completion also awaits bounded termination.
      if (stopped) await stop();
      throw error;
    } finally { clearTimeout(checkoutTimer); valid = false; operation.abort(); invalidations.delete(invalidate); active--; }
  }
  const client = Object.freeze<DatabaseClient>({
    query: <T>(statement: string, params?: unknown[]) => run(false, session => session.query<T>(statement, params), () => {}),
    transaction: <T>(callback: (session: DatabaseSession) => Promise<T>) => run(true, callback, () => {}),
    transactionWithPreCommitCheck: <T>(callback: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) => run(true, callback, check),
  });
  return Object.freeze({ client, close: stop, isAvailable: () => !stopped });
}
