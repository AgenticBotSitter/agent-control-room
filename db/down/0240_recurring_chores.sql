-- Reverses 0240 only: the recurring_chores table, its index and its REVOKE. The
-- guard triggers and the column grants that hang off it are 0241's, and 0241's
-- own down file drops them; a file that removed the trigger here would make the
-- stack order-dependent.
BEGIN;
DROP TABLE recurring_chores;
COMMIT;