-- M2 supervisor reconciliation. The watchdog may act only on these durable
-- database records and the canonical task rows they name. Process discovery,
-- stdout inspection and filesystem guesses are deliberately not represented.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_supervisor_task_heads (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  project_id text NOT NULL,
  lapse_count integer NOT NULL CHECK (lapse_count BETWEEN 0 AND 2),
  last_attempt_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','needs_attention','uncertain')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,job_id),
  FOREIGN KEY (tenant_id,job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,last_attempt_id,job_id)
    REFERENCES control_attempts(tenant_id,id,job_id) ON DELETE RESTRICT
);

CREATE TABLE control_supervisor_reconciliation_events (
  id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  lease_id text NOT NULL,
  node_id text NOT NULL,
  lapse_number integer NOT NULL CHECK (lapse_number BETWEEN 1 AND 2),
  disposition text NOT NULL CHECK (disposition IN ('queued','needs_attention','uncertain')),
  safe_reason_code text NOT NULL CHECK (safe_reason_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$'),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,attempt_id),
  FOREIGN KEY (tenant_id,job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id,job_id,node_id)
    REFERENCES control_attempts(tenant_id,id,job_id,node_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,lease_id,job_id,attempt_id,node_id)
    REFERENCES control_leases(tenant_id,id,job_id,attempt_id,node_id) ON DELETE RESTRICT
);

CREATE TABLE control_supervisor_agent_health (
  tenant_id text NOT NULL,
  worker_id text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$'),
  node_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('healthy','suspect')),
  safe_reason_code text CHECK (safe_reason_code IS NULL OR safe_reason_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$'),
  last_heartbeat_at timestamptz,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,worker_id),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((state='healthy' AND safe_reason_code IS NULL)
    OR (state='suspect' AND safe_reason_code IS NOT NULL))
);

CREATE FUNCTION reject_supervisor_reconciliation_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'supervisor reconciliation history is append only'; END $$;
REVOKE ALL ON FUNCTION public.reject_supervisor_reconciliation_event_mutation() FROM PUBLIC;
CREATE TRIGGER control_supervisor_reconciliation_events_immutable
  BEFORE UPDATE OR DELETE ON control_supervisor_reconciliation_events
  FOR EACH ROW EXECUTE FUNCTION reject_supervisor_reconciliation_event_mutation();
CREATE TRIGGER control_supervisor_reconciliation_events_no_truncate
  BEFORE TRUNCATE ON control_supervisor_reconciliation_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_supervisor_reconciliation_event_mutation();

CREATE INDEX control_supervisor_task_heads_attention
  ON control_supervisor_task_heads(tenant_id,state,updated_at DESC);
CREATE INDEX control_supervisor_agent_health_suspect
  ON control_supervisor_agent_health(tenant_id,observed_at DESC) WHERE state='suspect';

REVOKE ALL ON control_supervisor_task_heads, control_supervisor_reconciliation_events,
  control_supervisor_agent_health FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT, INSERT ON control_supervisor_task_heads, control_supervisor_reconciliation_events, control_supervisor_agent_health TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (lapse_count,last_attempt_id,state,updated_at) ON control_supervisor_task_heads TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (node_id,state,safe_reason_code,last_heartbeat_at,observed_at) ON control_supervisor_agent_health TO control_room_task_coordinator';
  END IF;
END $$;
