BEGIN;
LOCK TABLE pipeline_unattended_transitions, pipeline_advance_receipts, pipeline_templates, pipeline_runs
  IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pipeline_unattended_transitions)
    OR EXISTS (SELECT 1 FROM pipeline_advance_receipts)
    OR EXISTS (SELECT 1 FROM pipeline_templates WHERE may_advance_unattended)
    OR EXISTS (SELECT 1 FROM pipeline_runs WHERE unattended) THEN
    RAISE EXCEPTION 'pipeline unattended down migration refused: records exist';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE UPDATE (may_advance_unattended, version, updated_at, record_digest, auth_tag) ON pipeline_templates FROM control_room_private_web';
    EXECUTE 'REVOKE UPDATE (unattended, updated_at, version, template_version, template_digest, record_digest, auth_tag) ON pipeline_runs FROM control_room_private_web';
  END IF;
END $$;
DROP TRIGGER pipeline_advance_receipts_no_truncate ON pipeline_advance_receipts;
DROP TRIGGER pipeline_advance_receipts_immutable ON pipeline_advance_receipts;
DROP TRIGGER pipeline_unattended_transitions_no_truncate ON pipeline_unattended_transitions;
DROP TRIGGER pipeline_unattended_transitions_immutable ON pipeline_unattended_transitions;
DROP TABLE pipeline_advance_receipts;
DROP TABLE pipeline_unattended_transitions;
DROP FUNCTION reject_pipeline_unattended_history_mutation();
ALTER TABLE pipeline_templates ADD CONSTRAINT pipeline_templates_may_advance_unattended_check
  CHECK (may_advance_unattended=false);
ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_unattended_check CHECK (unattended=false);
COMMIT;
