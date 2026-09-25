import { createPrivatePostgresDatabase, type PrivatePostgresConfiguration } from "../../src/web/v1/private-postgres";
import { loadMacLocalDatabaseRolesFromRootV1 } from "./load-protected-configuration";
import { loadMacLocalProtectedConfigurationFromRootV1 } from "../../src/web/v1/mac-local-protected-loader";
import { macLocalOwnerIdentityIdV1 } from "../../src/web/v1/mac-local-owner-bootstrap";
import { verifyPrivateDatabase, verifyTaskCoordinatorDatabase, verifyNativeResultDatabase,
  verifyNativeQueueWorkerDatabase } from "../../src/web/v1/private-database-preflight";

type OpenedDatabase = ReturnType<typeof createPrivatePostgresDatabase>;
type RoleName = "web" | "coordinator" | "results" | "queueWorker";
type Runtime = Readonly<{
  loadRoles: typeof loadMacLocalDatabaseRolesFromRootV1;
  loadConfiguration: typeof loadMacLocalProtectedConfigurationFromRootV1;
  openDatabase: (configuration: PrivatePostgresConfiguration) => OpenedDatabase;
  verify: Readonly<Record<RoleName, (db: OpenedDatabase, configuration: PrivatePostgresConfiguration,
    scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }) => Promise<void>>>;
  report: (line: string) => void;
}>;

const production: Runtime = Object.freeze({
  loadRoles: loadMacLocalDatabaseRolesFromRootV1,
  loadConfiguration: loadMacLocalProtectedConfigurationFromRootV1,
  openDatabase: createPrivatePostgresDatabase,
  verify: {
    web: (db, config, scope) => verifyPrivateDatabase(db.client, config, scope, Date.now()),
    coordinator: (db, config, scope) => verifyTaskCoordinatorDatabase(db.client, config, scope, Date.now(), { nativeQueue: true }),
    results: (db, config, scope) => verifyNativeResultDatabase(db.client, config, scope, Date.now()),
    queueWorker: (db, config) => verifyNativeQueueWorkerDatabase(db.client, config),
  },
  report: line => process.stdout.write(`${line}\n`),
});

const refusal = (): "database_check_refused" => "database_check_refused";

const deniedProbe: Readonly<Record<RoleName, string>> = Object.freeze({
  web: "DELETE FROM tenants WHERE false",
  coordinator: "UPDATE control_jobs SET result_lock=result_lock WHERE false",
  results: "UPDATE control_jobs SET state=state WHERE false",
  queueWorker: "UPDATE control_room_queue.queue SET name=name WHERE false",
});

/** Read-only privilege and connectivity check for the four fixed Mac-local
 * accounts. Every denied probe has a false predicate, so even an incorrectly
 * granted account cannot change rows. Never prints configuration. */
export async function checkMacLocalDatabaseV1(protectedRoot: string, runtime: Runtime = production): Promise<number> {
  let roles: Awaited<ReturnType<typeof loadMacLocalDatabaseRolesFromRootV1>>;
  let scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string };
  try {
    roles = await runtime.loadRoles(protectedRoot);
    const configuration = await runtime.loadConfiguration(protectedRoot);
    const tenantId = configuration.localOwnerSession.tenantId;
    scope = { tenantId, workspaceId: configuration.workspaceId,
      ownerIdentityId: macLocalOwnerIdentityIdV1(tenantId), issuer: configuration.localOwnerSession.provider };
  }
  catch { runtime.report(refusal()); return 1; }
  let exitCode = 0;
  for (const name of ["web", "coordinator", "results", "queueWorker"] as const satisfies readonly RoleName[]) {
    let database: OpenedDatabase | undefined;
    try {
      const configuration = roles[name];
      database = runtime.openDatabase(configuration);
      const identity = (await database.client.query<{ role_ok: boolean }>(
        "SELECT current_user=$1 AND session_user=$1 AS role_ok", [configuration.username])).rows[0];
      if (identity?.role_ok !== true) throw new Error("database_check_refused");
      await database.client.query("SELECT 1");
      await runtime.verify[name](database, configuration, scope);
      try {
        await database.client.query(deniedProbe[name]);
        throw new Error("database_check_unexpected_write_grant");
      } catch (error) {
        if (!(error instanceof Error) || !/permission denied/iu.test(error.message)) throw error;
      }
      runtime.report(`${name} least privilege: ok`);
    } catch {
      exitCode = 1;
      runtime.report(`${name} ${refusal()}`);
    } finally {
      if (database) {
        try { await database.close(); }
        catch { exitCode = 1; runtime.report(`${name} ${refusal()}`); }
      }
    }
  }
  return exitCode;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const root = process.argv[2];
  if (!root || process.argv.length !== 3) {
    process.stdout.write("Usage: pnpm mac:check-database /absolute/Protected\n");
    process.exitCode = 2;
  } else process.exitCode = await checkMacLocalDatabaseV1(root);
}
