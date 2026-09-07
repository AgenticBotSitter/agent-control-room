import { startPgBossBoundedRuntime, type PgBossBoundedRuntimeConstructor, type PgBossBoundedRuntimeDatabase } from "./pg-boss-bounded-runtime";
import { startPgBossNativeTaskWorker, type NativeTaskDeliveryHandler, type NativeTaskRecoveryVerifier } from "./pg-boss-native-task-worker";

export type PgBossNativeRuntimeConstructor = PgBossBoundedRuntimeConstructor;
export type PgBossNativeRuntimeDatabase = PgBossBoundedRuntimeDatabase;

/** Fixed native queue and recovery contract; shared lifecycle owns the dedicated pool. */
export function startPgBossNativeTaskRuntime(
  PgBoss: PgBossNativeRuntimeConstructor, database: PgBossNativeRuntimeDatabase,
  input: { deliver: NativeTaskDeliveryHandler; verifyRecovery?: NativeTaskRecoveryVerifier;
    concurrency?: number; backend?: "postgres" | "pglite"; operationTimeoutMs?: number },
) {
  return startPgBossBoundedRuntime(PgBoss, database, input, {
    errorPrefix: "native_task", startWorker: startPgBossNativeTaskWorker,
  });
}
