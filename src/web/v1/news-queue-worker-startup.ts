import { createBoundedQueueWorkerBootstrap } from "./bounded-queue-worker-startup";
import { startPgBossAbsFeedRuntime } from "../../persistence/pg-boss-abs-feed-runtime";
import type { PgBossBoundedRuntimeConstructor } from "../../persistence/pg-boss-bounded-runtime";
import type { BoundedDeliveryHandler } from "../../persistence/pg-boss-bounded-worker";
import type { AbsFeedJobReference } from "../../persistence/pg-boss-abs-feed-worker";
import type { PrivatePostgresConfiguration } from "./private-postgres";
import type { TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";

export interface NewsQueueWorkerStartupConfiguration {
  database: PrivatePostgresConfiguration;
  /** Trusted topology of separately verified coordinator and ingestion resources.
   * These names are checked for separation, not proof those other pools passed preflight. */
  application: Pick<PrivatePostgresConfiguration, "host" | "port" | "database"> & {
    coordinatorLogin: string; ingestionLogin: string;
  };
  collect: BoundedDeliveryHandler<AbsFeedJobReference>;
  concurrency?: number;
}

/** Explicit feed-only startup: verifies the operational worker login and owns its pool.
 * The containing application must separately verify coordinator/ingestion profiles
 * and current collection authority. No default instance, route mounting, recovery,
 * package download or pool creation on import. One start attempt per bootstrap. */
export function createNewsQueueWorkerBootstrap(dependencies: {
  PgBoss: PgBossBoundedRuntimeConstructor;
  openDatabase: (config: PrivatePostgresConfiguration) => TaskCoordinatorDatabase;
  backend?: "postgres" | "pglite";
}) {
  const worker = createBoundedQueueWorkerBootstrap<AbsFeedJobReference>(dependencies, {
    errorPrefix: "abs_feed_worker", runtimeErrorPrefix: "abs_feed", startRuntime(PgBoss, database, input) {
      return startPgBossAbsFeedRuntime(PgBoss, database, { collect: input.deliver,
        concurrency: input.concurrency, backend: input.backend });
    },
  });
  return Object.freeze({ start(input: NewsQueueWorkerStartupConfiguration) {
    const app = input.application;
    return worker.start({ database: input.database, concurrency: input.concurrency,
      deliver: typeof input.collect === "function" ? input.collect.bind(input) : input.collect,
      application: { host: app?.host, port: app?.port, database: app?.database,
        loginNames: [app?.coordinatorLogin, app?.ingestionLogin] },
    });
  } });
}
