BEGIN;
LOCK TABLE work_batches, work_batch_revisions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM work_batches) OR EXISTS (SELECT 1 FROM work_batch_revisions) THEN
    RAISE EXCEPTION 'work batch intake down migration refused: records exist';
  END IF;
END $$;
DROP TRIGGER work_batch_revisions_truncate_guard ON work_batch_revisions;
DROP TRIGGER work_batch_revisions_append_only ON work_batch_revisions;
DROP TRIGGER work_batch_revisions_initial_only ON work_batch_revisions;
DROP TRIGGER work_batches_proposal_only ON work_batches;
DROP TABLE work_batch_revisions;
DROP TABLE work_batches;
DROP FUNCTION guard_initial_work_batch_revision_insert();
DROP FUNCTION guard_proposal_only_work_batch_insert();
COMMIT;
