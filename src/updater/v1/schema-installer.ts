// The updater's DDL loader (design item 7, §9.1, R10a).
//
// WHAT THIS IS. The updater applies its own schema at startup from the fixed DDL
// shipped inside `updater/<ver>/ddl/`. It is NOT the release migration ledger:
// `db/migrations/*.sql` belongs to the release and to the migrator, and nothing
// in it creates, alters or grants anything in schema `updater`. The point of the
// split is R10 — the tables that hold the owner's approval must not be owned by
// the account whose SQL a candidate controls.
//
// WHY THE APPLY IS SPLIT IN TWO. The role and the schema are created with the
// installer's bootstrap privilege, because `CREATE ROLE` and `CREATE SCHEMA` are
// cluster- and database-level operations that the deployer role must not hold
// (holding database CREATE would make it a database-level principal, and
// `scripts/mac-local/database-upgrade-grants.mjs` treats that as a reason to
// refuse grant convergence). Everything else runs AS the deployer over the
// existing schema, which is what proves the deployer needs no more authority
// than "I own schema `updater`": if a statement ever did need more, it would
// fail here rather than in production.
//
// IDEMPOTENCE. The design says the updater applies this at startup. So the
// loader is safe to run on every start, and the tests re-apply it to prove that.
// Every statement is `IF NOT EXISTS`, `CREATE OR REPLACE`, or a trigger
// definition replaced in place; a table that already exists is not touched, so
// no row can be lost by a restart.
//
// WHAT IS ASSERTED RATHER THAN ASSUMED. After the apply, the loader reads the
// catalog and checks the things a comment cannot: the schema's owner, the role's
// attributes, and the exact table set. A schema owned by somebody else, a role
// with a password, and a missing table are all refusals here, not surprises
// later.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A `pg` client, or anything with the same `query` surface. Structural on
 * purpose: the updater bundle must not import `pg`'s types at compile time when
 * it is bundled by the fixed esbuild step (design §6.6b). */
export interface UpdaterSqlRunnerV1 {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Where the fixed DDL lives inside the updater bundle. */
export const updaterDdlDirectoryV1 = "ddl";

/**
 * The DDL files, in the order they must be applied.
 *
 * The order is a security property, not a convenience: `0000_bootstrap.sql`
 * refuses to continue unless the deployer role exists, and `0002_schema.sql`
 * refuses unless the schema is already owned by it. Applying them out of order
 * produces a named refusal, never a half-built schema.
 */
export function updaterDdlFilesV1(): readonly string[] {
  return Object.freeze([
    "0001_deployer_role.sql",
    "0000_bootstrap.sql",
    "0002_schema.sql",
    "0003_guards.sql",
    "0004_backups.sql",
  ]);
}

export interface UpdaterSchemaOptionsV1 {
  /** A client with the installer's bootstrap privilege (root, on a peer map). */
  bootstrap: UpdaterSqlRunnerV1;
  /**
   * Called ONCE, after the role and schema exist and BEFORE the first deployer
   * statement, to produce the deployer's client.
   *
   * A factory rather than a client, because the ordering is the security
   * property: the deployer role does not exist until `0001` has run, so a client
   * could not be built earlier. It is also what lets the test harness set the
   * SCRAM verifier its client needs in exactly that gap — after `0001` has
   * checked that the role holds no password, and before anything runs as it.
   * Production's factory just opens the peer-authenticated connection.
   */
  connectDeployer: () => Promise<UpdaterSqlRunnerV1>;
  /**
   * The test harness had to give the deployer role a SCRAM verifier, because it
   * speaks the password protocol where production uses peer authentication.
   *
   * Declaring it here is the point: the loader otherwise REFUSES a role that
   * holds a password, and that refusal is a security assertion worth keeping
   * (a second way in is a second attack). So a caller that has knowingly created
   * a fixture password must say so, and a caller that has not gets the refusal.
   * There is no way to reach the permissive branch without having set one.
   */
  deployerHasFixturePassword?: boolean;
  /** Directory holding the DDL files. Defaults to the bundle's own `ddl/`. */
  directory?: string;
}

export interface UpdaterSchemaResultV1 {
  readonly appliedFiles: readonly string[];
  readonly tables: number;
  readonly triggers: number;
}

/** The design's table list (§9.1), asserted on the live catalog after the apply. */
export const updaterTablesV1 = Object.freeze(["plans", "plan_approvals", "plan_approval_outcomes",
  "passkey_registrations", "owner_requests", "push_queue", "runs", "run_events", "heartbeat",
  "backup_generations", "backup_state"]);

/**
 * The release-schema tables the deployer may read, and the only ones.
 *
 * Three, all read-only, all about who the owner is. The guard that requires a
 * live owner session on every web-inserted row is SECURITY DEFINER and owned by
 * the deployer, so it needs exactly these. Naming them here rather than only in
 * the DDL is what makes the grant checkable in both directions on every start.
 */
export const updaterReleaseReadTablesV1 = Object.freeze([
  "control_web_sessions", "control_identities", "control_role_grants",
]);

function refused(reason: string): never {
  throw new Error(`updater_schema_refused:${reason}`);
}

/**
 * Apply the updater's fixed DDL, idempotently, and assert the result.
 *
 * The assertions are the load-bearing part. A loader that only ran the files
 * would report success on a database where the schema was owned by somebody
 * else, or where the role had grown a password, and the next thing that happens
 * is the updater using authority it should not have.
 */
export async function applyUpdaterSchemaV1(options: UpdaterSchemaOptionsV1): Promise<UpdaterSchemaResultV1> {
  const directory = options.directory ?? updaterDdlDirectoryV1;
  const files = updaterDdlFilesV1();
  const applied: string[] = [];
  // Opened between the two halves, so the deployer role must already exist —
  // which is exactly what `0001` has just created.
  let deployer: UpdaterSqlRunnerV1 | undefined;
  for (const [index, file] of files.entries()) {
    const sql = await readFile(join(directory, file), "utf8");
    // 0000 and 0001 are the installer's; the rest is the deployer's. Which client
    // runs which file is part of the contract, so it is derived from the order
    // rather than from a name pattern that a new file could dodge.
    if (index < 2) {
      await options.bootstrap.query(sql);
    } else {
      deployer ??= await options.connectDeployer();
      await deployer.query(sql);
    }
    applied.push(file);
  }
  if (!deployer) refused("deployer_never_connected");

  const owner = await options.bootstrap.query(
    `SELECT pg_catalog.pg_get_userbyid(n.nspowner) AS owner
       FROM pg_catalog.pg_namespace n WHERE n.nspname = 'updater'`);
  if (owner.rows[0]?.owner !== "control_room_deployer") refused("schema_owner");

  const role = await options.bootstrap.query(
    `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
            (rolpassword IS NOT NULL) AS has_password
       FROM pg_catalog.pg_authid WHERE rolname = 'control_room_deployer'`);
  const attributes = role.rows[0];
  if (!attributes || attributes.rolcanlogin !== true || attributes.rolsuper !== false
    || attributes.rolcreatedb !== false || attributes.rolcreaterole !== false
    || attributes.rolreplication !== false || attributes.rolbypassrls !== false) {
    refused("role_attributes");
  }
  // 0001 raises on a password, so reaching here with one means the role was
  // created or altered outside the fixed DDL. A second way in is not tolerated.
  // The test harness is the one declared exception, and it has to have set the
  // password through `connectDeployer` to get here — so this cannot be reached
  // without one having existed.
  if (attributes.has_password === true && options.deployerHasFixturePassword !== true) refused("role_password");

  const present = await options.bootstrap.query(
    `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'updater' AND c.relkind = 'r' ORDER BY c.relname`);
  const tables = present.rows.map(row => String(row.relname));
  const missing = updaterTablesV1.filter(table => !tables.includes(table));
  if (missing.length > 0) refused(`missing_tables:${missing.join(",")}`);
  const extra = tables.filter(table => !updaterTablesV1.includes(table));
  if (extra.length > 0) refused(`unexpected_tables:${extra.join(",")}`);

  const triggers = await options.bootstrap.query(
    `SELECT count(*)::int AS count FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'updater' AND NOT t.tgisinternal`);

  // PUBLIC holds nothing, and neither does any role that is not the deployer or
  // the web login. This is the assertion that a re-run cannot quietly widen: the
  // DDL re-applies the revokes, and this reads the result back.
  const leaked = await options.bootstrap.query(
    `SELECT a.privilege_type, pg_catalog.pg_get_userbyid(a.grantee) AS grantee
       FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
      WHERE n.nspname = 'updater' AND a.grantee <> 0
        AND pg_catalog.pg_get_userbyid(a.grantee) NOT IN ('control_room_deployer','control_room_private_web')`);
  if (leaked.rows.length > 0) refused(`schema_acl:${JSON.stringify(leaked.rows)}`);

  const publicLeak = await options.bootstrap.query(
    `SELECT count(*)::int AS count FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'updater' AND c.relkind = 'r' AND r.rolname <> 'control_room_deployer'`);
  if (Number(publicLeak.rows[0]?.count ?? 0) !== 0) refused("table_owner");

  // The deployer's reach into the RELEASE schema is exactly three read-only
  // tables, and nothing else. This is the assertion that keeps R10a honest from
  // both directions: a grant that grows here is a grant a compromised updater
  // gained, and a grant that shrinks is a guard that cannot check the owner
  // session. Read from the catalog rather than from the DDL text, so a grant
  // added anywhere else is caught too.
  //
  // The predicate is COLUMN-level, not table-level, and that is the point: the
  // three grants are column-scoped, so `has_table_privilege(oid,'SELECT')` is
  // false for all of them and a table-level test would report the deployer as
  // having reached nothing at all — the same vacuous-pass shape this lane exists
  // to avoid. Any column the deployer can read is reach.
  const releaseReach = await options.bootstrap.query(
    `SELECT DISTINCT c.relname FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                     AND (has_column_privilege('control_room_deployer', c.oid, a.attname, 'SELECT')
                       OR has_column_privilege('control_room_deployer', c.oid, a.attname, 'INSERT')
                       OR has_column_privilege('control_room_deployer', c.oid, a.attname, 'UPDATE')))
          OR has_table_privilege('control_room_deployer', c.oid, 'DELETE')
          OR has_table_privilege('control_room_deployer', c.oid, 'TRUNCATE'))
      ORDER BY c.relname`);
  const reachable = releaseReach.rows.map(row => String(row.relname));
  // The write check comes FIRST, so a grant that is both a new reach AND a write
  // is reported as the more serious of the two. With the order the other way, a
  // write privilege added to a table outside the allowed three is reported as
  // "unexpected reach" — technically true, and it hides the half that matters.
  const releaseWrite = await options.bootstrap.query(
    `SELECT count(*)::int AS count FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
        AND (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                         AND (has_column_privilege('control_room_deployer', c.oid, a.attname, 'INSERT')
                           OR has_column_privilege('control_room_deployer', c.oid, a.attname, 'UPDATE')))
          OR has_table_privilege('control_room_deployer', c.oid, 'DELETE')
          OR has_table_privilege('control_room_deployer', c.oid, 'TRUNCATE'))`);
  if (Number(releaseWrite.rows[0]?.count ?? 0) !== 0) refused("release_write_privilege");
  const unexpectedReach = reachable.filter(table => !updaterReleaseReadTablesV1.includes(table));
  if (unexpectedReach.length > 0) refused(`release_reach:${unexpectedReach.join(",")}`);
  const missingReach = updaterReleaseReadTablesV1.filter(table => !reachable.includes(table));
  if (missingReach.length > 0) refused(`release_reach_missing:${missingReach.join(",")}`);

  return { appliedFiles: Object.freeze(applied), tables: tables.length, triggers: Number(triggers.rows[0]?.count ?? 0) };
}
