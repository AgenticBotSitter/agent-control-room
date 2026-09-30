BEGIN;
LOCK TABLE work_batch_split_suggestions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM work_batch_split_suggestions) THEN
    RAISE EXCEPTION 'work batch split suggestion down migration refused: records exist';
  END IF;
END $$;
-- Only what 0200 granted, and only from roles that exist here.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT ON work_batch_current_split_suggestions FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_work_intake') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON work_batch_split_suggestions FROM control_room_work_intake';
  END IF;
END $$;
DROP VIEW work_batch_current_split_suggestions;
DROP POLICY work_batch_split_suggestions_work_intake_scope ON work_batch_split_suggestions;
DROP POLICY work_batch_split_suggestions_existing_access ON work_batch_split_suggestions;
DROP TRIGGER work_batch_split_suggestions_replay_conflict ON work_batch_split_suggestions;
DROP TRIGGER work_batch_split_suggestions_no_truncate ON work_batch_split_suggestions;
DROP TRIGGER work_batch_split_suggestions_append_only ON work_batch_split_suggestions;
DROP TRIGGER work_batch_split_suggestions_guard ON work_batch_split_suggestions;
DROP FUNCTION guard_work_batch_split_suggestion_replay_conflict();
DROP FUNCTION guard_work_batch_split_suggestion_insert();
DROP TABLE work_batch_split_suggestions;
-- The key 0200 added and nothing else uses.
ALTER TABLE work_batch_revisions DROP CONSTRAINT work_batch_revisions_batch_revision_digest_key;
COMMIT;
