-- Ownership-scope acquisition is enforced at the database boundary.  The
-- project-scoped advisory lock serializes concurrent inserts even when callers
-- use different application processes; the trigger then checks the committed
-- live set before accepting each scope row.
CREATE OR REPLACE FUNCTION enforce_assignment_lease_scope_collision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  acquisition_time timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array(NEW.tenant_id, NEW.project_id)::text, 0));

  SELECT lease.acquired_at INTO acquisition_time
  FROM control_leases lease
  JOIN control_jobs job ON job.tenant_id=lease.tenant_id AND job.id=lease.job_id
  WHERE lease.tenant_id=NEW.tenant_id AND lease.id=NEW.lease_id AND lease.state='active'
    AND lease.expires_at>clock_timestamp()
    AND lease.job_id=NEW.job_id AND lease.attempt_id=NEW.attempt_id AND lease.node_id=NEW.node_id
    AND job.project_id=NEW.project_id
    AND (EXISTS (
      SELECT 1 FROM control_task_declared_scopes declared
      WHERE declared.tenant_id=NEW.tenant_id AND declared.project_id=NEW.project_id
        AND declared.job_id=NEW.job_id AND declared.scope_kind=NEW.scope_kind
        AND declared.path_fold=NEW.path_fold
    ) OR (NEW.scope_kind='tree' AND NEW.path_fold='' AND NOT EXISTS (
      SELECT 1 FROM control_task_declared_scopes declared
      WHERE declared.tenant_id=NEW.tenant_id AND declared.project_id=NEW.project_id
        AND declared.job_id=NEW.job_id
    )));

  IF acquisition_time IS NULL THEN
    RAISE EXCEPTION 'ownership lease is not active' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM control_assignment_lease_scopes held
    JOIN control_leases lease
      ON lease.tenant_id=held.tenant_id AND lease.id=held.lease_id
    WHERE held.tenant_id=NEW.tenant_id
      AND held.project_id=NEW.project_id
      AND held.lease_id<>NEW.lease_id
      AND lease.state='active'
      AND lease.expires_at>clock_timestamp()
      AND (
        (NEW.scope_kind='tree' AND (NEW.path_fold='' OR held.path_fold=NEW.path_fold
          OR held.path_fold LIKE NEW.path_fold || '/%'))
        OR (held.scope_kind='tree' AND (held.path_fold='' OR NEW.path_fold=held.path_fold
          OR NEW.path_fold LIKE held.path_fold || '/%'))
        OR (NEW.scope_kind='file' AND held.scope_kind='file' AND NEW.path_fold=held.path_fold)
      )
  ) THEN
    RAISE EXCEPTION 'ownership lease scope collision' USING ERRCODE='23P01';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_assignment_lease_scope_collision() FROM PUBLIC;

DROP TRIGGER IF EXISTS control_assignment_lease_scope_collision
  ON control_assignment_lease_scopes;
CREATE TRIGGER control_assignment_lease_scope_collision
BEFORE INSERT ON control_assignment_lease_scopes
FOR EACH ROW EXECUTE FUNCTION enforce_assignment_lease_scope_collision();
