import type { DatabaseSession } from "./database";
import { verifyPgBossNativeWorkerPermissions } from "./pg-boss-native-task-permissions";
import { PG_BOSS_NATIVE_SUBMISSION as spec } from "./pg-boss-native-task-submission";
import type { BoundedDeliveryHandler, BoundedRecoveryVerifier, PgBossBoundedWorkerClient } from "./pg-boss-bounded-worker";

interface RuntimeClient extends PgBossBoundedWorkerClient {
  start(): Promise<unknown>;
  stop(options: { graceful: false }): Promise<unknown>;
  on(event: "error", listener: (error: unknown) => void): unknown;
}
export type PgBossBoundedRuntimeConstructor = new (options: {
  db: { executeSql(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
  schema: string; backend: "postgres" | "pglite";
  migrate: false; createSchema: false; supervise: false; schedule: false; useListenNotify: false;
}) => RuntimeClient;
export interface PgBossBoundedRuntimeDatabase extends DatabaseSession {
  /** Dedicated worker-role pool, already preflighted and bounded by its owner.
   * Never pass a shared producer/web pool: this composition owns its close. */
  close(): Promise<void>;
}
type State = "starting" | "running" | "closing" | "closed" | "uncertain";
const error = (message: string) => {
  const value = new Error(message); value.stack = undefined; return value;
};

/** Internal shared ownership lifecycle for fixed native-task and feed wrappers.
 * Not a caller-selected queue, installer or application startup hook.
 * Supply the pinned upstream constructor and an already-authorized dedicated pool.
 * pg-boss owns pickup and worker cleanup; these deadlines fence our admission and
 * report uncertainty, never assert termination of arbitrary external work.
 * No schema creation/migration, supervisor, scheduler, LISTEN or automatic restart.
 */
export async function startPgBossBoundedRuntime<Reference>(
  PgBoss: PgBossBoundedRuntimeConstructor, database: PgBossBoundedRuntimeDatabase,
  input: { deliver: BoundedDeliveryHandler<Reference>; verifyRecovery?: BoundedRecoveryVerifier<Reference>; concurrency?: number; backend?: "postgres" | "pglite";
    operationTimeoutMs?: number },
  profile: { errorPrefix: "native_task" | "abs_feed"; startWorker(client: PgBossBoundedWorkerClient,
    input: { concurrency: number; deliver: BoundedDeliveryHandler<Reference>; verifyRecovery?: BoundedRecoveryVerifier<Reference> }): Promise<{ close(): Promise<void> }> },
) {
  const prefix = profile.errorPrefix, startWorker = profile.startWorker.bind(profile);
  const concurrency = input.concurrency ?? 1, timeout = input.operationTimeoutMs ?? 5000;
  const backend = input.backend ?? "postgres";
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 5000
    || !["postgres", "pglite"].includes(backend) || typeof input.deliver !== "function"
    || input.verifyRecovery !== undefined && typeof input.verifyRecovery !== "function"
    || typeof database.query !== "function" || typeof database.close !== "function")
    throw error(`${prefix}_runtime_config_invalid`);
  // Ownership transfers after validation; capture methods before any asynchronous work.
  const deliver = input.deliver.bind(input), query = database.query.bind(database), closeDatabase = database.close.bind(database);
  const verifyRecovery = input.verifyRecovery?.bind(input);
  const admission = new AbortController();
  let state: State = "starting", faulted = false, sqlClosed = false;
  let worker: { close(): Promise<void> } | undefined;
  let client: RuntimeClient | undefined, stopClient: (() => Promise<unknown>) | undefined;
  let closing: Promise<void> | undefined;
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    try {
      const result = await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error(`${prefix}_runtime_operation_uncertain`)), timeout);
      })]);
      if (performance.now() - started >= timeout) throw error(`${prefix}_runtime_operation_uncertain`);
      return result;
    } finally { clearTimeout(timer); }
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    state = "closing"; admission.abort();
    closing = (async () => {
      let uncertain = false;
      if (worker) { try { await bounded(() => worker!.close()); } catch { uncertain = true; } }
      // Even a drain failure must attempt upstream stop and close the dedicated pool.
      if (stopClient) { try { await bounded(stopClient); } catch { uncertain = true; } }
      sqlClosed = true;
      try { await bounded(closeDatabase); } catch { uncertain = true; }
      state = uncertain ? "uncertain" : "closed";
      if (uncertain) throw error(`${prefix}_runtime_close_uncertain`);
    })();
    return closing;
  };
  try {
    await bounded(() => verifyPgBossNativeWorkerPermissions({ query }));
    client = new PgBoss({ db: { async executeSql(sql, values) {
      if (sqlClosed) throw error(`${prefix}_runtime_unavailable`);
      return query(sql, values);
    } }, schema: spec.schema, backend, migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false });
    const captured = client;
    stopClient = captured.stop.bind(captured, { graceful: false });
    // Observe infrastructure errors before start. Never log/serialize their payload.
    captured.on("error", () => { faulted = true; void close().catch(() => {}); });
    await bounded(() => captured.start());
    if (admission.signal.aborted) throw error(`${prefix}_runtime_unavailable`);
    const registration = startWorker(captured, { concurrency,
      ...(verifyRecovery ? { async verifyRecovery(reference, ordinal, signal) {
        const combined = AbortSignal.any([signal, admission.signal]);
        if (combined.aborted) throw error(`${prefix}_runtime_unavailable`);
        await verifyRecovery(reference, ordinal, combined);
        if (combined.aborted) throw error(`${prefix}_runtime_unavailable`);
      } } : {}), async deliver(reference, signal) {
      const combined = AbortSignal.any([signal, admission.signal]);
      if (combined.aborted) throw error(`${prefix}_runtime_unavailable`);
      const result = await deliver(reference, combined);
      if (combined.aborted) throw error(`${prefix}_runtime_unavailable`);
      return result;
    } });
    // A timed-out registration may finish later. Fence its callback immediately and
    // retire the late group as well; a timeout never authorizes a replacement worker.
    void registration.then(late => {
      if (admission.signal.aborted) void bounded(() => late.close()).catch(() => {});
    }, () => {});
    worker = await bounded(() => registration);
    if (admission.signal.aborted) throw error(`${prefix}_runtime_unavailable`);
    state = "running";
  } catch {
    faulted = true;
    try { await close(); } catch { throw error(`${prefix}_runtime_start_cleanup_uncertain`); }
    throw error(`${prefix}_runtime_start_failed`);
  }
  return Object.freeze({
    status: () => Object.freeze({ state, faulted, accepting: state === "running" && !faulted }),
    close,
  });
}

