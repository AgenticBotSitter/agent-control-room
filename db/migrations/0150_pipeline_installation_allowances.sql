-- S7b: the one installation allowance record. It is the only place the owner
-- sets how much unattended work this installation may start, and it is read in
-- the SAME transaction as the advance receipt that claims a run.
-- No trigger, scheduler, provider invocation, merge or external effect is added.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE pipeline_installation_allowances (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL,
  -- Counted runs, never tokens and never dollars. Zero is a real ceiling: it
  -- stops this installation, it never means "unset".
  runs_per_hour integer NOT NULL DEFAULT 6 CHECK (runs_per_hour BETWEEN 0 AND 10000),
  runs_per_agent_per_day integer NOT NULL DEFAULT 12 CHECK (runs_per_agent_per_day BETWEEN 0 AND 10000),
  machine_max_agent_processes integer NOT NULL DEFAULT 12 CHECK (machine_max_agent_processes BETWEEN 0 AND 4096),
  machine_max_db_clusters integer NOT NULL DEFAULT 6 CHECK (machine_max_db_clusters BETWEEN 0 AND 256),
  -- The optional dollar cap. NULL means off, which is the shipped default: an
  -- unknown cost is recorded as unknown and never refuses advance.
  dollar_cap_microusd bigint CHECK (dollar_cap_microusd IS NULL OR dollar_cap_microusd >= 0),
  owner_identity_id text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL,
  -- Immutable false-valued lock column, as with every other coordinator row
  -- lock: the coordinator may take a row lock on this one table and may not
  -- change a single allowance value.
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id, workspace_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT
);

-- The owner's own writes only: version moves forward one step, the re-signed
-- digest and tag replace the previous ones, and nothing else is rewritten.
CREATE FUNCTION guard_pipeline_installation_allowance_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'pipeline installation allowance rejected'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'UPDATE' OR NEW.tenant_id<>OLD.tenant_id OR NEW.workspace_id<>OLD.workspace_id
    OR NEW.coordinator_lock IS DISTINCT FROM OLD.coordinator_lock
    OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'pipeline installation allowance rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_pipeline_installation_allowance_write() FROM PUBLIC;
CREATE TRIGGER pipeline_installation_allowances_guard
  BEFORE INSERT OR UPDATE ON public.pipeline_installation_allowances
  FOR EACH ROW EXECUTE FUNCTION public.guard_pipeline_installation_allowance_write();
CREATE TRIGGER pipeline_installation_allowances_no_delete
  BEFORE DELETE ON public.pipeline_installation_allowances
  FOR EACH ROW EXECUTE FUNCTION public.guard_pipeline_installation_allowance_write();
CREATE TRIGGER pipeline_installation_allowances_no_truncate
  BEFORE TRUNCATE ON public.pipeline_installation_allowances
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_pipeline_installation_allowance_write();

REVOKE ALL ON pipeline_installation_allowances FROM PUBLIC;

-- No shared login is granted this table. If one ever is, the work-intake
-- session must still see and write only its bound tenant, as 0104, 0108 and
-- 0109 confine their tables.
ALTER TABLE pipeline_installation_allowances ENABLE ROW LEVEL SECURITY;
CREATE POLICY pipeline_installation_allowances_existing_access ON pipeline_installation_allowances
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY pipeline_installation_allowances_work_intake_scope ON pipeline_installation_allowances
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session() OR
    pipeline_installation_allowances.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b))
  WITH CHECK (NOT public.is_work_intake_session() OR
    pipeline_installation_allowances.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b));

-- Existing installations already have these NOLOGIN roles. Keep the upgrade
-- grant as narrow as the fresh-install role files: absence is valid while an
-- operator is still applying migrations before role provisioning. The
-- coordinator reads the ceilings and takes the row lock; it can never insert,
-- raise a limit, or delete the record.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT, INSERT ON pipeline_installation_allowances TO control_room_private_web';
    EXECUTE 'GRANT UPDATE (runs_per_hour, runs_per_agent_per_day, machine_max_agent_processes, machine_max_db_clusters, dollar_cap_microusd, owner_identity_id, version, record_digest, auth_tag, updated_at) ON pipeline_installation_allowances TO control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT ON pipeline_installation_allowances TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (coordinator_lock) ON pipeline_installation_allowances TO control_room_task_coordinator';
  END IF;
END $$;
