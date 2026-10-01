-- 0211's combine-readiness guard must be satisfiable by the logins that move a
-- job into 'ready' or 'running'.
--
-- THE BUG THIS FIXES. 0211 hangs `guard_job_artifact_inputs_complete` off
-- `control_jobs` as a BEFORE UPDATE trigger, and that guard reads
-- control_task_declared_inputs and control_job_artifact_inputs. PostgreSQL
-- checks the caller's privilege on every relation a trigger's statements name,
-- as the INVOKER -- and 0211's guards are all SECURITY INVOKER by design, since
-- a definer would let a weak login read the owner's approval artefacts by
-- borrowing the guard's rights. So every login holding UPDATE on control_jobs'
-- state column must also be able to read those two tables, or the trigger
-- raises 42501 and the job can never start.
--
-- 0211 landed the trigger and granted the tables to the fleet gateway, the
-- private web login and (for 0209's sibling) the native publisher. It granted
-- nothing to the two logins that hold `UPDATE (state, version, payload,
-- updated_at) ON control_jobs`:
--
--   control_room_task_coordinator  -- the supervisor. `reconcileStalled` moves a
--     job running -> ready or running -> orphaned in exactly this statement, so
--     the sole fleet and local lease-expiry owner could not expire a lease at
--     all. Measured on real PostgreSQL 17 before this migration:
--     42501 permission denied for table control_task_declared_inputs, surfacing
--     in production as `database_unavailable` and leaving every stalled task
--     stranded in 'running' forever. A worker killed mid-job kept its task
--     leased until the installation was rebuilt.
--
--   control_room_news_coordinator -- the news coordinator, which holds the same
--     four columns. It was not exercised by the failing lane, but it is the same
--     42501 on the same statement and it would strand news work the same way.
--     The Mac-local owner does not run a news coordinator, which is why this one
--     is invisible until the VPS path; it is fixed here so the defect does not
--     survive on the branch that found it.
--
-- WHY A GRANT AND NOT A DEFiner. Making these guards SECURITY DEFINER would fix
-- both roles in one line and would hand every login holding UPDATE on
-- control_jobs a read of the owner's declared-output and declared-input
-- approvals -- the artefacts that decide what a machine may upload and what it
-- may combine -- through a function it cannot otherwise call. The two
-- declarations are owner decisions about a project's bytes; the coordinator is
-- a scheduler and the news coordinator is a feed runner. Neither needs that
-- read for its own work, and the grant below is strictly narrower: it conveys
-- exactly the two tables the guard already reads, and the columns are the same
-- ones the owner-facing pages read.
--
-- SCOPE. Two tables, SELECT only, no INSERT/UPDATE/DELETE. The coordinator
-- still cannot declare an input, bind a file, or re-point a binding: those
-- writes stay with the private web login, and 0211's own append-only and
-- derivation guards still apply to whoever holds them.
--
-- Same convergence as 0237 (the supervisor's read on control_effect_intents),
-- 0157 and 0046/0054/0087: the role file is the authoritative statement of the
-- grant, and a role file is only read when the module is provisioned, so an
-- installation provisioned before this file existed keeps the older ACL. The
-- role may not exist yet either -- several suites apply migrations to a
-- role-less database -- so each grant is guarded by the role's existence.
--
-- Read only, and only for the guard: an input declaration is written by the
-- owner at approval and a binding by the accept path. Neither is the
-- supervisor's or the news runner's to write.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT ON control_task_declared_inputs, control_job_artifact_inputs TO control_room_task_coordinator';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_news_coordinator') THEN
    EXECUTE 'GRANT SELECT ON control_task_declared_inputs, control_job_artifact_inputs TO control_room_news_coordinator';
  END IF;
END $$;
