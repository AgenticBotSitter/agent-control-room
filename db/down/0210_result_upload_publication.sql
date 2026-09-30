-- Down for 0210 only. It removes exactly what 0210 created and granted: the
-- publication table, its guard, and the two triggers it installed on 0206's
-- catalog tables. It touches nothing 0209 or 0211 added, and 0210 is the only
-- migration that ever installed those two triggers, so neither is recreated.
--
-- The role grants it revokes are the ones on control_result_publications. 0210
-- is also the migration that adds this table to
-- production_table_grants.sql's shared-role revokes, so giving the blanket grant
-- back is this file's job and not 0211's.
--
-- Nothing here depends on 0209, and 0211 references the catalog but not this
-- table, so a downgrade in the usual newest-first order is unambiguous.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_result_publications FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_result_publications FROM control_room_fleet_gateway';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_results') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_result_publications FROM control_room_native_results';
  END IF;
  -- Undo the shared-role revoke production_table_grants.sql performs for this
  -- table, one role at a time, exactly as the blanket grant was originally
  -- applied to them.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_application') THEN
    EXECUTE 'GRANT ALL ON control_result_publications TO control_room_application';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_reader') THEN
    EXECUTE 'GRANT SELECT ON control_result_publications TO control_room_reader';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_backup') THEN
    EXECUTE 'GRANT SELECT ON control_result_publications TO control_room_backup';
  END IF;
END $$;
-- 0210's triggers on 0206's tables come off first: a trigger cannot outlive the
-- migration that installed it.
DROP TRIGGER control_result_files_upload_stored_guard ON control_result_files;
DROP TRIGGER control_result_file_sets_published ON control_result_file_sets;
DROP TRIGGER control_result_publications_no_truncate ON control_result_publications;
DROP TRIGGER control_result_publications_no_delete ON control_result_publications;
DROP TRIGGER control_result_publications_no_update ON control_result_publications;
DROP TRIGGER control_result_publications_guard ON control_result_publications;
DROP INDEX control_result_publications_project;
DROP TABLE control_result_publications;
DROP FUNCTION guard_result_file_upload_stored();
DROP FUNCTION enforce_result_set_published();
DROP FUNCTION guard_result_publication_insert();
COMMIT;
