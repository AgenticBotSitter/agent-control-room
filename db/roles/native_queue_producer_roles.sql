-- OFFLINE CANDIDATE ONLY: existing coordinator role and pre-provisioned pg-boss
-- 12.30.0 queue required. Never called by application startup. Real PG unqualified.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM control_room_queue.queue
    WHERE name='native-task-delivery' AND policy='standard' AND partition=false
      AND retry_limit=0 AND dead_letter IS NULL AND notify=false) THEN
    RAISE EXCEPTION 'native queue prerequisite mismatch';
  END IF;
END $$;
REVOKE ALL ON SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_room_queue FROM PUBLIC;
GRANT USAGE ON SCHEMA control_room_queue TO control_room_task_coordinator;
GRANT SELECT ON control_room_queue.version,control_room_queue.queue TO control_room_task_coordinator;
-- PostgreSQL row locking requires UPDATE privilege on at least one column.
GRANT UPDATE(name) ON control_room_queue.queue TO control_room_task_coordinator;
GRANT SELECT,INSERT ON control_room_queue.job,control_room_queue.job_common TO control_room_task_coordinator;
COMMIT;
