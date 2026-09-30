import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { databaseOperationSignal, withDatabaseOperationSignal } from "../../persistence/operation-signal";

export const privateDatabaseLimits = Object.freeze({ connections: 8, checkoutMs: 5000,
  statementMs: 5000, transactionMs: 10000, closeMs: 5000 });
/** Server-aborted transactions whose outcome is fully known: the statement was
 * rejected, the transaction is already aborted, and the lease stays reusable.
 * 40P01 (deadlock) and 40001 (serialization failure) are two transactions
 * colliding. 55P03 (lock_not_available) is the pool's own deliberate
 * `lock_timeout` firing under the same contention — the production setting is a
 * 2 second wait, and twenty bots claiming on one project genuinely exceed it.
 * All three rolled back whole, so the operation did nothing and may be replayed;
 * none of them is an outage. */
export type PrivateDatabaseRollbackSqlState = "40P01" | "40001" | "55P03";
const ROLLBACK_SQL_STATES: ReadonlySet<string> = new Set(["40P01", "40001", "55P03"]);
export class PrivateDatabaseError extends Error {
  constructor(readonly code: "database_unavailable" | "database_outcome_uncertain" | "database_close_uncertain",
    /** PostgreSQL's sanitized five-character SQLSTATE. It proves that the
     * server rejected the statement; unlike a transport failure, that outcome
     * is known and must not quarantine every connection in the pool. */
    readonly sqlState?: string) { super(code); }
  get rollbackSqlState(): PrivateDatabaseRollbackSqlState | undefined {
    return this.sqlState !== undefined && ROLLBACK_SQL_STATES.has(this.sqlState)
      ? this.sqlState as PrivateDatabaseRollbackSqlState : undefined;
  }
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
  type Admission = { resolve(): void; reject(error: PrivateDatabaseError): void; timer: ReturnType<typeof setTimeout> };
  const waiting: Admission[] = [];
  let closing: Promise<void> | undefined;
  const invalidations = new Set<() => void>();
  const releaseAdmission = () => {
    active--;
    const next = waiting.shift();
    if (!next) return;
    clearTimeout(next.timer); active++; next.resolve();
  };
  const admit = async (signal: AbortSignal | undefined, timeoutMs: number) => {
    if (stopped) throw new PrivateDatabaseError("database_unavailable");
    if (signal?.aborted) throw new PrivateDatabaseError("database_unavailable");
    if (active < limits.connections) { active++; return; }
    // Keep overload memory bounded while allowing one pool-width burst to wait
    // for an already-running read. The wait itself is bounded by checkoutMs.
    if (waiting.length >= limits.connections) throw new PrivateDatabaseError("database_unavailable");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(admission.timer); signal?.removeEventListener("abort", aborted); };
      const finish = (work: () => void) => { if (settled) return; settled = true; cleanup(); work(); };
      const remove = () => { const index = waiting.indexOf(admission); if (index >= 0) waiting.splice(index, 1); };
      const aborted = () => { remove(); finish(() => reject(new PrivateDatabaseError("database_unavailable"))); };
      const admission: Admission = { resolve: () => finish(resolve), reject: error => finish(() => reject(error)), timer: setTimeout(() => {
        const index = waiting.indexOf(admission);
        if (index >= 0) waiting.splice(index, 1);
        admission.reject(new PrivateDatabaseError("database_unavailable"));
      }, timeoutMs) };
      waiting.push(admission);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  };
  function stop(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    for (const admission of waiting.splice(0)) {
      clearTimeout(admission.timer); admission.reject(new PrivateDatabaseError("database_unavailable"));
    }
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
    const totalMs = transaction ? limits.transactionMs : limits.statementMs;
    const parent = databaseOperationSignal();
    await admit(parent, Math.min(limits.checkoutMs, totalMs));
    // `await` yields even when a slot was immediately available. Close may
    // have started in that turn; refuse before acquisition and return the slot.
    if (stopped || parent?.aborted) { releaseAdmission(); throw new PrivateDatabaseError("database_unavailable"); }
    // Admission has its own bounded wait. Start the operation budget only once
    // this caller owns a slot, so queue contention cannot consume the budget
    // and turn an otherwise bounded request into a pool-wide timeout.
    const operationStarted = performance.now();
    const remainingMs = () => Math.max(1, totalMs - (performance.now() - operationStarted));
    const operation = new AbortController();
    const signal = parent ? AbortSignal.any([parent, operation.signal]) : operation.signal;
    let valid = true, busy = false, queryFailed = false;
    let statementSqlState: string | undefined;
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
    const checkoutTimer = setTimeout(() => { void stop().catch(() => {}); }, Math.min(limits.checkoutMs, remainingMs()));
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
        } catch (error) {
          queryFailed = true;
          if (error instanceof PrivateDatabaseError && error.sqlState) statementSqlState = error.sqlState;
          throw error;
        }
        finally { busy = false; }
      };
      try {
        assertActive();
        if (transaction) { await query("BEGIN"); began = true; }
        const result = await callback(Object.freeze({ query }));
        assertActive();
        if (busy || queryFailed) throw statementSqlState
          ? new PrivateDatabaseError("database_unavailable", statementSqlState)
          : new PrivateDatabaseError("database_outcome_uncertain");
        await check(); assertActive();
        if (busy || queryFailed) throw statementSqlState
          ? new PrivateDatabaseError("database_unavailable", statementSqlState)
          : new PrivateDatabaseError("database_outcome_uncertain");
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
        // PostgreSQL has already aborted the transaction for these statement-time failures.
        // The successful ROLLBACK above proves this lease is reusable; keep the pool serving
        // other requests while returning one sanitized, retryable refusal to this caller.
        //
        // The SQLSTATE travels with the refusal. It is the only thing that lets a
        // caller tell a claim-level collision (40P01/40001 — another transaction
        // won, move on to the next offer) apart from a genuine outage, and
        // discarding it here is what turned a five-bot deadlock into a terminal
        // refusal that ended the worker's whole pass.
        if (error instanceof PrivateDatabaseError && error.rollbackSqlState)
          throw new PrivateDatabaseError("database_unavailable", error.rollbackSqlState);
        throw error;
      } finally { valid = false; lease.release(); }
    });
    try {
      // Acquire has its own ceiling even when the encompassing transaction has time left.
      // It is measured separately by the wrapper below, before any statement can be issued.
      return await deadline(work, remainingMs());
    } catch (error) {
      // Invalidating active operations is immediate; reporting completion also awaits bounded termination.
      if (stopped) await stop();
      throw error;
    } finally { clearTimeout(checkoutTimer); valid = false; operation.abort(); invalidations.delete(invalidate); releaseAdmission(); }
  }
  const client = Object.freeze<DatabaseClient>({
    query: <T>(statement: string, params?: unknown[]) => run(false, session => session.query<T>(statement, params), () => {}),
    transaction: <T>(callback: (session: DatabaseSession) => Promise<T>) => run(true, callback, () => {}),
    transactionWithPreCommitCheck: <T>(callback: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) => run(true, callback, check),
  });
  return Object.freeze({ client, close: stop, isAvailable: () => !stopped });
}
