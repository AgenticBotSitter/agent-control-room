-- OFFLINE TEMPLATE ONLY. Requires the reviewed coordinator role and pre-provisioned
-- pg-boss 12.30.0 feed queue. Does not create a queue, login, worker or retry policy.
-- pg-boss shares job tables: SQL grants are NOT row isolation between queue names.
-- The fixed feed adapter and canonical admission remain mandatory authority boundaries.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM control_room_queue.queue WHERE name='abs-feed-collection'
    AND policy='standard' AND partition=false AND retry_limit=0 AND dead_letter IS NULL AND notify=false) THEN
    RAISE EXCEPTION 'feed queue prerequisite mismatch';
  END IF;
END $$;
REVOKE ALL ON SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_room_queue FROM PUBLIC;
GRANT USAGE ON SCHEMA control_room_queue TO control_room_news_coordinator;
GRANT SELECT ON control_room_queue.version,control_room_queue.queue TO control_room_news_coordinator;
GRANT UPDATE(name) ON control_room_queue.queue TO control_room_news_coordinator;
GRANT SELECT,INSERT ON control_room_queue.job,control_room_queue.job_common TO control_room_news_coordinator;
COMMIT;
