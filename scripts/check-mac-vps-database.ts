import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration,
  type PrivatePostgresConfiguration } from "../src/web/v1/private-postgres";

const CHECK_SCHEMA = "control-room.mac-local-database-check/v1" as const;
type RoleInput = Omit<PrivatePostgresConfiguration, "password"> & { passwordFile: string };
type CheckFile = { schema: typeof CHECK_SCHEMA; roles: Record<string, RoleInput> };
type OpenedDatabase = ReturnType<typeof createPrivatePostgresDatabase>;
type Runtime = Readonly<{
  readFile: typeof readFile;
  lstat: typeof lstat;
  openDatabase: (config: PrivatePostgresConfiguration) => OpenedDatabase;
  report: (line: string) => void;
}>;

const productionRuntime: Runtime = Object.freeze({ readFile, lstat, openDatabase: createPrivatePostgresDatabase,
  report: line => process.stdout.write(`${line}\n`) });

function refusal(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "configuration_file_insecure") return message;
  if (message === "configuration_invalid") return message;
  if (message === "password_file_insecure") return message;
  if (message === "migration_ledger_mismatch") return message;
  return "database_check_refused";
}

async function privateRegularFile(path: string, code: string, runtime: Runtime): Promise<void> {
  if (!isAbsolute(path)) throw new Error(code);
  const entry = await runtime.lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error(code);
}

async function loadCheckFile(configurationPath: string, runtime: Runtime): Promise<CheckFile> {
  if (!isAbsolute(configurationPath)) throw new Error("configuration_file_insecure");
  await privateRegularFile(configurationPath, "configuration_file_insecure", runtime);
  let parsed: unknown;
  try { parsed = JSON.parse(await runtime.readFile(configurationPath, "utf8")); } catch { throw new Error("configuration_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("configuration_invalid");
  const record = parsed as Partial<CheckFile>;
  if (record.schema !== CHECK_SCHEMA || !record.roles || typeof record.roles !== "object" || Array.isArray(record.roles)
    || Object.keys(record.roles).length < 1) throw new Error("configuration_invalid");
  return Object.freeze({ schema: CHECK_SCHEMA, roles: Object.freeze({ ...record.roles }) });
}

async function readRoleConfiguration(input: unknown, runtime: Runtime): Promise<PrivatePostgresConfiguration> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("configuration_invalid");
  const role = input as Partial<RoleInput>;
  if (typeof role.passwordFile !== "string") throw new Error("configuration_invalid");
  await privateRegularFile(role.passwordFile, "password_file_insecure", runtime);
  const password = (await runtime.readFile(role.passwordFile, "utf8")).replace(/[\r\n]+$/u, "");
  const { passwordFile: _passwordFile, ...connection } = role;
  try { return validatePrivatePostgresConfiguration({ ...connection, password } as PrivatePostgresConfiguration); }
  catch { throw new Error("configuration_invalid"); }
}

async function verifyLedger(database: OpenedDatabase, expected: readonly { file: string; sha256: string; order: number; kind?: string }[]) {
  const executable = expected.filter(entry => (entry.kind ?? "migrate") === "migrate");
  const actual = (await database.client.query<{ filename: string; digest: string; ledger_order: number }>(
    "SELECT filename, digest, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
  if (actual.length !== executable.length || actual.some((row, index) => row.filename !== executable[index]?.file
    || row.digest !== `sha256:${executable[index]?.sha256}` || row.ledger_order !== executable[index]?.order))
    throw new Error("migration_ledger_mismatch");
}

/** Read-only, per-login reachability check. It does not prove the full web ACL;
 * W3 runs createPrivateWebDatabaseCheck with the real startup configuration. */
export async function checkMacVpsDatabase(configurationPath: string, runtime = productionRuntime): Promise<number> {
  let ledger: { entries: readonly { file: string; sha256: string; order: number; kind?: string }[] };
  let configuration: CheckFile;
  try {
    configuration = await loadCheckFile(configurationPath, runtime);
    ledger = JSON.parse(await runtime.readFile(resolve(import.meta.dirname, "../deploy/postgres/migration-ledger.json"), "utf8"));
    if (!Array.isArray(ledger.entries)) throw new Error("configuration_invalid");
  } catch (error) {
    runtime.report(refusal(error)); return 1;
  }
  let exitCode = 0;
  for (const [roleName, input] of Object.entries(configuration.roles)) {
    let database: OpenedDatabase | undefined;
    try {
      const config = await readRoleConfiguration(input, runtime);
      database = runtime.openDatabase(config);
      const probe = (await database.client.query<{ role_ok: boolean }>(
        "SELECT current_user=$1 AND session_user=$1 AS role_ok", [config.username])).rows[0];
      if (probe?.role_ok !== true) throw new Error("database_check_refused");
      await database.client.query("SELECT 1");
      await verifyLedger(database, ledger.entries);
      runtime.report(roleName === "web" ? "web ok (generic; web ACL check deferred to W3)" : `${roleName} ok`);
    } catch (error) {
      exitCode = 1; runtime.report(`${roleName} ${refusal(error)}`);
    } finally {
      if (database) {
        try { await database.close(); }
        catch { exitCode = 1; runtime.report(`${roleName} database_check_refused`); }
      }
    }
  }
  return exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) {
    process.stdout.write("Usage: pnpm check:database:vps /absolute/protected/database-check.json\n");
    process.exitCode = 2;
  } else process.exitCode = await checkMacVpsDatabase(path);
}
