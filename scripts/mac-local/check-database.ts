import { Client } from "pg";
import { createPrivatePostgresDatabase, privatePostgresOptions, type PrivatePostgresConfiguration } from "../../src/web/v1/private-postgres";
import { loadMacLocalDatabaseRolesFromRootV1 } from "./load-protected-configuration";
import { loadMacLocalProtectedConfigurationFromRootV1 } from "../../src/web/v1/mac-local-protected-loader";
import { macLocalOwnerIdentityIdV1 } from "../../src/web/v1/mac-local-owner-bootstrap";
import { verifyPrivateDatabase, verifyTaskCoordinatorDatabase, verifyNativeResultDatabase, verifyLocalResultPublisherDatabase,
  verifyNativeQueueWorkerDatabase } from "../../src/web/v1/private-database-preflight";

type OpenedDatabase = ReturnType<typeof createPrivatePostgresDatabase>;
type RoleName = "web" | "coordinator" | "results" | "publisher" | "queueWorker";
type Runtime = Readonly<{
  loadRoles: typeof loadMacLocalDatabaseRolesFromRootV1;
  loadConfiguration: typeof loadMacLocalProtectedConfigurationFromRootV1;
  openDatabase: (configuration: PrivatePostgresConfiguration) => OpenedDatabase;
  verify: Readonly<Record<RoleName, (db: OpenedDatabase, configuration: PrivatePostgresConfiguration,
    scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }) => Promise<void>>>;
  /** "denied" only when PostgreSQL itself refuses the statement for lack of
   * privilege (SQLSTATE 42501); "allowed" when it runs; "error" otherwise. */
  deniedWrite: (configuration: PrivatePostgresConfiguration, statement: string) => Promise<"denied" | "allowed" | "error">;
  report: (line: string) => void;
}>;

/** The private database adapter deliberately hides every driver error, so the
 * denied-write probe uses its own short-lived plain connection with the same
 * validated address, credentials and TLS policy, and reads only the SQLSTATE. */
async function deniedWriteV1(configuration: PrivatePostgresConfiguration, statement: string): Promise<"denied" | "allowed" | "error"> {
  const options = privatePostgresOptions(configuration);
  const client = new Client({ host: options.host, port: options.port, database: options.database, user: options.username,
    password: options.password, ssl: options.ssl === false ? false : options.ssl, connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000, query_timeout: 5_000, application_name: "control-room-mac-check" });
  try {
    await client.connect();
    await client.query(statement);
    return "allowed";
  } catch (error) {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "42501" ? "denied" : "error";
  } finally {
    await client.end().catch(() => {});
  }
}

const production: Runtime = Object.freeze({
  loadRoles: loadMacLocalDatabaseRolesFromRootV1,
  loadConfiguration: loadMacLocalProtectedConfigurationFromRootV1,
  openDatabase: createPrivatePostgresDatabase,
  verify: {
    // Same queue option the task host passes to all three (private-task-startup.ts): the
    // fixed queue schema exists, and web/results must hold no rights in it.
    web: (db, config, scope) => verifyPrivateDatabase(db.client, config, scope, Date.now(), { nativeQueue: true }),
    coordinator: (db, config, scope) => verifyTaskCoordinatorDatabase(db.client, config, scope, Date.now(), { nativeQueue: true }),
    results: (db, config, scope) => verifyNativeResultDatabase(db.client, config, scope, Date.now(), { nativeQueue: true }),
    publisher: (db, config, scope) => verifyLocalResultPublisherDatabase(db.client, config, scope, Date.now(), { nativeQueue: true }),
    queueWorker: (db, config) => verifyNativeQueueWorkerDatabase(db.client, config),
  },
  deniedWrite: deniedWriteV1,
  report: line => process.stdout.write(`${line}\n`),
});

const refusal = (): "database_check_refused" => "database_check_refused";

const deniedProbe: Readonly<Record<RoleName, string>> = Object.freeze({
  web: "DELETE FROM tenants WHERE false",
  coordinator: "UPDATE control_jobs SET result_lock=result_lock WHERE false",
  results: "UPDATE control_jobs SET state=state WHERE false",
  publisher: "UPDATE control_harness_runs SET state=state WHERE false",
  queueWorker: "UPDATE control_room_queue.queue SET name=name WHERE false",
});

/** Read-only privilege and connectivity check for the five fixed Mac-local
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
  for (const name of ["web", "coordinator", "results", "publisher", "queueWorker"] as const satisfies readonly RoleName[]) {
    let database: OpenedDatabase | undefined;
    try {
      const configuration = roles[name];
      database = runtime.openDatabase(configuration);
      const identity = (await database.client.query<{ role_ok: boolean }>(
        "SELECT current_user=$1 AND session_user=$1 AS role_ok", [configuration.username])).rows[0];
      if (identity?.role_ok !== true) throw new Error("database_check_refused");
      await database.client.query("SELECT 1");
      await runtime.verify[name](database, configuration, scope);
      const probe = await runtime.deniedWrite(configuration, deniedProbe[name]);
      if (probe === "allowed") throw new Error("database_check_unexpected_write_grant");
      if (probe !== "denied") throw new Error("database_check_probe_failed");
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
