-- Durable safe completion, separate from provider I/O. Existing installed
-- migrations stay immutable. Completing heads can only repair database writes.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
ALTER TABLE control_owner_push_attempt_heads
  DROP CONSTRAINT control_owner_push_attempt_heads_state_check,
  ADD CONSTRAINT control_owner_push_attempt_heads_state_check
    CHECK (state IN ('pending','reserved','completing','delivered','failed')),
  ADD COLUMN completion_data jsonb,
  ADD COLUMN completion_disposition text CHECK (completion_disposition IN ('delivered','retry','deferred','failed')),
  ADD COLUMN completion_next_attempt_at timestamptz,
  ADD COLUMN completion_reason_code text CHECK (completion_reason_code IS NULL OR completion_reason_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$'),
  ADD COLUMN completion_retry_count integer NOT NULL DEFAULT 0 CHECK (completion_retry_count BETWEEN 0 AND 8),
  ADD CONSTRAINT owner_push_completion_shape CHECK (
    (state='completing' AND completion_data IS NOT NULL AND jsonb_typeof(completion_data)='array'
      AND reserved_at IS NOT NULL AND attempt_count>0)
    OR (state<>'completing' AND completion_data IS NULL AND completion_disposition IS NULL
      AND completion_next_attempt_at IS NULL AND completion_reason_code IS NULL AND completion_retry_count=0)),
  ADD CONSTRAINT owner_push_completion_disposition CHECK (
    (completion_disposition IS NULL AND completion_next_attempt_at IS NULL)
    OR (completion_disposition IS NOT NULL AND completion_next_attempt_at IS NOT NULL));
CREATE INDEX control_owner_push_completions_due
  ON control_owner_push_attempt_heads(next_attempt_at, action_inbox_id) WHERE state='completing';

CREATE OR REPLACE FUNCTION guard_owner_push_attempt_head_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE receipt jsonb;
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
  IF TG_OP='UPDATE' AND OLD.state='completing' AND NEW.state='completing' AND (
    NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
    OR NOT (NEW.completion_data @> OLD.completion_data)
  ) THEN RAISE EXCEPTION 'owner push completion rejected' USING ERRCODE='23514'; END IF;
  IF NEW.state='completing' THEN
    FOR receipt IN SELECT value FROM jsonb_array_elements(NEW.completion_data) LOOP
      IF jsonb_typeof(receipt)<>'object'
        OR NOT (receipt ?& ARRAY['subscription_id','event_tag','result','status_code','completed_at','remove'])
        OR receipt - ARRAY['subscription_id','event_tag','result','status_code','completed_at','remove'] <> '{}'::jsonb
        OR jsonb_typeof(receipt->'subscription_id')<>'string'
        OR (receipt->>'subscription_id') !~ '^push:[a-f0-9]{64}$'
        OR receipt->>'event_tag' IS DISTINCT FROM 'needs:'||NEW.action_inbox_id
        OR receipt->>'result' NOT IN ('delivered','failed')
        OR jsonb_typeof(receipt->'result')<>'string'
        OR jsonb_typeof(receipt->'remove')<>'boolean'
        OR jsonb_typeof(receipt->'completed_at')<>'string'
        OR (receipt->>'completed_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
        OR (receipt->'status_code'<>'null'::jsonb AND (
          jsonb_typeof(receipt->'status_code')<>'number'
          OR (receipt->>'status_code') !~ '^[1-5][0-9]{2}$'))
        OR (receipt->>'result'='delivered' AND (
          receipt->'status_code'='null'::jsonb OR (receipt->>'status_code')::integer NOT BETWEEN 200 AND 299
          OR (receipt->>'remove')::boolean))
        OR (receipt->>'result'='failed' AND (receipt->>'status_code')::integer BETWEEN 200 AND 299)
        OR ((receipt->>'remove')::boolean AND (receipt->>'status_code')::integer NOT IN (404,410))
      THEN RAISE EXCEPTION 'owner push completion rejected' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF (SELECT count(*) FROM jsonb_array_elements(NEW.completion_data)) <>
      (SELECT count(DISTINCT value->>'subscription_id') FROM jsonb_array_elements(NEW.completion_data))
    THEN RAISE EXCEPTION 'owner push completion rejected' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.guard_owner_push_attempt_head_write() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    GRANT UPDATE (completion_data,completion_disposition,completion_next_attempt_at,
      completion_reason_code,completion_retry_count) ON control_owner_push_attempt_heads TO control_room_private_web;
  END IF;
END $$;

DROP TRIGGER control_owner_push_attempt_heads_guard ON control_owner_push_attempt_heads;
CREATE TRIGGER control_owner_push_attempt_heads_guard BEFORE INSERT OR UPDATE ON control_owner_push_attempt_heads
  FOR EACH ROW EXECUTE FUNCTION public.guard_owner_push_attempt_head_write();
