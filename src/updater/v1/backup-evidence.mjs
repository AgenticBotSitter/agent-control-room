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
//   * every object in `public` (tables, columns, constraints, indexes, triggers
//     and functions) by their definition text, with ownership excluded;
//   * the per-table row counts;
//   * the ownership, read from the SOURCE only and recorded as evidence, since
//     ownership is restored by provisioning roles and is not in the dump.
//
// The column/constraint/index/trigger/function rows are the same shapes the
// release digest uses, taken verbatim so the two stay comparable, with the
// owner stripped from the table row. A digest is over definitions rather than
// over the objects themselves so it is stable across a restore.

import { createHash } from "node:crypto";

const sha256 = text => createHash("sha256").update(text).digest("hex");

/**
 * The same object set as the release's SCHEMA_SNAPSHOT, with ownership removed.
 *
 * Written out rather than derived from the release's constant because the
 * release's is a module-private string that already folds in `pg_get_userbyid`,
 * and editing a shared constant to suit a restore path would change what
 * `backup-database.mjs` records for every operator. Two definitions that are
 * meant to be the same shape is a drift risk, so `tests/updater-backup-contract.test.mjs`
 * asserts that this file's object kinds match the release's, and the lane proves
 * on a real round trip that a dump and its restore agree.
 */
const SHAPE_SNAPSHOT = `
  SELECT coalesce(jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.kind, snapshot.name, snapshot.detail), '[]'::jsonb)
    AS snapshot
  FROM (
    SELECT 'table' AS kind, n.nspname || '.' || c.relname AS name, c.relpersistence::text AS detail
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname, format_type(a.atttypid, a.atttypmod)
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    SELECT 'constraint', n.nspname || '.' || c.relname || '.' || con.conname,
           CASE WHEN con.contype = 'c' THEN 'check:' || con.contype::text || '|key:' || array_to_string(con.conkey, ',') || '|expr:' || regexp_replace(regexp_replace(regexp_replace(pg_get_expr(con.conbin, con.conrelid), '\\s', '', 'g'), '[()]', '', 'g'), '::', '.', 'g')
                ELSE 'def:' || pg_get_constraintdef(con.oid) END
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    SELECT 'index', n.nspname || '.' || c.relname || '.' || i.relname, pg_get_indexdef(i.oid)
    FROM pg_index idx JOIN pg_class c ON c.oid = idx.indrelid JOIN pg_class i ON i.oid = idx.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
    UNION ALL
    SELECT 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ) snapshot`;

/** The tables this evidence covers: every ordinary table in `public`. */
export async function evidenceTables(client) {
  const result = await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname <> 'control_room_schema_migrations'
    ORDER BY c.relname`);
  return result.rows.map(row => String(row.relname));
}

/** The shape digest: stable across a `--no-owner` restore, and only about shape. */
export async function readShapeDigest(client) {
  const { rows } = await client.query(SHAPE_SNAPSHOT);
  return `sha256:${sha256(JSON.stringify(rows[0].snapshot))}`;
}

/** Per-table row counts, sorted by table name so the arrays compare directly. */
export async function readRowCounts(client) {
  const tables = await evidenceTables(client);
  const counts = [];
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::bigint AS count FROM public."${table}"`);
    counts.push({ table, count: Number(result.rows[0].count) });
  }
  return counts;
}

/**
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
  const result = await client.query(`SELECT n.nspname || '.' || c.relname AS object,
      pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
      AND c.relname <> 'control_room_schema_migrations'
    ORDER BY 1`);
  return result.rows.map(row => ({ object: String(row.object), owner: String(row.owner) }));
}

/**
 * Everything one side of the comparison needs, read in one place.
 *
 * SEQUENTIALLY, not with `Promise.all`, and that is not a style choice. These
 * four reads go over ONE `pg` client, and node-postgres serialises a client's
 * queries internally while ALSO warning loudly when two overlap:
 * "Calling client.query() when the client is already executing a query is
 * deprecated and will be removed in pg@9.0". Under concurrency the overlap is a
 * real interleave, not a warning, and this runs inside a nightly root process
 * where a query landing in the wrong order produces a wrong row count. Measured:
 * the deprecation warning fires on the very first call.
 *
 * The alternative — a client pool for the evidence read — would be the right
 * answer for throughput and is not needed here: the read is a few catalog
 * queries once a night, and the shape digest is a consistent-state read rather
 * than a throughput-sensitive one.
 */
export async function readDumpEvidence(client) {
  const shapeDigest = await readShapeDigest(client);
  const rowCounts = await readRowCounts(client);
  const ownership = await readOwnership(client);
  return { shapeDigest, rowCounts, ownership };
}
