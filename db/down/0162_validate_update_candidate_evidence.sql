SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE control_update_candidates
  DROP CONSTRAINT ck_control_update_candidate_independent_reviews_array,
  DROP CONSTRAINT ck_control_update_candidate_risk_flags_array,
  ADD CONSTRAINT ck_control_update_candidate_risk_flags_array
    CHECK (jsonb_typeof(risk_flags) = 'array') NOT VALID,
  ADD CONSTRAINT ck_control_update_candidate_independent_reviews_array
    CHECK (jsonb_typeof(independent_reviews) = 'array') NOT VALID;
