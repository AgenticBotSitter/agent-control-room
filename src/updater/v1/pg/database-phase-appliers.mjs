// Two appliers that turn the release's DATA into SQL: grant convergence and the
// fixed queue schema.
//
// Both exist because the phase must converge grants and build the queue WITHOUT
// importing release code, and both are the reason Blocker 3 is closed. The lane
// proved the release's own `readMacGrantCatalogV1` / `diffMacGrantsV1` /
// `applyMacGrantDiffV1` converge to zero, and proved `installFixedQueueSchemaV1`
// builds a queue whose fingerprint matches — both by IMPORTING them, which is
// exactly what the shipped phase cannot do. So the CATALOG and the DIFF are
// reimplemented here against the same data, and the queue is built by applying
// the release's own DDL.
//
// WHAT IS BORROWED AND WHAT IS NOT, stated precisely because the review flagged
// it. The grant catalogue QUERY is borrowed verbatim from the release
// (`database-upgrade-grants.mjs`'s `macGrantCatalogSqlV1`), because a grant
// catalogue that queried different arms would diff against a different universe
// and could "converge" while grants existed that it never saw. The tuple
// ENCODING (`role|kind|object|column|privilege|grantable`) is borrowed, because
// the data file carries tuples in that shape. The GRANT SQL builder is NOT
// borrowed — `grantSql` validates against the release's own `groups` and
// `privilege` sets, which live in release code, so it is rebuilt here over
// equivalents validated by the data-file reader (`database-phase-data.mjs`).
//
// THE CONVERGENCE LOOP READS BACK AFTER IT WRITES, and that is the property rather
// than a nicety: "I issued the GRANTs" is not "the catalogue now matches", and
// only the second is what converges means. A converger that returned `converged:
// true` after applying a diff without re-reading would report success on a
// cluster where a grant silently did not take — which is the failure a grant
// converger exists to prevent.

import { runSessionStatementV1, runSessionTransactionV1 } from "./sql-session.mjs";

const refuse = code => { throw new Error(code); };

/**
 * The grant catalogue, verbatim from `database-upgrade-grants.mjs`.
 *
 * COPIED rather than imported, and the copy is what makes the equivalence
 * testable: `tests/install-database-phase-real-postgres.test.mjs` asserts this
 * text and the release's `macGrantCatalogSqlV1` are the same query once comments
 * and whitespace are normalised, so a change to the release's arms fails that test
 * rather than silently changing what the phase diffs against.
 *
 * `$1::text[]` is the ONLY difference from the release's spelling, and it is
 * substituted by `grantCatalogueQueryV1` rather than being a `pg` parameter,
 * because this transport is `psql`: there is no bind channel, and inlining the
 * principals is safe precisely because `readDesiredGrantsV1` has already refused
 * every principal that is not a bare identifier.
 */
export const MAC_GRANT_CATALOG_SQL_V1 = `
SELECT r.rolname AS role, CASE WHEN c.relkind='S' THEN 'sequence' ELSE 'table' END AS kind,
  n.nspname || '.' || c.relname AS object,
  '' AS column, a.privilege_type AS privilege, a.is_grantable
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
JOIN pg_roles r ON r.oid=a.grantee
WHERE r.rolname = ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f','S')
UNION ALL
SELECT r.rolname, 'table', n.nspname || '.' || c.relname, att.attname, a.privilege_type, a.is_grantable
FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN LATERAL aclexplode(att.attacl) a
JOIN pg_roles r ON r.oid=a.grantee
WHERE r.rolname = ANY($1::text[]) AND att.attnum > 0 AND NOT att.attisdropped
UNION ALL
SELECT r.rolname, 'schema', n.nspname, '', a.privilege_type, a.is_grantable
FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname = ANY($1::text[])
UNION ALL
SELECT r.rolname, 'database', d.datname, '', a.privilege_type, a.is_grantable
FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname = ANY($1::text[])
UNION ALL
SELECT r.rolname, 'function', n.nspname || '.' || p.proname || '(' || COALESCE((SELECT string_agg(
  -- The element type is what a GRANT spells, not the array's own catalog name.
  -- An array of text is stored as _text, so the compact catalog spelling makes
  -- every array-typed signature read as a DIFFERENT function from the one the
  -- role file grants, and the grant then reads as both extra and missing at
  -- once. MEASURED, and the shape is checked against the live catalog rather
  -- than recalled: typelem points at the element type and typlen = -1 is the
  -- varlena marker every array type carries. (typkind is not a pg_type column
  -- and naming it raised 42703 on the first real run.)
  CASE WHEN t.typelem <> 0 AND t.typlen = -1
    THEN pg_catalog.quote_ident(t.typelem::regtype::text) || '[]'
    ELSE pg_catalog.quote_ident(t.typname) END, ', ' ORDER BY u.ord)
  FROM unnest(p.proargtypes) WITH ORDINALITY AS u(oid, ord)
  JOIN pg_type t ON t.oid = u.oid), '') || ')', '', a.privilege_type, a.is_grantable
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN LATERAL aclexplode(p.proacl) a
JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname = ANY($1::text[])`;

/** The catalogue with the principals inlined, which is how `psql` takes them. */
export function grantCatalogueQueryV1(principals) {
  if (!Array.isArray(principals) || principals.length === 0 || principals.length > 128) {
    refuse("database_phase_desired_grants_refused:principals");
  }
  return MAC_GRANT_CATALOG_SQL_V1.replaceAll("$1::text[]",
    `ARRAY[${principals.map(name => `'${name}'`).join(",")}]::text[]`);
}

/**
 * The six-arm catalogue's rows into the release's tuple encoding.
 *
 * MEASURED, and the filter is not optional. Each arm projects its own column list,
 * so a row can carry NULLs where another arm's rows carry values — the release's
 * own `pg` reader sees those as nulls and its set builder drops them. Through this
 * transport a NULL becomes a JSON `null`, and a row with three empty fields would
 * otherwise become a tuple `||| |plain` that the diff would try to REVOKE with
 * no object named.
 */
export function catalogueRowsToTuplesV1(rows) {
  if (!Array.isArray(rows)) refuse("database_phase_grant_catalogue_refused");
  const tuples = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.role !== "string" || row.role === ""
      || typeof row.kind !== "string" || row.kind === "" || typeof row.object !== "string" || row.object === ""
      || typeof row.privilege !== "string" || row.privilege === "") continue;
    tuples.push([row.role, row.kind, row.object, typeof row.column === "string" ? row.column : "",
      row.privilege, row.is_grantable === true ? "grantable" : "plain"].join("|"));
  }
  return new Set(tuples);
}

/** The diff, as the release's `diffMacGrantsV1` computes it. */
export function diffGrantTuplesV1(actual, desired) {
  const extra = [...actual].filter(item => !desired.has(item)).sort();
  const missing = [...desired].filter(item => !actual.has(item)).sort();
  return Object.freeze({ extra: Object.freeze(extra), missing: Object.freeze(missing) });
}

/**
 * One `GRANT` or `REVOKE`, from one tuple.
 *
 * BUILT HERE rather than borrowed, and the reason is the release's own guards:
 * `grantSql` checks the role against `groups ∪ macRolePlan` and the privilege
 * against its own set, both of which live in release code. The equivalent guards
 * here are the reader's (`readDesiredGrantsV1` refuses a tuple whose role is not a
 * bare identifier, whose kind is not one of five, or whose privilege is not one of
 * nine), so by the time a tuple reaches here it has already passed the shape
 * check — and this function re-checks it anyway, because "already validated
 * upstream" is exactly the assumption that breaks when a second caller appears.
 */
export function grantStatementV1(tuple, verb) {
  if (verb !== "GRANT" && verb !== "REVOKE") refuse("database_phase_grant_sql_refused:verb");
  const parts = String(tuple).split("|");
  if (parts.length !== 6) refuse(`database_phase_grant_sql_refused:${String(tuple).slice(0, 80)}`);
  const [role, kind, object, column, privilege, grantable] = parts;
  const kinds = new Set(["table", "sequence", "schema", "function", "database"]);
  const privileges = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES",
    "TRIGGER", "USAGE", "EXECUTE"]);
  const identifier = /^[a-z][a-z0-9_]*$/u;
  const objectName = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\([a-z0-9_, ]*\))?$/u;
  if (!identifier.test(role) || !kinds.has(kind) || !privileges.has(privilege)
    || (grantable !== "plain" && grantable !== "grantable") || !objectName.test(object)
    || (column !== "" && !identifier.test(column))) {
    refuse(`database_phase_grant_sql_refused:${String(tuple).slice(0, 80)}`);
  }
  const on = verb === "GRANT" ? "TO" : "FROM";
  if (kind === "schema") return `${verb} ${privilege} ON SCHEMA ${object} ${on} ${role}`;
  if (kind === "database") return `${verb} ${privilege} ON DATABASE ${object} ${on} ${role}`;
  if (kind === "function") return `${verb} EXECUTE ON FUNCTION ${object} ${on} ${role}`;
  const target = kind === "sequence" ? "SEQUENCE " : "";
  return `${verb} ${privilege}${column ? ` (${column})` : ""} ON ${target}${object} ${on} ${role}`;
}

/**
 * Converge the live catalogue to the release's desired set, as the schema owner.
 *
 * The sequence is read, diff, apply, read again — and the SECOND read is what the
 * result reports on. The diff is applied as ONE transaction so a partial
 * convergence cannot commit: a REVOKE that applied and a GRANT that did not would
 * leave a cluster with strictly less privilege than either the release or the
 * existing state, and the read-back would catch it as "unconverged" — after the
 * damage rather than before it.
 */
export function convergeGrantsFromDataV1(data) {
  return async ({ root, layout, environment, port, profile, profileParameters, pgRoot, identity,
    asSchemaOwner, user = "control_room_migrator", database = "control_room", onSpawn }) => {
    if (!data || !Array.isArray(data.desired) || !Array.isArray(data.principals)) {
      refuse("database_phase_desired_grants_refused");
    }
    const query = grantCatalogueQueryV1(data.principals);
    // The `updater` schema is NOT the release's to converge. Its grants are the
    // updater loader's (`0002_schema.sql`/`0003_guards.sql`, e.g. EXECUTE on
    // `updater.authorization_complete` and USAGE on the schema for the web login),
    // and the loader re-asserts them exactly on every run. MEASURED in the M1 fix
    // round: on a RE-RUN of this phase — the retry after any kill past the loader —
    // the catalogue saw those grants, the diff called them extra, and the REVOKE
    // failed `permission denied for schema updater` (the migrator holds nothing
    // there, by design), so no retry past that point could converge. Had it
    // succeeded it would have been worse: the web login would lose the updater's
    // guard functions. The desired set never names `updater` objects, so ignoring
    // them on the live side is exact.
    const releaseOwned = tuple => !/^updater(\.|$)/u.test(tuple.split("|")[2] ?? "");
    const readCatalogue = async () => new Set([...catalogueRowsToTuplesV1(await asSchemaOwner(query))]
      .filter(releaseOwned));
    const desired = new Set(data.desired);
    let diff = diffGrantTuplesV1(await readCatalogue(), desired);
    if (diff.extra.length === 0 && diff.missing.length === 0) {
      return Object.freeze({ converged: true, convergedGrants: 0 });
    }
    const applied = diff.extra.length + diff.missing.length;
    const statements = [
      ...diff.extra.map(tuple => grantStatementV1(tuple, "REVOKE")),
      ...diff.missing.map(tuple => grantStatementV1(tuple, "GRANT")),
    ];
    // One transaction, as the MIGRATOR, which is the object owner: `initdb`
    // granted `control_room_schema_owner TO control_room_migrator` with INHERIT,
    // so the migrator's grants apply without a `SET ROLE` — and a `SET ROLE`
    // would DROP that ownership and make every GRANT answer
    // `permission denied for function commit_agent_review`, which names a
    // function and never mentions the role switch. MEASURED.
    await runSessionTransactionV1(statements, { root, layout, environment, port, profile,
      profileParameters, pgRoot, identity, onSpawn }, { user, database });
    diff = diffGrantTuplesV1(await readCatalogue(), desired);
    if (diff.extra.length > 0 || diff.missing.length > 0) {
      refuse(`release_schema_grants_unconverged:extra=${diff.extra.length}:missing=${diff.missing.length}`
        + `:first=${diff.extra[0] ?? diff.missing[0] ?? ""}`);
    }
    return Object.freeze({ converged: true, convergedGrants: applied });
  };
}

/**
 * Build the queue schema from the release's own DDL, as the SUPERUSER.
 *
 * WHY THE SUPERUSER, which is the one place this phase uses it and a recorded
 * decision rather than a convenience. The release's own
 * `expectedShapeDigest` fingerprints every relation's OWNER as well as its shape,
 * and the pin was recorded from a construction run as `postgres` — the release's
 * provisioner, and the identity the live VPS upgrade uses. MEASURED: building the
 * identical pg-boss construction as `control_room_migrator` produces
 * `sha256:09dc01b4…` instead of the pinned `sha256:e7286b89…` and the release's
 * installer refuses with `upgrade_queue_shape_refused` — correctly, because the
 * queue's objects would be owned by the release migrator and a migration could
 * `ALTER` or `DROP` them. So the queue is built over the peer map's `postgres`
 * line, as the database account.
 *
 * An existing schema is never rebuilt: a phase that ran `CREATE SCHEMA` over an
 * existing one would replace a live queue's DDL mid-flight. What is missing is
 * built; what exists is left exactly as it is (see the body).
 *
 * The construction program is sent through the transaction runner, which is
 * `--single-transaction -f -`. The program itself opens and commits its own
 * transaction (that is pg-boss's construction plan), so it is sent through
 * `runSessionStatementV1` — a plain statement — rather than the transaction
 * runner, whose `--single-transaction` would nest. That distinction is the same
 * one `sql-session.mjs` documents for `BEGIN`/`COMMIT` in a program.
 */
export function installFixedQueueFromDataV1(data) {
  return async ({ root, layout, environment, port, profile, profileParameters, pgRoot, identity,
    database = "control_room", onSpawn }) => {
    if (!data || !Array.isArray(data.construction) || data.construction.length === 0
      || typeof data.createQueue !== "string" || typeof data.namespace !== "string") {
      refuse("database_phase_queue_ddl_refused");
    }
    const context = { root, layout, environment, port, profile, profileParameters, pgRoot, identity, onSpawn };
    // The existence check is a ROW, read through the row-returning wrapper, and
    // the create is a separate statement the caller only sends when the row is
    // there — the same two-statement shape `init-database` uses for
    // `CREATE DATABASE`, for the same reason: a check that returned no row
    // because the query was wrong is indistinguishable from one that returned no
    // row because the object exists.
    const present = await runSessionStatementV1({ user: "postgres", database,
      sql: `SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE n.nspname = '${data.namespace}'` },
      context);
    // AN EXISTING QUEUE SCHEMA IS NOT A REFUSAL ANY MORE (H3 of the M1b review):
    // it is what a release phase killed after this step leaves, and the retry must
    // converge. The construction and the queue creation are each ONE program that
    // opens and commits its own transaction (`BEGIN; … COMMIT;`, pg-boss's own), and
    // a program cut short by a kill ends without its `COMMIT` and rolls back — so
    // the schema exists only if its construction COMMITTED, and the queue row only
    // if `create_queue` did. The retry therefore builds exactly what is missing:
    //
    //   schema absent                → construction, then the queue
    //   schema present, queue absent → the queue
    //   both present                 → nothing (and nothing is altered: on the
    //                                  live-database-move path this is the owner's
    //                                  running queue)
    const queueRow = async () => Number((await runSessionStatementV1({ user: "postgres", database,
      sql: `SELECT count(*)::int AS queues FROM ${data.namespace}.queue WHERE name = '${data.queue.name}'` },
    context))[0]?.queues ?? 0);
    if (present.length === 0) {
      // Each construction program is its own transaction, run as the SUPERUSER over
      // the peer map's `postgres` line — see the function comment for why the owner
      // is part of what the release's fingerprint protects.
      for (const program of data.construction) {
        await runSessionStatementV1({ user: "postgres", database, sql: program }, context);
      }
    }
    // Then the queue itself, as ONE statement so the advisory lock and the insert
    // are in the same transaction as pg-boss sent them.
    if (present.length === 0 || await queueRow() === 0) {
      await runSessionStatementV1({ user: "postgres", database, sql: data.createQueue }, context);
    }
    // Read back: the schema exists AND the queue row exists. A construction that
    // silently created nothing would otherwise be reported as installed.
    const after = await runSessionStatementV1({ user: "postgres", database,
      sql: `SELECT (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname = '${data.namespace}')`
        + `::int AS schemas, (SELECT count(*) FROM ${data.namespace}.queue`
        + ` WHERE name = '${data.queue.name}')::int AS queues` }, context);
    const row = after[0];
    if (!row || Number(row.schemas) !== 1 || Number(row.queues) !== 1) {
      refuse(`release_schema_queue_not_installed:schemas=${row?.schemas ?? "?"}:queues=${row?.queues ?? "?"}`);
    }
    return Object.freeze({ installed: true, namespace: data.namespace, queue: data.queue.name });
  };
}