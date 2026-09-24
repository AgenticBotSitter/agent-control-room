import type { DatabaseClient } from "../../persistence/database";
import type { Server, ServerOptions } from "node:http";
import type { PrivateClientAssets } from "./private-assets";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import { createMacLocalControlRoomServiceV1 } from "./mac-local-serving";
import { createMacLocalStartupV1 } from "./mac-local-startup";
import type { MacLocalCanonicalTaskOperationsV1 } from "./mac-local-web-process";

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
  createServer?: (options: Readonly<ServerOptions>) => Server;
  listenerTiming?: { bindMs?: number; closeMs?: number };
}>): LocalService {
  const configuration = input?.configuration;
  if (!configuration || !input.database?.client || typeof input.database.close !== "function"
    || !input.assets || typeof input.assets.respond !== "function" || typeof input.render !== "function")
    throw new Error("mac_local_host_configuration_invalid");
  return createMacLocalControlRoomServiceV1({
    origin: configuration.localOwnerSession.origin,
    port: configuration.port,
    localOwnerSession: configuration.localOwnerSession,
    workspaceId: configuration.workspaceId,
    database: input.database,
    ...(input.operations ? { ...input.operations } : {}),
    assets: input.assets,
    render: input.render,
    ...(input.createServer ? { createServer: input.createServer } : {}),
    ...(input.listenerTiming ? { listenerTiming: input.listenerTiming } : {}),
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
    createService: ({ configuration, database }) => createMacLocalWebServiceFromConfigurationV1({
      configuration, database, assets: input.assets, render: input.render,
      ...(input.operations ? { operations: input.operations } : {}),
      ...(input.createServer ? { createServer: input.createServer } : {}),
      ...(input.listenerTiming ? { listenerTiming: input.listenerTiming } : {}),
    }),
  });
  return Object.freeze({ async start() { return startup.start(await input.loadConfiguration()); } });
}
