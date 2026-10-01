// Item 19a's dump evidence: a SHAPE digest that survives a `--no-owner`
// restore, plus the per-table row counts that go with it.
//
// WHY A SEPARATE DIGEST, and why this is a bug the first version of this lane
// had. The release's own `readSchemaDigest` (deploy/postgres/evidence.mjs)
// includes each table's OWNER, which is right for its purpose: it pins the
// shape AND the ownership of a live database, and `backup-database.mjs` records
// ownership separately in `evidence.grants` for exactly that reason.
//
// It is the wrong comparison for a restore-verify, because the restore is run
// with `--no-owner` — R9.3 step 4 restores as the migrator with
// `--no-owner --role=control_room_migrator`, so every restored object is owned
// by whoever ran `pg_restore`, not by the original owner. Comparing the
// source's digest against such a restore's digest can therefore NEVER match, and
// the verify would refuse every good backup in the world. Measured on a real
// dump/restore round trip:
//
//   source=sha256:dfe89bf009c8f6f600bbf98ee78bfbfbe70f106411587260d5f37e63c8c09179
//   restored=sha256:e5699f6b6d5d851618b907a8b8ff4525839beca52afc4b2ee8419599f03c069b
//
// That is the whole of the difference, and it is a difference about WHO owns a
// table, not about whether the dump contains it.
//
// So the verify compares the things a dump is actually responsible for:
//   * every object in `public` AND in `updater` (tables, columns, constraints,
//     indexes, triggers and functions) by their definition text, with ownership
//     excluded. `updater` is in the set because a dump that lost the updater's
//     own schema — passkeys, plans, this very ledger — must not pass the verify
//     (review backup19b H3.3: adding a table with rows to `updater` used to leave
//     the digest unchanged);
//   * the per-table row counts, over the same two schemas;
//   * the ownership, read from the SOURCE only and recorded as evidence, since
//     ownership is restored by provisioning roles and is not in the dump.
//
// THE READER IS HOSTILE-INPUT CODE (review backup19b C1). Every table name in
// `public` is chosen by a candidate release, and the first version of this file
// built `SELECT count(*) FROM public."${table}"` and sent it over the simple
// query protocol — a table named `t1";ALTER ROLE control_room_migrator SUPERUSER;--`
// made the release login a superuser. The rules this file now holds to:
//   1. no SQL text is ever built from a catalog name in JavaScript: the
//      qualified name is quoted SERVER-side by `format('%I.%I')`, and is
//      cross-checked against the quoting rule here before it is used;
//   2. every statement goes over the EXTENDED protocol (`queryMode: 'extended'`),
//      which refuses more than one statement per call, so even a quoting bug
//      could not smuggle a second statement;
//   3. the reading session is pinned: `search_path = pg_catalog, pg_temp`,
//      READ ONLY, `row_security = off` (a policy's expression is a release's
//      code and must never run as the reader), and bounded lock and statement
//      timeouts so a release holding a lock cannot hang the backup;
//   4. the reading LOGIN must be a least-privilege role: not a superuser, not
//      able to create roles or databases, not a replication role, not a member
//      of any role that is, and holding ADMIN on no role — so even if all of the
//      above failed there is no authority to steal. `assertEvidenceReaderV1`
//      refuses anything else before the first catalog read.

import { createHash } from "node:crypto";
import { updaterRefuseV1 } from "./contracts.mjs";

const sha256 = text => createHash("sha256").update(text).digest("hex");

/** The schemas the evidence covers, in the order the arrays are built. */
export const EVIDENCE_SCHEMAS_V1 = Object.freeze(["public", "updater"]);

/** Bounded so a release cannot make the reader do unbounded work. */
const STATEMENT_TIMEOUT_V1 = "600s";
const LOCK_TIMEOUT_V1 = "60s";

const extended = (text, values = []) => Object.freeze({ text, values, queryMode: "extended" });

/**
 * The same object set as the release's SCHEMA_SNAPSHOT, with ownership removed,
 * over `EVIDENCE_SCHEMAS_V1` (bound as `$1`, so this is an extended-protocol
 * statement by construction).
 *
 * Written out rather than derived from the release's constant because the
 * release's is a module-private string that already folds in `pg_get_userbyid`,
 * and editing a shared constant to suit a restore path would change what
 * `backup-database.mjs` records for every operator. Two definitions that are
 * meant to be the same shape is a drift risk, so `tests/updater-backup-contract.test.mjs`
 * asserts that this file's object kinds match the release's, and the lane proves
 * on a real round trip that a dump and its restore agree.
 *
 * Catalog names are concatenated into DATA here (the snapshot's JSON), never
 * into SQL text, so a hostile name is just a string in a digest.
 */
const SHAPE_SNAPSHOT = `
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(snapshot)
           ORDER BY snapshot.kind, snapshot.name, snapshot.detail), '[]'::jsonb) AS snapshot
  FROM (
    SELECT 'table' AS kind, n.nspname || '.' || c.relname AS name, c.relpersistence::text AS detail
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p')
      AND NOT (n.nspname = 'public' AND c.relname = 'control_room_schema_migrations')
    UNION ALL
    SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname,
           pg_catalog.format_type(a.atttypid, a.atttypmod)
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND NOT (n.nspname = 'public' AND c.relname = 'control_room_schema_migrations')
    UNION ALL
    SELECT 'constraint', n.nspname || '.' || c.relname || '.' || con.conname,
           CASE WHEN con.contype = 'c' THEN 'check:' || con.contype::text || '|key:'
                  || pg_catalog.array_to_string(con.conkey, ',') || '|expr:'
                  || pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
                       pg_catalog.pg_get_expr(con.conbin, con.conrelid), '\\s', '', 'g'), '[()]', '', 'g'), '::', '.', 'g')
                ELSE 'def:' || pg_catalog.pg_get_constraintdef(con.oid) END
    FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1::text[])
      AND NOT (n.nspname = 'public' AND c.relname = 'control_room_schema_migrations')
    UNION ALL
    SELECT 'index', n.nspname || '.' || c.relname || '.' || i.relname, pg_catalog.pg_get_indexdef(i.oid)
    FROM pg_catalog.pg_index idx JOIN pg_catalog.pg_class c ON c.oid = idx.indrelid
      JOIN pg_catalog.pg_class i ON i.oid = idx.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1::text[])
      AND NOT (n.nspname = 'public' AND c.relname = 'control_room_schema_migrations')
    UNION ALL
    SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
           pg_catalog.pg_get_functiondef(p.oid)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = ANY($1::text[]) AND p.prokind = 'f'
    UNION ALL
    SELECT 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, pg_catalog.pg_get_triggerdef(t.oid)
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1::text[]) AND NOT t.tgisinternal
  ) snapshot`;

/**
 * Is `quoted` a well-formed rendering of the identifier `name`, as PostgreSQL's
 * `format('%I')` produces it? Stated here ONLY to cross-check the server: the
 * name that reaches SQL is the server's own quoting, and this is the
 * independent second opinion that it is ONE identifier and nothing else.
 *
 * Exactly two renderings are accepted, and both are a single identifier by the
 * SQL grammar: the bare name when it is plain lower-case (`[a-z_][a-z0-9_]*`),
 * or the name in double quotes with every inner quote doubled. Which of the two
 * the server chose (it quotes keywords, upper case, punctuation, unicode) does
 * not matter for safety, so no keyword list is needed here — and a release can
 * therefore not block the backup by picking a name such a list happened to
 * miss. Anything else is a refusal, never a repair.
 */
export function isQuotedIdentifierV1(name, quoted) {
  if (typeof name !== "string" || typeof quoted !== "string" || name.length === 0 || name.includes("\0")
      || Buffer.byteLength(name) > 63)
    return false;
  if (quoted === name) return /^[a-z_][a-z0-9_]*$/u.test(name);
  return quoted === `"${name.replaceAll('"', '""')}"`;
}

/**
 * Refuse a reading login that holds any authority beyond reading.
 *
 * Run before the first catalog read on BOTH sides of the comparison. A reader
 * that is a superuser (the test fixture used to be one) is exactly the login a
 * C1-style payload turns into a shell, so it is refused even though the read
 * itself would work.
 */
export async function assertEvidenceReaderV1(client) {
  const { rows } = await client.query(extended(`SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles other
               WHERE other.oid <> r.oid
                 AND (other.rolsuper OR other.rolcreaterole OR other.rolcreatedb OR other.rolreplication)
                 AND pg_catalog.pg_has_role(r.oid, other.oid, 'MEMBER')) AS inherits_authority,
      EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.admin_option) AS can_grant
    FROM pg_catalog.pg_roles r WHERE r.rolname = pg_catalog.current_user()`));
  const row = rows[0];
  if (!row || row.rolsuper !== false || row.rolcreaterole !== false || row.rolcreatedb !== false
      || row.rolreplication !== false || row.inherits_authority !== false || row.can_grant !== false)
    throw updaterRefuseV1("updater_backup_evidence_reader_refused");
}

/**
 * Pin the reading session. Every setting is `SET` (session scope) so it holds
 * for every statement this client runs afterwards, including inside the
 * snapshot transaction the dump port opens.
 */
export async function pinEvidenceSessionV1(client) {
  await client.query("SET search_path = pg_catalog, pg_temp");
  await client.query("SET row_security = off");
  await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT_V1}'`);
  await client.query(`SET lock_timeout = '${LOCK_TIMEOUT_V1}'`);
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET idle_in_transaction_session_timeout = '3600s'");
}

/** The tables this evidence covers, each with its server-quoted qualified name. */
export async function evidenceTables(client) {
  const result = await client.query(extended(`SELECT n.nspname AS schema, c.relname AS name,
      pg_catalog.format('%I', n.nspname) AS quoted_schema, pg_catalog.format('%I', c.relname) AS quoted_name,
      pg_catalog.format('%I.%I', n.nspname, c.relname) AS qualified
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p')
      AND NOT (n.nspname = 'public' AND c.relname = 'control_room_schema_migrations')`, [[...EVIDENCE_SCHEMAS_V1]]));
  const tables = result.rows.map(row => {
    const schema = String(row.schema), name = String(row.name), qualified = String(row.qualified);
    if (!isQuotedIdentifierV1(schema, row.quoted_schema) || !isQuotedIdentifierV1(name, row.quoted_name)
        || qualified !== `${row.quoted_schema}.${row.quoted_name}`)
      throw updaterRefuseV1("updater_backup_evidence_name_refused");
    return Object.freeze({ schema, name, qualified });
  });
  // Sorted HERE, by UTF-16 code unit, rather than by the server's collation:
  // both sides of the comparison sort the same way whatever the two clusters'
  // locales are, so the arrays compare element by element.
  return tables.sort((left, right) => (left.qualified < right.qualified ? -1 : left.qualified > right.qualified ? 1 : 0));
}

/** The shape digest: stable across a `--no-owner` restore, and only about shape. */
export async function readShapeDigest(client) {
  const { rows } = await client.query(extended(SHAPE_SNAPSHOT, [[...EVIDENCE_SCHEMAS_V1]]));
  return `sha256:${sha256(JSON.stringify(rows[0].snapshot))}`;
}

/**
 * Per-table row counts, keyed by the server-quoted qualified name.
 *
 * The statement embeds the SERVER's quoting of the name, cross-checked above,
 * and is sent over the extended protocol with a bound parameter, so it is one
 * statement or it is a refusal. `count(*)` evaluates no column, so no type
 * output function, default or index expression of a release runs here, and
 * `row_security = off` (with a BYPASSRLS reader) means no policy expression does.
 */
export async function readRowCounts(client) {
  const tables = await evidenceTables(client);
  const counts = [];
  for (const table of tables) {
    const result = await client.query(extended(
      `SELECT pg_catalog.count(*)::bigint AS count FROM ${table.qualified} WHERE $1::boolean`, [true]));
    const count = Number(result.rows[0].count);
    if (!Number.isSafeInteger(count) || count < 0) throw updaterRefuseV1("updater_backup_evidence_refused");
    counts.push({ table: table.qualified, count });
  }
  return counts;
}

/**
 * Ownership, read from the source only.
 *
 * Recorded as evidence for the operator and for item 18's restore path, and
 * deliberately NOT compared against a `--no-owner` restore: the restore's
 * ownership is whatever role ran `pg_restore`, and the release's own
 * `restore-identity.mjs` reconciles it from the recorded membership instead.
 * Comparing it here would be comparing a dump against a provisioning decision.
 */
export async function readOwnership(client) {
  const result = await client.query(extended(`SELECT n.nspname || '.' || c.relname AS object,
      pg_catalog.pg_get_userbyid(c.relowner) AS owner
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p','v','m','S')
      AND NOT (n.nspname = 'public' AND c.relname = 'control_room_schema_migrations')
    ORDER BY 1`, [[...EVIDENCE_SCHEMAS_V1]]));
  return result.rows.map(row => ({ object: String(row.object), owner: String(row.owner) }));
}

/**
 * Everything one side of the comparison needs, read in one place.
 *
 * The reader is checked and the session pinned FIRST, on every call, so no
 * caller can reach a catalog read with an unpinned or over-privileged login.
 *
 * SEQUENTIALLY, not with `Promise.all`, and that is not a style choice. These
 * reads go over ONE `pg` client, and node-postgres serialises a client's
 * queries internally while ALSO warning loudly when two overlap:
 * "Calling client.query() when the client is already executing a query is
 * deprecated and will be removed in pg@9.0". Under concurrency the overlap is a
 * real interleave, not a warning, and this runs inside a nightly root process
 * where a query landing in the wrong order produces a wrong row count.
 */
export async function readDumpEvidence(client) {
  await pinEvidenceSessionV1(client);
  await assertEvidenceReaderV1(client);
  const shapeDigest = await readShapeDigest(client);
  const rowCounts = await readRowCounts(client);
  const ownership = await readOwnership(client);
  return { shapeDigest, rowCounts, ownership };
}
