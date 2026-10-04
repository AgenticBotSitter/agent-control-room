// The schema digest the migration LEDGER records, and the one every consumer
// of that ledger recomputes. High 1 of the M1b review.
//
// WHAT WAS WRONG. The phase wrote `pre_schema_digest`/`post_schema_digest` with
// the RELEASE-SCHEMA query (`release-schema-digest.sql`, the health check's
// digest), and all three readers of those columns recompute them with
// `deploy/postgres/evidence.mjs` `readSchemaDigest` — a different query,
// serialised client-side:
//
//   - `apply-migrations.mjs` compares the live digest with the head row's
//     `post_schema_digest` and refuses `migration_live_schema_drift`;
//   - `database-upgrade-vps-step.mjs` refuses `upgrade_schema_drift_refused`;
//   - `private-postgres-owner-runner.ts` requires `post[last]` = the live digest.
//
// MEASURED (probe C2): ledger head `sha256:9378b2ed…`, `readSchemaDigest`
// `sha256:6b2fe9a3…`. So the first upgrade after install would have refused a
// cluster this phase had just built.
//
// WHAT THIS IS. `readSchemaDigest` runs `SCHEMA_SNAPSHOT` (below, copied
// VERBATIM — the template literal's source text, escapes included, is asserted
// equal to evidence.mjs's in the lane) and hashes `JSON.stringify(rows[0].snapshot)`,
// where `snapshot` is the `jsonb` array node-postgres hands back parsed. The ledger
// needs the same value INSIDE the migration's own transaction, server-side, so
// the serialisation is rebuilt in SQL:
//
//   - the snapshot is an array of FLAT objects whose values are strings or null;
//   - `JSON.stringify` of the parsed value is the compact form: no spaces, keys in
//     the order `jsonb` stores them (`jsonb_each` yields that order, and it is the
//     order `jsonb` prints and therefore the order `JSON.parse` sees);
//   - a `jsonb` string value's text form is escaped exactly as `JSON.stringify`
//     escapes (`\"`, `\\`, `\b\f\n\r\t`, other control characters as
//     lowercase `\u00xx`, everything else raw UTF-8), so `value::text` is reused;
//   - anything else (a nested value) RAISES — the cast of
//     `'schema_snapshot_value_refused:<type>'` to int fails with that text — rather
//     than being hashed in a form the client would serialise differently.
//
// The real-PostgreSQL lane asserts `readSchemaDigest(client) === post_schema_digest`
// of the head row on a cluster the phase built, which is the property itself.

export const SCHEMA_SNAPSHOT_SQL_V1 = `
  SELECT coalesce(jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.kind, snapshot.name, snapshot.detail), '[]'::jsonb) AS snapshot
  FROM (
    SELECT 'table' AS kind, n.nspname || '.' || c.relname AS name, pg_get_userbyid(c.relowner) AS detail
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname, format_type(a.atttypid, a.atttypmod)
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    SELECT 'constraint', n.nspname || '.' || c.relname || '.' || con.conname,
           CASE WHEN con.contype = 'c' THEN 'check:' || con.contype::text || '|key:' || array_to_string(con.conkey, ',') || '|expr:' || regexp_replace(regexp_replace(regexp_replace(pg_get_expr(con.conbin, con.conrelid), '\s', '', 'g'), '[()]', '', 'g'), '::', '.', 'g')
                ELSE 'def:' || pg_get_constraintdef(con.oid) END
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    SELECT 'index', n.nspname || '.' || c.relname || '.' || i.relname, pg_get_indexdef(i.oid)
    FROM pg_index idx JOIN pg_class c ON c.oid = idx.indrelid JOIN pg_class i ON i.oid = idx.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    -- Functions and triggers: these enforce the security-critical protections
    -- (e.g. INSERT/SELECT policies, integrity triggers, immutability). A schema
    -- digest that omits them cannot prove that the restored database actually
    -- enforces its claimed protections — a restore that drops a trigger would
    -- otherwise compare equal against a backup that included it.
    SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
    UNION ALL
    SELECT 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ) snapshot`;

/**
 * A scalar SQL expression whose value is exactly `readSchemaDigest(client)`:
 * `'sha256:' || hex(sha256(JSON.stringify(snapshot)))`, computed by the server.
 */
export function schemaSnapshotDigestExpressionV1() {
  return `(SELECT 'sha256:' || encode(sha256(convert_to('[' || coalesce((
    SELECT string_agg('{' || coalesce((
      SELECT string_agg(to_json(field.key)::text || ':' || CASE
          WHEN jsonb_typeof(field.value) IN ('string', 'null') THEN field.value::text
          ELSE ('schema_snapshot_value_refused:' || jsonb_typeof(field.value))::int::text END,
        ',' ORDER BY field.ordinality)
      FROM jsonb_each(element.value) WITH ORDINALITY AS field(key, value, ordinality)), '') || '}',
      ',' ORDER BY element.ordinality)
    FROM jsonb_array_elements(cr_snapshot.snapshot) WITH ORDINALITY AS element(value, ordinality)), '') || ']',
    'UTF8')), 'hex')
  FROM (${SCHEMA_SNAPSHOT_SQL_V1}) AS cr_snapshot)`;
}
