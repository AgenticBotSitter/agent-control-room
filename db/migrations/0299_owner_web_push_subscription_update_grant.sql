-- The production web login uses an atomic INSERT ... ON CONFLICT DO UPDATE
-- for both first subscription and key renewal. PostgreSQL requires UPDATE
-- authority even when the insert has no conflict. Grant only the four fields
-- that statement changes; subscription identity and delivery history stay put.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT UPDATE (p256dh, auth, expires_at, updated_at) ON owner_web_push_subscriptions TO control_room_private_web';
  END IF;
END $$;
