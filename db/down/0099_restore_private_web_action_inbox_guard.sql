-- The guard closes an authority regression on a shared table. A rollback may
-- not silently reopen it; the parent function remains installed.
DO $$ BEGIN
  RAISE EXCEPTION '0099 down migration refused: private web action inbox guard is load-bearing';
END $$;
