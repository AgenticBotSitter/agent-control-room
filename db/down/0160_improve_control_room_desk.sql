BEGIN;
LOCK TABLE control_update_candidate_decisions, control_update_candidates, control_improvement_requests IN ACCESS EXCLUSIVE MODE;
DROP TABLE control_update_candidate_decisions;
DROP TABLE control_update_candidates;
DROP TABLE control_improvement_requests;
COMMIT;
