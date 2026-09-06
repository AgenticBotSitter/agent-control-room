-- OFFLINE CANDIDATE SETUP ONLY; never executed by application startup.
-- Rehearsed with pg-boss 12.30.0 on PGlite, NOT accepted on real PostgreSQL.
-- Requires a separately provisioned, dedicated control_room_queue schema and the
-- fixed non-partitioned native-task-delivery queue. Fresh NOLOGIN role only.
-- Does not create a LOGIN, queue, schema, database or grant canonical task access.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM control_room_queue.queue
    WHERE name='native-task-delivery' AND policy='standard' AND partition=false
      AND retry_limit=0 AND dead_letter IS NULL AND notify=false
  ) THEN
    RAISE EXCEPTION 'native queue prerequisite mismatch';
  END IF;
END $$;
CREATE ROLE control_room_native_queue_worker NOLOGIN INHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_room_queue FROM PUBLIC;
GRANT USAGE ON SCHEMA control_room_queue TO control_room_native_queue_worker;
GRANT SELECT ON control_room_queue.version,control_room_queue.queue
  TO control_room_native_queue_worker;
-- Failure settlement uses DELETE + INSERT even with retry_limit=0. These grants
-- authorize operational-row maintenance, not execution of the described task.
GRANT SELECT,INSERT,UPDATE,DELETE ON control_room_queue.job,control_room_queue.job_common
  TO control_room_native_queue_worker;
COMMIT;
