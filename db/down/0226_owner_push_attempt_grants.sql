-- Reverses ONLY the grants 0226 conferred. The table, its guard trigger and its
-- guard function belong to 0224/0225 and are left in place here: this file is
-- the third of the series, and a rolling back of the grant must not drop a
-- table the earlier files created.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE UPDATE (state, attempt_count, next_attempt_at, reserved_at, last_attempt_at, completed_at, safe_reason_code, updated_at) ON control_owner_push_attempt_heads FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT, INSERT ON control_owner_push_attempt_heads FROM control_room_private_web';
  END IF;
END $$;
COMMIT;
