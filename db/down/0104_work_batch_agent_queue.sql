BEGIN;
LOCK TABLE work_batch_items, work_batch_agent_queue_heads, work_batch_queue_admissions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM work_batch_agent_queue_heads)
    OR EXISTS (SELECT 1 FROM work_batch_queue_admissions)
    OR EXISTS (SELECT 1 FROM work_batch_items WHERE requested_worker_id IS NOT NULL) THEN
    RAISE EXCEPTION 'work batch agent queue down migration refused: records exist';
  END IF;
END $$;
DROP VIEW work_batch_effective_queue_admissions;
DROP POLICY work_batch_queue_admissions_work_intake_scope ON work_batch_queue_admissions;
DROP POLICY work_batch_queue_admissions_existing_access ON work_batch_queue_admissions;
DROP POLICY work_batch_agent_queue_heads_work_intake_scope ON work_batch_agent_queue_heads;
DROP POLICY work_batch_agent_queue_heads_existing_access ON work_batch_agent_queue_heads;
DROP TRIGGER work_batch_agent_queue_heads_consistency ON work_batch_agent_queue_heads;
DROP FUNCTION enforce_work_batch_agent_queue_head_consistency();
DROP TRIGGER work_batch_queue_admissions_no_truncate ON work_batch_queue_admissions;
DROP TRIGGER work_batch_queue_admissions_append_only ON work_batch_queue_admissions;
DROP TRIGGER work_batch_queue_admissions_guard ON work_batch_queue_admissions;
DROP FUNCTION guard_work_batch_queue_admission_insert();
DROP TABLE work_batch_queue_admissions;
DROP TRIGGER work_batch_agent_queue_heads_no_truncate ON work_batch_agent_queue_heads;
DROP TRIGGER work_batch_agent_queue_heads_no_delete ON work_batch_agent_queue_heads;
DROP TRIGGER work_batch_agent_queue_heads_guard ON work_batch_agent_queue_heads;
DROP FUNCTION guard_work_batch_agent_queue_head_write();
DROP TABLE work_batch_agent_queue_heads;
ALTER TABLE work_batch_items DROP COLUMN requested_worker_id;
COMMIT;
