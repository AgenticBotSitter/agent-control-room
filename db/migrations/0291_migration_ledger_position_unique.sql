-- ONE LEDGER POSITION PER MIGRATION, for an installation that already exists.
--
-- `db/setup/production_migration_ledger.sql` now defines `ledger_order` as
-- UNIQUE. That definition is what a FRESH install gets, because the setup file
-- runs before any migration and its `CREATE TABLE IF NOT EXISTS` is the whole
-- definition. An EXISTING installation already has the table, so the setup
-- file's CREATE is a no-op there and the constraint would never arrive. This
-- migration is the one that adds it to a database that is already migrated.
--
-- WHY THIS WAS A REAL DEFECT AND NOT A COSMETIC ONE (rv-mr5o Finding 1,
-- confirmed on a real PostgreSQL 17 cluster). Two branches cut from the same
-- last shipped migration each add one migration above it. Each branch's ledger
-- is self-consistent -- `scripts/generate-migration-ledger.mjs` numbers the
-- sorted filenames sequentially -- but the MERGED ledger renumbers one of them,
-- because the merged sort interleaves the two new files. A database already
-- migrated from one branch's ledger then has an applied row at a position the
-- merged ledger gives to a DIFFERENT migration. Three existing checks in
-- `deploy/postgres/apply-migrations.mjs` each passed that state:
--
--   * the per-row validation looked each applied row up BY FILENAME, and the
--     renumbered file's own bytes had not changed;
--   * the gap check compared ORDER NUMBERS positionally and never filenames,
--     so two different migrations at one integer compared equal;
--   * `pending` was keyed by filename, so the renumbered file was correctly
--     pending -- and its DDL ran.
--
-- With no UNIQUE constraint the applier ran that DDL, COMMITTED it with its
-- ledger row, and wrote a SECOND row at the position the first row already
-- held. The run then failed on `migration_live_schema_drift`, because
-- `ORDER BY ledger_order DESC LIMIT 1` hit the tie and picked the stale row as
-- "the head". The half-applied schema and the duplicated position both
-- survived the run, and every later apply on that database was reading a ledger
-- that could not describe itself.
--
-- WHAT THIS MIGRATION DOES, IN ORDER, AND WHY THE ORDER IS THE POINT:
--
--   1. Refuse a ledger that already holds two rows at one position, IN PLAIN
--      WORDS, having changed nothing. `ALTER TABLE ... ADD CONSTRAINT` on such
--      a table would fail with `duplicate key value violates unique constraint`
--      -- a server message that names a constraint this database does not have
--      and says nothing about which migration is at fault. Worse, it is a
--      failure the operator cannot act on: they need to know that TWO of their
--      recorded migrations share a position, and which two.
--      So the check is a REFUSAL, and it happens first: an installation in that
--      state is an operator decision (restore the pre-upgrade backup, or work
--      out which row is the real one), not something a migration may guess at by
--      deleting a row. Deleting a row would erase the record of what ran, and the
--      two rows are genuinely indistinguishable from here.
--   2. Add the constraint otherwise, and only then. It takes a brief ACCESS
--      EXCLUSIVE lock, which the `lock_timeout` below bounds: this table is the
--      ledger and nothing writes to it except the applier.
--
-- NO ROW IS DELETED, RENUMBERED OR REWRITTEN BY THIS MIGRATION, in either arm.
-- A ledger is a record of what ran; a migration that edits one is destroying
-- evidence. The refusal arm leaves the operator's database exactly as it was.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Arm 0: the constraint is ALREADY THERE.
--
-- On a FRESH install `db/setup/production_migration_ledger.sql` has already
-- created the table with `ledger_order ... UNIQUE`, because that file runs
-- before any migration and its `CREATE TABLE` is the whole definition. So a
-- fresh install applies this migration to a table that already has the very
-- constraint it exists to add, and a bare `ADD CONSTRAINT` would fail there with
-- `relation "control_room_schema_migrations_ledger_order_key" already exists` --
-- which would make this migration UNAPPLICABLE to every fresh install.
--
-- The two arms are kept apart on purpose: a constraint that is already present
-- is this migration's own work, already done by the setup file, and it is
-- skipped. A DIFFERENT constraint that merely happens to cover the column is not
-- skipped, because the down file drops this constraint by name and a ledger left
-- with an unnamed equivalent would not be the state 0291 produced.
--
-- ONE BLOCK, NOT A BLOCK PLUS A STATEMENT.
--
-- The first version of this file had the two checks in a `DO` block and the
-- `ALTER TABLE` after it, with arm 0 doing `RETURN`. That is wrong in a way
-- only a real cluster shows: `RETURN` inside a `DO` block returns from the
-- block's anonymous function, NOT from the script, so the `ALTER TABLE` after it
-- ran anyway and a FRESH install failed with `relation
-- "control_room_schema_migrations_ledger_order_key" already exists` -- because
-- on a fresh install the setup file has already created the table with that
-- exact constraint. Measured on PostgreSQL 17 before this was fixed. The `ALTER`
-- is inside the block now, so `RETURN` really does skip it.
-- `cr_table` is NOT initialised in the DECLARE and is assigned by arm -1 below,
-- because a `'...'::regclass` cast in the declaration is evaluated BEFORE the
-- body and raises 42P01 on a database with no ledger table -- exactly the shape
-- arm -1 exists to handle. (A comment between DECLARE items is also not valid
-- PL/pgSQL; this line moved out of the block for that reason, measured.)
DO $cr_ledger_uniq$
DECLARE
  cr_shared record;
  cr_existing text;
  cr_table regclass;
BEGIN
  -- Arm -1: the LEDGER TABLE IS NOT HERE AT ALL.
  --
  -- Not a shape production ever runs in -- the applier creates the table before
  -- it applies any migration -- but a shape two shipped tools DO run: the schema
  -- digest is recomputed by replaying `db/migrations/*.sql` into a bare database
  -- (tests/audit-required-hashes.test.mjs, and the same method as the lead's
  -- cook-digest script), and neither applies
  -- `db/setup/production_migration_ledger.sql`. Without this arm, every one of
  -- those replays would stop at this file with `relation
  -- "control_room_schema_migrations" does not exist` -- which is a digest that
  -- cannot be recomputed at all, not a migration that correctly refused.
  --
  -- So a missing ledger table is a NO-OP here, and only that.
  cr_table := to_regclass('public.control_room_schema_migrations');
  IF cr_table IS NULL THEN
    RETURN;
  END IF;

  -- Arm 0: the constraint is ALREADY THERE.
  --
  -- On a FRESH install `db/setup/production_migration_ledger.sql` has already
  -- created the table with `ledger_order ... UNIQUE`: that file runs before any
  -- migration and its `CREATE TABLE` is the whole definition, and PostgreSQL
  -- names an inline `UNIQUE` `<table>_ledger_order_key` -- the same name this
  -- migration adds. So on a fresh install this migration's work is already done
  -- and the only correct thing to do is nothing.
  --
  -- Read from the CATALOG by COLUMN SET, not by name, so the arm cannot be
  -- fooled by a constraint covering a different column, and it is then compared
  -- BY NAME so that a differently-named unique over the same column is refused
  -- rather than skipped: the down file drops this constraint by name, and a
  -- ledger left holding an unnamed equivalent is not the state 0291 produced.
  SELECT c.conname INTO cr_existing
    FROM pg_constraint c
   WHERE c.conrelid = cr_table
     AND c.contype = 'u'
     AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                           WHERE attrelid = c.conrelid AND attname = 'ledger_order')]::smallint[]
   LIMIT 1;
  IF FOUND THEN
    IF cr_existing <> 'control_room_schema_migrations_ledger_order_key' THEN
      RAISE EXCEPTION 'ledger position is already UNIQUE under the name %, so the constraint 0291 adds (%%) is not what this ledger has; re-check this installation by hand -- this migration changed nothing.',
        cr_existing;
    END IF;
    RETURN;
  END IF;

  -- Arm 1: the ledger is already half-applied. Refused by name, with the
  -- position and both files, before any DDL on the table is attempted.
  SELECT c.ledger_order AS shared_order,
         array_agg(c.filename ORDER BY c.filename) AS shared_files
    INTO cr_shared
    FROM public.control_room_schema_migrations c
   GROUP BY c.ledger_order
  HAVING count(*) > 1
   ORDER BY c.ledger_order
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger position % is recorded by two migrations (%), so the unique position cannot be'
      ' added; this ledger was half-applied by an earlier upgrade, and which row is the real one is an'
      ' operator decision -- restore the pre-upgrade backup, or re-run with the collision renumbered so'
      ' the two sort to different positions. This migration changed nothing.', cr_shared.shared_order,
      cr_shared.shared_files;
  END IF;

  -- Arm 2: the ordinary case. A fresh install never reaches here (arm 0 returns),
  -- so this is the shape an EXISTING installation takes.
  ALTER TABLE public.control_room_schema_migrations
    ADD CONSTRAINT control_room_schema_migrations_ledger_order_key UNIQUE (ledger_order);
END $cr_ledger_uniq$;