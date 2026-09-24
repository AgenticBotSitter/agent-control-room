import type { DatabaseClient } from "../../persistence/database";
import type { Server, ServerOptions } from "node:http";
import type { PrivateClientAssets } from "./private-assets";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import { createMacLocalControlRoomServiceV1 } from "./mac-local-serving";
import { createMacLocalStartupV1 } from "./mac-local-startup";
import type { MacLocalCanonicalTaskOperationsV1 } from "./mac-local-web-process";
import type { MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";
import type { MacLocalTaskApplicationV1 } from "./mac-local-task-application";

type OpenedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void> }>;
type LocalService = Readonly<{ start(): Promise<void>; close(): Promise<void>; isReady(): boolean }>;

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
  taskApplication?: Pick<MacLocalTaskApplicationV1, "operations" | "isReady" | "close">;
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
  createServer?: (options: Readonly<ServerOptions>) => Server;
  listenerTiming?: { bindMs?: number; closeMs?: number };
}>) {
  if (!input || typeof input.loadConfiguration !== "function" || typeof input.readVersion !== "function"
    || typeof input.openDatabase !== "function" || !input.assets || typeof input.assets.respond !== "function"
    || typeof input.render !== "function") throw new Error("mac_local_host_configuration_invalid");
  const startup = createMacLocalStartupV1({
    readVersion: input.readVersion,
    openDatabase: input.openDatabase,
    createService: ({ configuration, database, workerReadiness }) => createMacLocalWebServiceFromConfigurationV1({
      configuration, database, assets: input.assets, render: input.render,
      ...(input.operations ? { operations: input.operations } : {}),
      workerReadiness,
      ...(input.createServer ? { createServer: input.createServer } : {}),
      ...(input.listenerTiming ? { listenerTiming: input.listenerTiming } : {}),
    }),
  });
  return Object.freeze({ async start() { return startup.start(await input.loadConfiguration()); } });
}
