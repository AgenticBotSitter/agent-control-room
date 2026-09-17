import type { IncomingMessage, Server, ServerOptions } from "node:http";
import type { DatabaseClient } from "../../persistence/database";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration,
  type PrivatePostgresConfiguration } from "../../web/v1/private-postgres";
import { createGitHubBrokerLoopbackService } from "../../web/v1/private-serving";
import { createGitHubWorkerBrokerNodeBridge, type WorkerAuthorizer } from "./node-handler";
import { PostgresGitHubWorkerWakeStore } from "./postgres-wake-store";
import { GitHubWorkerBroker } from "./worker-broker";
import { prepareGitHubWorkerOperations } from "./worker-operations";

export { createGitHubAppJwt } from "./installation-auth";

export const GITHUB_BROKER_DATABASE_ROLE = "control_room_github_broker";

const APP_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;

export type GitHubBrokerPrivateServiceConfiguration = Readonly<{
  repository: string;
  installationId: number;
  webhookSecret: string;
  database: PrivatePostgresConfiguration;
  port: number;
  /**
   * Vouches for the caller and, for worker operations, for the stable worker identity that the
   * operation is bound to. An authorizer that only answers true/false proves authentication but
   * names no identity, so the operation route refuses every operation it authorized.
   */
  authorizeWorker: WorkerAuthorizer;
  /**
   * Optional GitHub App credentials. When present the broker also serves the versioned
   * worker operations. When absent the wake routes are unchanged and the operation route
   * answers 503, so existing deployments are never broken by an unconfigured key.
   */
  github?: Readonly<{ appId: string; privateKeyPem: string }>;
}>;

type OwnedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void>; isAvailable(): boolean }>;
type BrokerPrivateServiceDependencies = Readonly<{
  openDatabase(config: PrivatePostgresConfiguration): OwnedDatabase;
  createServer?: (options: Readonly<ServerOptions>) => Server;
  now?: () => number;
}>;

function captureGitHubCredentials(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error();
  const { appId, privateKeyPem } = value as { appId?: unknown; privateKeyPem?: unknown };
  if (typeof appId !== "string" || !APP_ID_PATTERN.test(appId)
    || typeof privateKeyPem !== "string" || !privateKeyPem.includes("BEGIN")
    || !privateKeyPem.includes("PRIVATE KEY")) throw new Error();
  return Object.freeze({ appId, privateKeyPem });
}

function captureConfiguration(input: GitHubBrokerPrivateServiceConfiguration) {
  try {
    const database = validatePrivatePostgresConfiguration(input.database);
    if (database.username !== GITHUB_BROKER_DATABASE_ROLE
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)
      || !Number.isSafeInteger(input.installationId) || input.installationId < 1
      || typeof input.webhookSecret !== "string" || input.webhookSecret.length < 32
      || !Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535
      || typeof input.authorizeWorker !== "function") throw new Error();
    const github = captureGitHubCredentials(input.github);
    return Object.freeze({ repository: input.repository, installationId: input.installationId,
      webhookSecret: input.webhookSecret, database, port: input.port, authorizeWorker: input.authorizeWorker,
      ...(github ? { github } : {}) });
  } catch { throw new Error("github_broker_private_service_config_invalid"); }
}

/**
 * Production composition boundary for the private GitHub wake broker.
 *
 * Preparing the service constructs a lazy PostgreSQL pool but makes no connection and
 * opens no listener. start() is the sole listener effect and remains deployment-gated.
 * The production path always uses the atomic PostgreSQL admission store; the legacy
 * replayStore+wakeSink composition is intentionally unavailable here.
 */
export async function prepareGitHubBrokerPrivateService(input: GitHubBrokerPrivateServiceConfiguration,
  dependencies: BrokerPrivateServiceDependencies = { openDatabase: createPrivatePostgresDatabase }) {
  const config = captureConfiguration(input);
  let database: OwnedDatabase | undefined;
  try {
    database = dependencies.openDatabase(config.database);
    const store = new PostgresGitHubWorkerWakeStore(database.client);
    const broker = new GitHubWorkerBroker({ secret: config.webhookSecret, repository: config.repository,
      installationId: config.installationId, atomicStore: store, now: dependencies.now });
    const bridge = createGitHubWorkerBrokerNodeBridge({ broker, wakeStore: store,
      authorizeWorker: config.authorizeWorker,
      ...(config.github ? { operations: prepareGitHubWorkerOperations({
        repository: config.repository, appId: config.github.appId,
        installationId: String(config.installationId), privateKeyPem: config.github.privateKeyPem,
        ...(dependencies.now ? { now: dependencies.now } : {}),
      }) } : {}),
      close: () => database!.close(), isReady: () => database!.isAvailable() });
    return createGitHubBrokerLoopbackService(bridge, { port: config.port,
      ...(dependencies.createServer ? { createServer: dependencies.createServer } : {}) });
  } catch {
    if (database) {
      try { await database.close(); } catch { throw new Error("github_broker_private_service_cleanup_uncertain"); }
    }
    throw new Error("github_broker_private_service_prepare_failed");
  }
}
