-- Reverses 0241 only: the page_visits and page_pins tables and their indexes.
-- The guard triggers and grants that hang off them are 0242's, dropped there.
BEGIN;
DROP TABLE page_pins;
DROP TABLE page_visits;
COMMIT;