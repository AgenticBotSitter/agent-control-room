-- Reverses 0272 exactly: the one partial index it created on
-- control_attempts. Nothing else changes -- no grant is revoked, no row is
-- touched, and no other index is dropped, so a rollback leaves the catalogue
-- exactly as it was before the migration ran.
--
-- Dropping it restores the pre-0272 behaviour: the Workers board scans
-- control_attempts once per worker, per LATERAL, which is slow but correct.
-- The read is not broken by the index being absent, so this file is safe to run
-- against a live installation.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DROP INDEX IF EXISTS idx_control_attempts_node_state_updated;
