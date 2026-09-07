import { createBoundedQueueWorkerBootstrap, type BoundedQueueWorkerStartupConfiguration } from "./bounded-queue-worker-startup";
import { startPgBossNativeTaskRuntime, type PgBossNativeRuntimeConstructor } from "../../persistence/pg-boss-native-task-runtime";
import type { NativeTaskSubmissionReference } from "../../persistence/native-task-submission";
import type { PrivatePostgresConfiguration } from "./private-postgres";
import type { TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";

export type NativeQueueWorkerStartupConfiguration = BoundedQueueWorkerStartupConfiguration<NativeTaskSubmissionReference>;

/** Fixed native queue startup. Shared bootstrap retains topology, preflight and pool ownership. */
export function createNativeQueueWorkerBootstrap(dependencies: {
  PgBoss: PgBossNativeRuntimeConstructor;
  openDatabase: (config: PrivatePostgresConfiguration) => TaskCoordinatorDatabase;
  backend?: "postgres" | "pglite";
}) {
  return createBoundedQueueWorkerBootstrap<NativeTaskSubmissionReference>(dependencies, {
    errorPrefix: "native_queue_worker", runtimeErrorPrefix: "native_task", startRuntime: startPgBossNativeTaskRuntime,
  });
}
