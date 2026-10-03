-- Revoke exactly what 0291 granted, and nothing else: the UNIQUE constraint on
-- control_room_schema_migrations.ledger_order, which 0291 added.
--
-- `db/setup/production_migration_ledger.sql` also declares the column UNIQUE,
-- and that file is NOT reverted: it is the definition a FRESH install gets from
-- its own CREATE TABLE, and a fresh install never applied 0291 and so has
-- nothing to reverse. Dropping the constraint here returns an existing
-- installation to exactly the pre-0291 state -- one migration, one position,
-- enforced only by the applier's own prefix check, which is what the ledger
-- looked like before this pair. It does not remove the only copy of that
-- property from a fresh install, because a fresh install's constraint came from
-- the setup file and this file has never run there.
--
-- Nothing else is touched: no row is deleted, renumbered or rewritten, no
-- privilege is changed, and no other constraint on the ledger is dropped. The
-- ledger's rows are the record of what ran.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE public.control_room_schema_migrations
  DROP CONSTRAINT IF EXISTS control_room_schema_migrations_ledger_order_key;