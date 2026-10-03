-- Reverses 0273 exactly: the two partial jsonb expression indexes it created on
-- control_completion_gate_records. No grant is revoked, no row is touched, and
-- idx_control_completion_gate_subject / idx_control_completion_gate_parent are
-- left alone -- this file drops only the two names 0273 created.
--
-- Dropping them restores the pre-0273 behaviour: correct results from a
-- sequential search per stage run, which is slow at growth size but not wrong.
-- The scorecard read needs no new grant either way, so nothing about what the
-- production login may do changes.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DROP INDEX IF EXISTS idx_control_completion_gate_root_target;
DROP INDEX IF EXISTS idx_control_completion_gate_review_target;
