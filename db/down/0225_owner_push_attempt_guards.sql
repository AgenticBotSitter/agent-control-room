-- Reverses ONLY the guard 0225 created. 0224's table and its grants are left
-- in place: this is the middle of the series, and rolling back the guard must
-- not remove the table the first file created.
BEGIN;
DROP TRIGGER control_owner_push_attempt_heads_guard ON control_owner_push_attempt_heads;
DROP FUNCTION public.guard_owner_push_attempt_head_write();
COMMIT;
