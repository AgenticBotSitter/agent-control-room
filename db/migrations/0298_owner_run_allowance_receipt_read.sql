-- 0298: the owner's run page can read the installation's live position against
-- every ceiling.
--
-- THE BUG THIS FIXES. R7L-06 added `loopAllowanceForOwner`
-- (src/pipelines/v1/advance-service.ts:561), the read that shows the owner where
-- this run stands against runs-per-hour, runs-per-agent-per-day, live agent
-- processes, the cluster count and the loop ceilings. It is composed on the WEB
-- login in both web compositions -- private-process.ts:350 and
-- mac-local-web-process.ts:270 each build `PipelineAdvanceServiceV1` on
-- `options.database.client` and hand it to `createLinearPipelineHttpHandlerV1` --
-- and that login held no SELECT on `pipeline_advance_receipts`, which is the one
-- table the projection counts.
--
-- Measured on real PostgreSQL 17 as `control_room_web` on this tree, with the
-- real migration runner and the real db/roles files, after a real
-- `createTemplate`/`instantiate`/`setAllowance`: `loopAllowanceForOwner` threw
-- `database_unavailable` with **sqlState 42501** -- a permission error, not a
-- missing row. So this is not "every stage says unknown": with no grant the run
-- page degrades to `read_permission_denied` on every open run, forever.
--
-- WHY `pipeline_advance_receipts` AND NOT `pipeline_stage_loop_counts`.
--
-- The finding that raised this named both tables as missing. Only one of them is
-- read. Read the whole service rather than the finding's example, because the
-- examples are samples and a grant nobody needs is a grant the preflight then
-- has to declare forever:
--
--   * `pipeline_stage_loop_counts` (0151) is written by `#appendLoopCount` and
--     `#raiseLoopAttention` and read by NOTHING in src/. `grep` over src/ finds
--     two statements, both `INSERT INTO pipeline_stage_loop_counts`. The loop
--     count the projection shows is derived from `pipeline_advance_receipts`
--     (`#loopRounds`), which is the table 0151's own header says is the durable
--     receipt of the same fact. 0151's comment ("No shared login is granted this
--     table") is therefore still true after this migration, and stays true.
--   * `pipeline_advance_receipts` (0109) is read three ways on this path:
--     `#loopRounds` (`stage_ordinal, loop_index, source_job_id`) for the round
--     index, and `#installationUsage` for all four counters -- two COUNTs keyed on
--     `tenant_id` and `advanced_at`, one `COUNT(DISTINCT execution_job_id)`, and
--     one `SUM(delegation_cost_microusd)` filtered on `delegation_cost_state`.
--
-- So nine columns, named exactly as the four queries name them. Nothing else on
-- this table becomes readable, which is the point of the next section.
--
-- WHY COLUMN GRANTS AND NOT THE TABLE, AND WHY NOT A VIEW.
--
-- This table is the advance's own integrity record, and four of its columns are
-- the proof that a row was authorised:
--
--   auth_tag, receipt_digest, request_digest, selection_digest,
--   template_digest, run_digest, policy_digest, delegation_receipt_digest,
--   delegation_cost_evidence_digest
--
-- `auth_tag` is `hmac-sha256:<64 hex>` over the receipt's canonical material
-- under the installation integrity key, and `#replayReceipt`
-- (advance-service.ts:1142) re-verifies it before treating a row as a genuine
-- past advance. The web login is a SHARED login for the whole installation -- one
-- process, one credential, every project. A table-wide SELECT would hand that
-- process the material to mint a receipt the product itself would later accept as
-- a real advance, which is a strictly larger capability than the one R7L-06 asked
-- for and is not something any other owner-side read in
-- private_web_roles.sql does: the tables it reads whole hold no HMAC over a
-- record a different login wrote.
--
-- A view was considered and rejected as the wider of the two options, not the
-- narrower. A view runs with its OWNER's rights, so it would have to be
-- SECURITY DEFINER to work at all with no table grant, and a SECURITY DEFINER
-- view over these tables is a permanently-open window whose WHERE clause is the
-- only defence -- the same objection 0213's text-copy view is built to avoid, and
-- the reason `privateWebReadColumns` exists as a shape in the preflight at all.
-- Column grants have no such window: an ungranted column raises 42501 in the
-- database, every time, for every caller.
--
-- WHAT THIS DOES NOT GRANT.
--
--   * No INSERT, UPDATE or DELETE. The receipts remain append-only history owned
--     by the coordinator login; 0109's `pipeline_advance_receipts_immutable`
--     trigger and no-truncate trigger still refuse any mutation, and this
--     migration adds no write grant for any role.
--   * No read of `pipeline_stage_loop_counts` (above).
--   * No read of any other login's rows. The table's RLS is unchanged: 0109's
--     permissive `USING (true)` plus its restrictive work-intake-scope policy
--     still confine an intake session to its bound tenant, and the web login's
--     own `tasks.read` check on the project stays the thing that decides which
--     run it may read.
--   * The web login still holds no UPDATE on `pipeline_runs.unattended_last_
--     swept_at`, no capability port, and no way to start work: the projection
--     returns `startsWork: false` and `grantsExecutionAuthority: false`.
--
-- SCOPE. One table, nine columns, SELECT, for one login. `db/down/0298` revokes
-- exactly these nine and nothing else, and `private_web_roles.sql` carries the
-- same statement for a fresh install. The role file is the authoritative
-- statement and is only read when the module is provisioned, so an installation
-- provisioned before this migration existed keeps the older ACL until it is
-- reprovisioned -- the same convergence every other grant migration since 0237
-- relies on. The role may not exist either, so the grant is guarded by its
-- existence.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    -- The nine columns `loopAllowanceForOwner` reads, and nothing else. Each is
    -- named by one of its four queries; no column is here for symmetry.
    EXECUTE 'GRANT SELECT (tenant_id, pipeline_run_id, stage_ordinal, loop_index, source_job_id, '
      || 'execution_job_id, advanced_at, delegation_cost_state, delegation_cost_microusd) '
      || 'ON pipeline_advance_receipts TO control_room_private_web';
  END IF;
END $$;
