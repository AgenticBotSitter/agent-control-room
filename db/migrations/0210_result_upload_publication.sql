-- "Save to my Mac", part 2 (plan v4.3 §2.6, MIG-D): publishing a manifest.
--
-- 0209 made the promise. This migration makes the proof: a result set reaches
-- 'stored' — which is what the owner's catalog, the review target and every
-- download link read — only when EVERY promised file has a PUBLISHED upload
-- session, and every one of those sessions is the owner-approved promise for
-- that exact file.
--
-- The hole this closes. Without it, `control_result_file_sets.state` is a
-- statement the publisher makes about bytes on a disk the database cannot see.
-- 0206 already refuses a manifest digest that does not cover the catalog rows
-- and a file count that does not match, but nothing tied a catalog's 'stored'
-- files to a receipt. A fleet publisher with INSERT on the catalog could mark a
-- file stored with no bytes anywhere, and the owner would see a complete,
-- downloadable-looking result that 404s. Here a 'stored' file is one whose
-- upload session is 'published', and a session is only publishable once its
-- chunks exactly tile the promise (0209), so the chain from "these 8 MiB
-- arrived, in order, hashing to X" to "the owner can download a stored file
-- whose digest is X" is checkable row by row and each link refuses on its own.
--
-- The store is the other half of the proof and it is not in the database: 0206's
-- byte store re-proves the whole-file digest on every write and every read, so
-- the catalog and the bytes agree or the download 404s. What this migration
-- guarantees is that the catalog's story can be walked UPWARD from the arrival
-- of the bytes, and that the publication record a later restore reconciles
-- against exists only when the whole set is present.
--
-- A manifest publishes ONCE. There is no un-publish: a 'stored' set moves on to
-- quarantined or accepted, never back, so a byte that was once offered to the
-- owner cannot become un-offered by a later write.
--
-- Every guard is SECURITY INVOKER and inlines its checks, as 0206-0209 do. No
-- login gains EXECUTE on anything new.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- ---------------------------------------------------------------------------
-- The publication receipt
-- ---------------------------------------------------------------------------
-- One row per set published through the upload path. It is the join point a
-- restore rehearsal reconciles: rows here must correspond to a stored catalog
-- set, and a stored catalog set published this way must have a row, with the
-- same digest, count and bytes. The reconciliation itself is a later slice
-- (plan M4/M7); what this migration owes it is the row to reconcile against.

CREATE TABLE control_result_publications (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  set_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  -- The manifest digest 0206 recomputed and accepted, recorded again here as a
  -- join key: a reader proves the set's manifest and the publication's manifest
  -- are one value without relying on the catalog's trigger having run.
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  file_count integer NOT NULL CHECK (file_count BETWEEN 0 AND 32),
  total_bytes bigint NOT NULL CHECK (total_bytes BETWEEN 0 AND 536870912),
  published_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, set_id),
  FOREIGN KEY (tenant_id, set_id) REFERENCES control_result_file_sets(tenant_id, set_id) ON DELETE RESTRICT,
  -- Positional again (0206 spells out why): job_id -> id, project_id -> project_id.
  -- A publication can therefore not name a job from another project.
  FOREIGN KEY (tenant_id, job_id, project_id) REFERENCES control_jobs(tenant_id, id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES control_attempts(tenant_id, id) ON DELETE RESTRICT,
  CHECK (published_at <= pg_catalog.statement_timestamp() + interval '1 minute')
);
CREATE INDEX control_result_publications_project
  ON control_result_publications(tenant_id, project_id, published_at DESC);

-- The publication guard. Three checks, and each is a statement the database
-- cannot otherwise make:
--
--   1. Identity. The set is this attempt's own, and the attempt's recorded
--      worker is a currently-active fleet worker. 0207 applies the same binding
--      to a set's creation; this applies it to the act of saying the bytes are
--      all there.
--   2. EVERY promised file is present, and present means "its own upload session
--      is published". The session's expected size and digest must be the
--      catalog row's — the same values 0209 pinned at reservation, so a
--      published session cannot vouch for different bytes than the catalog
--      promises, and cannot be for a file the reservation guard did not verify.
--   3. The receipt repeats the set's own promise: same manifest digest, same
--      count, same byte total. A publication row that disagreed with the set it
--      names would be a second, unchecked answer to "what was published".
--
-- ORDER, and why it is this way round. The set reaches 'stored' only when a
-- receipt exists (the deferred trigger below), and a receipt is only accepted
-- when every promised file is already stored. Those two rules are checked in
-- ONE transaction, in either statement order, because both are DEFERRED or
-- read the rows as they will be at COMMIT. What this guard therefore requires
-- is a set that is on the point of being stored: 'stored' already, or 'declared'
-- with every one of its files stored. It does NOT require the set to be
-- 'stored', because that would make a stored set the PRECONDITION of the
-- receipt that a stored set requires — a circle no statement order can
-- satisfy, and one that would otherwise be resolved by giving up one of the
-- two rules.
CREATE FUNCTION guard_result_publication_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE owner_set public.control_result_file_sets%ROWTYPE; attempt_worker text; stored_files integer;
BEGIN
  SELECT * INTO owner_set FROM public.control_result_file_sets s
    WHERE s.tenant_id=NEW.tenant_id AND s.set_id=NEW.set_id;
  IF owner_set.set_id IS NULL
    OR owner_set.project_id IS DISTINCT FROM NEW.project_id
    OR owner_set.job_id IS DISTINCT FROM NEW.job_id
    OR owner_set.attempt_id IS DISTINCT FROM NEW.attempt_id THEN
    RAISE EXCEPTION 'result publication rejected' USING ERRCODE = '23514';
  END IF;
  -- Every promised file is already stored, and the set is either stored or one
  -- step from it. A set with a file still 'declared' is not a publication, it
  -- is an upload in progress. The count and the byte total are checked against
  -- the set's own promise here, so a receipt cannot be a second, unchecked
  -- answer to "what was published".
  SELECT count(*) INTO stored_files FROM public.control_result_files f
    WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id AND f.state='stored';
  IF owner_set.state NOT IN ('declared','stored') OR stored_files<>owner_set.file_count
    OR (SELECT count(*) FROM public.control_result_files f WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id
      AND f.state<>'stored')>0
    OR NEW.file_count IS DISTINCT FROM owner_set.file_count
    OR NEW.total_bytes IS DISTINCT FROM owner_set.total_bytes THEN
    RAISE EXCEPTION 'result publication rejected' USING ERRCODE = '23514';
  END IF;
  -- The manifest is compared against the set's only when the set is ALREADY
  -- stored, because a 'declared' set still carries the placeholder digest it
  -- was created with. On the way in, the set's own guard recomputes the
  -- manifest over these rows and refuses any value that does not match it —
  -- so the receipt's digest is proved a moment later either way.
  IF owner_set.state='stored' AND (owner_set.stored_at IS NULL
    OR owner_set.manifest_digest IS DISTINCT FROM NEW.manifest_digest) THEN
    RAISE EXCEPTION 'result publication rejected' USING ERRCODE = '23514';
  END IF;
  SELECT a.worker_id INTO attempt_worker FROM public.control_attempts a
    WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.attempt_id;
  IF attempt_worker IS NULL OR owner_set.producer_kind<>'fleet'
    OR owner_set.producer_id IS DISTINCT FROM attempt_worker
    OR NOT EXISTS (SELECT 1 FROM public.fleet_workers w WHERE w.tenant_id=NEW.tenant_id
      AND w.worker_id=attempt_worker AND w.state='active') THEN
    RAISE EXCEPTION 'result publication producer rejected' USING ERRCODE = '42501';
  END IF;
  -- Every promised file, every one of them published through its own upload,
  -- and every one of them vouching for exactly the digest and size the catalog
  -- promises. A native-text file has no upload and is therefore not publishable
  -- here; it is already published by the 0206 receipt and never takes this
  -- path.
  IF owner_set.file_count>0 AND EXISTS (SELECT 1 FROM public.control_result_files f
      WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id AND NOT EXISTS (
        SELECT 1 FROM public.control_result_upload_sessions u
        WHERE u.tenant_id=f.tenant_id AND u.set_id=f.set_id AND u.ordinal=f.ordinal
          AND u.state='published' AND u.published_at IS NOT NULL
          AND u.expected_size_bytes=f.size_bytes AND u.expected_content_digest=f.content_digest)) THEN
    RAISE EXCEPTION 'result publication rejected: not every promised file is published' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_publication_insert() FROM PUBLIC;
CREATE TRIGGER control_result_publications_guard BEFORE INSERT ON control_result_publications
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_publication_insert();

-- A publication is a permanent record of what was promised to the owner. Nothing
-- about it changes: not the digest, not the count, not the bytes, not the time.
-- A retraction is a new set, never an edit to this one.
CREATE FUNCTION guard_result_publication_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'result publication update rejected' USING ERRCODE = '23514';
END $$;
REVOKE ALL ON FUNCTION public.guard_result_publication_update() FROM PUBLIC;
CREATE TRIGGER control_result_publications_no_update BEFORE UPDATE ON control_result_publications
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_publication_update();
CREATE TRIGGER control_result_publications_no_delete BEFORE DELETE ON control_result_publications
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_result_publications_no_truncate BEFORE TRUNCATE ON control_result_publications
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

-- A stored set published through the upload path HAS a receipt, and the receipt
-- is committed with the set. Deferred, because a publisher writes the set, its
-- files, its sessions and the receipt in one transaction in whichever order it
-- finds convenient, and the claim "stored means published" can only be checked
-- when all of them are visible.
--
-- The check is deliberately one-directional — every publication has a stored
-- set (the insert guard above, and the set's own foreign key), and every stored
-- FLEET set has exactly one publication. A native-text set is not this path and
-- is excluded, as it is in the insert guard: it was published by its own receipt
-- in 0206 and carries no store bytes.
CREATE FUNCTION enforce_result_set_published() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state='stored' AND OLD.state IS DISTINCT FROM 'stored' AND NEW.source_kind='file-store'
    AND NOT EXISTS (SELECT 1 FROM public.control_result_publications p
      WHERE p.tenant_id=NEW.tenant_id AND p.set_id=NEW.set_id
        AND p.manifest_digest=NEW.manifest_digest AND p.file_count=NEW.file_count
        AND p.total_bytes=NEW.total_bytes) THEN
    RAISE EXCEPTION 'result file set stored without a publication receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_result_set_published() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER control_result_file_sets_published
  AFTER UPDATE ON control_result_file_sets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_result_set_published();

-- The catalog's one writable transition for a FLEET publisher is
-- 'declared' -> 'stored', and that is all it may make. It holds UPDATE on
-- `state` because the transition is a state change, so the column grant alone
-- would also let it write 'quarantined' or 'missing' — which are decisions
-- about the OWNER's bytes, taken on the web path by a grant-checked owner or by
-- the native publisher. This trigger is what turns the column grant back into
-- the single transition it was meant to be, and it belongs here rather than in
-- 0209 because 0209 reserves uploads and 0210 is what makes a fleet file
-- 'stored' at all.
--
-- A native publisher, the web login and a restore all move a stored file to
-- 'quarantined' or 'missing', so the rule is stated as "a file in a FLEET set
-- may only ever move forward into 'stored'", not as an absolute. A native-text
-- set has no fleet producer and is untouched by this guard, which is exactly
-- right: it never has a worker in the story.
CREATE FUNCTION guard_result_file_producer_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE producer_id text;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
  SELECT s.producer_id INTO producer_id FROM public.control_result_file_sets s
    WHERE s.tenant_id = NEW.tenant_id AND s.set_id = NEW.set_id AND s.producer_kind = 'fleet';
  IF producer_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.state<>'stored' OR OLD.state<>'declared' THEN
    RAISE EXCEPTION 'result file state rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_file_producer_state() FROM PUBLIC;
CREATE TRIGGER control_result_files_producer_state_guard BEFORE UPDATE ON control_result_files
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_producer_state();

-- A file row is only 'stored' through its own PUBLISHED session. Enforced on
-- the file's own UPDATE, so the guarantee holds whichever order a publisher
-- chooses to write in: it cannot mark one file stored and rely on the set's
-- later update to notice.
-- VOLATILE, not STABLE, and that is load-bearing rather than a default.
--
-- This guard is a BEFORE UPDATE trigger that reads the upload sessions table to
-- decide whether the row it is guarding may become 'stored'. A STABLE function
-- takes its snapshot at the start of the STATEMENT that called it, so a session
-- published moments earlier in the SAME transaction is invisible to it - and
-- worse, a STABLE function's plan is trusted to be consistent, so the guard
-- silently answered "no published session" for a row that was being published in
-- that very transaction, and the first version of this guard never fired at all,
-- for the superuser or for the gateway.
--
-- VOLATILE is the honest volatility for a BEFORE trigger: it must see the
-- transaction's own writes. It is still a per-row guard on a single UPDATE, so
-- the cost is one indexed existence check per stored file.
CREATE FUNCTION guard_result_file_upload_stored() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE producer_kind text;
BEGIN
  IF NEW.state<>'stored' OR OLD.state IS DISTINCT FROM 'stored' THEN RETURN NEW; END IF;
  -- Only a FLEET set's file gets here through an upload session. A native-text
  -- set, a restore and a republish all store bytes by their own path and have no
  -- chunked upload behind them, and requiring one of those would refuse the
  -- ordinary results path rather than harden it - which is what happened the
  -- first time this guard ran against the catalog lane, where the results login
  -- could not even read the upload table.
  SELECT s.producer_kind INTO producer_kind FROM public.control_result_file_sets s
    WHERE s.tenant_id=NEW.tenant_id AND s.set_id=NEW.set_id;
  IF producer_kind IS DISTINCT FROM 'fleet' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
      SELECT 1 FROM public.control_result_upload_sessions u
      WHERE u.tenant_id=NEW.tenant_id AND u.set_id=NEW.set_id AND u.ordinal=NEW.ordinal
        AND u.state='published' AND u.expected_size_bytes=NEW.size_bytes
        AND u.expected_content_digest=NEW.content_digest) THEN
    RAISE EXCEPTION 'result file stored without a published upload' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_file_upload_stored() FROM PUBLIC;
CREATE TRIGGER control_result_files_upload_stored_guard BEFORE UPDATE ON control_result_files
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_upload_stored();

REVOKE ALL ON control_result_publications FROM PUBLIC;
