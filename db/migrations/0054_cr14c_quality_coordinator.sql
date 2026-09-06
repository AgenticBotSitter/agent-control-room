-- Inert locking support; no authority-bearing native run updates are granted.
ALTER TABLE control_harness_runs ADD COLUMN coordinator_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_harness_runs_coordinator_lock CHECK (coordinator_lock IS FALSE);

-- The coordinator may record only its deterministic service verification, never a human
-- review, acceptance profile, target, finding, revision, or worker-authored verification.
CREATE FUNCTION guard_task_coordinator_quality_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator'
    AND pg_has_role(current_user,oid,'MEMBER'))
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    IF NEW.kind IS DISTINCT FROM 'verification'
      OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
      OR NEW.payload->>'projectId' IS DISTINCT FROM NEW.project_id
      OR NEW.payload->>'id' IS DISTINCT FROM NEW.id
      OR NEW.payload->'verifier'->>'actorType' IS DISTINCT FROM 'service'
      OR NEW.payload->'verifier'->>'actorId' IS DISTINCT FROM 'service:document-structure-verifier'
      OR coalesce(NEW.payload->>'outcome','') NOT IN ('passed','failed')
      OR NEW.payload->>'grantsApproval' IS DISTINCT FROM 'false'
      OR NEW.payload->>'grantsExecutionAuthority' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'task coordinator quality insert rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_task_coordinator_quality_insert() FROM PUBLIC;
CREATE TRIGGER control_completion_gate_task_coordinator_quality BEFORE INSERT ON control_completion_gate_records
  FOR EACH ROW EXECUTE FUNCTION guard_task_coordinator_quality_insert();
