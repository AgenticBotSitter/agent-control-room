import type { DatabaseClient } from "../../persistence/database";
import type { Server, ServerOptions } from "node:http";
import type { PrivateClientAssets } from "./private-assets";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import { createMacLocalControlRoomServiceV1 } from "./mac-local-serving";
import { createMacLocalStartupV1 } from "./mac-local-startup";
import type { MacLocalCanonicalTaskOperationsV1, MacLocalWebProcessOptionsV1 } from "./mac-local-web-process";
import type { MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";
import type { MacLocalTaskApplicationV1 } from "./mac-local-task-application";
import type { MacLocalDatabaseRolesV1 } from "./mac-local-database-roles";
import type { NativeQueueWorkerStartupConfiguration } from "./native-queue-worker-startup";
import { createPostgresLocalOwnerSessionStoreV1 } from "./local-owner-session-store";
import type { LocalOwnerSessionStoreV1 } from "./local-owner-session-store";
import type { PersistedLocalOwnerSessionV1 } from "./local-owner-session";
import { captureWorkBatchQueueCatalogV1, createWorkBatchQueueSelectionAuthorityV1,
  type WorkBatchQueueAcceptedResultPortV1, type WorkBatchQueueCatalogV1,
  type WorkBatchQueueSelectionAuthorityV1 } from "../../work-intake/v1";
import { WebOperationsModeServiceV1, operationsModeStopAuthorityV1 } from "./operations-mode-service";
import { createOperationsModeSupervisorPortV1 } from "./operations-mode-supervisor-port";
import type { OwnerWebPushConfigV1 } from "../../web-push/v1";

/** The installation's one supervisor identity. The Mac-local host runs a single
 * supervisor loop, so this is fixed rather than configurable: a second id would
 * be a second loop over the same health observations, and each would open its
 * own incident. */
export const MAC_LOCAL_SUPERVISOR_ID_V1 = "supervisor:mac-local";

type OpenedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void>; isAvailable(): boolean }>;
type LocalService = Readonly<{ start(): Promise<void>; close(): Promise<void>; isReady(): boolean }>;
type HostedTaskApplication = Pick<MacLocalTaskApplicationV1, "operations" | "taskReadKeys" | "actionInboxSource" | "projectEvents" | "resultFileStore" | "isReady" | "close" | "queueDelivery" | "queueRecovery" | "workBatchAuthority" | "workBatchView">
  & Partial<Pick<MacLocalTaskApplicationV1, "taskService">>;
type OwnedQueueWorker = Readonly<{ close(): Promise<void>; status(): { accepting: boolean } }>;

/** The protected enablement is the only Mac-local source of exact worker and
 * model identities. Historical Hermes 0.21 evidence is deliberately not an
 * active queue destination. */
export function createMacLocalWorkBatchQueueCatalogV1(
  configuration: MacLocalProtectedConfigurationV1): WorkBatchQueueCatalogV1 {
  const suffix = { hermes: "hermes", "claude-code": "claude", codex: "codex" } as const;
  return captureWorkBatchQueueCatalogV1(configuration.enablement.workers.flatMap(worker => {
    if (worker.kind === "hermes-021") return [];
    return [{ workerId: worker.workerId, workerKind: worker.kind,
      nodeId: `${configuration.enablement.nodeId}.${suffix[worker.kind]}`,
      ...(worker.modelPolicy ? { modelPolicy: worker.modelPolicy } : {}) }];
  }));
}

/** One small composition for the Mac-local web host. It deliberately uses the
 * dedicated loopback web process, rather than adapting the hosted Cloudflare
 * process or opening a second database/scheduler. Construction is inert. */
export function createMacLocalWebServiceFromConfigurationV1(input: Readonly<{
  configuration: MacLocalProtectedConfigurationV1;
  database: OpenedDatabase;
  assets: PrivateClientAssets;
  render(request: Request): Promise<Response> | Response;
  localOwnerSessionStore?: LocalOwnerSessionStoreV1;
  initialLocalOwnerSessions?: readonly PersistedLocalOwnerSessionV1[];
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
  workBatchIntegrityKey?: Uint8Array;
  workBatchQueueCatalog?: WorkBatchQueueCatalogV1;
  workBatchQueueAdmissionAuthority?: WorkBatchQueueAcceptedResultPortV1;
  ownerWebPush?: OwnerWebPushConfigV1;
  hostProcessId?: number;
  healthProbeKey?: Uint8Array;
  healthReleaseId?: string;
  healthStartedAt?: string;
  /** Remote-worker owner section, present only when the host also runs the
   * fleet gateway on its own database login. */
  fleet?: MacLocalWebProcessOptionsV1["fleet"];
  /** Installation-wide Pause / Drain / Stop. Supply the instance the host
   * already built, so the endpoint and the supervisor's health port are two
   * callers of one service rather than two services over one state. */
  operationsMode?: WebOperationsModeServiceV1;
}>): LocalService {
  const configuration = input?.configuration;
  if (!configuration || !input.database?.client || typeof input.database.close !== "function"
    || typeof input.database.isAvailable !== "function"
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
    ...(configuration.remoteAccess ? { remoteAccess: configuration.remoteAccess } : {}),
    ...(input.localOwnerSessionStore ? { localOwnerSessionStore: input.localOwnerSessionStore } : {}),
    ...(input.initialLocalOwnerSessions ? { initialLocalOwnerSessions: input.initialLocalOwnerSessions } : {}),
    workspaceId: configuration.workspaceId,
    database: input.database,
    ...(taskApplication ? { ...taskApplication.operations } : input.operations ? { ...input.operations } : {}),
    ...(taskApplication?.taskService ? { taskService: taskApplication.taskService } : {}),
    ...(taskApplication?.taskReadKeys ? { taskReadKeys: taskApplication.taskReadKeys } : {}),
    // "Save to my Mac" (plan v4.3 2.6). Without this the download route does
    // not exist on a real installation, which is the exact failure mode the
    // operations-mode forwarding below was written to prevent.
    ...(taskApplication?.resultFileStore ? { resultFileStore: taskApplication.resultFileStore } : {}),
    ...(taskApplication?.actionInboxSource ? { actionInboxSource: taskApplication.actionInboxSource } : {}),
    ...(taskApplication?.projectEvents ? { projectEvents: taskApplication.projectEvents } : {}),
    ...(input.workerReadiness ? { workerReadiness: input.workerReadiness } : {}),
    taskWorkersStarted: Boolean(taskApplication),
    ...(input.workBatchIntegrityKey ? { workBatchIntegrityKey: input.workBatchIntegrityKey } : {}),
    ...(input.workBatchIntegrityKey ? { workBatchQueueCatalog: input.workBatchQueueCatalog
      ?? createMacLocalWorkBatchQueueCatalogV1(configuration) } : {}),
    ...(input.workBatchQueueAdmissionAuthority ? { workBatchQueueAdmissionAuthority: input.workBatchQueueAdmissionAuthority } : {}),
    ...(input.ownerWebPush ? { ownerWebPush: input.ownerWebPush } : {}),
    // The host's own pid, for the authenticated readiness route. Without this
    // forwarding the route is absent in this composition and answers 404, so
    // `mac:up` can never prove a started host is ready -- exactly the failure
    // `operationsMode` above documents, and for the same reason: the option
    // exists on the web process but is never mounted here.
    ...(input.hostProcessId ? { hostProcessId: input.hostProcessId } : {}),
    ...(input.healthProbeKey ? { healthProbeKey: input.healthProbeKey, healthReleaseId: input.healthReleaseId,
      healthStartedAt: input.healthStartedAt } : {}),
    ...(input.fleet ? { fleet: input.fleet } : {}),
    // The installation-wide mode. This forwarding is the whole fix: without it
    // the endpoint exists in the web process but is never mounted, and it 404s
    // on a real installation while every service-level test passes.
    ...(input.operationsMode ? { operationsMode: input.operationsMode } : {}),
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
      // The task application owns the restricted controller/result pools. It
      // first refuses new operations and drains active saves, so it must finish
      // before the web composition closes the database beneath the host. Keep
      // the later close best-effort even when the drain reports uncertainty.
      const task = await Promise.allSettled([taskApplication.close()]);
      const site = await Promise.allSettled([service.close()]);
      if ([...task, ...site].some(result => result.status === "rejected"))
        throw new Error("mac_local_host_cleanup_uncertain");
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
  verifyModelPolicy?: Parameters<typeof createMacLocalStartupV1>[0]["verifyModelPolicy"];
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
    workBatches?: Readonly<{ integrityKey: Uint8Array; queueCatalog: WorkBatchQueueCatalogV1;
      selectionAuthority: WorkBatchQueueSelectionAuthorityV1 }>;
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
  workBatchIntegrityKey?: Uint8Array;
  ownerWebPush?: OwnerWebPushConfigV1;
  /** The identity the health loop reports under. Defaults to the one fixed
   * Mac-local supervisor; supplied only where a distinct id is needed. */
  supervisorId?: string;
  hostProcessId?: number;
  healthProbeKey?: Uint8Array;
  healthReleaseId?: string;
  healthStartedAt?: string;
}>) {
  if (!input || typeof input.loadConfiguration !== "function" || typeof input.readVersion !== "function"
    || typeof input.openDatabase !== "function" || !input.assets || typeof input.assets.respond !== "function"
    || typeof input.render !== "function") throw new Error("mac_local_host_configuration_invalid");
  if (input.hostProcessId !== undefined
    && (!Number.isSafeInteger(input.hostProcessId) || input.hostProcessId <= 1))
    throw new Error("mac_local_host_configuration_invalid");
  if (input.operations && input.createTaskApplication) throw new Error("mac_local_host_configuration_invalid");
  if (input.createTaskApplication && typeof input.loadDatabaseRoles !== "function") throw new Error("mac_local_host_configuration_invalid");
  if (input.startQueueWorker && (!input.createTaskApplication || typeof input.startQueueWorker !== "function"))
    throw new Error("mac_local_host_configuration_invalid");
  const startup = createMacLocalStartupV1({
    readVersion: input.readVersion,
    ...(input.verifyModelPolicy ? { verifyModelPolicy: input.verifyModelPolicy } : {}),
    openDatabase: input.openDatabase,
    createService: async ({ configuration, database, workerReadiness, databaseRoles }) => {
      let taskApplication: HostedTaskApplication | undefined;
      try {
        if (input.createTaskApplication && !databaseRoles) throw new Error("mac_local_host_configuration_invalid");
        const workBatches = input.workBatchIntegrityKey ? (() => {
          if (!(input.workBatchIntegrityKey instanceof Uint8Array) || input.workBatchIntegrityKey.length !== 32)
            throw new Error("mac_local_host_configuration_invalid");
          const queueCatalog = createMacLocalWorkBatchQueueCatalogV1(configuration);
          return Object.freeze({ integrityKey: Uint8Array.from(input.workBatchIntegrityKey), queueCatalog,
            selectionAuthority: createWorkBatchQueueSelectionAuthorityV1(queueCatalog, workerReadiness) });
        })() : undefined;
        // The server-side operations mode for this installation. It exists
        // before the web process so the supervisor's machine-health port and
        // the owner-facing endpoint are two callers of ONE recorded decision
        // rather than two facts that could disagree.
        //
        // It is built before the task application, so the coordinator's stop
        // authority is not available yet and is attached below. That is the
        // only ordering that works: `stopped` revokes on the coordinator's own
        // login, and before that login exists there is nothing to revoke on.
        let service: WebOperationsModeServiceV1 | undefined;
        if (input.workBatchIntegrityKey) {
          const key = input.workBatchIntegrityKey;
          if (!(key instanceof Uint8Array) || key.length !== 32)
            throw new Error("mac_local_host_configuration_invalid");
          service = new WebOperationsModeServiceV1(database.client,
            { tenantId: configuration.localOwnerSession.tenantId, workspaceId: configuration.workspaceId },
            key, Date.now);
        }
        taskApplication = input.createTaskApplication
          ? await input.createTaskApplication({ configuration, database, workerReadiness, databaseRoles: databaseRoles!,
            ...(workBatches ? { workBatches } : {}),
            // The supervisor's machine-health pause goes to the server-owned
            // operations mode, never to a private copy of it. The port is only
            // offered once the mode exists, because a supervisor that could not
            // pause would silently protect nothing.
            //
            // The option name must stay `supervisor`: it is the one the task
            // provider reads. A differently-named field with the same shape
            // type-checks and then silently never arrives, which is exactly how
            // this wiring stayed invisible for a whole stream.
            ...(service ? { supervisor: { operations: createOperationsModeSupervisorPortV1(
              { target: { pauseForMachineHealth: reason => service!.pauseForMachineHealth(reason),
                resumeAfterMachineHealth: request => service!.resumeAfterMachineHealth(request) } }),
              supervisorId: input.supervisorId ?? MAC_LOCAL_SUPERVISOR_ID_V1 } } : {}) }) : undefined;
        if (workBatches && input.createTaskApplication
          && (!taskApplication?.workBatchAuthority || !taskApplication.workBatchView))
          throw new Error("mac_local_host_configuration_invalid");
        // The coordinator exists only after the task application, so the stop
        // authority is attached after the fact: `stopped` revokes on the
        // coordinator's own login, and before that login exists there is
        // nothing to revoke on.
        if (service && taskApplication) {
          const stop = operationsModeStopAuthorityV1(taskApplication as unknown as
            { listRunning?: unknown; revokeRunning?: unknown });
          if (stop) service.attachStopAuthority(stop);
        }
        // Some inert composition tests intentionally supply an opaque fake
        // client. A real opened DatabaseClient always exposes query and must
        // use the durable store.
        const localOwnerSessionStore = typeof database.client.query === "function"
          ? createPostgresLocalOwnerSessionStoreV1(database.client, configuration.localOwnerSession) : undefined;
        const initialLocalOwnerSessions = localOwnerSessionStore ? await localOwnerSessionStore.load(Date.now()) : [];
        const web = createMacLocalWebServiceFromConfigurationV1({
          configuration, database, assets: input.assets, render: input.render,
          ...(workBatches ? { workBatchIntegrityKey: workBatches.integrityKey,
            workBatchQueueCatalog: workBatches.queueCatalog,
            workBatchQueueAdmissionAuthority: taskApplication?.workBatchView } : {}),
          ...(localOwnerSessionStore ? { localOwnerSessionStore } : {}), initialLocalOwnerSessions,
          ...(taskApplication ? { taskApplication } : input.operations ? { operations: input.operations } : {}),
          workerReadiness,
          ...(input.createServer ? { createServer: input.createServer } : {}),
          ...(input.listenerTiming ? { listenerTiming: input.listenerTiming } : {}),
          ...(input.ownerWebPush ? { ownerWebPush: input.ownerWebPush } : {}),
          ...(input.hostProcessId ? { hostProcessId: input.hostProcessId } : {}),
          ...(input.healthProbeKey ? { healthProbeKey: input.healthProbeKey, healthReleaseId: input.healthReleaseId,
            healthStartedAt: input.healthStartedAt } : {}),
          ...(service ? { operationsMode: service } : {}),
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
                  loginNames: [databaseRoles.web.username, databaseRoles.coordinator.username, databaseRoles.results.username,
                    databaseRoles.publisher.username, databaseRoles.agentReviewer.username] },
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
