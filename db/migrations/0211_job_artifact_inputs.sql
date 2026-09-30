-- "Save to my Mac", part 2 (plan v4.3 §2.6 + §2.3, MIG-D): combine inputs.
--
-- §2.3: "The combine part waits until every input part is accepted and its
-- files are on the Mac", and "a combine job becomes ready only when every
-- predecessor has a completion-gate accepted result and every declared input
-- file is bound by digest". This migration is that binding, and it is two
-- tables because the two halves happen at different times:
--
--   control_task_declared_inputs   the OWNER's declaration, at approval: this
--                                 part needs this file, from that part, by
--                                 that name. No digest — none exists yet.
--   control_job_artifact_inputs    the BINDING, at production: that declared
--                                 input resolved to this exact file, digest
--                                 and size, because that is what the producer
--                                 published and the owner accepted.
--
-- "Unreviewed bytes are never combined" is the rule that shapes the binding
-- guard. A binding is refused unless the producer's result SET is accepted —
-- `retention_state='retained'`, which 0207 already makes a grant-checked owner
-- act naming the accepting identity. So a combine job's input is always a file
-- the owner has already reviewed and accepted, and there is no path by which an
-- unreviewed, quarantined, missing or merely-uploaded file becomes a combine
-- input.
--
-- The one hole this closes against plan §2.6 H2 — "Input downloads for a
-- combine part could name any digest" — is closed by the binding being DERIVED
-- rather than by the gateway lacking a grant. The binding row carries
-- project_id, source_set_id, file_id, display_name, size_bytes and
-- content_digest, and the insert guard OVERWRITES all six from the accepted
-- catalog row rather than comparing what a caller sent. So a caller cannot bind
-- a digest that is not the file's, a size that is not its size, a name that is
-- not its name, or a project that is not its project: the value it supplied is
-- simply gone, and what the row holds is a fact about the catalog.
--
-- That matters for the gateway, which will serve
-- `GET /fleet/v1/claims/:id/inputs`. It reads this one table, and the byte
-- store's storage key is derived from exactly the columns this table holds, so
-- it never has to be told a storage key at all. The gateway DOES hold SELECT on
-- the catalog — 0209's reservation guard is SECURITY INVOKER and reads it, and a
-- guard that could not read what it checks would fail closed on every honest
-- reservation — so the H2 property is carried by the derivation and by the
-- per-claim project scope, not by an absent privilege. See the note in
-- db/roles/fleet_gateway_roles.sql, which says the same thing at the place a
-- reader of the grants will actually find it.
--
-- Readiness is enforced here too, on the canonical job row, so a combine part
-- cannot go ready or running with a hole in its inputs even if a caller forgets
-- to check. It is a no-op for every job with no declared inputs, so no existing
-- path changes shape.
--
-- Every guard is SECURITY INVOKER and inlines its checks, as 0206-0209 do. No
-- login gains EXECUTE on anything new.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Declared inputs: the owner's statement of what a part needs
-- ---------------------------------------------------------------------------

CREATE TABLE control_task_declared_inputs (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  -- The CONSUMER: the combine part that waits.
  job_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 32),
  -- The PRODUCER: the part whose accepted files this one combines. Same project,
  -- which the foreign key below enforces positionally rather than by a trigger.
  producer_job_id text NOT NULL,
  -- The name the consumer asked for, not a path. It is matched against the
  -- producer's published catalog row's display name, so a producer cannot
  -- satisfy a declaration with a file of a different name — which is the same
  -- rule the owner saw on the approval screen.
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120
    AND display_name !~ '[[:cntrl:]]' AND display_name !~ '[/\\]'
    AND display_name !~ '"' AND display_name !~ '\.\.' AND display_name !~ '^\.'
    AND display_name ~ '^[A-Za-z0-9]'),
  decided_by_identity_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, job_id, ordinal),
  UNIQUE (tenant_id, job_id, display_name),
  FOREIGN KEY (tenant_id, job_id, project_id) REFERENCES control_jobs(tenant_id, id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, producer_job_id, project_id) REFERENCES control_jobs(tenant_id, id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, decided_by_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  CHECK (producer_job_id <> job_id),
  CHECK (decided_by_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  CHECK (created_at <= pg_catalog.statement_timestamp() + interval '1 minute')
);
CREATE INDEX control_task_declared_inputs_producer
  ON control_task_declared_inputs(tenant_id, producer_job_id, job_id, ordinal);

-- The declaration is the owner's, and it may only be made while the consuming
-- job has not started — the same rule as 0209's declared outputs, for the same
-- reason: nothing a machine does can change the promise after the fact. It also
-- names a real dependency, because §2.3's graph is exactly that: a combine part
-- depends on every part whose files it combines. A declaration naming a producer
-- the consumer does not depend on would be a claim no scheduler enforces.
CREATE FUNCTION guard_task_declared_input_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE job_state text;
BEGIN
  SELECT j.state INTO job_state FROM public.control_jobs j
    WHERE j.tenant_id=NEW.tenant_id AND j.id=NEW.job_id AND j.project_id=NEW.project_id;
  IF job_state IS NULL OR job_state NOT IN ('proposed','ready') THEN
    RAISE EXCEPTION 'task declared input rejected' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.control_identities i
      JOIN public.control_role_grants g ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.decided_by_identity_id
        AND i.actor_type='human' AND i.state='active'
        AND g.role_key='owner' AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>NEW.created_at)
        AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'tasks.write')
        AND (g.project_ids ? '*' OR g.project_ids ? NEW.project_id)
        AND NEW.created_at <= pg_catalog.statement_timestamp()+interval '1 minute'
        AND NEW.created_at >= pg_catalog.statement_timestamp()-interval '5 minutes') THEN
    RAISE EXCEPTION 'task declared input needs the owner' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.control_job_dependencies d
      WHERE d.tenant_id=NEW.tenant_id AND d.job_id=NEW.job_id AND d.depends_on_job_id=NEW.producer_job_id) THEN
    RAISE EXCEPTION 'task declared input rejected: not a declared dependency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_task_declared_input_insert() FROM PUBLIC;
CREATE TRIGGER control_task_declared_inputs_guard BEFORE INSERT ON control_task_declared_inputs
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_declared_input_insert();

CREATE TRIGGER control_task_declared_inputs_no_update BEFORE UPDATE ON control_task_declared_inputs
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_task_declared_inputs_no_delete BEFORE DELETE ON control_task_declared_inputs
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_task_declared_inputs_no_truncate BEFORE TRUNCATE ON control_task_declared_inputs
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- The binding: an accepted file, bound to the consumer that declared it
-- ---------------------------------------------------------------------------

CREATE TABLE control_job_artifact_inputs (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  consumer_job_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 32),
  producer_job_id text NOT NULL,
  project_id text NOT NULL,
  -- The set the bytes came from, and the file within it. Together they are the
  -- identity a reader resolves, never a digest alone.
  source_set_id text NOT NULL,
  file_id text NOT NULL,
  -- DERIVED FROM THE CATALOG ROW, never from the caller: the four columns the
  -- byte store's storage key is computed from, plus the name the owner sees.
  -- See the header for why this is the H2 answer rather than a convenience.
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120
    AND display_name !~ '[[:cntrl:]]' AND display_name !~ '[/\\]'
    AND display_name !~ '"' AND display_name !~ '\.\.' AND display_name !~ '^\.'
    AND display_name ~ '^[A-Za-z0-9]'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 268435456),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  bound_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, consumer_job_id, ordinal),
  -- One file per declared ordinal, and one declaration per display name, so the
  -- binding cannot answer a declaration twice with two different files.
  UNIQUE (tenant_id, consumer_job_id, display_name),
  UNIQUE (tenant_id, file_id, consumer_job_id),
  FOREIGN KEY (tenant_id, consumer_job_id) REFERENCES control_jobs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, producer_job_id) REFERENCES control_jobs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_set_id) REFERENCES control_result_file_sets(tenant_id, set_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, file_id) REFERENCES control_result_files(tenant_id, file_id) ON DELETE RESTRICT,
  CHECK (bound_at <= pg_catalog.statement_timestamp() + interval '1 minute')
);
-- The gateway's read: everything bound for one consumer job, in ordinal order.
CREATE INDEX control_job_artifact_inputs_consumer
  ON control_job_artifact_inputs(tenant_id, consumer_job_id, ordinal);
-- The publisher's write: which declared inputs this producer still owes.
CREATE INDEX control_job_artifact_inputs_producer
  ON control_job_artifact_inputs(tenant_id, producer_job_id, ordinal);

-- The binding guard. The caller's only part is the ORDINAL of a declaration it
-- has already had recorded; everything else is derived, and "unreviewed bytes
-- are never combined" is what makes it derivable.
--
-- The search is deliberately ORDERED and SINGLE: exactly one file can satisfy a
-- declaration. A producer with two accepted sets holding the same display name
-- for the same job binds the earlier one, deterministically, and a second
-- binding of the same ordinal is refused by the primary key rather than
-- silently choosing a different file.
CREATE FUNCTION guard_job_artifact_input_insert() RETURNS trigger
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE declared public.control_task_declared_inputs%ROWTYPE; source_set text; source_file text;
  source_project text; source_name text; source_size bigint; source_digest text;
BEGIN
  SELECT * INTO declared FROM public.control_task_declared_inputs d
    WHERE d.tenant_id=NEW.tenant_id AND d.job_id=NEW.consumer_job_id AND d.ordinal=NEW.ordinal;
  IF declared.ordinal IS NULL THEN
    RAISE EXCEPTION 'job artifact input rejected: not a declared input' USING ERRCODE = '23514';
  END IF;
  -- Which file is being bound is DERIVED: the declared name, in the producer
  -- job's own STORED and ACCEPTED set, in the declared project. A caller cannot
  -- choose, and cannot name a digest, a set, another job or another project.
  SELECT f.set_id, f.file_id, s.project_id, f.display_name, f.size_bytes, f.content_digest
    INTO source_set, source_file, source_project, source_name, source_size, source_digest
    FROM public.control_result_files f
    JOIN public.control_result_file_sets s ON s.tenant_id=f.tenant_id AND s.set_id=f.set_id
    WHERE f.tenant_id=NEW.tenant_id AND s.job_id=declared.producer_job_id
      AND s.project_id=declared.project_id AND s.source_kind='file-store'
      AND s.state='stored' AND s.retention_state='retained'
      AND f.display_name=declared.display_name AND f.state='stored'
    ORDER BY f.set_id COLLATE "C", f.ordinal LIMIT 1;
  IF source_file IS NULL THEN
    RAISE EXCEPTION 'job artifact input rejected: no accepted file with that name' USING ERRCODE = '23514';
  END IF;
  -- OVERWRITE, not compare. A caller that supplied a different digest, size,
  -- name, set, job or project here is not refused — its value is replaced by
  -- the one the catalog says, which is why there is nothing to compare. The
  -- foreign keys then prove the ids exist and are the right ids.
  NEW.producer_job_id := declared.producer_job_id;
  NEW.project_id := source_project;
  NEW.source_set_id := source_set;
  NEW.file_id := source_file;
  NEW.display_name := source_name;
  NEW.size_bytes := source_size;
  NEW.content_digest := source_digest;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_job_artifact_input_insert() FROM PUBLIC;
CREATE TRIGGER control_job_artifact_inputs_guard BEFORE INSERT ON control_job_artifact_inputs
  FOR EACH ROW EXECUTE FUNCTION public.guard_job_artifact_input_insert();

-- A binding is permanent. Re-pointing a combine job's input at a different file
-- after the combiner has started is exactly the "unreviewed bytes are combined"
-- failure §2.3 forbids, and a consumer's input set changing under a running job
-- is not a thing any honest path needs.
CREATE TRIGGER control_job_artifact_inputs_no_update BEFORE UPDATE ON control_job_artifact_inputs
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_job_artifact_inputs_no_delete BEFORE DELETE ON control_job_artifact_inputs
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_job_artifact_inputs_no_truncate BEFORE TRUNCATE ON control_job_artifact_inputs
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- Combine readiness
-- ---------------------------------------------------------------------------
-- §2.3: a combine job becomes ready only when every predecessor is accepted and
-- every declared input file is bound by digest. This is that rule on the
-- canonical job row, so it holds for every writer rather than for the one that
-- remembered to check: the claim path, the pipeline advance and a direct repair
-- all meet the same refusal.
--
-- It fires only on a move INTO 'ready' or 'running', because those are the two
-- states from which work actually starts, and 'running' is included for the
-- paths that start a job without passing through ready. A job with no declared
-- inputs is unaffected — the declaration count is 0 and the check is vacuous —
-- which is why this migration changes no existing behaviour.
--
-- It reads the TWO tables of this migration and nothing else, deliberately. A
-- guard on `control_jobs` runs for every role holding UPDATE on that table, so
-- reading the result catalog here would mean granting the whole catalog —
-- storage keys included — to the coordinator, the news coordinator and the web
-- login, purely so a trigger can look at it. "Accepted" is instead carried by
-- the binding itself: a binding row exists only for a file whose set the owner
-- accepted at that moment, and acceptance is a point-in-time fact. A later
-- retention sweep moving that set to trash does not un-accept the result the
-- owner's approval was given on, and refusing to start a job because a 90-day
-- sweep has since run would be a worse failure than the one this guard exists
-- to prevent.
CREATE FUNCTION guard_job_artifact_inputs_complete() RETURNS trigger
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE declared integer; bound integer;
BEGIN
  IF NEW.state NOT IN ('ready','running')
    OR NOT ((OLD.state,NEW.state) IN (('proposed','ready'),('proposed','running'),('ready','running'),
        ('orphaned','ready'),('failed','ready'),('cancelled','ready'),('running','ready'))) THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO declared FROM public.control_task_declared_inputs d
    WHERE d.tenant_id=NEW.tenant_id AND d.job_id=NEW.id;
  IF declared=0 THEN RETURN NEW; END IF;
  -- Every declared input bound exactly once, to the producer and the name it
  -- asked for. The binding guard proved the acceptance; this proves the count.
  SELECT count(*) INTO bound FROM public.control_task_declared_inputs d
    WHERE d.tenant_id=NEW.tenant_id AND d.job_id=NEW.id
      AND EXISTS (SELECT 1 FROM public.control_job_artifact_inputs a
        WHERE a.tenant_id=d.tenant_id AND a.consumer_job_id=d.job_id AND a.ordinal=d.ordinal
          AND a.producer_job_id=d.producer_job_id AND a.display_name=d.display_name);
  IF bound<>declared THEN
    RAISE EXCEPTION 'job declared inputs are not all bound to accepted files' USING ERRCODE = '23514';
  END IF;
  -- Every declared PRODUCER must have produced something the owner accepted: a
  -- combine part whose input part has bound nothing has nothing to combine,
  -- whatever the file count says. One binding per producer is the rule, because
  -- §2.3's gate is about the predecessor's result being accepted, not about how
  -- many files it produced.
  IF EXISTS (SELECT 1 FROM (SELECT DISTINCT d.producer_job_id FROM public.control_task_declared_inputs d
        WHERE d.tenant_id=NEW.tenant_id AND d.job_id=NEW.id) producer
      WHERE NOT EXISTS (SELECT 1 FROM public.control_job_artifact_inputs a
        WHERE a.tenant_id=NEW.tenant_id AND a.consumer_job_id=NEW.id AND a.producer_job_id=producer.producer_job_id)) THEN
    RAISE EXCEPTION 'job producers are not all accepted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_job_artifact_inputs_complete() FROM PUBLIC;
CREATE TRIGGER control_jobs_artifact_inputs_complete BEFORE UPDATE ON control_jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_job_artifact_inputs_complete();

REVOKE ALL ON control_task_declared_inputs, control_job_artifact_inputs FROM PUBLIC;
