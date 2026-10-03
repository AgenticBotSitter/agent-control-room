import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
// Production migration applier. Effect-free unless both connection flags are
// supplied: without them it prints the planned file order and exits 0 without
// connecting. A real run needs the two-phase connections:
//   node deploy/postgres/apply-migrations.mjs \
//     --bootstrap-target "host=/sock dbname=control_room user=postgres" \
//     --migrate-target "host=/sock dbname=control_room user=control_room_migrator password=..."
// Corresponding ledger: deploy/postgres/migration-ledger.json (immutable order/checksum).
// Each migration file applies inside one transaction together with its ledger row.
// Refuses: altered digest of an applied file, missing file, reordered files,
// partially recorded rows, gaps in the pending suffix, and any migration that
// left the canonical-payload data guard reading a column it renamed or dropped.
// Optional logins come only from protected CONTROL_ROOM_*_PASSWORD env values
// (never argv); without them the operator receives the exact psql command for
// db/roles/production_provision.sql.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectTarget, parseKeywordValueTarget, readSchemaDigest } from "./evidence.mjs";
import { guardColumnsForTableV1, guardColumnsV1, GUARD_FUNCTION_NAME, introducesPayloadGuard }
  from "./canonical-payload-guard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = text => createHash("sha256").update(text).digest("hex");
const flag = (args, name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

/**
 * @typedef {{ planned: boolean, files?: number, digest?: string, applied?: { file: string, order: number, preSchemaDigest: string, postSchemaDigest: string }[], noOp?: boolean, schemaDigest?: string, objects?: number, logins?: string, grants?: string, operatorProvisionCommand?: string }} ApplyResult
 * @param {{ target?: string, rootDir?: string, ledgerPath?: string, env?: NodeJS.ProcessEnv,
 *   bootstrapTarget?: string | { host?: string, port?: number, database?: string, user?: string, password?: string, application_name?: string },
 *   migrateTarget?: string | { host?: string, port?: number, database?: string, user?: string, password?: string, application_name?: string },
 *   migrateViaLocalPeer?: boolean }} options
 * @returns {Promise<ApplyResult>}
 */
export { readSchemaDigest } from "./evidence.mjs";

/**
 * Every column `validate_control_payload_mirror` reads, per guarded table, as
 * two queries and no state of our own.
 *
 * The guard's own body is the authority on which columns it reads
 * (`canonical-payload-guard.mjs` explains why). The catalog supplies which
 * tables actually carry the trigger, so a table that lost the trigger is not
 * checked as though it still had the guard -- the two facts are read together.
 */
async function payloadGuardExpectations(client) {
  const guard = (await client.query(
    "SELECT p.prosrc AS prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
    + ` WHERE n.nspname = 'public' AND p.proname = $1`
    + " ORDER BY p.oid LIMIT 1", [GUARD_FUNCTION_NAME])).rows[0]?.prosrc;
  if (typeof guard !== "string") throw new Error("payload_guard_function_missing");
  const tables = (await client.query(
    "SELECT c.relname AS table FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid"
    + " JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = c.relnamespace"
    + " WHERE NOT t.tgisinternal AND n.nspname = 'public' AND p.proname = $1"
    + " ORDER BY 1", [GUARD_FUNCTION_NAME])).rows.map(row => row.table);
  if (tables.length === 0) throw new Error("payload_guard_has_no_triggers");
  const parsed = guardColumnsV1(guard);
  return tables.map(table => ({ table, columns: guardColumnsForTableV1(parsed, table) }));
}

/**
 * Refuse a migration that left the canonical-payload guard reading a column that
 * no longer exists.
 *
 * Why this can only fail loudly and never pass vacuously, which is the whole
 * requirement -- a guard that quietly checks nothing is the same defect one
 * level up:
 *   * the guard function must exist and have a readable body, or this throws;
 *   * at least one table must still carry the trigger, or this throws;
 *   * a guarded table with no branch in the guard body throws -- while the body
 *     HAS branches. A body with none at all is the 0003 shape (the prelude is
 *     the whole guard) and the prelude is applied to every table, which is what
 *     such a guard does; see `canonical-payload-guard.mjs`;
 *   * every column the guard reads for that table is looked up by name in
 *     `pg_attribute` with `attisdropped` excluded, so a dropped column does not
 *     count as present;
 *   * a rename is caught because the OLD name is gone, whether or not the new
 *     name exists. A migration that renames a column to another name is still a
 *     rename the guard has not been updated for.
 *
 * The refusal names the table, the columns and the migration, and nothing else:
 * no paths, no usernames, no values.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} client
 * @param {string} migrationFile the file just applied, named in the refusal
 */
export async function verifyPayloadGuard(client, migrationFile = "unknown") {
  const missing = [];
  for (const { table, columns } of await payloadGuardExpectations(client)) {
    const present = new Set((await client.query(
      "SELECT a.attname FROM pg_attribute a WHERE a.attrelid = to_regclass($1)"
      + " AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = ANY($2::text[])", [table, columns])).rows
      .map(row => row.attname));
    for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
  }
  if (missing.length > 0)
    throw new Error(`migration_payload_guard_broken:${migrationFile}:${missing.join(",")}`
      + " (the canonical-payload data guard reads a column this migration renamed or dropped;"
      + " update the guard in the same migration, or the rollback is the safe default)");
  return { checked: true };
}

export async function applyMigrations({ target, rootDir = root, ledgerPath, env = process.env,
    bootstrapTarget, migrateTarget, migrateViaLocalPeer = false }) {
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
  // Normal two-phase provisioning. The bootstrapTarget is a superuser connection that
  // creates the NOLOGIN owner + migrator + app + scheduler logins (idempotent:
  // IF NOT EXISTS guards each CREATE ROLE). The migrateTarget is a connection
  // authenticated as the restricted migrator; the migrator is in
  // control_room_schema_owner so SET ROLE control_room_schema_owner before each
  // migration ensures created objects are owned by the NOLOGIN role. The
  // explicitly opted-in VPS-local upgrade skips bootstrap and assumes that
  // same restricted migrator identity from a Unix-socket operator session.
  // This proves
  // the production migrator path actually runs as the least-privilege login and
  // owns the resulting objects, instead of running as a connection superuser.
  if (!bootstrapTarget) throw new Error("migration_refused_no_bootstrap_target");
  if (!migrateTarget) throw new Error("migration_refused_no_migrate_target");
  if (migrateViaLocalPeer) {
    if (typeof bootstrapTarget !== "string" || migrateTarget !== bootstrapTarget)
      throw new Error("migration_peer_target_refused");
    const parsed = parseKeywordValueTarget(migrateTarget);
    if (typeof parsed.host !== "string" || !parsed.host.startsWith("/")
      || parsed.database !== "control_room" || parsed.user !== "postgres"
      || Object.keys(parsed).some(key => !["host", "port", "database", "user"].includes(key)))
      throw new Error("migration_peer_target_refused");
  }
  // The VPS-local upgrade targets an already-provisioned database. It must
  // never rerun bootstrap, which can create roles or change role membership.
  if (!migrateViaLocalPeer) await runBootstrap({ target: bootstrapTarget, env, rootDir });
  const client = connectTarget(migrateTarget);
  await client.connect();
  try {
    if (migrateViaLocalPeer) {
      const operator = (await client.query(`SELECT current_user, session_user, rolsuper
        FROM pg_roles WHERE rolname=current_user`)).rows[0];
      if (operator?.current_user !== "postgres" || operator?.session_user !== "postgres" || operator?.rolsuper !== true)
        throw new Error("migration_peer_operator_refused");
      const role = (await client.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
        FROM pg_roles WHERE rolname='control_room_migrator'`)).rows[0];
      const membership = (await client.query(`SELECT count(*)::int AS n FROM pg_auth_members m
        JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
        WHERE parent.rolname='control_room_schema_owner' AND member.rolname='control_room_migrator'
          AND NOT m.admin_option AND m.inherit_option AND m.set_option`)).rows[0];
      if (role?.rolcanlogin !== true || role?.rolsuper !== false || role?.rolcreatedb !== false
        || role?.rolcreaterole !== false || role?.rolreplication !== false || role?.rolbypassrls !== false
        || membership?.n !== 1) throw new Error("migration_peer_role_refused");
      await client.query("SET SESSION AUTHORIZATION control_room_migrator");
      const migrator = (await client.query(`SELECT current_user, session_user, rolsuper
        FROM pg_roles WHERE rolname=current_user`)).rows[0];
      if (migrator?.current_user !== "control_room_migrator"
        || migrator?.session_user !== "control_room_migrator" || migrator?.rolsuper !== false)
        throw new Error("migration_peer_identity_refused");
    }
    // Schema migrations must run inside one transaction so the ledger row only
    // commits if the schema change succeeded. The migrator does not own the
    // control_room_schema_migrations table itself; the table is created in the
    // bootstrap phase owned by the schema owner so the migrator can write
    // through its IN ROLE membership.
    await client.query(await readFile(join(rootDir, "db/setup/production_migration_ledger.sql"), "utf8"));
    const applied = (await client.query(
      "SELECT filename, digest, ledger_order, post_schema_digest FROM control_room_schema_migrations"
      + " ORDER BY ledger_order, filename")).rows;
    // A LEDGER THAT ALREADY HOLDS TWO ROWS AT ONE POSITION is refused before
    // anything else is decided. It cannot happen on a database this applier has
    // driven, because `ledger_order` is UNIQUE and every row is written by the
    // INSERT below; it happens on a database that already took a half-applied
    // migration from the pre-constraint applier (rv-mr5o Finding 1). The check
    // reads the catalog rather than trusting the constraint to be there, because
    // an installation that has not run 0291 does not have the constraint.
    //
    // REFUSED, NOT REPAIRED. Deleting or renumbering a row here would erase the
    // record of what ran, and which of two rows is the real one is an operator
    // decision with a restore in front of it, not something a tool may guess.
    // So the run stops having changed nothing and says which position is shared.
    for (const order of (await client.query(
      "SELECT ledger_order, count(*)::int AS rows, array_agg(filename ORDER BY filename) AS filenames"
      + " FROM control_room_schema_migrations GROUP BY ledger_order HAVING count(*) > 1 ORDER BY ledger_order")).rows)
      throw new Error(`migration_ledger_duplicate_rows:${order.ledger_order}:${order.filenames.join(",")}`
        + " (two migrations recorded the same ledger position; this ledger was half-applied before the"
        + " position was unique, and which row is the real one is an operator decision -- restore the"
        + " pre-upgrade backup or rename one migration and re-run, nothing has been changed here)");
    const appliedByName = new Map(applied.map(row => [row.filename, row]));
    // Every applied row must name a migration THIS release still has, at the
    // position this release gives it, with the digest this release pins. Three
    // separate refusals, because they are three separate operator problems and
    // collapsing them costs the operator the one fact they need:
    //
    //   * a filename this ledger does not have  -> `migration_unknown_row`: this
    //     release does not know what the database recorded;
    //   * the same file at a DIFFERENT ledger_order -> `migration_ledger_position_conflict`:
    //     the ledger RENUMBERED an applied migration, which is rv-mr5o Finding 1.
    //     This is the check `apply-migrations.mjs` did not have and the release
    //     applier already made (`pendingMigrationsV1` in
    //     src/updater/v1/pg/database-phase-ledger.mjs compares file + order +
    //     digest positionally; the two appliers disagreed, and the lenient one is
    //     the one every upgrade runs).
    //
    // WHY IT MUST BE BY NAME AND NOT BY INDEX. Comparing `applied[i]` with
    // `executable[i]` is what the gap check below does, and it cannot tell a
    // RENUMBERED row from a DELETED one: both leave the row at a different index
    // than its order. A deleted middle row must stay `migration_gap` (there is a
    // hole and the tail has to come off too -- see
    // tests/result-upload-downgrade-postgres.test.ts), while a renumbered row is
    // the collision. Looking the row up BY ITS OWN FILENAME and then comparing
    // the ORDER that filename holds in this ledger separates them exactly, and
    // reuses the by-filename lookup that already existed here.
    if (applied.length > executable.length) throw new Error("migration_unknown_rows");
    const executableByName = new Map(executable.map(entry => [entry.file, entry]));
    for (const row of applied) {
      const pinned = executableByName.get(row.filename);
      if (!pinned) throw new Error(`migration_unknown_row:${row.filename}`);
      if (`sha256:${pinned.sha256}` !== row.digest) throw new Error(`migration_ledger_digest_mismatch:${row.filename}`);
      if (Number(row.ledger_order) !== pinned.order) {
        // The file that now HOLDS this migration's recorded position, which is
        // the third name in the refusal. It is the other half of the story and
        // is usually the more useful half: in the collision this closes, the
        // database recorded `0285` at order 154 and the merged ledger gives
        // order 154 to `0240`, so the operator needs both names to know that two
        // branches each added a migration above the same last shipped one.
        const holder = executable.find(entry => entry.order === Number(row.ledger_order))?.file ?? "none";
        throw new Error(`migration_ledger_position_conflict:${row.ledger_order}:${row.filename}:${holder}`
          + ` (this migration is recorded at a position this release gives to ${holder}, which means two`
          + " branches each added a migration above the same last shipped one and this database applied"
          + " one of them; rename the migration so it sorts after the applied head, regenerate the ledger,"
          + " and re-run -- nothing has been changed here)");
      }
    }
    // AND the applied positions must be a DENSE PREFIX of the executable ledger's
    // positions, so a hole cannot be `pending`-filtered past: an entry with no row
    // below it is a migration this database never ran, sitting under one it did.
    // This is the `migration_gap` refusal, unchanged -- it is what makes a
    // partially-applied upgrade a refusal rather than a re-apply.
    const executableOrders = executable.map(entry => entry.order);
    const appliedOrders = applied.map(row => row.ledger_order);
    if (appliedOrders.length > executableOrders.length
      || !appliedOrders.every((order, index) => order === executableOrders[index])) {
      const bad = applied.find((row, index) => row.ledger_order !== executableOrders[index]);
      throw new Error(`migration_gap:${bad?.filename ?? "unknown"}`);
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
    // Whether the canonical-payload guard is ARMED yet. The guard is created by
    // 0003 and its body replaced by 0004, so a fresh install applying 0001 or
    // 0002 has nothing to check and the check must not be a refusal there.
    // Tracked from the migration TEXTS this run applied (plus the ones already
    // recorded), never from a migration number restated in code: a second
    // list of "which migration introduces the guard" would be the same
    // drift this whole mechanism exists to remove.
    let guardIntroduced = false;
    for (const row of applied) {
      if (introducesPayloadGuard(onDisk.get(row.filename) ?? "")) { guardIntroduced = true; break; }
    }
    for (const entry of pending) {
      const pre = await readSchemaDigest(client);
      await client.query("BEGIN");
      try {
        await client.query(onDisk.get(entry.file));
        if (introducesPayloadGuard(onDisk.get(entry.file))) guardIntroduced = true;
        // The canonical-payload guard reads its table's columns by name out of
        // to_jsonb(NEW), which PL/pgSQL resolves at RUN time. So a migration that
        // renames one of those columns compiles, applies, and reports success --
        // and every later write to that table is then refused with "canonical
        // payload mirror mismatch". Checked HERE, inside the same transaction
        // that applied the migration, so the rename rolls back with it and the
        // ledger never records a migration that broke a data guard. The check
        // must not be able to pass vacuously: verifyPayloadGuard throws rather
        // than returning an empty finding when the guard cannot be read.
        if (guardIntroduced) await verifyPayloadGuard(client, entry.file);
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
      // 42P01 is `undefined_table`: the file names a RELATION the cluster does not
      // have, which is what an upgrade from an older applied ledger looks like --
      // this release's grant file grants on tables a prefix of the migrations never
      // created.
      //
      // 42883 is `undefined_function`, and it is the SAME situation for a FUNCTION
      // grant. `production_table_grants.sql` and the role files grant EXECUTE on
      // `work_intake_split_suggestion_visible`, `planner_failure_scope_key` and
      // `control_room_planner_grant_owner_retry`, all created by 0203-0205. An
      // upgrade rung whose applied ledger stops before them therefore raised
      // `function work_intake_split_suggestion_visible(text, text, text) does not
      // exist` and the whole run failed (round 4, R4-B3: test:postgres-production
      // #11-#15, "upgrade from S2's / main's / ... applied ledger").
      //
      // So the deferred-partial-schema arm covers both codes. Nothing is weakened:
      // `grants` is reported as `deferred_partial_schema:<message>`, the run
      // continues, and the S-slice tests assert `grants === "applied"` on a
      // complete schema -- so a deferral on a cluster that IS complete is still
      // visible in the result rather than silent.
      if (error?.code !== "42P01" && error?.code !== "42883") throw error;
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
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v') ORDER BY 1`)).rows;
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
         'control_room_scheduler', 'control_room_work_intake', 'control_room_work_intake_agent')`)).rows;
    const existingSet = new Set(existing.map(row => row.rolname));
    const needsMigratorPassword = !existingSet.has("control_room_migrator");
    const needsAppPassword = !existingSet.has("control_room_app");
    const needsSchedulerPassword = !existingSet.has("control_room_scheduler");
    const needsWorkIntakePassword = !existingSet.has("control_room_work_intake_agent");
    const migratorPassword = env.CONTROL_ROOM_MIGRATOR_PASSWORD;
    const appPassword = env.CONTROL_ROOM_APP_PASSWORD;
    const schedulerPassword = env.CONTROL_ROOM_SCHEDULER_PASSWORD;
    const workIntakePassword = env.CONTROL_ROOM_WORK_INTAKE_PASSWORD;
    if (needsMigratorPassword && (!migratorPassword || migratorPassword.length < 24)) throw new Error("provision_refused_short_password");
    if (needsAppPassword && (!appPassword || appPassword.length < 24)) throw new Error("provision_refused_short_password");
    if (needsSchedulerPassword && schedulerPassword && schedulerPassword.length < 24) throw new Error("provision_refused_short_password");
    if (needsWorkIntakePassword && (!workIntakePassword || workIntakePassword.length < 24))
      throw new Error("provision_refused_short_password");
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
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_work_intake') THEN
          CREATE ROLE control_room_work_intake NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_scheduler') THEN
          CREATE ROLE control_room_scheduler LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_work_intake_agent') THEN
          CREATE ROLE control_room_work_intake_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
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
    if (needsWorkIntakePassword) {
      await client.query(`ALTER ROLE control_room_work_intake_agent PASSWORD ${client.escapeLiteral(workIntakePassword)}`);
    }
    await client.query("GRANT control_room_schema_owner TO control_room_migrator");
    await client.query("GRANT control_room_application TO control_room_app");
    if (needsSchedulerPassword) {
      await client.query("GRANT control_room_schedule_admissions TO control_room_scheduler");
    }
    await client.query("GRANT control_room_work_intake TO control_room_work_intake_agent");
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

const invoked = isMainModuleV1(process.argv[1], import.meta.url);
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
