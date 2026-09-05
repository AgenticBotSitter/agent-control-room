-- Browser receipts bind an immutable proposal to existing canonical records, not a second job queue.
CREATE TABLE control_web_task_commands (
  tenant_id text NOT NULL,
  identity_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 12 AND 180),
  project_id text NOT NULL,
  job_id text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, identity_id, idempotency_key),
  FOREIGN KEY (tenant_id, identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, job_id) REFERENCES control_jobs(tenant_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER control_web_task_commands_append_only BEFORE UPDATE OR DELETE ON control_web_task_commands
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_web_task_commands_truncate_guard BEFORE TRUNCATE ON control_web_task_commands
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE INDEX control_jobs_project_catalog ON control_jobs(tenant_id, project_id, id COLLATE "C");

-- The fresh private web role may INSERT only initial, effect-free canonical proposals. It receives
-- no UPDATE on these tables and no INSERT/UPDATE on attempts, leases, dispatch, effects or approvals.
-- No SECURITY DEFINER or permission-granting routine is introduced.
CREATE FUNCTION guard_private_web_proposal_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web'
    AND pg_has_role(current_user,oid,'MEMBER'))
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    IF NEW.version <> 0 OR NEW.created_at <> NEW.updated_at
      OR NEW.state <> (CASE WHEN TG_TABLE_NAME='control_requests' THEN 'draft' ELSE 'proposed' END)
      OR NEW.payload->>'state' IS DISTINCT FROM NEW.state
      OR NEW.payload->>'id' IS DISTINCT FROM NEW.id
      OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
      OR NEW.payload->>'projectId' IS DISTINCT FROM NEW.project_id
      OR NEW.payload->>'version' IS DISTINCT FROM '0' THEN
      RAISE EXCEPTION 'private proposal insert rejected';
    END IF;
    IF TG_TABLE_NAME='control_jobs' AND (
      NEW.payload->'authority'->>'effectPolicy' IS DISTINCT FROM 'none'
      OR NEW.payload->'authority'->>'networkPolicy' IS DISTINCT FROM 'none'
      OR NEW.payload->'authority'->>'maxConcurrentEffects' IS DISTINCT FROM '0'
      OR NEW.payload->'authority'->'credentialRefs' IS DISTINCT FROM '[]'::jsonb
      OR NEW.payload->'authority'->'filesystemRoots' IS DISTINCT FROM '[]'::jsonb
      OR NEW.payload->'authority'->'allowedNetworkDestinations' IS DISTINCT FROM '[]'::jsonb
      OR NEW.payload->'authority'->>'allowedExecutor' IS DISTINCT FROM 'executor:unassigned') THEN
      RAISE EXCEPTION 'private proposal insert rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_private_web_proposal_insert() FROM PUBLIC;
CREATE TRIGGER control_requests_private_proposal BEFORE INSERT ON control_requests
  FOR EACH ROW EXECUTE FUNCTION guard_private_web_proposal_insert();
CREATE TRIGGER control_workflows_private_proposal BEFORE INSERT ON control_workflows
  FOR EACH ROW EXECUTE FUNCTION guard_private_web_proposal_insert();
CREATE TRIGGER control_jobs_private_proposal BEFORE INSERT ON control_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_private_web_proposal_insert();
