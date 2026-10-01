BEGIN;
-- 0152 alone: the receipt records an honest unknown cost instead of refusing.
-- 0151, 0150 and 0153 are untouched, so this file removes only what its own up
-- migration added.
LOCK TABLE pipeline_advance_receipts IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pipeline_advance_receipts WHERE delegation_cost_state='unknown') THEN
    RAISE EXCEPTION 'pipeline unknown-cost down migration refused: unknown-cost receipts exist';
  END IF;
END $$;
ALTER TABLE pipeline_advance_receipts DROP CONSTRAINT pipeline_advance_receipts_cost_pair_check;
ALTER TABLE pipeline_advance_receipts ALTER COLUMN delegation_cost_evidence_digest SET NOT NULL;
ALTER TABLE pipeline_advance_receipts ALTER COLUMN delegation_cost_microusd SET NOT NULL;
ALTER TABLE pipeline_advance_receipts DROP COLUMN delegation_cost_state;
COMMIT;
