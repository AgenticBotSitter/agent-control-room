-- M2 machine and loop health observations. Measurements are evidence only;
-- pausing admission remains a separately composed server-side operation.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_supervisor_loop_heads (
  tenant_id text NOT NULL,
  supervisor_id text NOT NULL CHECK (supervisor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$'),
  version bigint NOT NULL CHECK (version >= 1),
  last_started_at timestamptz NOT NULL,
  last_completed_at timestamptz,
  state text NOT NULL CHECK (state IN ('starting','healthy','unhealthy')),
  PRIMARY KEY (tenant_id,supervisor_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CHECK (last_completed_at IS NULL OR last_completed_at>=last_started_at)
);

CREATE TABLE control_supervisor_health_observations (
  id text NOT NULL,
  tenant_id text NOT NULL,
  supervisor_id text NOT NULL,
  loop_version bigint NOT NULL CHECK (loop_version >= 1),
  host_alive boolean NOT NULL,
  loop_alive boolean NOT NULL,
  shared_memory_segments integer CHECK (shared_memory_segments IS NULL OR shared_memory_segments >= 0),
  load_one_minute double precision CHECK (load_one_minute IS NULL OR load_one_minute >= 0),
  state text NOT NULL CHECK (state IN ('healthy','unhealthy')),
  safe_reason_codes jsonb NOT NULL CHECK (jsonb_typeof(safe_reason_codes)='array'),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,supervisor_id,loop_version),
  FOREIGN KEY (tenant_id,supervisor_id)
    REFERENCES control_supervisor_loop_heads(tenant_id,supervisor_id) ON DELETE RESTRICT
);

CREATE FUNCTION reject_supervisor_health_observation_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'supervisor health observations are append only'; END $$;
REVOKE ALL ON FUNCTION public.reject_supervisor_health_observation_mutation() FROM PUBLIC;
CREATE TRIGGER control_supervisor_health_observations_immutable
  BEFORE UPDATE OR DELETE ON control_supervisor_health_observations
  FOR EACH ROW EXECUTE FUNCTION reject_supervisor_health_observation_mutation();
CREATE TRIGGER control_supervisor_health_observations_no_truncate
  BEFORE TRUNCATE ON control_supervisor_health_observations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_supervisor_health_observation_mutation();

CREATE INDEX control_supervisor_health_unhealthy
  ON control_supervisor_health_observations(tenant_id,observed_at DESC) WHERE state='unhealthy';

REVOKE ALL ON control_supervisor_loop_heads, control_supervisor_health_observations FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT, INSERT ON control_supervisor_loop_heads, control_supervisor_health_observations TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (version,last_started_at,last_completed_at,state) ON control_supervisor_loop_heads TO control_room_task_coordinator';
    EXECUTE 'GRANT SELECT ON control_service_incident_heads, control_service_incidents TO control_room_task_coordinator';
    EXECUTE 'GRANT INSERT (tenant_id,correlation_key) ON control_service_incident_heads TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (next_generation) ON control_service_incident_heads TO control_room_task_coordinator';
    EXECUTE 'GRANT INSERT (id,tenant_id,correlation_key,generation,service_id,severity,safe_reason_code,safe_remedy_code,state,opened_at,last_observed_at) ON control_service_incidents TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (severity,safe_reason_code,safe_remedy_code,state,last_observed_at,resolved_at) ON control_service_incidents TO control_room_task_coordinator';
  END IF;
END $$;
