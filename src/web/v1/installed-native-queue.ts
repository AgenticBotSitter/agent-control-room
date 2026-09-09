import { PgBoss } from "pg-boss";
import { preparePgBossNativeTaskSubmission } from "../../persistence/pg-boss-native-task-submission";
import { createNativeQueueWorkerBootstrap } from "./native-queue-worker-startup";
import type { PrivatePostgresConfiguration } from "./private-postgres";
import type { TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";
import type { DatabaseSession } from "../../persistence/database";
import type { NativeQueueWorkerStartupConfiguration } from "./native-queue-worker-startup";
import { preparePgBossAbsFeedSubmission } from "../../persistence/pg-boss-abs-feed-submission";
import { createNewsQueueWorkerBootstrap, type NewsQueueWorkerStartupConfiguration } from "./news-queue-worker-startup";

/** Installed-package composition only. Import/construction opens no pool and starts no worker.
 * The caller still explicitly selects nativeQueue/queueWorker and supplies verified startup.
 * Recovery availability does not enable it: task bootstrap captures it only when configured.
 */
export function createInstalledNativeQueueFactories(options: {
  openWorkerDatabase: (configuration: PrivatePostgresConfiguration) => TaskCoordinatorDatabase;
  backend?: "postgres" | "pglite";
}) {
  const backend = options.backend ?? "postgres", openDatabase = options.openWorkerDatabase;
  if (!["postgres", "pglite"].includes(backend) || typeof openDatabase !== "function")
    throw new Error("installed_native_queue_config_invalid");
  return Object.freeze({
    prepareNativeSubmission: (database: DatabaseSession) => preparePgBossNativeTaskSubmission(PgBoss, database, { backend, recovery: true }),
    startNativeWorker: (configuration: NativeQueueWorkerStartupConfiguration) =>
      createNativeQueueWorkerBootstrap({ PgBoss, openDatabase, backend }).start(configuration),
  });
}

/** Same installed pg-boss package, separate news queue and restricted worker pool.
 * Supply these factories to createPrivateTaskBootstrap with explicit news config.
 * Construction does not open a database, fetch sources or start a worker. */
export function createInstalledNewsQueueFactories(options: {
  openWorkerDatabase: (configuration: PrivatePostgresConfiguration) => TaskCoordinatorDatabase;
  backend?: "postgres" | "pglite";
}) {
  const backend = options.backend ?? "postgres", openDatabase = options.openWorkerDatabase;
  if (!["postgres", "pglite"].includes(backend) || typeof openDatabase !== "function")
    throw new Error("installed_news_queue_config_invalid");
  return Object.freeze({
    prepareNewsSubmission: (database: DatabaseSession) => preparePgBossAbsFeedSubmission(PgBoss, database, { backend }),
    startNewsWorker: (configuration: NewsQueueWorkerStartupConfiguration) =>
      createNewsQueueWorkerBootstrap({ PgBoss, openDatabase, backend }).start(configuration),
  });
}
