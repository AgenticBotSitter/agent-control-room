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

import { readFile, readdir } from "node:fs/promises";
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
 *
 * `0004_push_claims.sql` is the last because it REPLACES two trigger functions
 * that 0003 defines (`guard_push_update` and `guard_push_schedule`) and adds
 * columns to a table 0002 creates. Applied earlier it would either fail on the
 * missing table or be overwritten by 0003's older bodies, and an updater that
 * silently ran the superseded guard is exactly the failure this ordering
 * prevents.
 */
export function updaterDdlFilesV1(): readonly string[] {
  return Object.freeze([
    "0001_deployer_role.sql",
    "0000_bootstrap.sql",
    "0002_schema.sql",
    "0003_guards.sql",
    "0004_push_claims.sql",
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

/** The design's table list (§9.1), asserted on the live catalog after the apply.
 * Item 10a adds three: the open-registration table the web reads, and the two
 * refusal tables that make R16's per-plan-per-hour aggregate a database
 * property. N06 adds a fifth: the owner's acknowledgement of an update
 * OUTCOME, which is what makes an error or rollback warning stay outstanding
 * until it is answered rather than until the updater's next tick.
 *
 * R7U-01 adds the sixth, and it is a different question from the review table's.
 * `owner_review` records that an update errored or rolled back, keyed by KIND.
 * `owner_run_attention` records which RUN left the installation in a state the
 * owner must act on -- `needs_attention`, `uncertain` or a refused upgrade --
 * and stays the published state until the owner acknowledges it or a newer run
 * supersedes it. The defect it closes is that those outcomes are terminal, so
 * the run left `WHERE finished_at IS NULL` and every later poll answered
 * `idle`: a failed upgrade was reported healthy one poll later, forever.
 *
 * They are named here so the loader's "unexpected_tables" refusal fires on a
 * table nobody reviewed. That refusal is the point: this table is
 * the updater's own record of a question the owner has not answered, and a
 * second such table appearing without a review is exactly the shape of problem
 * this list exists to make visible. */
export const updaterTablesV1 = Object.freeze(["plans", "plan_approvals", "plan_approval_outcomes",
  "passkey_registrations", "passkey_open_registrations", "passkey_registrations_limits",
  "approval_refusals", "approval_refusal_buckets", "owner_requests", "owner_review", "owner_run_attention",
  "push_queue", "runs", "run_events", "heartbeat"]);

/**
 * The release-schema tables the deployer may read, and the only ones.
 *
 * Three about who the owner is, and — since item 10a — one about how many
 * browsers can be warned. All read-only, all column-scoped. The first three are
 * what the owner-session guard's SECURITY DEFINER body needs; the fourth is what
 * `enqueue_cooling_off_notices` counts so a `passkey add` with nobody to warn
 * refuses rather than passing quietly (P-5).
 *
 * Naming them here rather than only in the DDL is what makes the grant checkable
 * in both directions on every start.
 */
export const updaterReleaseReadTablesV1 = Object.freeze([
  "control_web_sessions", "control_identities", "control_role_grants", "owner_web_push_subscriptions",
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
  // The files this tree KNOWS about, in order. A file the DIRECTORY does not have
  // is skipped rather than read, and that is what makes an older install's DDL
  // directory a valid input: `tests/fixtures/updater-ddl-item7` is item 7's
  // bundle verbatim and has no `0004_push_claims.sql`, and the upgrade test
  // applies it precisely to prove that this tree's DDL upgrades an old one.
  // Reading it anyway was `ENOENT` on the first real run of that lane after the
  // file was added (measured).
  //
  // A file the tree knows about but the directory is MISSING is not silently
  // tolerated in the real bundle: `updaterDdlFilesV1()` and the directory's
  // contents are asserted equal by tests/updater-schema-ddl.test.ts, and the
  // loader's own table assertion below catches a bundle that lost a file's
  // effects. So the skip is a property of an explicitly older directory, not a
  // way for a broken bundle to pass.
  const files = updaterDdlFilesV1();
  const applied: string[] = [];
  const onDiskFiles = new Set((await readdir(directory)).filter(name => name.endsWith(".sql")));
  // Opened between the two halves, so the deployer role must already exist —
  // which is exactly what `0001` has just created.
  let deployer: UpdaterSqlRunnerV1 | undefined;
  for (const [index, file] of files.entries()) {
    if (!onDiskFiles.has(file)) continue;
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

  // PUBLIC holds nothing, and neither does any role that is not the deployer, the
  // web login, or the nightly backup's dump group. This is the assertion that a
  // re-run cannot quietly widen: the DDL re-applies the revokes, and this reads
  // the result back.
  //
  // R5Q-06. `control_room_schema_owner` is the group the migrator inherits
  // (`db/roles/production_provision.sql` creates the login IN ROLE it), it is NOT
  // a Mac service principal so the release converger never sees this grant, and
  // the dump login needs it because `pg_dump` reads every schema. Without it in
  // this list the loader REFUSES at startup on a correct install — which is the
  // right direction to fail in, but it means this assertion and the DDL are two
  // halves of one decision and must be changed together. The read-only half is
  // the catalog block immediately below.
  const leaked = await options.bootstrap.query(
    `SELECT a.privilege_type, pg_catalog.pg_get_userbyid(a.grantee) AS grantee
       FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
      WHERE n.nspname = 'updater' AND a.grantee <> 0
        AND pg_catalog.pg_get_userbyid(a.grantee) NOT IN ('control_room_deployer','control_room_private_web','control_room_schema_owner')`);
  if (leaked.rows.length > 0) refused(`schema_acl:${JSON.stringify(leaked.rows)}`);

  // R5Q-06, THE OTHER HALF. The dump group must hold a read and NOTHING else:
  // the schema's USAGE and SELECT on every table, no function EXECUTE, no
  // sequence, and not one write privilege on any table.
  //
  // WHY THIS IS ASSERTED RATHER THAN TRUSTED. `GRANT SELECT ON ALL TABLES` is one
  // line, and a later edit that made it `GRANT ALL` would still apply — this
  // schema's owner may grant its own objects anything, so nothing in PostgreSQL
  // would object. This is the check that makes the R5Q-06 grant read-only a
  // property of the install rather than a comment. It is read from the CATALOG,
  // so a grant widened anywhere — by this DDL, by hand, or by a restore that
  // replayed a wider ACL — fails the updater at startup.
  const backupReach = await options.bootstrap.query(
    `SELECT c.relname AS table,
        pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'SELECT') AS read,
        pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'INSERT') AS insert,
        pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'UPDATE') AS update,
        pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'DELETE') AS remove,
        pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'TRUNCATE') AS truncate,
        pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'REFERENCES') AS references,
        pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'TRIGGER') AS trigger
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'updater' AND c.relkind = 'r' ORDER BY c.relname`);
  const unreadable = backupReach.rows.filter(row => row.read !== true).map(row => row.table);
  if (unreadable.length > 0) refused(`backup_read_missing:${unreadable.join(",")}`);
  const writable = backupReach.rows.filter(row => row.insert === true || row.update === true
    || row.remove === true || row.truncate === true || row.references === true || row.trigger === true)
    .map(row => row.table);
  if (writable.length > 0) refused(`backup_read_widened:${writable.join(",")}`);
  // The view the web reads (`passkey_open_registrations_web`) is a VIEW, not a
  // table, and `pg_dump` reads it too. It is evaluated as its owner, so the
  // grantee needs SELECT on it exactly as it does on the tables.
  const backupView = await options.bootstrap.query(
    `SELECT pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'SELECT') AS read,
        pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'INSERT') AS insert,
        pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'UPDATE') AS update,
        pg_catalog.has_table_privilege('control_room_schema_owner', c.oid, 'DELETE') AS remove
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'updater' AND c.relname = 'passkey_open_registrations_web'`);
  const view = backupView.rows[0];
  if (view?.read !== true) refused("backup_read_missing:passkey_open_registrations_web");
  if (view?.insert === true || view?.update === true || view?.remove === true) {
    refused("backup_read_widened:passkey_open_registrations_web");
  }
  // No function EXECUTE and no sequence privilege: this schema's guards are
  // SECURITY DEFINER and owned by the deployer, and a dump login that could
  // EXECUTE them could call a guard as the owner rather than merely copy its
  // definition. There are no sequences at all, which is asserted rather than
  // assumed, because a `SERIAL` added later would be a sequence nobody granted.
  //
  // MEASURED TWICE, and both attempts are why this reads the ACL directly. The
  // sequence half was written first with `has_sequence_privilege(role, c.oid,
  // 'USAGE')` beside `c.relkind = 'S'` in one WHERE clause, then with the filter
  // moved into a subquery, and BOTH answered
  // `42809 "idx_audit_scope_time" is not a sequence` — on the release schema's
  // own index, which is in the same `pg_class`. A qual is not guaranteed to be
  // applied before a STABLE function call, and a subquery is flattened away.
  // `aclexplode` over `relacl` cannot fail on a relation of the wrong kind, so it
  // is what counts an actual grant. This is the same pattern
  // `db/migrations/0285_queue_backup_read.sql` uses for its own default-privilege
  // check, and the same reason: `aclexplode` names the GRANTOR in an aclitem, so a
  // `LIKE` could not tell the grantee from the grantor.
  const backupExtras = await options.bootstrap.query(
    `SELECT
        (SELECT count(*)::int FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'updater'
            AND pg_catalog.has_function_privilege('control_room_schema_owner', p.oid, 'EXECUTE')) AS functions,
        (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'updater' AND c.relkind = 'S') AS sequences,
        (SELECT count(*)::int FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
           JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
          WHERE n.nspname = 'updater' AND c.relkind = 'S'
            AND g.rolname = 'control_room_schema_owner'
            AND a.privilege_type IN ('USAGE','SELECT')) AS sequences_granted`);
  const extras = backupExtras.rows[0];
  if (Number(extras?.functions ?? -1) !== 0) refused(`backup_function_execute:${extras?.functions}`);
  if (Number(extras?.sequences ?? 0) !== Number(extras?.sequences_granted ?? -1)) {
    // Any sequence at all must be readable, or the next `SERIAL` is a dump that
    // fails the morning after it lands.
    refused(`backup_sequence_unreadable:of_${extras?.sequences}:granted_${extras?.sequences_granted}`);
  }

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
