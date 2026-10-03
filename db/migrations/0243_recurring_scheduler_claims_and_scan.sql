-- Two durable facts the recurring scheduler previously kept in memory, and so
-- lost on every restart:
--
--   1. WHO OWNS THE PROPOSAL. `RECURRING_S7B_CAPS_V1` declares
--      `maxConcurrentProposals: 1`, and 0186 gave the coordinator an
--      `attempt_count` it increments, but nothing anywhere said which instance
--      was speaking. Measured on real PostgreSQL 17 as the production logins
--      (tests/recurring-scheduling-postgres.test.ts, PLAN-U1): fifty
--      independently connected task-coordinator schedulers racing one due rule
--      reached the S1 proposal port FIFTY TIMES SIMULTANEOUSLY against a
--      declared ceiling of one, and the ledger counted fifty attempts. The
--      single batch, zero jobs and zero attempts still held -- S1's idempotency
--      is what saved it -- but the ceiling was a comment, and `attempt_count`
--      was being spent fifty times for one occurrence, which is the retry
--      budget a later failure would have drawn on.
--
--      `control_recurring_proposal_claims` is that missing owner. One row per
--      tenant, held for a LEASE rather than forever, so an instance that dies
--      mid-proposal does not fence the installation permanently. Acquisition is
--      a single `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <=
--      statement_timestamp()`, so the compare and the take are one atomic step
--      and a live claim cannot be taken by a second caller. Taking over an
--      EXPIRED claim is the crash recovery, and it needs no separate
--      reconciliation pass: the next tick finds the row expired and takes it.
--
--   2. WHERE THE SCAN GOT TO. 0186 indexes the rules for exactly this question
--      (`control_recurring_rules_due` on tenant, state, last_evaluated_at,
--      rule_id) and the scheduler answered it with a bare
--      `ORDER BY rule_id LIMIT 100`. Measured on real PostgreSQL 17 (PLAN-U2):
--      with 101 active rules, the 101st was never read by any tick, ever, and
--      its cursor never moved. A tenant with more rules than one page simply had
--      a silent tail. The page bound itself is NOT removed -- a tick has a
--      deadline, and an unbounded scan would let a large rule set spend the
--      whole budget reading rules it can never propose from (the per-cycle cap
--      is three) -- so the bound is spent over a durable rotating cursor
--      instead, which is what makes every rule reachable across consecutive
--      bounded ticks rather than only the first hundred.
--
-- WHY A CLAIM IS NOT AN UPDATE OF THE OCCURRENCE ROW. The obvious fix is
-- "claim the `control_recurring_proposals` row instead of inserting it". It
-- cannot work: 0186 makes that table's PK `(tenant_id, rule_id,
-- occurrence_key)`, so a claim can only be expressed as a row that does not yet
-- exist, and 0186's own guard admits an attempt_count increase of at most one
-- per update. Fifty racing callers would have to agree on the key before any of
-- them could claim anything, which is the problem.
--
-- NEITHER TABLE GRANTS EXECUTION AUTHORITY. A claim is a scheduling fact and a
-- cursor is a position in a scan. Both are per-tenant and both are owned by the
-- coordinator login alone, which already cannot start work: 0186's proposals
-- table carries no authority and this migration adds none.
--
-- Same convergence as 0237/0238/0157/0046/0054/0087: db/roles/*.sql is the
-- authoritative statement of the grant, and a role file is only read when the
-- module is provisioned, so an installation provisioned before this file
-- existed keeps the older ACL. Each grant is guarded by the role's existence
-- because several suites apply migrations to a role-less database.
--
-- Read the cursor, write both -- and DELETE on neither. A cursor row is never
-- removed (wrapping the scan is a column update, not a delete), and a claim is
-- released by expiring it, so the coordinator holds no way to erase either
-- fact, and in particular no way to erase the record of having been fenced.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- ---------------------------------------------------------------- the claim --
CREATE TABLE control_recurring_proposal_claims (
  tenant_id text NOT NULL,
  -- The instance speaking. A liveness label, not a credential, so a peer can
  -- tell "somebody else is proposing" from "the claim expired and nobody took
  -- it" without the value meaning anything to anybody.
  claim_owner text NOT NULL CHECK (char_length(claim_owner) BETWEEN 8 AND 180),
  claimed_at timestamptz NOT NULL,
  -- The lease end, which is what makes an abandoned claim recoverable rather
  -- than a permanent fence. Bounded by the schema owner's clock rather than a
  -- caller's: a scheduler whose own wall clock jumps cannot extend its claim,
  -- and one that runs slow cannot lose a live claim to its own slowness.
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  -- `>=` and not `>`, and the reason is measured rather than guessed. Releasing a
  -- claim writes `expires_at = statement_timestamp()`, so a tick that took its
  -- claim and was released in the same instant produces a ZERO-LENGTH lease -- the
  -- row exists to say "nobody is proposing", and equality says exactly that. A
  -- strict `>` refuses that release with 23514 and the exception escapes the
  -- `finally` that was supposed to make release unconditional, so a fast tick
  -- fails at the very statement that frees it. What the constraint must forbid is
  -- a lease that ENDS BEFORE IT STARTS, because that is the shape a caller uses to
  -- claim a window it never had.
  CHECK (expires_at >= claimed_at)
);
COMMENT ON TABLE control_recurring_proposal_claims IS
  'One row per tenant: which scheduler instance owns the right to propose, until expires_at.';

-- ---------------------------------------------------------------- the cursor --
CREATE TABLE control_recurring_scan_cursors (
  tenant_id text NOT NULL,
  -- The greatest rule_id the last tick finished reading. Keyset pagination
  -- resumes strictly after it, so a tick can never spend its whole page budget
  -- re-reading a prefix it already covered. NULL means "start at the beginning
  -- next time", which is both a tenant's first tick and the state a wrapped scan
  -- leaves behind -- that wrap is what makes the rotation a rotation rather
  -- than a walk to the end that stops.
  last_rule_id text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
COMMENT ON TABLE control_recurring_scan_cursors IS
  'Per-tenant position in the active-rule scan, so every rule is reachable across consecutive bounded ticks.';

-- ------------------------------------------------------------------- grants --
-- The UPDATE grants name every column, INCLUDING `tenant_id`, rather than being
-- table-wide. That is forced by the private-web preflight, which compares
-- `has_column_privilege(..., 'UPDATE')` against the declaration ONE COLUMN AT A
-- TIME and refuses any database where one differs -- so a table-wide UPDATE on a
-- table whose declaration omits the key column fails as
-- `private_database_preflight_failed` on a perfectly correct cluster. Measured on
-- real PostgreSQL 17 through the coordinator login, which is what found it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT, INSERT ON control_recurring_proposal_claims,'
      ' control_recurring_scan_cursors TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (tenant_id,claim_owner,claimed_at,expires_at)'
      ' ON control_recurring_proposal_claims TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (tenant_id,last_rule_id,updated_at)'
      ' ON control_recurring_scan_cursors TO control_room_task_coordinator';
  END IF;
END $$;
