-- Validate control_loop_update_candidates_check outside the transaction that
-- introduced it so existing reads are not blocked by an exclusive lock.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE control_loop_update_candidates
  VALIDATE CONSTRAINT control_loop_update_candidates_check;
