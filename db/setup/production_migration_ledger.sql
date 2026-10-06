-- Production migration ledger. Applied exactly once per migration file by
-- deploy/postgres/apply-migrations.mjs inside the same transaction as the file.
-- db/migrations/*.sql contents are read-only inputs; this table is the only
-- production schema object owned by the #63 package (DDL lives here, not there).
--
-- ledger_order IS UNIQUE, and that is the load-bearing part of this table's
-- definition. It makes "one migration, one ledger position" a property of the
-- DATABASE rather than a convention the applier is trusted to keep.
--
-- WHY. Two branches cut from the same last shipped migration each add one file
-- above it. Each branch's own ledger is consistent -- `scripts/generate-migration-ledger.mjs`
-- numbers the sorted filenames sequentially -- but the MERGED ledger renumbers
-- one of them, because the merged sort interleaves the two new files. A
-- database already migrated from one branch's ledger then has an applied row at
-- a position the merged ledger gives to a DIFFERENT migration, and the applier's
-- per-row check (by filename) and gap check (by integer) each pass that state.
-- Measured on a real PostgreSQL 17 cluster against the real applier before this
-- constraint existed (rv-mr5o Finding 1): the colliding migration's DDL ran,
-- committed, and wrote a SECOND row at the position the first row already held,
-- and the run only then failed with `migration_live_schema_drift` -- because
-- `ORDER BY ledger_order DESC LIMIT 1` hit the tie and picked the stale row as
-- "the head". The half-applied schema and the duplicated position both survived
-- the run.
--
-- WITH THE CONSTRAINT the same collision is refused by the server inside the
-- transaction that carries the migration, so the DDL and the row roll back
-- together and the failure names a duplicate key rather than a ledger that has
-- stopped describing itself. `deploy/postgres/apply-migrations.mjs` ALSO refuses
-- the position BEFORE it runs any file, so the operator's refusal names the
-- position, the applied file and the new one instead of a constraint. The
-- constraint is the floor; the applier check is the readable message.
--
-- An existing installation that already holds two rows at one position cannot
-- take this constraint, and `ALTER TABLE ... ADD CONSTRAINT` would fail halfway
-- having changed nothing. That is what 0291 is for: it refuses such an
-- installation in plain words and leaves it untouched.
CREATE TABLE IF NOT EXISTS control_room_schema_migrations (
  filename text PRIMARY KEY CHECK (filename ~ '^[0-9]{4}_[a-z0-9_]+\.sql$|^db/'),
  digest text NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  ledger_order integer NOT NULL CHECK (ledger_order >= 1) UNIQUE,
  pre_schema_digest text NOT NULL CHECK (pre_schema_digest ~ '^sha256:[a-f0-9]{64}$'),
  post_schema_digest text NOT NULL CHECK (post_schema_digest ~ '^sha256:[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON control_room_schema_migrations FROM PUBLIC;
