BEGIN;
-- 0141 changes the meaning of a redeemed enrollment from a mutable owner row
-- to an append-only gateway fact. Recreating 0140's mutable authority boundary
-- would re-open the security finding, even on an empty installation, so this
-- downgrade is deliberately refused. Restore the pre-upgrade backup instead.
DO $$ BEGIN
  RAISE EXCEPTION 'fleet owner authority down migration refused: restore the pre-upgrade backup';
END $$;
COMMIT;
