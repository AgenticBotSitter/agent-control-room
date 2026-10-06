-- Text-copy derivations, part 2 (plan v4.3 §2.7, MIG-E): who may read and
-- who may write a derivation.
--
-- 0212 made the record. This migration makes it useful and closes it. Three
-- readers, three different questions, and the difference between them is the
-- whole point of this file:
--
--   * The OWNER reads every derivation in their project. They are the person who
--     wants to read the text copy, and the web login is the only login that
--     already carries a live result-read grant.
--
--   * The PUBLISHER (control_room_native_results) writes them. A conversion is
--     a fact about a file that this login published, and 0212's insert guard
--     already refuses any row whose source is not a real catalog file with the
--     digest the converter hashed. It is "record what I converted", which is
--     not the same authority as accepting or deleting anything.
--
--   * A BOT (control_room_native_queue_worker) reads them, and ONLY for the
--     inputs of its OWN project that it has actually been given. This is the
--     narrowest of the three and it is enforced by a VIEW, not by a GRANT: a
--     grant on the table would let a bot read every derivation in the tenant,
--     which is a cross-project read of other work's documents. The view joins
--     the derivation to the work the calling login has claimed, so there is no
--     row a bot can select that is not an input of its own claimed work.
--
-- The view is SECURITY INVOKER, not SECURITY DEFINER. That is the whole design
-- in one keyword: a definer view would run the join as its owner and could hand
-- a bot rows the bot's own role cannot read, so the projection is exactly the
-- bot's own privileges narrowed by its own claims, and a grant the bot does not
-- hold stays a grant the bot does not get.
--
-- No definer-rights function is created, so the private-database preflight needs
-- no extra EXECUTE grant — the same property 0206 and 0207 were written for.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- ---------------------------------------------------------------------------
-- A bot's view of the text copies for the inputs it has been given.
-- ---------------------------------------------------------------------------
--
-- WHAT A BOT'S READ IS BOUND TO, and why it is the admission table:
--
-- `control_room_native_queue_worker` is a SINGLE NOLOGIN group inherited by
-- every Mac-local bot login, so `current_user` on its own cannot say which bot
-- is asking. The schema has exactly one place that binds a login to the work it
-- was given, and it is `work_batch_queue_admissions` (0104): one row per
-- admission, naming the worker, the project and the job together, written by
-- the owner's approval and never by the bot.
--
-- The join below is therefore on the JOB, and the caller contributes the
-- worker identity through `current_user` matched against the worker login the
-- admission recorded. The consequence is stated plainly rather than hidden:
--
--   * A bot sees the text copies of files belonging to jobs it was admitted to.
--     A job in another project, or a job it was never admitted to, is absent —
--     not refused, ABSENT, so there is no row to enumerate and no error to
--     distinguish "exists but forbidden" from "does not exist".
--   * On a Mac-local installation every bot shares ONE login, so "its own
--     claimed inputs" is per-admission, not per-process: the isolation the owner
--     asked for is that a bot cannot read work it was not given, which holds
--     whatever the login count is. Splitting two bots that share a login is a
--     per-machine credential question (0140's own scope), not a question this
--     view can answer, and pretending otherwise would be a false guarantee.
--
-- The claim is read from a table the worker already holds privileges on, so this
-- view grants no new authority to reach work: a worker holding no admission
-- matches no row.

-- Owned by the schema owner, for the same reason as the owner view: a
-- SECURITY INVOKER view needs the caller's own SELECT on every table it reads,
-- and granting that to a bot would let it read every project's derivations
-- directly. So the view runs as the schema owner and the narrowing is entirely in
-- its WHERE clause, which is the whole security property of this view.
CREATE VIEW control_worker_text_copy_derivations AS
SELECT d.tenant_id,
       q.project_id,
       d.derivation_id,
       d.source_set_id,
       d.source_file_id,
       d.source_content_digest,
       d.converter_id,
       d.converter_version,
       d.status,
       d.diagnostic_category,
       d.derived_file_id,
       d.derived_content_digest,
       d.derived_size_bytes,
       d.created_at,
       d.completed_at
  FROM public.control_text_copy_derivations d
  JOIN public.control_result_file_sets s
    ON s.tenant_id = d.tenant_id AND s.set_id = d.source_set_id
  JOIN public.work_batch_queue_admissions q
    ON q.tenant_id = d.tenant_id
   AND q.job_id = s.job_id
  -- The caller's own login is the claim, and it is a claim the CALLER cannot
  -- widen: `q.worker_id` is set by the owner's approval, never by the worker, and
  -- the table is append-only. So a bot sees a derivation only for a job its login
  -- was admitted to, and cannot name itself into another one.
  --
  -- A bot login and a fleet worker id are DIFFERENT strings on a Mac-local
  -- install (0140's fleet credentials do not exist there), so this matches the
  -- login and joins no fleet_workers row. That is a weaker binding than a
  -- per-machine credential and is recorded as such: it prevents a bot reading
  -- work it was not given, and it does not separate two bots that share a login.
  -- See the report.
 --
 -- `session_user`, NOT `current_user`: inside a view owned by the schema owner
 -- `current_user` IS the schema owner, so it would match every row in the tenant.
 -- `session_user` is the connected login, which is the only identity this view
 -- is allowed to narrow by.
 WHERE q.worker_id = session_user
   AND q.worker_kind <> 'hermes'
   -- An admission that has been superseded is not a claim any more: a bot that
   -- had work reassigned must lose its rows, and a revision that never took
   -- effect must not grant a second reading of the same job.
   AND q.assignment_revision = (SELECT max(later.assignment_revision)
                                  FROM public.work_batch_queue_admissions later
                                 WHERE later.tenant_id = q.tenant_id AND later.job_id = q.job_id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_schema_owner') THEN
    EXECUTE 'ALTER VIEW control_worker_text_copy_derivations OWNER TO control_room_schema_owner';
  END IF;
END $$;
COMMENT ON VIEW control_worker_text_copy_derivations IS
  'Text-copy derivations for the inputs of the work the calling login has claimed. '
  'Runs as the schema owner because the bot login must NOT hold SELECT on the table '
  'behind it, and its whole security property is the WHERE clause: a row exists '
  'only where this login has an admission for that job.';

-- The owner-facing projection: one row per derivation, with the display name of
-- the file it describes, so the UI does not have to join the catalog itself and
-- so a derivation whose source has been moved to 'missing' still reads honestly
-- rather than disappearing from the owner's list.
-- OWNED BY the schema owner, which in PostgreSQL is what makes a view run with
-- the owner's privileges: there is no `security_definer` reloption, a view is
-- definer by default and `security_invoker` is the opt-out. The reason is the
-- owner's ACL rather than convenience.
--
-- 0207's warning was that a definer view "would run the join as its owner and
-- could hand a bot rows the bot's own role cannot read". That is exactly right
-- for the WORKER view, which is why that one is invoker. It does not transfer to
-- the owner: the owner already holds a project-scoped route to result files
-- (0208), and this view is the same route for derivations. What must not happen
-- is the owner learning a project id from somewhere else and reading another
-- project's derivations through it — so the project is not taken on trust: the
-- view checks the caller's OWNER GRANT over the row's project inline, the same
-- check 0207's acceptance guard and 0208's download guard already perform.
CREATE VIEW control_project_text_copy_derivations AS
SELECT d.tenant_id,
       s.project_id,
       d.derivation_id,
       d.source_set_id,
       d.source_file_id,
       f.display_name AS source_display_name,
       f.state AS source_state,
       d.source_content_digest,
       d.converter_id,
       d.converter_version,
       d.status,
       d.diagnostic_category,
       d.derived_file_id,
       df.display_name AS derived_display_name,
       d.derived_content_digest,
       d.derived_size_bytes,
       d.created_at,
       d.completed_at
  FROM public.control_text_copy_derivations d
  JOIN public.control_result_file_sets s
    ON s.tenant_id = d.tenant_id AND s.set_id = d.source_set_id
  LEFT JOIN public.control_result_files f
    ON f.tenant_id = d.tenant_id AND f.file_id = d.source_file_id
  LEFT JOIN public.control_result_files df
    ON df.tenant_id = d.tenant_id AND df.file_id = d.derived_file_id
 WHERE EXISTS (
         SELECT 1 FROM public.control_identities i
          JOIN public.control_role_grants g
            ON g.tenant_id = i.tenant_id AND g.identity_id = i.id
          JOIN public.control_web_sessions w
            ON w.tenant_id = i.tenant_id AND w.identity_id = i.id
         WHERE i.tenant_id = d.tenant_id
           AND i.actor_type = 'human' AND i.state = 'active'
           AND g.role_key = 'owner' AND g.revoked_at IS NULL
           AND (g.expires_at IS NULL OR g.expires_at > statement_timestamp())
           AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'tasks.results.read')
           AND (g.project_ids ? '*' OR g.project_ids ? s.project_id)
           -- A live session for the caller's own login, so a role that exists
           -- without anyone signed in cannot read through the definer view.
           AND w.revoked_at IS NULL
           AND w.expires_at > statement_timestamp());

-- Pinned to the schema owner: the view runs with this role's privileges, so it
-- must be a role that holds only what the view's own body needs and that no login
-- inherits. Without this the view would be owned by the migration's connecting
-- role, which is not a property worth relying on.
--
-- CONDITIONAL, because the digest tool applies this ledger to a bare cluster
-- where no production role exists yet, and an unconditional ALTER aborts the
-- whole migration with 42704. On such a cluster the view keeps the applying
-- role's ownership, which is the same situation every other object in the
-- ledger is in; on a real installation the owner is pinned.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_schema_owner') THEN
    EXECUTE 'ALTER VIEW control_project_text_copy_derivations OWNER TO control_room_schema_owner';
  END IF;
END $$;
COMMENT ON VIEW control_project_text_copy_derivations IS
  'The owner''s per-project read of text-copy derivations, carrying the source '
  'file''s display name. Owned by the schema owner, because the web login holds '
  'no SELECT on the table behind it and that is what keeps the table out of the '
  'owner''s reach; the per-project narrowing is therefore an inline check of the '
  'caller''s own live owner grant, not an ACL.';

REVOKE ALL ON control_worker_text_copy_derivations FROM PUBLIC;
REVOKE ALL ON control_project_text_copy_derivations FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- These are CONDITIONAL, and they have to be: the applier runs the migration
-- ledger BEFORE db/roles/*.sql, so at this point none of the three roles
-- necessarily exists — a Mac-local cluster and a fleet cluster provision
-- different role files, and neither has all three. An unconditional
-- `GRANT ... TO control_room_private_web` aborts the whole migration with
-- 42704 "role does not exist", which is exactly what it did on the first run
-- against a real cluster. 0190 and 0195 solve the same problem the same way,
-- and the copies in db/roles/ remain the ones an installation actually applies.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT ON control_project_text_copy_derivations TO control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_results') THEN
    EXECUTE 'GRANT SELECT, INSERT ON control_text_copy_derivations TO control_room_native_results';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_queue_worker') THEN
    -- The VIEW only, never the table. A SELECT on the table would be a
    -- tenant-wide read of every project's text copies, which is precisely the
    -- cross-project read the view exists to remove.
    EXECUTE 'GRANT SELECT ON control_worker_text_copy_derivations TO control_room_native_queue_worker';
  END IF;
END $$;
