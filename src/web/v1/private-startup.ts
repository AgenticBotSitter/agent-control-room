import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration,
  type PrivatePostgresConfiguration } from "./private-postgres";
import { verifyPrivateDatabase } from "./private-database-preflight";
import { installPrivateWebProcess, type PrivateWebProcessOptions } from "./private-process";
import { captureWebOrigins } from "./access-verifier";
import { captureHerdrReaders } from "./herdr-service";
export { createAccessKeyLoader } from "./access-key-cache";

export type PrivateStartupConfiguration = Omit<PrivateWebProcessOptions, "database" | "clock" | "drainMs" | "planning" | "assignment" | "approvals" | "submission" | "queueAttention" | "revisions" | "ideaCreation" | "newsCollections"> & {
  database: PrivatePostgresConfiguration; ownerIdentityId: string;
};
type OwnedDatabase = ReturnType<typeof createPrivatePostgresDatabase>;
export function validatePrivateStartupConfiguration(input: PrivateStartupConfiguration) {
  const exactOrigin = (value: string) => { const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value) throw new Error(); return value; };
  const reference = (value: string) => { if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error(); return value; };
  const key = (value: Uint8Array) => { if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error(); return new Uint8Array(value); };
  try {
    const sites = captureWebOrigins({ origin: input.origin, audience: input.audience }, input.secondaryAccess);
    // The production bootstrap owns only the restricted web pool. Do not silently discard or
    // pretend to configure a privileged planning dependency through this startup profile.
    if (["planning", "assignment", "approvals", "submission", "queueAttention", "revisions", "ideaCreation", "newsCollections"]
      .some(name => name in input)) throw new Error();
    if (!Number.isSafeInteger(input.maxSessionSeconds) || input.maxSessionSeconds < 1 || input.maxSessionSeconds > 604800
      || typeof input.loadKeys !== "function") throw new Error();
    return Object.freeze({ origin: exactOrigin(input.origin), issuer: exactOrigin(input.issuer), audience: reference(input.audience),
      ...(sites[1] ? { secondaryAccess: sites[1] } : {}),
      tenantId: reference(input.tenantId), workspaceId: reference(input.workspaceId), ownerIdentityId: reference(input.ownerIdentityId),
      maxSessionSeconds: input.maxSessionSeconds, loadKeys: input.loadKeys,
      database: validatePrivatePostgresConfiguration(input.database),
      ...(input.herdrObservations !== undefined ? { herdrObservations: captureHerdrReaders(input, input.herdrObservations) } : {}),
      ...(input.ideaProjects ? { ideaProjects: { integrityKey: key(input.ideaProjects.integrityKey) } } : {}),
      ...(input.news ? { news: { integrityKey: key(input.news.integrityKey) } } : {}),
      ...(input.tasks ? { tasks: { harnessIntegrityKey: key(input.tasks.harnessIntegrityKey),
        ...(input.tasks.results ? { results: { ...input.tasks.results, integrityKey: key(input.tasks.results.integrityKey) } } : {}),
        ...(input.tasks.reviews ? { reviews: { ...input.tasks.reviews, integrityKey: key(input.tasks.reviews.integrityKey) } } : {}),
        ...(input.tasks.ownerReviews ? { ownerReviews: { ...input.tasks.ownerReviews, integrityKey: key(input.tasks.ownerReviews.integrityKey) } } : {}),
        ...(input.tasks.manualVerificationScenarios ? { manualVerificationScenarios: input.tasks.manualVerificationScenarios.map(value => ({ ...value })) } : {}) } } : {}),
      ...(input.connections ? { connections: { registryIntegrityKey: key(input.connections.registryIntegrityKey),
        ...(input.connections.telemetryIntegrityKey ? { telemetryIntegrityKey: key(input.connections.telemetryIntegrityKey) } : {}) } } : {}),
    });
  } catch { throw new Error("private_startup_config_invalid"); }
}

/** Injectable lifecycle, not a request endpoint. Only trusted server code supplies these dependencies.
 * A failed or completed startup cannot be retried in the same lifecycle; supervisor owns restart.
 */
export function createPrivateWebBootstrap(dependencies: {
  openDatabase: (config: PrivatePostgresConfiguration) => OwnedDatabase;
  install: typeof installPrivateWebProcess; clock?: () => number;
}) {
  let started = false;
  return Object.freeze({ async start(input: PrivateStartupConfiguration) {
    if (started) throw new Error("private_startup_already_attempted");
    started = true;
    const config = validatePrivateStartupConfiguration(input);
    let database: OwnedDatabase | undefined;
    try {
      const clock = dependencies.clock ?? Date.now;
      const now = clock(); if (!Number.isSafeInteger(now) || now < 0) throw new Error();
      database = dependencies.openDatabase(config.database);
      await verifyPrivateDatabase(database.client, config.database, config, now);
      const pool = database;
      const installed = dependencies.install({ ...config, database: pool, clock });
      let ready = true, closing: Promise<void> | undefined;
      return Object.freeze({ isReady: () => ready && pool.isAvailable(), close: () => {
        if (!closing) { ready = false; closing = installed.close(); }
        return closing;
      } });
    } catch {
      if (database) { try { await database.close(); } catch { throw new Error("private_startup_cleanup_uncertain"); } }
      throw new Error("private_startup_prerequisites_failed");
    }
  } });
}

// Constructs only a lifecycle closure. Explicit start is the first possible database effect.
const production = createPrivateWebBootstrap({ openDatabase: createPrivatePostgresDatabase, install: installPrivateWebProcess });
export const startPrivateWebApplication = production.start;

/** Read-only database acceptance without installing the application or binding a
 * listener. Still an explicit database connection: run only for an approved target.
 * Reuses the production ACL/schema/owner checks, with no fixture relaxation. */
export function createPrivateWebDatabaseCheck(dependencies: {
  openDatabase: (config: PrivatePostgresConfiguration) => OwnedDatabase;
  clock?: () => number;
}) {
  return async (input: PrivateStartupConfiguration) => {
    const config = validatePrivateStartupConfiguration(input);
    const now = (dependencies.clock ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("private_database_check_failed");
    let database: OwnedDatabase | undefined;
    let failed = false;
    try {
      database = dependencies.openDatabase(config.database);
      await verifyPrivateDatabase(database.client, config.database, config, now);
    } catch {
      failed = true;
    }
    if (database) {
      try { await database.close(); }
      catch { throw new Error("private_database_check_cleanup_uncertain"); }
    }
    if (failed) throw new Error("private_database_check_failed");
    return Object.freeze({ schema: "control-room.private-database-check/v1" as const,
      databasePreflight: "passed" as const, databaseClosed: true as const,
      applicationInstalled: false as const, listenerStarted: false as const,
      backupVerified: false as const, productionReady: false as const });
  };
}
export const checkPrivateWebDatabase = createPrivateWebDatabaseCheck({ openDatabase: createPrivatePostgresDatabase });
