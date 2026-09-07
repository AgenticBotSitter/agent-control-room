-- OFFLINE CANDIDATE: apply only after native_queue_producer_roles.sql and explicit
-- recovery review. No startup execution or production acceptance. pg-boss 12.30.0.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM control_room_queue.queue
    WHERE name='native-task-delivery' AND policy='standard' AND partition=false
      AND retry_limit=0 AND dead_letter IS NULL AND notify=false) THEN
    RAISE EXCEPTION 'native queue prerequisite mismatch';
  END IF;
END $$;
-- Public retry/update mention these columns even when preserving their values.
-- No table-wide UPDATE, identity/retry_count change, DELETE, DDL or worker
-- canonical privileges. The trusted adapter still supplies only retryLimit:0.
GRANT UPDATE(state,completed_on,data,priority,start_after,keep_until,expire_seconds,
  deletion_seconds,retry_limit,retry_delay,retry_backoff,retry_delay_max,dead_letter,
  heartbeat_seconds,group_id,group_tier)
  ON control_room_queue.job,control_room_queue.job_common TO control_room_task_coordinator;
COMMIT;
