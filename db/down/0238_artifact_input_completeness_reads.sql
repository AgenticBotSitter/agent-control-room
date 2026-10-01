-- Revoke exactly what 0238 granted, and nothing else: the SELECT the coordinator
-- and the news coordinator hold on the two combine-input tables, so that
-- 0211's BEFORE UPDATE guard on control_jobs stops being satisfiable and those
-- logins can no longer move a job into 'ready' or 'running'. That is the
-- pre-0238 behaviour, which is the point: 0211's trigger was unreachable for
-- these roles before 0238 and the failure it caused was invisible.
--
-- No other privilege on these tables, and no other role, is touched. The role
-- files keep granting the read, so re-applying 0238 (or upgrading forward
-- again) restores it -- the down file reverses one migration, it does not
-- rewrite the authoritative statement.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE SELECT ON control_task_declared_inputs, control_job_artifact_inputs FROM control_room_task_coordinator';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_news_coordinator') THEN
    EXECUTE 'REVOKE SELECT ON control_task_declared_inputs, control_job_artifact_inputs FROM control_room_news_coordinator';
  END IF;
END $$;
