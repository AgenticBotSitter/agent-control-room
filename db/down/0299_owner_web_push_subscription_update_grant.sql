-- Reverse only the four subscription renewal column grants. Retain all rows,
-- keys and delivery history. This restores the earlier subscription refusal.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE UPDATE (p256dh, auth, expires_at, updated_at) ON owner_web_push_subscriptions FROM control_room_private_web';
  END IF;
END $$;
