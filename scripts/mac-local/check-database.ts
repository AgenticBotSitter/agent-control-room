import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPrivatePostgresDatabase, type PrivatePostgresConfiguration } from "../../src/web/v1/private-postgres";
import { loadMacLocalDatabaseRolesFromRootV1 } from "./load-protected-configuration";

type OpenedDatabase = ReturnType<typeof createPrivatePostgresDatabase>;
type RoleName = "web" | "coordinator" | "results" | "queueWorker";
type Runtime = Readonly<{
  loadRoles: typeof loadMacLocalDatabaseRolesFromRootV1;
  readFile: typeof readFile;
  openDatabase: (configuration: PrivatePostgresConfiguration) => OpenedDatabase;
  report: (line: string) => void;
}>;

const production: Runtime = Object.freeze({
  loadRoles: loadMacLocalDatabaseRolesFromRootV1,
  readFile,
  openDatabase: createPrivatePostgresDatabase,
  report: line => process.stdout.write(`${line}\n`),
});

const refusal = (): "database_check_refused" => "database_check_refused";

async function verifyMigrationLedger(database: OpenedDatabase, runtime: Runtime): Promise<void> {
  let ledger: unknown;
  try { ledger = JSON.parse(await runtime.readFile(resolve(import.meta.dirname, "../../deploy/postgres/migration-ledger.json"), "utf8")); }
  catch { throw new Error("database_check_refused"); }
  const entries = (ledger as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error("database_check_refused");
  const expected = entries.filter((entry): entry is { file: string; sha256: string; order: number; kind?: string } =>
    !!entry && typeof entry === "object" && typeof (entry as { file?: unknown }).file === "string"
      && typeof (entry as { sha256?: unknown }).sha256 === "string" && Number.isSafeInteger((entry as { order?: unknown }).order)
      && ((entry as { kind?: unknown }).kind === undefined || (entry as { kind?: unknown }).kind === "migrate"))
    .filter(entry => (entry.kind ?? "migrate") === "migrate");
  if (expected.length !== entries.filter(entry => (entry as { kind?: unknown } | undefined)?.kind !== "non_migrate").length)
    throw new Error("database_check_refused");
  const rows = (await database.client.query<{ filename: string; digest: string; ledger_order: number }>(
    "SELECT filename, digest, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
  if (rows.length !== expected.length || rows.some((row, index) => row.filename !== expected[index]?.file
    || row.digest !== `sha256:${expected[index]?.sha256}` || row.ledger_order !== expected[index]?.order))
    throw new Error("database_check_refused");
}

/** Read-only reachability and migration check for the four fixed Mac-local
 * database roles. It loads only the protected role map; it never accepts
 * individual connection strings, writes, retries, or prints configuration. */
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
      await verifyMigrationLedger(database, runtime);
      runtime.report(`${name} ok`);
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
