-- S8 honest provider waits. These rows say only that a provider-side wait was
-- observed and when it may be retried; they are not execution authority.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_provider_waits (
  tenant_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  node_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('out_of_usage','rate_limited','provider_down')),
  state text NOT NULL CHECK (state IN ('waiting','released')),
  retry_after timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,attempt_id),
  FOREIGN KEY (tenant_id,job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id,job_id,node_id)
    REFERENCES control_attempts(tenant_id,id,job_id,node_id) ON DELETE RESTRICT,
  CHECK (retry_after>observed_at),
  CHECK ((state='waiting' AND released_at IS NULL)
    OR (state='released' AND released_at IS NOT NULL AND released_at>=observed_at))
);

CREATE FUNCTION guard_provider_wait_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.state<>'waiting' OR NEW.state<>'released' OR NEW.released_at IS NULL
    OR (to_jsonb(NEW)-ARRAY['state','released_at'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','released_at']) THEN
    RAISE EXCEPTION 'provider wait update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_provider_wait_update() FROM PUBLIC;
CREATE TRIGGER control_provider_waits_guard BEFORE UPDATE ON control_provider_waits
  FOR EACH ROW EXECUTE FUNCTION guard_provider_wait_update();
CREATE TRIGGER control_provider_waits_no_delete BEFORE DELETE ON control_provider_waits
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_provider_waits_no_truncate BEFORE TRUNCATE ON control_provider_waits
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE INDEX control_provider_waits_due
  ON control_provider_waits(tenant_id,retry_after,id) WHERE state='waiting';

REVOKE ALL ON control_provider_waits FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT, INSERT ON control_provider_waits TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (state,released_at) ON control_provider_waits TO control_room_task_coordinator';
  END IF;
END $$;
