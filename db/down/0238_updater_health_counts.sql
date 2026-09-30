-- Reverses db/migrations/0238_updater_health_counts.sql and nothing else.
--
-- The up file created one function and granted EXECUTE on it. This revokes the
-- grant, drops the function, and asserts that no other object is left behind by
-- the reverse -- a down file that revoked something else, or left a grant
-- dangling, would be an upgrade that could not be rolled back the way it went up.

DO $$
DECLARE
  fn regprocedure := 'public.updater_health_counts()'::regprocedure;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = fn) THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'control_room_deployer') THEN
      REVOKE EXECUTE ON FUNCTION updater_health_counts() FROM control_room_deployer;
    END IF;
    DROP FUNCTION updater_health_counts();
  END IF;
END;
$$;

-- The reversal is complete when the function is gone from the catalog and holds
-- no EXECUTE grant for any role that outlived it. Checking it here is what turns
-- "the down file ran" into "the down file did its job".
DO $$
BEGIN
  IF to_regprocedure('public.updater_health_counts()') IS NOT NULL THEN
    RAISE EXCEPTION 'updater health count function survived its down migration' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_proc p ON p.oid = d.objid
      WHERE d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
        AND p.proname LIKE 'updater_health%') THEN
    RAISE EXCEPTION 'an updater_health object is still depended on' USING ERRCODE = '42501';
  END IF;
END;
$$;