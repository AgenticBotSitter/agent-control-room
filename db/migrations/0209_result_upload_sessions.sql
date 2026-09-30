-- "Save to my Mac", part 2 (plan v4.3 §2.6, MIG-D): chunked upload ingress.
--
-- Part 1 (0206-0208) built the catalog, the byte store and the owner download.
-- This migration builds the way bytes GET THERE from a remote machine.
--
-- The shape is a promise, kept by three tables:
--
--   control_task_declared_outputs    what the OWNER approved this part may
--                                    produce. Frozen before the claim, so
--                                    "only declared outputs" is a fact about
--                                    the plan and not a request field.
--   control_result_upload_sessions   one reserved upload per declared output:
--                                    the expected size and SHA-256, the chunk
--                                    size (8 MiB by default) and the exact
--                                    number of chunks those two imply.
--   control_result_upload_chunks     the chunks as they arrive, each with its
--                                    own digest, create-once and never edited.
--
-- The refusals the plan asks for, and where each one lives:
--
--   * A live approved claim reserves an upload. The reservation guard
--     re-checks the claim with 0140's own `fleet_claim_is_live`, so a revoked
--     worker, an elapsed lease, an expired credential or a released claim
--     cannot reserve — and the same predicate guards every chunk, so a claim
--     that dies mid-upload stops mid-upload rather than at finalise.
--   * 8 MiB chunks. `expected_chunks` is a CONSTRAINT derived from the expected
--     size and the chunk size, so "the last chunk is short" is arithmetic the
--     database checks rather than a convention the connector follows. A
--     reservation past 32 chunks is refused, which is also the 256 MiB ceiling.
--   * Exact retries are idempotent. A chunk is create-once: the same ordinal
--     with the same digest and size replays, anything else is a conflict. The
--     session row is the idempotency key for the reservation, so a retried
--     reserve returns the same upload rather than a second one.
--   * Conflicting bytes refuse. Two shapes, both structural: a second chunk for
--     an ordinal already taken is a primary-key conflict, and a finalise whose
--     chunks do not exactly tile the promised size is refused by the session's
--     update guard.
--   * Pause blocks NEW reservations. 0156's mode rule is read inline here, so a
--     paused or draining installation refuses a reserve exactly as it refuses a
--     claim. DRAINING does not void what is already reserved — that is what
--     draining means — and Stop is the one that voids.
--   * Stop voids them. There is a VOIDED state with a reason, one-way, and the
--     only way out of it is a new attempt. Voided bytes are never referenced by
--     a catalog row, because a PUBLISHED session is what moves a catalog file
--     to 'stored' (0211).
--   * A manifest publishes only when every promised file is present and
--     verified. That is 0206's existing deferred completeness trigger, reached
--     here because a set's files are declared at RESERVATION and each becomes
--     'stored' only through its own published session. Nothing in this
--     migration can move a set to 'stored'.
--
-- One binding worth stating plainly: a session names a catalog file by
-- (set, ordinal), and the reservation guard pins its size and digest to THAT
-- FILE'S OWN declared row. A caller cannot reserve an upload for a name or a
-- digest the owner did not approve, because it is not supplying either — it
-- restates them, and the guard compares.
--
-- Every guard is SECURITY INVOKER and inlines its checks, exactly as 0206-0208
-- do. No login gains EXECUTE on anything new, so the private-database preflight
-- needs no new pinned boundary and no new definer-rights function.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Declared outputs
-- ---------------------------------------------------------------------------
-- What a part may produce. This is the owner's approval artefact for §2.6's
-- "the connector uploads only files listed in the part's declared outputs", and
-- it is why a worker cannot widen what it uploads by editing a request.

-- VOLATILITY, for every trigger function in 0209-0211.
--
-- Each of these guards is a BEFORE trigger that reads rows the guarding
-- statement's OWN transaction may have just written: a chunk row inserted by the
-- same transaction that marks its session received, a publication row the same
-- transaction that marks a file stored, a binding the same transaction that
-- moves a job to ready. A STABLE function takes its snapshot at the start of the
-- statement that called it and is trusted to see a consistent view, so it cannot
-- see those writes - and a guard written that way does not fail loudly. It
-- answers "no such row" for a row that exists, and the protection it was written
-- to provide is simply absent.
--
-- 0210's per-file guard is the case that proved it. Marked STABLE, it never
-- fired at all: not for the fleet gateway, and not for the schema owner either,
-- so the "a file cannot be stored without a published upload" refusal was being
-- asserted by a test that was passing for an unrelated reason. VOLATILE is the
-- honest volatility for a BEFORE trigger, and the cost is one indexed existence
-- check per guarded row.
--
CREATE TABLE control_task_declared_outputs (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  job_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 32),
  -- The same display-name grammar 0206 refuses, for the same reason: this value
  -- reaches a Content-Disposition header and a page, and never a path.
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120
    AND display_name !~ '[[:cntrl:]]' AND display_name !~ '[/\\]'
    AND display_name !~ '"' AND display_name !~ '\.\.' AND display_name !~ '^\.'
    AND display_name ~ '^[A-Za-z0-9]'),
  declared_media_type text NOT NULL CHECK (declared_media_type IN
    ('text/plain','text/markdown','text/csv','text/html','application/json','image/png','image/jpeg',
     'image/gif','image/webp','application/pdf','application/zip','application/octet-stream')),
  -- WHO approved this output, so the guard below can check that identity's live
  -- owner grant rather than trusting the caller's claim to be the owner.
  decided_by_identity_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, job_id, ordinal),
  -- Two declared outputs may not share a name: the owner's "download all" and
  -- the owner's Project Files list both key on it.
  UNIQUE (tenant_id, job_id, display_name),
  FOREIGN KEY (tenant_id, job_id, project_id) REFERENCES control_jobs(tenant_id, id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, decided_by_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  CHECK (decided_by_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  CHECK (created_at <= pg_catalog.statement_timestamp() + interval '1 minute')
);
CREATE INDEX control_task_declared_outputs_project
  ON control_task_declared_outputs(tenant_id, project_id, job_id, ordinal);

-- A declaration is part of the owner's approval: a live human owner with a
-- write grant over this project, and only while the job has not started. The
-- state list is deliberately narrow — a 'proposed' or 'ready' job has not been
-- claimed, so nothing a machine can do changes the promise after the fact, and
-- a job already running cannot grow its output list underneath a live claim.
CREATE FUNCTION guard_task_declared_output_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE job_state text;
BEGIN
  SELECT j.state INTO job_state FROM public.control_jobs j
    WHERE j.tenant_id=NEW.tenant_id AND j.id=NEW.job_id AND j.project_id=NEW.project_id;
  IF job_state IS NULL OR job_state NOT IN ('proposed','ready') THEN
    RAISE EXCEPTION 'task declared output rejected' USING ERRCODE = '23514';
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
    RAISE EXCEPTION 'task declared output needs the owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_task_declared_output_insert() FROM PUBLIC;
CREATE TRIGGER control_task_declared_outputs_guard BEFORE INSERT ON control_task_declared_outputs
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_declared_output_insert();

-- A declaration is frozen. A worker, a retry or a later plan revision cannot
-- rename an output, retype it, move it to another job, re-order it or
-- re-attribute it. A changed plan needs a new job.
CREATE TRIGGER control_task_declared_outputs_no_update BEFORE UPDATE ON control_task_declared_outputs
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_task_declared_outputs_no_delete BEFORE DELETE ON control_task_declared_outputs
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_task_declared_outputs_no_truncate BEFORE TRUNCATE ON control_task_declared_outputs
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- Upload sessions
-- ---------------------------------------------------------------------------

CREATE TABLE control_result_upload_sessions (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  upload_id text NOT NULL CHECK (upload_id ~ '^result-upload:[a-f0-9]{32}$'),
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  -- The set this upload is one file OF. A set is one attempt's promise, so the
  -- session, the set and the attempt cannot come from three different attempts.
  set_id text NOT NULL,
  -- Ordinal within that set. The file id, display name, media types and digest
  -- are the CATALOG ROW's, reached through this ordinal, and the reservation
  -- guard pins the promise below to that row.
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 32),
  -- Fleet-only in v1. The native path already publishes through the local result
  -- publisher's own transaction (0206-0208) and needs no reservation; making
  -- that structural beats making it a convention.
  producer_kind text NOT NULL DEFAULT 'fleet' CHECK (producer_kind = 'fleet'),
  worker_id text NOT NULL CHECK (worker_id ~ '^fleet-worker:[a-f0-9]{32}$'),
  claim_id text NOT NULL CHECK (claim_id ~ '^fleet-claim:[a-f0-9]{32}$'),
  -- The promise. Both are checked against the declared catalog row below, so a
  -- caller cannot reserve a different size or digest than the owner approved.
  -- Zero is allowed because an empty file is a real deliverable; it implies zero
  -- chunks, which the CHECK below derives rather than a caller states.
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes BETWEEN 0 AND 268435456),
  expected_content_digest text NOT NULL CHECK (expected_content_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- 8 MiB is the plan's chunk size and the default the connector uses; a
  -- smaller one is allowed so a small file needs no 8 MiB round trip, and a
  -- larger one is not.
  chunk_size_bytes integer NOT NULL CHECK (chunk_size_bytes BETWEEN 1 AND 8388608),
  -- CONSTRAINT, not a convention: the chunk count IS the ceiling on the promise,
  -- and it is the size divided by the chunk size, rounded up. Past 32 is the
  -- 256 MiB ceiling restated, so the two can never disagree.
  expected_chunks integer NOT NULL CHECK (expected_chunks BETWEEN 0 AND 32
    AND expected_chunks = ((expected_size_bytes + chunk_size_bytes - 1) / chunk_size_bytes)),
  state text NOT NULL CHECK (state IN ('reserved','received','published','voided')),
  void_reason text CHECK (void_reason IN ('stopped','expired','abandoned','content_mismatch')),
  created_at timestamptz NOT NULL,
  -- 24 hours, as the plan's abandoned-upload retention. An upload nobody
  -- finishes stops being a promise the installation is still holding open, and
  -- the chunk guard refuses its bytes rather than waiting for a sweeper.
  expires_at timestamptz NOT NULL,
  received_at timestamptz,
  published_at timestamptz,
  voided_at timestamptz,
  PRIMARY KEY (tenant_id, upload_id),
  -- One upload per set ordinal, and one per catalog file: a second reservation
  -- for the same promised file is a conflict, not a second attempt.
  UNIQUE (tenant_id, set_id, ordinal),
  FOREIGN KEY (tenant_id, job_id, project_id) REFERENCES control_jobs(tenant_id, id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES control_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, set_id) REFERENCES control_result_file_sets(tenant_id, set_id) ON DELETE RESTRICT,
  -- Bound to the exact declared row, not merely to a set: the promise is
  -- checked against the owner's approved name, type, size and digest below.
  FOREIGN KEY (tenant_id, set_id, ordinal) REFERENCES control_result_files(tenant_id, set_id, ordinal) ON DELETE RESTRICT,
  -- Each timestamp marks a stage that was REACHED, so a void never erases
  -- the stage before it: a session that was received and is then voided keeps
  -- `received_at`, and a reader can still see how far the bytes got. The
  -- one-way edges and the absence of a rewind are the trigger's job, because a
  -- CHECK cannot see OLD; these say a stage's stamp exists exactly when the
  -- session is at or past that stage, and never for a session still reserved.
  CHECK (state<>'reserved' OR (received_at IS NULL AND published_at IS NULL AND voided_at IS NULL)),
  CHECK (published_at IS NULL OR received_at IS NOT NULL),
  CHECK (voided_at IS NULL OR (received_at IS NOT NULL OR published_at IS NULL)),
  -- A void is terminal and never coexists with a publication: a published set
  -- is already the owner's, and un-publishing it is not a thing any path does.
  CHECK (NOT (state='voided' AND published_at IS NOT NULL)),
  -- The reverse, and the one that makes "Stop voids a half-sent upload"
  -- possible: voiding a RECEIVED session leaves its received_at in place.
  CHECK (NOT (state='received' AND voided_at IS NOT NULL)),
  CHECK (voided_at IS NULL OR voided_at>=created_at
    AND voided_at<=pg_catalog.statement_timestamp()+interval '1 minute'),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CHECK (created_at <= pg_catalog.statement_timestamp() + interval '1 minute'),
  CHECK (received_at IS NULL OR (received_at >= created_at AND received_at <= expires_at)),
  CHECK (published_at IS NULL OR (published_at >= created_at AND published_at <= expires_at))
);
-- The gateway's two hot reads: "what is live for this claim" and "what is
-- still open for the sweeper".
CREATE INDEX control_result_upload_sessions_claim
  ON control_result_upload_sessions(tenant_id, claim_id, ordinal);
CREATE INDEX control_result_upload_sessions_open
  ON control_result_upload_sessions(tenant_id, expires_at) WHERE state='reserved';

-- The reservation guard: the one place a new upload may come into being, and
-- where the claim, the plan and the installation's mode are checked together.
--
-- The mode read is 0156's own rule, inlined: no recorded revision means
-- running, because the absence of an owner decision is not a decision. PAUSED
-- and DRAINING refuse a new reservation; DRAINING does not void what is already
-- reserved, which is what draining means.
CREATE FUNCTION guard_result_upload_session_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mode text; declared public.control_task_declared_outputs%ROWTYPE; owner_file public.control_result_files%ROWTYPE;
BEGIN
  -- 1. A live approved claim, re-checked here rather than taken on trust from
  --    the caller: the same predicate 0140 uses for events and results.
  IF NOT public.fleet_claim_is_live(NEW.tenant_id,NEW.claim_id,NEW.worker_id) THEN
    RAISE EXCEPTION 'result upload session rejected' USING ERRCODE = '42501';
  END IF;
  -- 2. The claim IS this work: same project, job and attempt. A live claim over
  --    some other job cannot reserve an upload for this one.
  IF NOT EXISTS (SELECT 1 FROM public.fleet_claims fc
      WHERE fc.tenant_id=NEW.tenant_id AND fc.claim_id=NEW.claim_id AND fc.worker_id=NEW.worker_id
        AND fc.project_id=NEW.project_id AND fc.job_id=NEW.job_id AND fc.attempt_id=NEW.attempt_id) THEN
    RAISE EXCEPTION 'result upload session rejected' USING ERRCODE = '42501';
  END IF;
  -- 3. Pause and Drain refuse a NEW reservation.
  SELECT m.mode INTO mode FROM public.installation_operations_mode_revisions m
    WHERE m.tenant_id=NEW.tenant_id ORDER BY m.revision DESC LIMIT 1;
  IF mode IS NOT NULL AND mode<>'running' THEN
    RAISE EXCEPTION 'installation operations mode % refuses a new upload reservation', mode
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- 4. The set is this attempt's own, is a fleet file-store set (a native-text
  --    set carries no store bytes and never has an upload), names this worker as
  --    its producer, and is still 'declared' — a set already stored, marked
  --    incomplete or quarantined takes no further uploads.
  IF NOT EXISTS (SELECT 1 FROM public.control_result_file_sets s
      WHERE s.tenant_id=NEW.tenant_id AND s.set_id=NEW.set_id AND s.project_id=NEW.project_id
        AND s.job_id=NEW.job_id AND s.attempt_id=NEW.attempt_id
        AND s.producer_kind='fleet' AND s.producer_id=NEW.worker_id AND s.source_kind='file-store'
        AND s.state='declared') THEN
    RAISE EXCEPTION 'result upload session rejected' USING ERRCODE = '23514';
  END IF;
  -- 5. The promised file is a declared output of this job, and this ordinal
  --    names a catalog row carrying exactly that name and type.
  SELECT * INTO declared FROM public.control_task_declared_outputs d
    WHERE d.tenant_id=NEW.tenant_id AND d.job_id=NEW.job_id AND d.ordinal=NEW.ordinal;
  SELECT * INTO owner_file FROM public.control_result_files f
    WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id AND f.ordinal=NEW.ordinal;
  IF declared.ordinal IS NULL OR owner_file.ordinal IS NULL
    OR owner_file.display_name IS DISTINCT FROM declared.display_name
    OR owner_file.declared_media_type IS DISTINCT FROM declared.declared_media_type THEN
    RAISE EXCEPTION 'result upload session rejected: not a declared output' USING ERRCODE = '23514';
  END IF;
  -- 6. The promise matches the approved promise. The size and the digest are
  --    the catalog row's; the caller restating them is a convenience, and this
  --    comparison is what makes a restatement safe.
  IF NEW.expected_size_bytes IS DISTINCT FROM owner_file.size_bytes
    OR NEW.expected_content_digest IS DISTINCT FROM owner_file.content_digest
    OR owner_file.state<>'declared' OR owner_file.stored_at IS NOT NULL THEN
    RAISE EXCEPTION 'result upload session rejected: promise differs from the declared file' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_upload_session_insert() FROM PUBLIC;
CREATE TRIGGER control_result_upload_sessions_guard BEFORE INSERT ON control_result_upload_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_upload_session_insert();

-- A session moves reserved -> received -> published, or -> voided. There is no
-- other edge: nothing rewinds, a published session is not unpublishable, and a
-- voided one is terminal.
--
-- 'received' is the proof that the chunks arrived: exactly the promised number
-- of them, tiling the promised size exactly, each the size its ordinal requires,
-- and the claim still live at that moment. It is checked here rather than in the
-- application because the application is the thing being checked.
CREATE FUNCTION guard_result_upload_session_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mode text;
BEGIN
  IF ROW(NEW.tenant_id,NEW.upload_id,NEW.project_id,NEW.job_id,NEW.attempt_id,NEW.set_id,NEW.ordinal,
      NEW.producer_kind,NEW.worker_id,NEW.claim_id,NEW.expected_size_bytes,NEW.expected_content_digest,
      NEW.chunk_size_bytes,NEW.expected_chunks,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.upload_id,OLD.project_id,OLD.job_id,OLD.attempt_id,OLD.set_id,
      OLD.ordinal,OLD.producer_kind,OLD.worker_id,OLD.claim_id,OLD.expected_size_bytes,
      OLD.expected_content_digest,OLD.chunk_size_bytes,OLD.expected_chunks,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.state,NEW.state) IN (('reserved','received'),('reserved','voided'),('received','published'),
      ('received','voided'))) THEN
    RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.state='voided' AND OLD.void_reason IS NOT NULL THEN
    RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.state='received' AND OLD.state='reserved' THEN
    -- The claim must still be live. An upload that outlives its claim does not
    -- become a promise the owner is ever shown.
    IF NOT public.fleet_claim_is_live(OLD.tenant_id,OLD.claim_id,OLD.worker_id) THEN
      RAISE EXCEPTION 'result upload session rejected' USING ERRCODE = '42501';
    END IF;
    IF NEW.received_at IS NULL OR NEW.received_at<OLD.created_at OR NEW.received_at>OLD.expires_at
      OR NEW.received_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
    END IF;
    -- The tiling. Ordinals 1..expected_chunks with no gaps (the primary key
    -- makes a gap and a duplicate the same refusal), no extras, each chunk the
    -- size its position requires, summing to exactly the promised size. The
    -- per-chunk size is the SAME expression the chunk guard and the table's own
    -- CHECK use, so the three cannot drift apart.
    IF (SELECT count(*) FROM public.control_result_upload_chunks c
          WHERE c.tenant_id=OLD.tenant_id AND c.upload_id=OLD.upload_id)<>OLD.expected_chunks
      OR (SELECT coalesce(sum(c.size_bytes),0) FROM public.control_result_upload_chunks c
          WHERE c.tenant_id=OLD.tenant_id AND c.upload_id=OLD.upload_id)<>OLD.expected_size_bytes
      OR EXISTS (SELECT 1 FROM public.control_result_upload_chunks c
          WHERE c.tenant_id=OLD.tenant_id AND c.upload_id=OLD.upload_id
            AND c.size_bytes IS DISTINCT FROM (CASE WHEN c.ordinal<OLD.expected_chunks
              THEN OLD.chunk_size_bytes::bigint
              ELSE OLD.expected_size_bytes-OLD.chunk_size_bytes::bigint*(OLD.expected_chunks-1) END)) THEN
      RAISE EXCEPTION 'result upload session update rejected: chunks do not tile the promise' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Publishing is what 0211 proves against the catalog; the only thing checked
  -- here is that the claim was still live when the bytes were declared whole.
  IF NEW.state='published' AND OLD.state='received' THEN
    IF NEW.published_at IS NULL OR NEW.published_at<OLD.received_at OR NEW.published_at>OLD.expires_at
      OR NEW.published_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state='voided' THEN
    IF NEW.voided_at IS NULL OR NEW.voided_at<OLD.created_at
      OR NEW.voided_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
    END IF;
    -- A worker's own void needs a live claim over this session: that is a
    -- worker giving up on its own upload, never one cancelling another's.
    -- The ONE void that needs no claim is Stop, because Stop is precisely the
    -- case where there is no claim left to check.
    IF NEW.void_reason='stopped' THEN
      SELECT m.mode INTO mode FROM public.installation_operations_mode_revisions m
        WHERE m.tenant_id=OLD.tenant_id ORDER BY m.revision DESC LIMIT 1;
      IF mode IS DISTINCT FROM 'stopped' THEN
        RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
      END IF;
    ELSIF NOT public.fleet_claim_is_live(OLD.tenant_id,OLD.claim_id,OLD.worker_id) THEN
      RAISE EXCEPTION 'result upload session rejected' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_upload_session_update() FROM PUBLIC;
CREATE TRIGGER control_result_upload_sessions_update_guard BEFORE UPDATE ON control_result_upload_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_upload_session_update();

-- A session is a record of a promise, kept like every other one: never deleted,
-- never truncated, so "which upload did these bytes come from" always has an
-- answer and a voided session cannot be removed to free its id for reuse.
CREATE TRIGGER control_result_upload_sessions_no_delete BEFORE DELETE ON control_result_upload_sessions
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_result_upload_sessions_no_truncate BEFORE TRUNCATE ON control_result_upload_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- Chunks
-- ---------------------------------------------------------------------------

CREATE TABLE control_result_upload_chunks (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  upload_id text NOT NULL,
  -- The chunk's position in the promised tiling, not a caller-chosen name.
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 32),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  -- Over the BYTES of this chunk, so a replay is provably the same chunk and a
  -- substitute is provably a different one. The whole-file digest is the
  -- session's, and the byte store proves it on the way in.
  chunk_digest text NOT NULL CHECK (chunk_digest ~ '^sha256:[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, upload_id, ordinal),
  FOREIGN KEY (tenant_id, upload_id) REFERENCES control_result_upload_sessions(tenant_id, upload_id) ON DELETE RESTRICT,
  CHECK (received_at <= pg_catalog.statement_timestamp() + interval '1 minute')
);
-- Finalise reads a session's chunks in order; this is that read's only index.
CREATE INDEX control_result_upload_chunks_session
  ON control_result_upload_chunks(tenant_id, upload_id, ordinal);

-- A chunk is create-once, and only accepted while its session is still
-- reservable: a live claim, an unexpired session, and no bytes beyond the
-- promise. "An exact retry replays" is not a rule here — it is the primary key:
-- a second insert for an ordinal is a conflict, and the gateway answers a retry
-- by reading the row back and comparing the two digests, so a substitution is
-- reported as a conflict rather than silently accepted.
CREATE FUNCTION guard_result_upload_chunk_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE session public.control_result_upload_sessions%ROWTYPE;
BEGIN
  SELECT * INTO session FROM public.control_result_upload_sessions s
    WHERE s.tenant_id=NEW.tenant_id AND s.upload_id=NEW.upload_id;
  IF session.upload_id IS NULL THEN
    RAISE EXCEPTION 'result upload chunk rejected' USING ERRCODE = '23503';
  END IF;
  -- A received or published session is already whole; a voided one is dead.
  -- `55000` is object_not_in_prerequisite_state: the session is not in a state
  -- that admits more bytes.
  IF session.state<>'reserved' THEN
    RAISE EXCEPTION 'result upload chunk rejected' USING ERRCODE = '55000';
  END IF;
  IF NOT public.fleet_claim_is_live(session.tenant_id,session.claim_id,session.worker_id) THEN
    RAISE EXCEPTION 'result upload chunk rejected' USING ERRCODE = '42501';
  END IF;
  -- Expiry is a refusal, not a cleanup: an upload nobody finished inside its 24
  -- hours is not a promise any more, and its late bytes are ignored rather than
  -- waiting on a sweeper that may not run.
  IF session.expires_at<=NEW.received_at OR NEW.received_at<=pg_catalog.statement_timestamp()-interval '5 minutes' THEN
    RAISE EXCEPTION 'result upload chunk rejected' USING ERRCODE = '55000';
  END IF;
  IF NEW.ordinal>session.expected_chunks
    -- The size this position must have: full chunks, then one short remainder.
    -- The same expression the session's CHECK and its update guard use, so a
    -- reservation and a chunk can never disagree about the tiling.
    OR NEW.size_bytes IS DISTINCT FROM (CASE WHEN NEW.ordinal<session.expected_chunks
      THEN session.chunk_size_bytes::bigint
      ELSE session.expected_size_bytes-session.chunk_size_bytes::bigint*(session.expected_chunks-1) END)
    -- Never past the promise, even across concurrent senders.
    OR (SELECT coalesce(sum(c.size_bytes),0) FROM public.control_result_upload_chunks c
        WHERE c.tenant_id=NEW.tenant_id AND c.upload_id=NEW.upload_id)+NEW.size_bytes>session.expected_size_bytes THEN
    RAISE EXCEPTION 'result upload chunk rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_upload_chunk_insert() FROM PUBLIC;
CREATE TRIGGER control_result_upload_chunks_guard BEFORE INSERT ON control_result_upload_chunks
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_upload_chunk_insert();

CREATE TRIGGER control_result_upload_chunks_no_update BEFORE UPDATE ON control_result_upload_chunks
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_result_upload_chunks_no_delete BEFORE DELETE ON control_result_upload_chunks
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_result_upload_chunks_no_truncate BEFORE TRUNCATE ON control_result_upload_chunks
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

REVOKE ALL ON control_task_declared_outputs, control_result_upload_sessions, control_result_upload_chunks
  FROM PUBLIC;