-- MLOAD-04: the Workers scorecard's "who caught it" lookup was unbounded.
--
-- DatabaseWorkerScorecardReadSourceV1.read (src/web/v1/worker-scorecard-read.ts)
-- answers "which review caught this?" with a correlated LATERAL over
-- control_completion_gate_records that walks two jsonb fields:
--
--   rev.payload->>'targetId' = prior_target.id
--   prior_target.payload->>'rootTargetId' = target.payload->>'rootTargetId'
--   rev.payload->>'decision' = 'changes_requested'
--
-- Both are jsonb equality predicates, and the table's real indexes
-- (idx_control_completion_gate_subject, idx_control_completion_gate_parent) are
-- (tenant_id, project_id, kind, subject_id|parent_id, occurred_at, id) -- neither
-- can serve a jsonb containment chain, so each of the 2,000 bounded stage runs
-- re-searched the table. Measured on this tree at growth size: 116 ms and
-- 1,010,440 shared buffers for 2,000 rows, which is what pushed the scorecard to
-- 4.4 s under the eight concurrent readers of MLOAD-03b.
--
-- TWO EXPRESSION INDEXES, one per direction of the chain, both partial on the
-- kind the query names so each stays small as the record table grows:
--
--   idx_control_completion_gate_root_target
--     serves `prior_target.kind='target' AND prior_target.payload->>'rootTargetId' = ?`
--   idx_control_completion_gate_review_target
--     serves `rev.kind='review' AND rev.payload->>'targetId' = ? AND rev.payload->>'decision' = ?`
--
-- `decision` is in the review index rather than filtered, because the LATERAL
-- binds the decision as an equality predicate on every lookup: keeping it as a
-- key column lets the planner test both equalities inside one index scan, while
-- a partial index on kind alone would still have to fetch and discard the rows
-- of the other decisions. The predicate is on `kind`, which the query also binds
-- by equality, so nothing non-matching is stored at all.
--
-- SCOPE. Two indexes. No grant, no data change, no trigger, no rewrite of any
-- existing object. `id` is deliberately NOT a key column: the LATERAL's tiebreak
-- is on the reviewer's identity, not on row order, so a covering id would add
-- width to every write on a table that grows with every review for no read
-- benefit.
--
-- UPGRADE COST, measured at growth size: see the report. Both of these build
-- inside the applier's own 5 s statement_timeout on the table they index, which
-- was verified rather than assumed.
--
-- WHY NOT CONCURRENTLY. Squawk's require-concurrent-index-creation rule asks for
-- CREATE INDEX CONCURRENTLY for both of these, and it is right that a plain
-- CREATE INDEX takes a ShareLock that blocks writes while it builds. It is not
-- used here because CONCURRENTLY cannot run inside a transaction block and the
-- applier runs every migration inside one
-- (`deploy/postgres/apply-migrations.mjs`), so it would fail outright. At the
-- size measured here the build is sub-second on both.
--
-- The lock_timeout below is the part that IS worth having and IS cheap: it
-- bounds how long the statement waits for its ShareLock rather than queueing
-- behind an open transaction, so an upgrade on a busy installation fails fast
-- and retries. It matches what the grant migrations in this range already set.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- CONCURRENTLY cannot run inside the applier's transaction, and both builds are
-- sub-second at growth size inside the statement_timeout above; the lock_timeout
-- bounds how long each statement waits for its ShareLock.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX idx_control_completion_gate_root_target
  ON control_completion_gate_records (tenant_id, (payload->>'rootTargetId'))
  WHERE kind = 'target';

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX idx_control_completion_gate_review_target
  ON control_completion_gate_records (tenant_id, (payload->>'targetId'), (payload->>'decision'))
  WHERE kind = 'review';
