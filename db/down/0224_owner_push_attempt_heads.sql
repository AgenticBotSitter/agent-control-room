-- Reverses ONLY what 0224 created. The grants of 0226 are revoked by 0226's own
-- down file, which runs first, so this drop cannot be refused by a grant still
-- standing.
--
-- Refuses while any row exists: the table is a delivery ledger, and dropping it
-- would erase the record that proves which owner attention items have already
-- been pushed. A silent loss of that record is exactly how a stall gets alerted
-- about twice, so it is an operator decision, not a downgrade.
BEGIN;
LOCK TABLE control_owner_push_attempt_heads IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_owner_push_attempt_heads) THEN
    RAISE EXCEPTION 'owner push attempt heads down migration refused: delivery records exist';
  END IF;
END $$;
DROP TABLE control_owner_push_attempt_heads;
COMMIT;
