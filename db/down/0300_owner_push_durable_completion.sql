-- Old binaries must never discard retained completion work.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_owner_push_attempt_heads WHERE state='completing' OR completion_data IS NOT NULL)
  THEN RAISE EXCEPTION 'owner push completion retained' USING ERRCODE='23514'; END IF;
END $$;
DROP INDEX control_owner_push_completions_due;
ALTER TABLE control_owner_push_attempt_heads
  DROP CONSTRAINT owner_push_completion_shape,
  DROP CONSTRAINT owner_push_completion_disposition,
  DROP CONSTRAINT control_owner_push_attempt_heads_state_check,
  DROP COLUMN completion_data,
  DROP COLUMN completion_disposition,
  DROP COLUMN completion_next_attempt_at,
  DROP COLUMN completion_reason_code,
  DROP COLUMN completion_retry_count,
  ADD CONSTRAINT control_owner_push_attempt_heads_state_check CHECK (state IN ('pending','reserved','delivered','failed'));
CREATE OR REPLACE FUNCTION guard_owner_push_attempt_head_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.action_inbox_id IS DISTINCT FROM OLD.action_inbox_id
    OR NEW.link IS DISTINCT FROM OLD.link
    OR NEW.attempt_count<OLD.attempt_count
    OR NEW.attempt_count>OLD.attempt_count+1
    -- A delivery is permanent. There is no path back to 'pending' or
    -- 'reserved', which is the whole "exactly once" property. The same is true
    -- of a permanent failure: an item that has stopped trying stays stopped, so
    -- a caller cannot reopen an exhausted head and re-alert the phone.
    OR (OLD.state='delivered' AND NEW.state<>'delivered')
    OR (OLD.state='delivered' AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR (OLD.state='failed' AND NEW.state<>'failed')
    OR (OLD.state='failed' AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.state='reserved' AND NEW.state='reserved' AND NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
      AND NEW.attempt_count=OLD.attempt_count)
  ) THEN
    RAISE EXCEPTION 'owner push attempt head rejected';
  END IF;
  IF NEW.next_attempt_at>pg_catalog.statement_timestamp()+interval '1 day'
    OR NEW.updated_at>pg_catalog.statement_timestamp()+interval '1 day' THEN
    RAISE EXCEPTION 'owner push attempt head rejected';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER control_owner_push_attempt_heads_guard ON control_owner_push_attempt_heads;
CREATE TRIGGER control_owner_push_attempt_heads_guard BEFORE UPDATE ON control_owner_push_attempt_heads
  FOR EACH ROW EXECUTE FUNCTION public.guard_owner_push_attempt_head_write();
COMMIT;
