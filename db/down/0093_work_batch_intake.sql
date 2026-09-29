BEGIN;
LOCK TABLE work_batches, work_batch_revisions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM work_batches) OR EXISTS (SELECT 1 FROM work_batch_revisions) THEN
    RAISE EXCEPTION 'work batch intake down migration refused: records exist';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_work_intake') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON control_idempotency, audit_events, control_audit_chain_heads FROM control_room_work_intake';
    EXECUTE 'REVOKE INSERT (tenant_id, operation_scope, idempotency_key, request_digest, status) ON control_idempotency FROM control_room_work_intake';
    EXECUTE 'REVOKE UPDATE (status, result, completed_at) ON control_idempotency FROM control_room_work_intake';
    EXECUTE 'REVOKE UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads FROM control_room_work_intake';
    EXECUTE 'REVOKE UPDATE (web_lock) ON control_identities, control_role_grants FROM control_room_work_intake';
    EXECUTE 'REVOKE UPDATE (coordinator_lock) ON projects FROM control_room_work_intake';
  END IF;
END $$;
DROP TRIGGER work_batch_revisions_truncate_guard ON work_batch_revisions;
DROP TRIGGER work_batch_revisions_append_only ON work_batch_revisions;
DROP TRIGGER work_batch_revisions_initial_only ON work_batch_revisions;
DROP TRIGGER work_batches_proposal_only ON work_batches;
DROP TRIGGER control_idempotency_work_intake_guard ON control_idempotency;
DROP TRIGGER audit_events_work_intake_head_consistency ON audit_events;
DROP TRIGGER audit_events_work_intake_guard ON audit_events;
DROP TRIGGER control_audit_chain_heads_work_intake_nonempty ON control_audit_chain_heads;
DROP TRIGGER control_audit_chain_heads_work_intake_guard ON control_audit_chain_heads;
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='control_idempotency'
      AND policyname NOT IN ('control_idempotency_existing_access','control_idempotency_work_intake_scope'))>0
    OR (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='audit_events'
      AND policyname NOT IN ('audit_events_existing_access','audit_events_work_intake_scope'))>0 THEN
    RAISE EXCEPTION 'work batch intake down migration refused: shared-ledger RLS policies depend on it';
  END IF;
END $$;
DROP POLICY control_idempotency_work_intake_scope ON control_idempotency;
DROP POLICY control_idempotency_existing_access ON control_idempotency;
DROP POLICY audit_events_work_intake_scope ON audit_events;
DROP POLICY audit_events_existing_access ON audit_events;
ALTER TABLE control_idempotency DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY;
DROP TABLE work_batch_revisions;
DROP TABLE work_batches;
DROP TABLE work_intake_tenant_binding;
DROP FUNCTION guard_work_intake_audit_head_write();
DROP FUNCTION enforce_work_intake_audit_head_nonempty();
DROP FUNCTION enforce_work_intake_audit_event_head();
DROP FUNCTION guard_work_intake_audit_event_insert();
DROP FUNCTION work_intake_canonical_jsonb(jsonb);
DROP FUNCTION guard_work_intake_idempotency_write();
DROP FUNCTION is_work_intake_session();
DROP TABLE work_intake_role_anchor;
DROP FUNCTION guard_initial_work_batch_revision_insert();
DROP FUNCTION guard_proposal_only_work_batch_insert();
COMMIT;
