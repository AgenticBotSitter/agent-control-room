import { validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";
import { verifyNativeQueueWorkerDatabase } from "./private-database-preflight";
import type { TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";
import { startPgBossNativeTaskRuntime, type PgBossNativeRuntimeConstructor } from "../../persistence/pg-boss-native-task-runtime";
import type { NativeTaskDeliveryHandler, NativeTaskRecoveryVerifier } from "../../persistence/pg-boss-native-task-worker";

export interface NativeQueueWorkerStartupConfiguration {
  database: PrivatePostgresConfiguration;
  /** Trusted application topology, not a request-provided tenant/permission policy. */
  application: Pick<PrivatePostgresConfiguration, "host" | "port" | "database"> & { loginNames: readonly string[] };
  deliver: NativeTaskDeliveryHandler;
  verifyRecovery?: NativeTaskRecoveryVerifier;
  concurrency?: number;
}
const failure = (message: string) => { const error = new Error(message); error.stack = undefined; return error; };

/** Explicit server composition only; no default instance, package loading or pool effect on import.
 * Caller supplies the pinned package, bounded pool factory and current-authority delivery handler.
 * One attempt per bootstrap. Does not install a web endpoint or authorize native execution. */
export function createNativeQueueWorkerBootstrap(dependencies: {
  PgBoss: PgBossNativeRuntimeConstructor;
  openDatabase: (config: PrivatePostgresConfiguration) => TaskCoordinatorDatabase;
  /** Test backend is a construction-time dependency, never deployment configuration. */
  backend?: "postgres" | "pglite";
}) {
  const { PgBoss, backend = "postgres" } = dependencies;
  const open = dependencies.openDatabase.bind(dependencies);
  let attempted = false;
  return Object.freeze({ async start(input: NativeQueueWorkerStartupConfiguration) {
    if (attempted) throw failure("native_queue_worker_already_attempted");
    attempted = true;
    let config: PrivatePostgresConfiguration, deliver: NativeTaskDeliveryHandler, concurrency: number;
    let verifyRecovery: NativeTaskRecoveryVerifier | undefined;
    try {
      config = validatePrivatePostgresConfiguration(input.database);
      const app = input.application;
      if (app.host !== config.host || app.port !== config.port || app.database !== config.database
        || !Array.isArray(app.loginNames) || app.loginNames.length < 2 || app.loginNames.length > 5
        || new Set(app.loginNames).size !== app.loginNames.length
        || app.loginNames.some(name => typeof name !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(name) || name === config.username)
        || typeof input.deliver !== "function" || input.verifyRecovery !== undefined && typeof input.verifyRecovery !== "function") throw new Error();
      concurrency = input.concurrency ?? 1;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error();
      deliver = input.deliver;
      verifyRecovery = input.verifyRecovery;
    } catch { throw failure("native_queue_worker_config_invalid"); }
    let pool: TaskCoordinatorDatabase | undefined, closing: Promise<void> | undefined, closed = false, timedOut = false;
    const bounded = async <T>(work: () => Promise<T>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(failure("native_queue_worker_timeout")); }, 5000);
      })]); } finally { clearTimeout(timer); }
    };
    let closeRaw: (() => Promise<void>) | undefined;
    const close = () => closing ??= (async () => { closed = true; if (closeRaw) await bounded(closeRaw); })();
    try {
      pool = open(config);
      closeRaw = pool.close.bind(pool);
      const available = pool.isAvailable.bind(pool), query = pool.client.query.bind(pool.client);
      const transaction = pool.client.transaction.bind(pool.client);
      const check = () => { if (closed || !available()) throw failure("native_queue_worker_unavailable"); };
      check();
      await bounded(() => verifyNativeQueueWorkerDatabase({ ...pool!.client, transaction: work => transaction(tx => {
        check(); return work({ async query<T>(sql: string, values?: unknown[]) { check(); const result = await tx.query<T>(sql, values); check(); return result; } });
      }) }, config));
      check();
      return await startPgBossNativeTaskRuntime(PgBoss, { close, async query<T>(sql: string, values?: unknown[]) {
        check(); const result = await query<T>(sql, values); check(); return result;
      } }, { backend, concurrency,
        ...(verifyRecovery ? { async verifyRecovery(reference, ordinal, signal) {
          check(); await verifyRecovery!(reference, ordinal, signal); check();
        } } : {}), async deliver(reference, signal) {
        check(); const result = await deliver(reference, signal); check(); return result;
      } });
    } catch (error) {
      if (pool && !closeRaw) throw failure("native_queue_worker_cleanup_uncertain");
      try { await close(); } catch { throw failure("native_queue_worker_cleanup_uncertain"); }
      const uncertain = timedOut || error instanceof Error && error.message === "native_task_runtime_start_cleanup_uncertain";
      throw failure(uncertain ? "native_queue_worker_cleanup_uncertain" : "native_queue_worker_start_failed");
    }
  } });
}
