-- MIG-I: exact private-web rights for the push dispatcher.
--
-- SELECT, INSERT (first reservation of a newly noticed item), and column-scoped
-- UPDATE over exactly the retry bookkeeping: the attempt count, the sendable
-- state, the backoff time, the reservation and completion instants, and the
-- safe reason. No DELETE -- a head is removed only with its action inbox item,
-- by that table's own ON DELETE CASCADE, never by the dispatcher.
--
-- The link column is deliberately NOT updatable: a caller may record WHERE a
-- phone should go the first time, and can never repoint it afterwards.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    GRANT SELECT, INSERT ON control_owner_push_attempt_heads TO control_room_private_web;
    GRANT UPDATE (state, attempt_count, next_attempt_at, reserved_at, last_attempt_at, completed_at,
      safe_reason_code, updated_at) ON control_owner_push_attempt_heads TO control_room_private_web;
  END IF;
END $$;
