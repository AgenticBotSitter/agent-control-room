CREATE TABLE control_web_task_review_commands (
  tenant_id text NOT NULL,
  identity_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 12 AND 180),
  project_id text NOT NULL,
  job_id text NOT NULL,
  artifact_id text NOT NULL,
  target_id text NOT NULL,
  review_id text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  command jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, identity_id, idempotency_key),
  UNIQUE (tenant_id, identity_id, target_id),
  FOREIGN KEY (tenant_id, identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, artifact_id) REFERENCES control_artifact_manifests(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, target_id) REFERENCES control_completion_gate_records(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, review_id) REFERENCES control_completion_gate_records(tenant_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER control_web_task_review_commands_append_only BEFORE UPDATE OR DELETE ON control_web_task_review_commands
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_web_task_review_commands_truncate_guard BEFORE TRUNCATE ON control_web_task_review_commands
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- SELECT FOR UPDATE needs a column UPDATE privilege; only this immutable false-valued lock column
-- is granted on records. Existing append-only trigger still rejects any actual record UPDATE.
ALTER TABLE control_completion_gate_records ADD COLUMN web_lock boolean NOT NULL DEFAULT false CHECK (web_lock=false);
CREATE FUNCTION guard_private_web_quality_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web'
    AND pg_has_role(current_user,oid,'MEMBER'))
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    IF NEW.kind NOT IN ('review','finding')
      OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
      OR NEW.payload->>'projectId' IS DISTINCT FROM NEW.project_id
      OR NEW.payload->>'id' IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
    IF NEW.kind='review' AND (
      NEW.payload->>'authority' IS DISTINCT FROM 'completion_gate'
      OR coalesce(NEW.payload->>'decision','') NOT IN ('accepted','changes_requested')
      OR NEW.payload->'reviewer'->>'actorType' IS DISTINCT FROM 'human'
      OR NEW.payload->>'grantsApproval' IS DISTINCT FROM 'false'
      OR NEW.payload->>'grantsExecutionAuthority' IS DISTINCT FROM 'false') THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_private_web_quality_insert() FROM PUBLIC;
CREATE TRIGGER control_completion_gate_private_quality BEFORE INSERT ON control_completion_gate_records
  FOR EACH ROW EXECUTE FUNCTION guard_private_web_quality_insert();
