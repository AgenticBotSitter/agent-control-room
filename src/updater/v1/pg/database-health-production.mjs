// The PRODUCTION database half of §5.8's health check (rv-9b B1).
//
// M4's `checkHealthDatabaseV1` is the check; it takes its reads as dependencies and
// refuses without them. Nothing on the install path ever built them, so the
// installer's `checkHealth` reached a `database_port_not_yet_supplied` stub. This
// module builds them from what the install root already holds and nothing else:
//
//   - the identity is the DATABASE ACCOUNT, read as the owner of the data directory
//     `init-database` created as that account (never root: the peer map sends D to
//     the migrator and to `postgres`, and root only to the deployer);
//   - the port, database and migrator names are the release's role manifest, the
//     same file `initializeDatabaseV1` reads its port from;
//   - every statement runs through `runSessionStatementV1` as D, under
//     `service-postgres.sb`, exactly as the release phase does;
//   - the schema digest is the bundle's own `release-schema-digest.sql`, run as the
//     migrator — the query and the role the release phase recorded the digest with;
//   - the updater digest is the DDL FILE-SET digest `init-database` recorded (see
//     `updater-ddl.mjs` for why it is a file digest), plus a live probe that the
//     `updater` schema exists.
//
// It also ADAPTS the two contracts: `install/health.mjs` asks
// `{root, pgDataId, schemaDigest, updaterSchemaDigest}` and expects
// `{healthy, schemaDigest, updaterSchemaDigest}` back; M4's port takes
// `expectedRelease` and `samples` too and answers `{healthy, samples, schemaDigest}`.
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { planPgClusterLayoutV1 } from "../../../pg-runtime/v1/pg-cluster-layout.ts";
import { postgresProfileParametersV1 } from "./database-phase-process.mjs";
import { readRoleManifestV1 } from "./database-phase-data.mjs";
import { checkHealthDatabaseV1, DATABASE_HEALTH_COUNTS_V1, FIRST_OWNER_HEALTH_SAMPLES_V1 } from "./first-owner-ports.mjs";
import { digestReleaseSchemaRowsV1, readReleaseSchemaDigestSqlV1 } from "./release-schema-digest.mjs";
import { runSessionStatementV1 } from "./sql-session.mjs";
import { computeUpdaterDdlFileDigestV1, readUpdaterDdlFilesV1 } from "./updater-ddl.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const refuse = code => { throw Object.assign(new Error(code), { code }); };
const bare = digest => digest.slice("sha256:".length);

/** The DDL files and order `init-database` digests; the two must stay one list. */
export const UPDATER_DDL_FILES_V1 = Object.freeze(["0001_deployer_role.sql", "0000_bootstrap.sql"]);

/**
 * The session context, built from the install root alone.
 *
 * `accounts.database` is a NAME only for the layout's peer-map text, which this
 * caller never writes; it is the policy's name for D, and the uid/gid that matter
 * are the data directory's owner.
 */
export async function databaseSessionContextV1(root, pgDataId, runtime = {}) {
  const data = join(root, "pg", pgDataId);
  const entry = await lstat(data).catch(() => refuse("health_database_refused:data_directory"));
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid < 1) refuse("health_database_refused:data_directory");
  const manifest = await (runtime.readRoleManifest ?? readRoleManifestV1)(join(root, "current"))
    .catch(() => refuse("health_database_refused:role_manifest"));
  const layout = planPgClusterLayoutV1({ pgRoot: join(root, "pg"), dataId: pgDataId,
    runtimeDirectory: join(root, "runtime", "pg-current"),
    accounts: { database: runtime.databaseAccountName ?? "_crdb", migrator: manifest.migratorLogin,
      deployer: manifest.deployerLogin }, port: manifest.port });
  if (layout.status !== "socket_only_cluster_layout_built") refuse(`health_database_refused:layout:${layout.refusal?.reason}`);
  return Object.freeze({ manifest, context: Object.freeze({ root, layout, port: manifest.port,
    environment: Object.freeze({ ...layout.environment }), pgRoot: join(root, "pg"),
    identity: Object.freeze({ uid: entry.uid, gid: entry.gid }),
    profile: join(root, "updater", "current", "policy", "service-postgres.sb"),
    profileParameters: postgresProfileParametersV1({ root, layout, logDirectory: join(root, "logs", "postgresql17") }),
    onSpawn: runtime.onPgSpawn }) });
}

/** M4's dependency bundle over the real session transport. */
export async function databaseHealthDependenciesV1(root, pgDataId, runtime = {}) {
  const { manifest, context } = await databaseSessionContextV1(root, pgDataId, runtime);
  const digestSql = await readReleaseSchemaDigestSqlV1(root);
  const as = (user, sql) => runSessionStatementV1({ user, database: manifest.database, sql }, context);
  return Object.freeze({
    digestRows: digestReleaseSchemaRowsV1,
    sample: async () => Object.freeze({ ok: true, rows: await as(manifest.migratorLogin, digestSql) }),
    readUpdaterDigest: async () => {
      const rows = await as("postgres", "SELECT nspname FROM pg_namespace WHERE nspname = 'updater'");
      if (!Array.isArray(rows) || rows.length !== 1) refuse("health_database_refused:updater_schema_missing");
      return bare(computeUpdaterDdlFileDigestV1(await readUpdaterDdlFilesV1(
        join(root, "updater", "current", "ddl"), UPDATER_DDL_FILES_V1)));
    },
    readCounts: async table => {
      if (!Object.hasOwn(DATABASE_HEALTH_COUNTS_V1, table)) refuse("health_database_refused:count_table");
      const rows = await as("postgres", `SELECT count(*)::bigint::text AS n FROM ${table}`);
      if (!Array.isArray(rows) || rows.length !== 1) refuse("health_database_refused:count");
      const count = Number(rows[0]?.n);
      if (!Number.isSafeInteger(count) || count < 0) refuse("health_database_refused:count");
      return count;
    },
  });
}

/** `checkDatabase` for `install/health.mjs`, backed by M4's real check. */
export async function checkDatabaseHealthProductionV1(input, runtime = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "pgDataId,root,schemaDigest,updaterSchemaDigest"
    || !DIGEST.test(input.schemaDigest ?? "") || !DIGEST.test(input.updaterSchemaDigest ?? "")) {
    refuse("health_database_refused");
  }
  const expectedRelease = await readlink(join(input.root, "current")).catch(() => refuse("health_database_refused:current"));
  const dependencies = await (runtime.dependencies ?? databaseHealthDependenciesV1)(input.root, input.pgDataId, runtime);
  const result = await checkHealthDatabaseV1({ root: input.root, expectedRelease, pgDataId: input.pgDataId,
    samples: FIRST_OWNER_HEALTH_SAMPLES_V1, schemaDigest: input.schemaDigest,
    updaterSchemaDigest: input.updaterSchemaDigest }, dependencies);
  if (result?.healthy !== true || result.schemaDigest !== input.schemaDigest) refuse("health_database_refused");
  return Object.freeze({ healthy: true, schemaDigest: input.schemaDigest, updaterSchemaDigest: input.updaterSchemaDigest });
}
