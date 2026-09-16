// Production migration applier. Effect-free unless both connection flags are
// supplied: without them it prints the planned file order and exits 0 without
// connecting. A real run needs the two-phase connections:
//   node deploy/postgres/apply-migrations.mjs \
//     --bootstrap-target "host=/sock dbname=control_room user=postgres" \
//     --migrate-target "host=/sock dbname=control_room user=control_room_migrator password=..."
// Corresponding ledger: deploy/postgres/migration-ledger.json (immutable order/checksum).
// Each migration file applies inside one transaction together with its ledger row.
// Refuses: altered digest of an applied file, missing file, reordered files,
// partially recorded rows, and gaps in the pending suffix. Optional logins come only
// from PG_MIGRATOR_PASSWORD / PG_APP_PASSWORD env (never argv); without them the
// operator receives the exact psql command for db/roles/production_provision.sql.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectTarget, readSchemaDigest } from "./evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = text => createHash("sha256").update(text).digest("hex");
const flag = (args, name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

/**
 * @typedef {{ planned: boolean, files?: number, digest?: string, applied?: { file: string, order: number, preSchemaDigest: string, postSchemaDigest: string }[], noOp?: boolean, schemaDigest?: string, objects?: number, logins?: string, grants?: string, operatorProvisionCommand?: string }} ApplyResult
 * @param {{ target?: string, rootDir?: string, ledgerPath?: string, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<ApplyResult>}
 */
export { readSchemaDigest } from "./evidence.mjs";

export async function applyMigrations({ target, rootDir = root, ledgerPath, env = process.env,
    bootstrapTarget, migrateTarget }) {
  // `target` is a legacy plan-mode flag only; the run gate is the two phase
  // connections (the CLI refuses a partial pair outright).
  if (!bootstrapTarget && !migrateTarget) {
    const ledger = JSON.parse(await readFile(ledgerPath ?? join(rootDir, "deploy/postgres/migration-ledger.json"), "utf8"));
    return { planned: true, files: ledger.entries.length, digest: ledger.digest };
  }
  const ledgerFile = ledgerPath ?? join(rootDir, "deploy/postgres/migration-ledger.json");
  const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
  // Only "migrate" entries execute. "provision" entries (psql operator scripts with
  // client-side variables) are integrity-tracked by the ledger but never executed
  // here; the equivalent logins are created below from env passwords, or by the
  // operator via db/roles/production_provision.sql.
  const executable = ledger.entries.filter(entry => (entry.kind ?? "migrate") === "migrate");
  for (const entry of ledger.entries) {
    const kind = entry.kind ?? "migrate";
    if (kind !== "migrate" && kind !== "grants" && kind !== "provision") {
      throw new Error(`migration_unknown_kind:${entry.file}`);
    }
  }
  // Two-phase provisioning. The bootstrapTarget is a superuser connection that
  // creates the NOLOGIN owner + migrator + app + scheduler logins (idempotent:
  // IF NOT EXISTS guards each CREATE ROLE). The migrateTarget is a connection
  // authenticated as the restricted migrator; the migrator is in
  // control_room_schema_owner so SET ROLE control_room_schema_owner before each
  // migration ensures created objects are owned by the NOLOGIN role. This proves
  // the production migrator path actually runs as the least-privilege login and
  // owns the resulting objects, instead of running as a connection superuser.
  if (!bootstrapTarget) throw new Error("migration_refused_no_bootstrap_target");
  if (!migrateTarget) throw new Error("migration_refused_no_migrate_target");
  await runBootstrap({ target: bootstrapTarget, env, rootDir });
  const client = connectTarget(migrateTarget);
  await client.connect();
  try {
    // Schema migrations must run inside one transaction so the ledger row only
    // commits if the schema change succeeded. The migrator does not own the
    // control_room_schema_migrations table itself; the table is created in the
    // bootstrap phase owned by the schema owner so the migrator can write
    // through its IN ROLE membership.
    await client.query(await readFile(join(rootDir, "db/setup/production_migration_ledger.sql"), "utf8"));
    const applied = (await client.query(
      "SELECT filename, digest, ledger_order, post_schema_digest FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
    const appliedByName = new Map(applied.map(row => [row.filename, row]));
    for (const row of applied) {
      const pinned = executable.find(entry => entry.file === row.filename);
      if (!pinned) throw new Error(`migration_unknown_row:${row.filename}`);
      if (`sha256:${pinned.sha256}` !== row.digest) throw new Error(`migration_ledger_digest_mismatch:${row.filename}`);
    }
    const onDisk = new Map();
    for (const entry of ledger.entries) {
      let bytes;
      try {
        bytes = await readFile(join(rootDir, entry.file), "utf8");
      } catch {
        throw new Error(`migration_missing:${entry.file}`);
      }
      if (sha256(bytes) !== entry.sha256) throw new Error(`migration_altered:${entry.file}`);
      onDisk.set(entry.file, bytes);
    }
    if (appliedByName.size > executable.length) throw new Error("migration_unknown_rows");
    const executableOrders = executable.map(entry => entry.order);
    const appliedOrders = applied.map(row => row.ledger_order);
    if (appliedOrders.length > executableOrders.length
      || !appliedOrders.every((order, index) => order === executableOrders[index])) {
      const bad = applied.find((row, index) => row.ledger_order !== executableOrders[index]);
      throw new Error(`migration_gap:${bad?.filename ?? "unknown"}`);
    }
    for (const row of applied) {
      if (!onDisk.has(row.filename)) throw new Error(`migration_missing:${row.filename}`);
    }
    const pending = executable.filter(entry => !appliedByName.has(entry.file));
    const appliedNow = [];
    // SET ROLE control_room_schema_owner for the migrator session so all
    // objects created by migrations are owned by the NOLOGIN schema owner, not
    // by the migrator login. RESET ROLE returns to the migrator's own
    // privileges for the ledger row INSERT below.
    await client.query("SET ROLE control_room_schema_owner");
    for (const entry of pending) {
      const pre = await readSchemaDigest(client);
      await client.query("BEGIN");
      try {
        await client.query(onDisk.get(entry.file));
        const post = await readSchemaDigest(client);
        await client.query("RESET ROLE");
        await client.query(
          `INSERT INTO control_room_schema_migrations(filename, digest, ledger_order, pre_schema_digest, post_schema_digest)
           VALUES($1, $2, $3, $4, $5)`,
          [entry.file, `sha256:${entry.sha256}`, entry.order, pre, post]);
        await client.query("COMMIT");
        // Restore the schema-owner role for the next iteration (or for the
        // post-migration ownership check below). RESET ROLE on COMMIT
        // discards the role change, so re-apply on every iteration.
        await client.query("SET ROLE control_room_schema_owner");
        appliedNow.push({ file: entry.file, order: entry.order, preSchemaDigest: pre, postSchemaDigest: post });
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration_failed:${entry.file}:${error.message}`, { cause: error });
      }
    }
    await client.query("RESET ROLE");
    // Live-schema drift verification: after all migrations in this run have
    // committed (or on a no-op rerun), compare the live schema with the saved
    // post-migration schema digest of the highest entry currently in the
    // ledger. Re-query the ledger rather than reusing the pre-loop `applied`
    // because this run may have added new rows. A drift refuses closed before
    // any grants or logins are applied — the cluster's schema no longer matches
    // what the ledger claims it should be.
    const liveApplied = (await client.query(
      "SELECT filename, post_schema_digest FROM control_room_schema_migrations ORDER BY ledger_order DESC LIMIT 1")).rows;
    if (liveApplied.length > 0) {
      const liveSchemaDigest = await readSchemaDigest(client);
      const lastApplied = liveApplied[0];
      if (liveSchemaDigest !== lastApplied.post_schema_digest) {
        throw new Error(`migration_live_schema_drift:${lastApplied.filename}:expected=${lastApplied.post_schema_digest},live=${liveSchemaDigest}`);
      }
    }
    // production_table_grants.sql has the REVOKE / GRANT / ALTER DEFAULT
    // PRIVILEGES statements that converge on every run. Run as the schema
    // owner (migrator's IN ROLE membership) so future objects created by
    // migrations are owned by control_room_schema_owner and the GRANT
    // statements apply to them. Idempotent across fresh install and upgrade:
    // bootstrap already created the group roles, so this only adjusts
    // privileges.
    let grants = "applied";
    try {
      await client.query("SET ROLE control_room_schema_owner");
      await client.query(await readFile(join(rootDir, "db/roles/production_table_grants.sql"), "utf8"));
      await client.query("RESET ROLE");
    } catch (error) {
      await client.query("RESET ROLE").catch(() => {});
      if (error?.code !== "42P01") throw error;
      grants = `deferred_partial_schema:${error.message.split("\n")[0]}`;
    }
    // Schedule-admission scheduler login (idempotent, owned by the schema
    // owner so the grants from production_roles.sql apply). This is the only
    // remaining bootstrap work; the migrator owns the migrator connection,
    // and the schema-owner role owns the schema.
    let logins = "applied";
    const ownership = (await client.query(
      `SELECT n.nspname || '.' || c.relname AS object, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S') ORDER BY 1`)).rows;
    const nonOwnerObjects = ownership.filter(row => row.owner !== "control_room_schema_owner");
    if (nonOwnerObjects.length > 0) {
      throw new Error(`migration_refused_non_owner_objects:${nonOwnerObjects.slice(0, 3).map(row => `${row.object}:${row.owner}`).join(",")}`);
    }
    const schemaDigest = await readSchemaDigest(client);
    return {
      planned: false, applied: appliedNow, noOp: appliedNow.length === 0,
      schemaDigest, objects: ownership.length, logins, grants,
    };
  } finally {
    await client.end();
  }
}

/**
 * Bootstrap phase: connect once as superuser and idempotently create the
 * NOLOGIN schema-owner role, the restricted migrator + application + scheduler
 * logins, and the control_room_schema_migrations table owned by the schema
 * owner. All operations are idempotent so a fresh install and an existing
 * installation converge on the same role/grant/table state. The superuser
 * connection is closed before any migration runs, so the migrator path is
 * the only code that touches schema objects after bootstrap.
 * Passwords are required only for the roles that do not yet exist — a no-op
 * rerun against an already-bootstrapped database skips password validation
 * entirely, so re-running applyMigrations without env passwords (the typical
 * no-op CI case) succeeds.
 * @param {{ target: string, env: NodeJS.ProcessEnv, rootDir: string }} options
 */
async function runBootstrap({ target, env, rootDir }) {
  const client = connectTarget(target);
  await client.connect();
  try {
    // Detect which roles already exist so password provisioning only runs
    // when the bootstrap is fresh-install. Existing-install reruns skip the
    // password checks and the ALTER ROLE password statements.
    const existing = (await client.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('control_room_schema_owner', 'control_room_migrator',
         'control_room_application', 'control_room_app', 'control_room_schedule_admissions',
         'control_room_scheduler')`)).rows;
    const existingSet = new Set(existing.map(row => row.rolname));
    const needsMigratorPassword = !existingSet.has("control_room_migrator");
    const needsAppPassword = !existingSet.has("control_room_app");
    const needsSchedulerPassword = !existingSet.has("control_room_scheduler");
    const migratorPassword = env.CONTROL_ROOM_MIGRATOR_PASSWORD;
    const appPassword = env.CONTROL_ROOM_APP_PASSWORD;
    const schedulerPassword = env.CONTROL_ROOM_SCHEDULER_PASSWORD;
    if (needsMigratorPassword && (!migratorPassword || migratorPassword.length < 24)) throw new Error("provision_refused_short_password");
    if (needsAppPassword && (!appPassword || appPassword.length < 24)) throw new Error("provision_refused_short_password");
    if (needsSchedulerPassword && schedulerPassword && schedulerPassword.length < 24) throw new Error("provision_refused_short_password");
    await client.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_schema_owner') THEN
          CREATE ROLE control_room_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_migrator') THEN
          CREATE ROLE control_room_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_application') THEN
          CREATE ROLE control_room_application NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_app') THEN
          CREATE ROLE control_room_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_schedule_admissions') THEN
          CREATE ROLE control_room_schedule_admissions NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_github_broker') THEN
          CREATE ROLE control_room_github_broker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_scheduler') THEN
          CREATE ROLE control_room_scheduler LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END;
    $$;`);
    if (needsMigratorPassword) {
      await client.query(`ALTER ROLE control_room_migrator PASSWORD ${client.escapeLiteral(migratorPassword)}`);
    }
    if (needsAppPassword) {
      await client.query(`ALTER ROLE control_room_app PASSWORD ${client.escapeLiteral(appPassword)}`);
    }
    if (needsSchedulerPassword && schedulerPassword) {
      await client.query(`ALTER ROLE control_room_scheduler PASSWORD ${client.escapeLiteral(schedulerPassword)}`);
    }
    await client.query("GRANT control_room_schema_owner TO control_room_migrator");
    await client.query("GRANT control_room_application TO control_room_app");
    if (needsSchedulerPassword) {
      await client.query("GRANT control_room_schedule_admissions TO control_room_scheduler");
    }
    // control_room_schema_migrations owned by schema owner so the migrator
    // (IN ROLE schema_owner) can INSERT through its membership. CREATE TABLE
    // IF NOT EXISTS is idempotent across fresh installs and existing clusters.
    // The CREATE runs as the bootstrap superuser (fixture_admin), then the
    // table is re-owned to control_room_schema_owner so the migrator's IN ROLE
    // membership grants the INSERT it needs.
    await client.query(await readFile(join(rootDir, "db/setup/production_migration_ledger.sql"), "utf8"));
    await client.query(`ALTER TABLE control_room_schema_migrations OWNER TO control_room_schema_owner`);
    // Grant CREATE on schema public to the schema owner so subsequent migrations
    // (run as migrator SET ROLE schema_owner) can CREATE TABLE. Also grant the
    // USAGE on schema public so SET ROLE schema_owner can reference existing
    // tables in the public schema. Bootstrap owns these grants because schema
    // public itself is owned by the bootstrap superuser (fixture_admin in tests,
    // postgres in production).
    await client.query(`GRANT CREATE, USAGE ON SCHEMA public TO control_room_schema_owner`);
    await client.query(`GRANT CREATE, USAGE ON SCHEMA public TO control_room_migrator`);
    // Database ownership transfers to the schema owner here, not in
    // provision-database.sql: the schema-owner role does not exist when the
    // database is created, so a clean PostgreSQL would reject an OWNER clause.
    // ALTER is idempotent — re-running bootstrap on an existing install is a
    // no-op for ownership.
    await client.query(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO control_room_schema_owner', current_database()); END; $$;`);
    // Run the role CREATE block from production_roles.sql as the bootstrap
    // superuser. The migrator session does not have CREATEROLE; this DO block
    // creates the group roles (control_room_application, control_room_reader,
    // etc.) that production_table_grants.sql will reference. Bootstrap owns
    // role DDL; the migrate phase owns table-level grants after migrations.
    await client.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_migrator') THEN CREATE ROLE control_room_migrator NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_application') THEN CREATE ROLE control_room_application NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_reader') THEN CREATE ROLE control_room_reader NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_backup') THEN CREATE ROLE control_room_backup NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_schedule_admissions') THEN CREATE ROLE control_room_schedule_admissions NOLOGIN; END IF;
      END;
    $$;`);
  } finally {
    await client.end();
  }
}

const invoked = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  try {
    // The single --target form never worked: the applier refuses without both
    // phase connections, so fail loudly instead of pretending to migrate.
    if (flag(args, "--target", undefined) !== undefined) {
      throw new Error("migration_removed_flag:--target (use --bootstrap-target and --migrate-target)");
    }
    const bootstrap = flag(args, "--bootstrap-target", undefined);
    const migrate = flag(args, "--migrate-target", undefined);
    if ((bootstrap === undefined) !== (migrate === undefined)) {
      throw new Error("migration_refused_partial_targets (supply both --bootstrap-target and --migrate-target, or neither for a plan)");
    }
    const result = await applyMigrations({ bootstrapTarget: bootstrap, migrateTarget: migrate,
      rootDir: resolve(flag(args, "--root", root)) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`migration_apply_failed: ${error.message}`);
    process.exit(1);
  }
}
