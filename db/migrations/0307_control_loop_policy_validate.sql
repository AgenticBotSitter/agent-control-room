-- Validate P71's command-body constraint in its own migration transaction.
-- 0306 already enforces it on new writes while existing rows await validation.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE control_loop_improvement_commands VALIDATE CONSTRAINT control_loop_improvement_commands_check1;
