-- Validate the candidate evidence constraints outside the transaction that
-- introduced them so existing reads are not blocked by an exclusive lock.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE control_update_candidates
  VALIDATE CONSTRAINT ck_control_update_candidate_risk_flags_array;

ALTER TABLE control_update_candidates
  VALIDATE CONSTRAINT ck_control_update_candidate_independent_reviews_array;
