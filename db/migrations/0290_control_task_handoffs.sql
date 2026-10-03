-- 0290: the text a worker is actually handed, per job.
--
-- THE BUG THIS FIXES. The canonical domain stores ONE request per workflow, and
-- a pipeline run's three stage jobs all share it. `instantiate` therefore wrote
-- the shared template description into that one request and every stage job, so
-- all three stages carried identical instructions. The fleet gateway -- the only
-- route the installed Mac uses since da1fc5f6a ("Offer to other machines") --
-- hands the worker `control_requests.payload->>'objective'`, so a bot claiming the
-- CHECK stage was told "Complete one bounded change." and never saw the CHECK
-- stage's own authenticated description. Measured on real PostgreSQL 17 before
-- this migration: the claim view returned the shared objective only, with no
-- stage marker present anywhere in the bytes the bot received.
--
-- The same loss hit approved acceptance requirements: an owner-approved batch
-- item's `acceptance_criteria` and `acceptance_tests` live on
-- `work_batch_items`, which no read on the connector route consulted, so the
-- bot could not see what "done" meant.
--
-- WHY A NEW TABLE RATHER THAN THE REQUEST. `control_requests` is one row per
-- workflow and is guarded by `validate_control_payload_mirror` plus 0041's
-- proposal trigger; a per-job instruction cannot live there without breaking
-- that mirror and changing the proposal digest every existing prepared plan and
-- stored replay is bound to. The job payload is likewise write-once lineage.
--
-- WHY NOT `pipeline_stage_runs`. That table is only populated for pipeline
-- stages, and the acceptance-criteria case is a batch item, not a stage. One
-- table covers both, and any future job that composes instructions the same way.
--
-- WRITE ONCE, BY THE OWNER'S OWN LOGIN, AT PROPOSE TIME. The row is inserted in
-- the same transaction that creates the job, by the one login already authorised
-- to create that job: the private web login. It authors all three sources --
-- an ordinary proposal, each pipeline stage, and an owner-approved batch item
-- (whose acceptance criteria and tests it reads from work_batch_items in that
-- same transaction). Nothing writes it afterwards: there is no UPDATE grant on
-- it for any role, so a later stage, the gateway, or the coordinator cannot
-- rewrite what a worker was told.
--
-- The text is bound to its job by `instructions_digest`, so the owner-side
-- reader and the gateway read the SAME bytes the authorising transaction stored.
-- A row whose digest does not match its text is not read at all: the reader
-- falls back to the legacy request objective rather than sending text that no
-- authorisation vouches for.
--
-- SCOPE. One table, INSERT by the two authoring logins, SELECT by the three
-- that display or deliver task text (private web, fleet gateway, and the task
-- coordinator). No UPDATE and no DELETE for any role -- the record is append-only
-- for the life of the job, and `db/down/0290` revokes exactly these grants.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_task_handoffs (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  project_id text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  instructions text NOT NULL CHECK (length(instructions) BETWEEN 1 AND 4000),
  acceptance_criteria text CHECK (acceptance_criteria IS NULL OR length(acceptance_criteria) BETWEEN 1 AND 4000),
  acceptance_tests text CHECK (acceptance_tests IS NULL OR length(acceptance_tests) BETWEEN 1 AND 4000),
  stage_kind text CHECK (stage_kind IS NULL OR stage_kind IN ('plan','build','check','signoff','effect')),
  stage_ordinal bigint CHECK (stage_ordinal IS NULL OR stage_ordinal>=0),
  instructions_digest text NOT NULL CHECK (instructions_digest ~ '^sha256:[a-f0-9]{64}$'),
  authored_by_identity_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, job_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, job_id, project_id) REFERENCES control_jobs(tenant_id, id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, authored_by_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT
);

-- The instruction text may never change once written: it is what a worker was
-- authorised to be told. PostgreSQL enforces this rather than any application
-- code, because the two authoring logins and the two readers are separate
-- processes on separate machines.
CREATE FUNCTION guard_control_task_handoff_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'task handoff instructions are write-once';
END $$;
REVOKE ALL ON FUNCTION public.guard_control_task_handoff_immutable() FROM PUBLIC;
CREATE TRIGGER control_task_handoffs_immutable BEFORE UPDATE OR DELETE ON public.control_task_handoffs
  FOR EACH ROW EXECUTE FUNCTION public.guard_control_task_handoff_immutable();

CREATE INDEX control_task_handoffs_project ON control_task_handoffs(tenant_id, project_id);

-- The two logins that author task text, and the three that read or deliver it.
-- Guarded by role existence because several suites apply migrations to a
-- role-less database. The role files remain the authoritative statement; a
-- database provisioned before them keeps the older ACL until it is reprovisioned.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT INSERT, SELECT ON control_task_handoffs TO control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    EXECUTE 'GRANT SELECT ON control_task_handoffs TO control_room_fleet_gateway';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT ON control_task_handoffs TO control_room_task_coordinator';
  END IF;
END $$;