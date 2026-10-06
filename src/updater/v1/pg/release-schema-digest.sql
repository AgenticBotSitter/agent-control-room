-- The release schema's shape, as one row-returning statement, for the updater's
-- own schema digest.
--
-- WHY THIS IS A FILE AND NOT A STRING IN JAVASCRIPT. It must be the SAME TEXT as
-- the release's own `readPrivateWebSchemaDigest` query, and the only way to keep
-- two copies of a thirty-line catalog query identical over time is to make the
-- copy greppable and diffable — which a template literal inside a .mjs file is
-- not. This file is the artifact a reviewer diffs against the release when a
-- migration changes the schema, which is exactly the review that has to happen.
--
-- The text below the header is COPIED VERBATIM from that function, down to the
-- spacing around `=`. The equivalence test strips comments and collapses
-- whitespace before comparing, because SQL's meaning does not depend on either;
-- what it does not normalise is a single SQL token, so a dropped
-- `pg_catalog.` qualification or a changed `COLLATE` still fails the test. That
-- is the property that makes the duplication safe: not "someone was careful",
-- but "a divergence cannot reach a cluster".
--
-- WHY THE MIGRATION LEDGER IS EXCLUDED, AND BY OWNER. `control_room_schema_migrations`
-- is created by the bootstrap rather than by a migration, and it records DATA — a
-- row per applied file. A digest that included it would be a digest of how many
-- migrations have run rather than of the schema's shape, and it would move on
-- every apply. The exclusion is qualified by OWNER
-- (`control_room_schema_owner`) and not by name alone, so a look-alike table with
-- a different owner or a different relkind still changes the digest and is still
-- caught.
--
-- THE ORDER IS LOAD-BEARING. The caller digests `JSON.stringify(rows)` in the
-- order they arrive, so `ORDER BY kind COLLATE "C", name COLLATE "C"` is what
-- makes the same schema produce the same digest on every machine. Without the
-- collation the order would follow the server's locale.

WITH ledger AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='control_room_schema_migrations' AND c.relkind='r'
    AND pg_get_userbyid(c.relowner)='control_room_schema_owner')
SELECT * FROM (SELECT 'column' AS kind, c.relname || '.' || a.attname AS name,
  json_build_array(c.relkind,a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,
    pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,c.relrowsecurity,c.relforcerowsecurity)::text AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','S','f')
  AND c.oid IS DISTINCT FROM (SELECT oid FROM ledger)
UNION ALL SELECT 'constraint', c.relname || '.' || x.conname,
  json_build_array(pg_get_constraintdef(x.oid),x.convalidated)::text
FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  AND c.oid IS DISTINCT FROM (SELECT oid FROM ledger)
UNION ALL SELECT 'index', c.relname, pg_get_indexdef(c.oid)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='i'
  AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=c.oid AND i.indrelid=(SELECT oid FROM ledger))
UNION ALL SELECT 'trigger', c.relname || '.' || t.tgname,
  json_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND NOT t.tgisinternal
UNION ALL SELECT 'policy', c.relname || '.' || p.polname,
  json_build_array(p.polcmd,p.polpermissive,
    ARRAY(SELECT CASE r WHEN 0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(p.polroles) r ORDER BY 1),
    pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid))::text
FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
UNION ALL SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') manifest
ORDER BY kind COLLATE "C", name COLLATE "C"
