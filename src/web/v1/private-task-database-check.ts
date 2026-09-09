import { createPrivatePostgresDatabase, type PrivatePostgresConfiguration } from "./private-postgres";
import { validatePrivateTaskStartupConfiguration, type PrivateTaskStartupConfiguration } from "./private-task-startup";
import { verifyPrivateDatabase, verifyTaskCoordinatorDatabase, verifyNativeResultDatabase,
  verifyNativeEvidenceDatabase, verifyNativeSessionDatabase, verifyIdeaCreationDatabase,
  verifyIdeaRuntimeDatabase, verifyPrivateIdeaAdapter, verifyNativeQueueWorkerDatabase,
  verifyNewsCoordinatorDatabase, verifyNewsIngestionDatabase } from "./private-database-preflight";
import type { TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";

/** Explicit database inspection, not startup. Supplied non-database ports must be inert:
 * validation captures them but never invokes them or takes ownership of them.
 * No queue preparation, service construction, key lookup, worker or listener. */
export function createPrivateTaskDatabaseCheck(dependencies: {
  openDatabase: (config: PrivatePostgresConfiguration) => TaskCoordinatorDatabase;
  clock?: () => number;
}) {
  return async (input: PrivateTaskStartupConfiguration, signal?: AbortSignal) => {
    const acquired = new Map<TaskCoordinatorDatabase, () => Promise<void>>();
    const clients = new Set<TaskCoordinatorDatabase["client"]>();
    const rolesChecked: string[] = [];
    let failed = false;
    const active = () => { if (signal?.aborted) throw new Error(); };
    try {
      active();
      const config = validatePrivateTaskStartupConfiguration(input);
      const now = (dependencies.clock ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error();
      const queue = config.nativeQueue || config.news ? { nativeQueue: true as const,
        ...(!config.nativeQueue ? { nativeQueueProducer: false as const } : {}),
        ...(config.nativeQueueRecovery ? { nativeQueueRecovery: true as const } : {}) } : undefined;
      async function check(name: string, database: PrivatePostgresConfiguration,
        verify: (client: TaskCoordinatorDatabase["client"]) => Promise<unknown>) {
        active();
        const pool = dependencies.openDatabase(database);
        if (acquired.has(pool)) throw new Error();
        const close = pool.close.bind(pool);
        acquired.set(pool, async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([Promise.resolve().then(close), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error()), 5000);
          })]); } finally { clearTimeout(timer); }
        });
        active();
        if (clients.has(pool.client)) throw new Error();
        clients.add(pool.client);
        await verify(pool.client); active();
        if (!pool.isAvailable()) throw new Error();
        rolesChecked.push(name);
        return pool;
      }
      const web = await check("web", config.web.database,
        client => verifyPrivateDatabase(client, config.web.database, config.web, now, queue));
      await check("coordinator", config.database,
        client => verifyTaskCoordinatorDatabase(client, config.database, config.web, now, queue));
      if (config.resultDatabase) await check("results", config.resultDatabase,
        client => verifyNativeResultDatabase(client, config.resultDatabase!, config.web, now, queue));
      if (config.evidence) await check("evidence", config.evidence.database,
        client => verifyNativeEvidenceDatabase(client, config.evidence!.database, config.web, now, queue));
      if (config.sessions) await check("sessions", config.sessions.database,
        client => verifyNativeSessionDatabase(client, config.sessions!.database, config.web, now, queue));
      if (config.ideaCreation) {
        await verifyPrivateIdeaAdapter(web.client, config.web); active();
        await check("ideas", config.ideaCreation.database,
          client => verifyIdeaCreationDatabase(client, config.ideaCreation!.database, config.web, now, queue));
      }
      if (config.ideaRuntime) await check("ideaRuntime", config.ideaRuntime.database,
        client => verifyIdeaRuntimeDatabase(client, config.ideaRuntime!.database, config.web, now, queue));
      if (config.queueWorker) await check("nativeQueueWorker", config.queueWorker.database,
        client => verifyNativeQueueWorkerDatabase(client, config.queueWorker!.database));
      if (config.news) {
        const news = config.news;
        await check("newsCoordinator", news.coordinatorDatabase,
          client => verifyNewsCoordinatorDatabase(client, news.coordinatorDatabase, config.web, now, { newsQueue: true }));
        await check("newsIngestion", news.ingestionDatabase,
          client => verifyNewsIngestionDatabase(client, news.ingestionDatabase, config.web, now, { nativeQueue: true }));
        await check("newsQueueWorker", news.workerDatabase,
          client => verifyNativeQueueWorkerDatabase(client, news.workerDatabase));
      }
      active();
      if ([...acquired.keys()].some(pool => !pool.isAvailable())) throw new Error();
    } catch { failed = true; }
    const cleanup = await Promise.allSettled([...acquired.values()].map(close => close()));
    if (cleanup.some(result => result.status === "rejected")) throw new Error("private_task_database_check_cleanup_uncertain");
    if (failed || signal?.aborted) throw new Error("private_task_database_check_failed");
    return Object.freeze({ schema: "control-room.private-task-database-check/v1", databasePreflight: "passed" as const,
      rolesChecked: Object.freeze(rolesChecked), databaseClosed: true, applicationInstalled: false,
      listenerStarted: false, workersStarted: false, backupVerified: false, productionReady: false });
  };
}

export const checkPrivateTaskDatabase = createPrivateTaskDatabaseCheck({ openDatabase: createPrivatePostgresDatabase });
