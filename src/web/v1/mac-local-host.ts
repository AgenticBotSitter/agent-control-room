import type { DatabaseClient } from "../../persistence/database";
import type { Server, ServerOptions } from "node:http";
import type { PrivateClientAssets } from "./private-assets";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import { createMacLocalControlRoomServiceV1 } from "./mac-local-serving";
import { createMacLocalStartupV1 } from "./mac-local-startup";
import type { MacLocalCanonicalTaskOperationsV1 } from "./mac-local-web-process";
import type { MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";
import type { MacLocalTaskApplicationV1 } from "./mac-local-task-application";
import type { MacLocalDatabaseRolesV1 } from "./mac-local-database-roles";
import type { NativeQueueWorkerStartupConfiguration } from "./native-queue-worker-startup";

type OpenedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void> }>;
type LocalService = Readonly<{ start(): Promise<void>; close(): Promise<void>; isReady(): boolean }>;
type HostedTaskApplication = Pick<MacLocalTaskApplicationV1, "operations" | "isReady" | "close" | "queueDelivery" | "queueRecovery">;
type OwnedQueueWorker = Readonly<{ close(): Promise<void>; status(): { accepting: boolean } }>;

/** One small composition for the Mac-local web host. It deliberately uses the
 * dedicated loopback web process, rather than adapting the hosted Cloudflare
 * process or opening a second database/scheduler. Construction is inert. */
export function createMacLocalWebServiceFromConfigurationV1(input: Readonly<{
  configuration: MacLocalProtectedConfigurationV1;
  database: OpenedDatabase;
  assets: PrivateClientAssets;
  render(request: Request): Promise<Response> | Response;
  /** The existing shared controller operations.  Supplying these makes the
   * local website use the same task/review/correction lifecycle as every
   * other topology; omitting them intentionally leaves those routes absent. */
  operations?: MacLocalCanonicalTaskOperationsV1;
  /** A complete, existing controller composition. This is mutually exclusive
   * with bare operations so a local host cannot accidentally mix operations
   * from one controller with the lifecycle of another. */
  taskApplication?: HostedTaskApplication;
  workerReadiness?: Pick<MacLocalWorkerReadinessV1, "read">;
  createServer?: (options: Readonly<ServerOptions>) => Server;
  listenerTiming?: { bindMs?: number; closeMs?: number };
}>): LocalService {
  const configuration = input?.configuration;
  if (!configuration || !input.database?.client || typeof input.database.close !== "function"
    || !input.assets || typeof input.assets.respond !== "function" || typeof input.render !== "function")
    throw new Error("mac_local_host_configuration_invalid");
  if (input.operations && input.taskApplication) throw new Error("mac_local_host_configuration_invalid");
  const taskApplication = input.taskApplication;
  if (taskApplication && (typeof taskApplication.isReady !== "function" || typeof taskApplication.close !== "function"
    || !taskApplication.operations)) throw new Error("mac_local_host_configuration_invalid");
  const service = createMacLocalControlRoomServiceV1({
    origin: configuration.localOwnerSession.origin,
    port: configuration.port,
    localOwnerSession: configuration.localOwnerSession,
    workspaceId: configuration.workspaceId,
    database: input.database,
    ...(taskApplication ? { ...taskApplication.operations } : input.operations ? { ...input.operations } : {}),
    ...(input.workerReadiness ? { workerReadiness: input.workerReadiness } : {}),
    taskWorkersStarted: Boolean(taskApplication),
    assets: input.assets,
    render: input.render,
    ...(input.createServer ? { createServer: input.createServer } : {}),
    ...(input.listenerTiming ? { listenerTiming: input.listenerTiming } : {}),
  });
  if (!taskApplication) return service;
  let close: Promise<void> | undefined;
  return Object.freeze({
    start: service.start.bind(service),
    isReady: () => service.isReady() && taskApplication.isReady(),
    close: () => close ??= (async () => {
      const results = await Promise.allSettled([service.close(), taskApplication.close()]);
      if (results.some(result => result.status === "rejected")) throw new Error("mac_local_host_cleanup_uncertain");
    })(),
  });
}

/** The fixed Mac-local startup order: load protected configuration, verify the
 * owner-pinned executable versions, then and only then open the one authority
 * database and assemble the loopback website. It starts neither worker nor
 * listener until its explicit start() call. */
export function createMacLocalProtectedHostV1(input: Readonly<{
  loadConfiguration(): Promise<MacLocalProtectedConfigurationV1>;
  readVersion(executablePath: string): Promise<string>;
  openDatabase(configuration: MacLocalProtectedConfigurationV1["database"]): OpenedDatabase;
  assets: PrivateClientAssets;
  render(request: Request): Promise<Response> | Response;
  operations?: MacLocalCanonicalTaskOperationsV1;
  /** Optional construction of the shared task lifecycle after local executable
   * verification and the restricted web database opening. The factory owns any
   * extra restricted controller connections it opens; the returned lifecycle
   * is then owned by the local host. */
  createTaskApplication?: (input: Readonly<{
    configuration: MacLocalProtectedConfigurationV1;
    database: OpenedDatabase;
    workerReadiness: MacLocalWorkerReadinessV1;
    databaseRoles: MacLocalDatabaseRolesV1;
  }>) => HostedTaskApplication | Promise<HostedTaskApplication>;
  /** Reads the fixed owner-only database-role file. It is required whenever a
   * shared task composition is configured, and is read before any pool opens. */
  loadDatabaseRoles?: () => Promise<MacLocalDatabaseRolesV1>;
  /** The existing installed pg-boss worker factory. It is optional because
   * construction and website-only local setup never start a queue. When
   * configured it starts only after the loopback listener is ready. */
  startQueueWorker?: (configuration: NativeQueueWorkerStartupConfiguration) => Promise<OwnedQueueWorker>;
  createServer?: (options: Readonly<ServerOptions>) => Server;
  listenerTiming?: { bindMs?: number; closeMs?: number };
}>) {
  if (!input || typeof input.loadConfiguration !== "function" || typeof input.readVersion !== "function"
    || typeof input.openDatabase !== "function" || !input.assets || typeof input.assets.respond !== "function"
    || typeof input.render !== "function") throw new Error("mac_local_host_configuration_invalid");
  if (input.operations && input.createTaskApplication) throw new Error("mac_local_host_configuration_invalid");
  if (input.createTaskApplication && typeof input.loadDatabaseRoles !== "function") throw new Error("mac_local_host_configuration_invalid");
  if (input.startQueueWorker && (!input.createTaskApplication || typeof input.startQueueWorker !== "function"))
    throw new Error("mac_local_host_configuration_invalid");
  const startup = createMacLocalStartupV1({
    readVersion: input.readVersion,
    openDatabase: input.openDatabase,
    createService: async ({ configuration, database, workerReadiness, databaseRoles }) => {
      let taskApplication: HostedTaskApplication | undefined;
      try {
        if (input.createTaskApplication && !databaseRoles) throw new Error("mac_local_host_configuration_invalid");
        taskApplication = input.createTaskApplication
          ? await input.createTaskApplication({ configuration, database, workerReadiness, databaseRoles: databaseRoles! }) : undefined;
        const web = createMacLocalWebServiceFromConfigurationV1({
          configuration, database, assets: input.assets, render: input.render,
          ...(taskApplication ? { taskApplication } : input.operations ? { operations: input.operations } : {}),
          workerReadiness,
          ...(input.createServer ? { createServer: input.createServer } : {}),
          ...(input.listenerTiming ? { listenerTiming: input.listenerTiming } : {}),
        });
        if (!input.startQueueWorker) return web;
        if (!taskApplication?.queueDelivery || !databaseRoles) throw new Error("mac_local_host_configuration_invalid");
        let worker: OwnedQueueWorker | undefined, closing: Promise<void> | undefined, starting: Promise<void> | undefined;
        let workerClose: Promise<void> | undefined;
        let closeRequested = false;
        const closeWorker = () => workerClose ??= worker?.close ? Promise.resolve().then(worker.close.bind(worker)) : Promise.resolve();
        return Object.freeze({
          start() {
            return starting ??= (async () => {
            await web.start();
            try {
              worker = await input.startQueueWorker!({ database: databaseRoles.queueWorker,
                application: { host: databaseRoles.coordinator.host, port: databaseRoles.coordinator.port,
                  database: databaseRoles.coordinator.database,
                  loginNames: [databaseRoles.web.username, databaseRoles.coordinator.username, databaseRoles.results.username] },
                concurrency: 1,
                deliver: taskApplication!.queueDelivery!,
                ...(taskApplication!.queueRecovery?.verify ? { verifyRecovery: taskApplication!.queueRecovery.verify } : {}),
              });
              if (!worker || typeof worker.close !== "function" || typeof worker.status !== "function" || !worker.status().accepting || closeRequested)
                throw new Error("mac_local_host_queue_worker_unavailable");
            } catch (error) {
              const stopped = worker?.close ? await Promise.allSettled([closeWorker()]) : [];
              const site = await Promise.allSettled([web.close()]);
              if ([...stopped, ...site].some(result => result.status === "rejected"))
                throw new Error("mac_local_host_cleanup_uncertain");
              throw error;
            }
            })();
          },
          isReady: () => web.isReady() && worker?.status().accepting === true,
          close: () => closing ??= (async () => {
            closeRequested = true;
            await starting?.catch(() => {});
            const workerClosed = worker?.close ? await Promise.allSettled([closeWorker()]) : [];
            const webClosed = await Promise.allSettled([web.close()]);
            if ([...workerClosed, ...webClosed].some(result => result.status === "rejected"))
              throw new Error("mac_local_host_cleanup_uncertain");
          })(),
        });
      } catch (error) {
        if (taskApplication) {
          try { await taskApplication.close(); }
          catch { throw new Error("mac_local_host_cleanup_uncertain"); }
        }
        throw error;
      }
    },
  });
  const sameWebConnection = (configuration: MacLocalProtectedConfigurationV1, roles: MacLocalDatabaseRolesV1) => {
    const a = configuration.database, b = roles.web;
    return a.host === b.host && a.port === b.port && a.database === b.database && a.username === b.username
      && a.password === b.password && a.majorVersion === b.majorVersion
      && JSON.stringify(a.privateEndpoint ?? null) === JSON.stringify(b.privateEndpoint ?? null);
  };
  return Object.freeze({ async start() {
    const configuration = await input.loadConfiguration();
    const databaseRoles = input.loadDatabaseRoles ? await input.loadDatabaseRoles() : undefined;
    if (databaseRoles && !sameWebConnection(configuration, databaseRoles)) throw new Error("mac_local_host_configuration_invalid");
    return startup.start(configuration, databaseRoles);
  } });
}
