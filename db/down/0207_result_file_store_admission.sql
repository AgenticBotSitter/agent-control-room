-- Down for 0207 only: the two guards it added and the two columns it added.
-- It revokes no grant, because 0207 granted none — its authority lives in
-- trigger guards, and those are what comes off. The acceptance columns are
-- dropped after the guards, because a CHECK and a foreign key both depend on
-- them and a trigger would otherwise be reading a column that is gone.
BEGIN;
DROP TRIGGER control_result_file_sets_acceptance_guard ON control_result_file_sets;
DROP TRIGGER control_result_file_sets_producer_guard ON control_result_file_sets;
DROP FUNCTION guard_result_file_set_acceptance();
DROP FUNCTION guard_result_file_set_producer();
-- 0206's own update guard still runs after this file, so the column it does not
-- touch is what keeps the table consistent; only 0207's additions go.
ALTER TABLE control_result_file_sets DROP CONSTRAINT control_result_file_sets_accepted_by_present;
ALTER TABLE control_result_file_sets DROP CONSTRAINT control_result_file_sets_accepted_by_fk;
ALTER TABLE control_result_file_sets DROP COLUMN accepted_by_identity_id;
COMMIT;
