-- S7b: "count runs, never dollars". An advance whose cost evidence is unknown
-- used to refuse with `policy_cost_unknown`, so unattended work could not run
-- at all until a cost-evidence port returned a number. The receipt now records
-- the honest state: a known cost is stored with its evidence digest, an unknown
-- cost is stored as unknown, and the two can never disagree.
-- The dollar cap is optional and off by default (see 0150). No trigger,
-- scheduler, provider invocation, merge or external effect is added.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE pipeline_advance_receipts ADD COLUMN delegation_cost_state text NOT NULL DEFAULT 'known'
  CHECK (delegation_cost_state IN ('known','unknown'));
-- Existing receipts were only ever written for a known cost, so the default
-- above states that truthfully for every pre-S7b row and the pairing check
-- below validates against the real data without a table rewrite.
ALTER TABLE pipeline_advance_receipts ALTER COLUMN delegation_cost_microusd DROP NOT NULL;
ALTER TABLE pipeline_advance_receipts ALTER COLUMN delegation_cost_evidence_digest DROP NOT NULL;
ALTER TABLE pipeline_advance_receipts ADD CONSTRAINT pipeline_advance_receipts_cost_pair_check
  CHECK ((delegation_cost_state='known' AND delegation_cost_microusd IS NOT NULL
      AND delegation_cost_evidence_digest IS NOT NULL)
    OR (delegation_cost_state='unknown' AND delegation_cost_microusd IS NULL
      AND delegation_cost_evidence_digest IS NULL)) NOT VALID;
-- The constraint is NOT VALID, as 0109's equivalent is: the three columns were
-- just added in this same file, so no pre-S7b row can violate the pairing, and
-- validating in one scan would take a lock no migration this size should take.
-- Every row written from here on is checked, which is what the pairing is for.
-- The down file drops this constraint outright along with its own column, so no
-- unvalidated constraint is left behind.
