-- S7b: the machine ceiling's one honest gap. Agent processes are countable in
-- the database (live harness runs). Database clusters are not: a cluster is a
-- host-level postmaster, invisible to SQL, and the known leak is an unknown
-- number of them. So the owner reports that number alongside their ceilings,
-- the coordinator enforces it, and an observation that is missing or stale
-- refuses rather than passing silently. No system guesses it, and no agent or
-- harness can write it.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE pipeline_machine_capacity_observations (
  id text NOT NULL,
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  -- Only the owner reports this. Nothing derives it from a guess.
  source text NOT NULL CHECK (source = 'owner_reported'),
  db_clusters integer NOT NULL CHECK (db_clusters >= 0),
  observed_at timestamptz NOT NULL,
  -- Two observations may not claim the same instant, so "the latest" is total.
  UNIQUE (tenant_id, workspace_id, observed_at),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX pipeline_machine_capacity_observations_latest
  ON pipeline_machine_capacity_observations(tenant_id, workspace_id, observed_at DESC, id);

-- Append-only: a count is evidence about one moment, and rewriting it would
-- destroy the history the ceiling is judged against.
CREATE TRIGGER pipeline_machine_capacity_observations_immutable
  BEFORE UPDATE OR DELETE ON public.pipeline_machine_capacity_observations
  FOR EACH ROW EXECUTE FUNCTION public.reject_pipeline_unattended_history_mutation();
CREATE TRIGGER pipeline_machine_capacity_observations_no_truncate
  BEFORE TRUNCATE ON public.pipeline_machine_capacity_observations
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_pipeline_unattended_history_mutation();

REVOKE ALL ON pipeline_machine_capacity_observations FROM PUBLIC;

-- No shared login is granted this table. If one ever is, the work-intake
-- session must still see and write only its bound tenant, as 0104, 0108 and
-- 0109 confine their tables.
ALTER TABLE pipeline_machine_capacity_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY pipeline_machine_capacity_observations_existing_access ON pipeline_machine_capacity_observations
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY pipeline_machine_capacity_observations_work_intake_scope ON pipeline_machine_capacity_observations
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session() OR
    pipeline_machine_capacity_observations.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b))
  WITH CHECK (NOT public.is_work_intake_session() OR
    pipeline_machine_capacity_observations.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b));

-- Existing installations already have these NOLOGIN roles. Keep the upgrade
-- grant as narrow as the fresh-install role files: the owner reports, the
-- coordinator only reads.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT, INSERT ON pipeline_machine_capacity_observations TO control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT ON pipeline_machine_capacity_observations TO control_room_task_coordinator';
  END IF;
END $$;
