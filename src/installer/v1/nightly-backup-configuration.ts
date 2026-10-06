import { isAbsolute, join, normalize, resolve } from "node:path";
import ledger from "../../../deploy/postgres/migration-ledger.json";
import { canonicalJson } from "../../security/canonical-digest";

export const NIGHTLY_BACKUP_CONFIGURATION_V1 = "control-room.nightly-backup/v1" as const;
export const NIGHTLY_BACKUP_LOGIN_V1 = "control_room_migrator" as const;
export const NIGHTLY_BACKUP_RETENTION_V1 = 14 as const;

export { BACKUP_MANIFEST_SCHEMA_V1, NIGHTLY_DUMP_TIMEOUT_MS_V1 } from "./nightly-backup-constants";

export const NIGHTLY_BACKUP_REQUIRED_TABLES_V1 = Object.freeze([
  "tenants", "workspaces", "projects", "control_web_task_commands", "control_harness_runs",
  "control_harness_run_events",
]);

export type NightlyBackupConfigurationV1 = Readonly<{
  schema: typeof NIGHTLY_BACKUP_CONFIGURATION_V1;
  database: Readonly<{
    host: string;
    port: 5432;
    name: "control_room";
    login: typeof NIGHTLY_BACKUP_LOGIN_V1;
    passwordFile: string;
  }>;
  outputRoot: string;
  lockFile: string;
  pgBin: string;
  ledgerDigest: string;
  requiredTables: readonly string[];
  retention: Readonly<{ dailyBackups: typeof NIGHTLY_BACKUP_RETENTION_V1 }>;
}>;

const safeAbsolutePath = (value: string) => isAbsolute(value) && normalize(value) === value
  && resolve(value) === value && value !== "/" && !value.endsWith("/")
  && !/[\u0000-\u001f\u007f]/u.test(value);

/** One pure config builder shared by daemon generation and runtime validation. */
export function createNightlyBackupConfigurationV1(installRoot: string): NightlyBackupConfigurationV1 {
  if (!safeAbsolutePath(installRoot)) throw new Error("nightly_backup_install_root_refused");
  const protectedRoot = join(installRoot, "Protected");
  return Object.freeze({
    schema: NIGHTLY_BACKUP_CONFIGURATION_V1,
    database: Object.freeze({
      host: join(installRoot, "pg", "socket"),
      port: 5432 as const,
      name: "control_room" as const,
      login: NIGHTLY_BACKUP_LOGIN_V1,
      passwordFile: join(protectedRoot, "config", "database-passwords", `${NIGHTLY_BACKUP_LOGIN_V1}.txt`),
    }),
    outputRoot: join(installRoot, "backups", "nightly"),
    lockFile: join(protectedRoot, "runtime-state", "nightly-backup", "run.lock"),
    pgBin: join(installRoot, "runtime", "pg-current", "bin"),
    ledgerDigest: `sha256:${ledger.digest}`,
    requiredTables: NIGHTLY_BACKUP_REQUIRED_TABLES_V1,
    retention: Object.freeze({ dailyBackups: NIGHTLY_BACKUP_RETENTION_V1 }),
  });
}

export function nightlyBackupConfigurationFileV1(installRoot: string): string {
  return join(installRoot, "Protected", "config", "backup.json");
}

/** Refuses hand-edited paths, logins, retention, ledger pins, or extra fields. */
export function parseNightlyBackupConfigurationV1(configurationPath: string,
  value: unknown): NightlyBackupConfigurationV1 {
  if (!safeAbsolutePath(configurationPath)) throw new Error("nightly_backup_configuration_refused");
  const suffix = join("Protected", "config", "backup.json");
  if (!configurationPath.endsWith(`/${suffix}`)) throw new Error("nightly_backup_configuration_refused");
  const installRoot = configurationPath.slice(0, -(suffix.length + 1));
  const expected = createNightlyBackupConfigurationV1(installRoot);
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error("nightly_backup_configuration_refused");
  }
  return expected;
}
