import { createPrivatePostgresDatabase, type PrivatePostgresConfiguration } from "../../src/web/v1/private-postgres";
import { loadMacLocalDatabaseRolesFromRootV1 } from "./load-protected-configuration";

type OpenedDatabase = ReturnType<typeof createPrivatePostgresDatabase>;
type RoleName = "web" | "coordinator" | "results" | "queueWorker";
type Runtime = Readonly<{
  loadRoles: typeof loadMacLocalDatabaseRolesFromRootV1;
  openDatabase: (configuration: PrivatePostgresConfiguration) => OpenedDatabase;
  report: (line: string) => void;
}>;

const production: Runtime = Object.freeze({
  loadRoles: loadMacLocalDatabaseRolesFromRootV1,
  openDatabase: createPrivatePostgresDatabase,
  report: line => process.stdout.write(`${line}\n`),
});

const refusal = (): "database_check_refused" => "database_check_refused";

/** Read-only reachability and migration check for the four fixed Mac-local
 * database roles. The migration history is intentionally restricted to the
 * schema owner, so this verifies each runtime account without widening its
 * privileges. The provisioner verifies the migration ledger before it writes
 * this protected role map. It never writes, retries, or prints configuration. */
export async function checkMacLocalDatabaseV1(protectedRoot: string, runtime: Runtime = production): Promise<number> {
  let roles: Awaited<ReturnType<typeof loadMacLocalDatabaseRolesFromRootV1>>;
  try { roles = await runtime.loadRoles(protectedRoot); }
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
      runtime.report(`${name} connectivity ok (privilege isolation not checked)`);
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
