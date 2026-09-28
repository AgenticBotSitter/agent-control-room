import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { withoutDatabaseOperationSignal } from "../../persistence/operation-signal";
import { PrivateDatabaseError } from "./bounded-database";

export interface RecoveringPrivateDatabaseGeneration {
  client: DatabaseClient;
  close(): Promise<void>;
  isAvailable(): boolean;
}

const unavailable = () => new PrivateDatabaseError("database_unavailable");

/** Stable application client over replaceable, independently bounded pool generations.
 * The operation that discovers a failed generation is never replayed. A replacement
 * is admitted only after the old generation closes cleanly and the candidate passes
 * the same session qualification exercised by an ordinary query. */
export function recoveringPrivateDatabase(open: (reportFault: () => void) => RecoveringPrivateDatabaseGeneration,
  options: { delaysMs?: readonly number[]; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}) {
  if (typeof open !== "function") throw new Error("recovering_database_config_invalid");
  const delays = [...(options.delaysMs ?? [250, 500, 1_000, 2_000, 5_000])];
  if (delays.length < 1 || delays.length > 16
    || delays.some(value => !Number.isSafeInteger(value) || value < 1 || value > 30_000))
    throw new Error("recovering_database_config_invalid");
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(unavailable()); return; }
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(unavailable()); }
    signal.addEventListener("abort", aborted, { once: true });
  }));
  if (typeof sleep !== "function") throw new Error("recovering_database_config_invalid");

  type State = "ready" | "reconnecting" | "closed" | "close_uncertain";
  let state: State = "ready";
  let current: RecoveringPrivateDatabaseGeneration | undefined;
  let candidate: RecoveringPrivateDatabaseGeneration | undefined;
  let recovery: Promise<void> | undefined, closing: Promise<void> | undefined;
  let closed = false, cleanupUncertain = false;
  const shutdown = new AbortController();
  const generationClosures = new Map<RecoveringPrivateDatabaseGeneration, Promise<void>>();

  const closeGeneration = (generation: RecoveringPrivateDatabaseGeneration) => {
    let closingGeneration = generationClosures.get(generation);
    if (!closingGeneration) {
      closingGeneration = Promise.resolve().then(() => generation.close()).catch(() => {
        cleanupUncertain = true; state = "close_uncertain"; throw new PrivateDatabaseError("database_close_uncertain");
      });
      generationClosures.set(generation, closingGeneration);
    }
    return closingGeneration;
  };
  const recover = (faulted?: RecoveringPrivateDatabaseGeneration) => {
    if (closed || cleanupUncertain || recovery) return;
    if (faulted && faulted !== current) return;
    const failed = current;
    state = "reconnecting";
    recovery = withoutDatabaseOperationSignal(() => (async () => {
      current = undefined;
      if (failed) await closeGeneration(failed);
      let attempt = 0;
      while (!closed && !cleanupUncertain) {
        try { await sleep(delays[Math.min(attempt, delays.length - 1)]!, shutdown.signal); }
        catch { return; }
        if (closed) return;
        try {
          let opened: RecoveringPrivateDatabaseGeneration | undefined, faultBeforeReturn = false;
          opened = open(() => { if (opened) recover(opened); else faultBeforeReturn = true; });
          candidate = opened;
          if (faultBeforeReturn) recover(opened);
          await candidate.client.query("SELECT 1");
          if (!candidate.isAvailable()) throw unavailable();
          if (closed) { await closeGeneration(candidate); candidate = undefined; return; }
          current = candidate; candidate = undefined; state = "ready"; return;
        } catch {
          if (candidate) {
            try { await closeGeneration(candidate); }
            catch { candidate = undefined; return; }
            candidate = undefined;
          }
          attempt++;
        }
      }
    })().catch(() => {}).finally(() => {
      recovery = undefined;
      // A newly published generation can fault after its final qualification
      // check but before this recovery promise retires. Its fault callback
      // cannot start a second recovery while `recovery` is still set, so
      // re-check here to avoid leaving an unavailable generation poisoned.
      if (!closed && !cleanupUncertain && (!current || !current.isAvailable())) recover(current);
    }));
  };
  let initial: RecoveringPrivateDatabaseGeneration | undefined, initialFault = false;
  initial = open(() => { if (initial) recover(initial); else initialFault = true; });
  current = initial;
  if (initialFault) recover(initial);
  const use = async <T>(operation: (client: DatabaseClient) => Promise<T>): Promise<T> => {
    if (closed || cleanupUncertain) throw unavailable();
    const generation = current;
    if (!generation || !generation.isAvailable()) { recover(); throw unavailable(); }
    try { return await operation(generation.client); }
    catch (error) {
      if (!generation.isAvailable()) recover(generation);
      throw error;
    }
  };
  const client = Object.freeze<DatabaseClient>({
    query: <T>(statement: string, params?: unknown[]) => use(db => db.query<T>(statement, params)),
    transaction: <T>(work: (session: DatabaseSession) => Promise<T>) => use(db => db.transaction(work)),
    transactionWithPreCommitCheck: <T>(work: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) =>
      use(db => db.transactionWithPreCommitCheck(work, check)),
  });
  return Object.freeze({
    client,
    isAvailable: () => state === "ready" && current?.isAvailable() === true,
    close: () => closing ??= (async () => {
      closed = true; state = "closed"; shutdown.abort();
      const generations = [...new Set([current, candidate].filter((value): value is RecoveringPrivateDatabaseGeneration => !!value))];
      current = undefined; candidate = undefined;
      const outcomes = await Promise.allSettled(generations.map(closeGeneration));
      await recovery;
      if (cleanupUncertain || outcomes.some(outcome => outcome.status === "rejected")) {
        state = "close_uncertain";
        throw new PrivateDatabaseError("database_close_uncertain");
      }
    })(),
  });
}
