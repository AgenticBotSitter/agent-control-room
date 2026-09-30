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
--   3. The receipt repeats the set's own state: same manifest digest, same
--      count, same byte total. A publication row that disagreed with the set it
--      names would be a second, unchecked answer to "what was published".
CREATE FUNCTION guard_result_publication_insert() RETURNS trigger
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE owner_set public.control_result_file_sets%ROWTYPE; attempt_worker text; missing integer;
BEGIN
  SELECT * INTO owner_set FROM public.control_result_file_sets s
    WHERE s.tenant_id=NEW.tenant_id AND s.set_id=NEW.set_id;
  IF owner_set.set_id IS NULL OR owner_set.state<>'stored' OR owner_set.stored_at IS NULL
    OR owner_set.project_id IS DISTINCT FROM NEW.project_id
    OR owner_set.job_id IS DISTINCT FROM NEW.job_id
    OR owner_set.attempt_id IS DISTINCT FROM NEW.attempt_id THEN
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
  -- The completeness of the set: a stored set holds exactly its declared files,
  -- 0206's own trigger proved it, and this count is what "every promised file"
  -- is measured against.
  SELECT count(*) INTO missing FROM public.control_result_files f
    WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id AND f.state<>'stored';
  IF missing>0 OR NEW.manifest_digest IS DISTINCT FROM owner_set.manifest_digest
    OR NEW.file_count IS DISTINCT FROM owner_set.file_count
    OR NEW.total_bytes IS DISTINCT FROM owner_set.total_bytes THEN
    RAISE EXCEPTION 'result publication rejected' USING ERRCODE = '23514';
  END IF;
  -- Every file, every one of them published through its own upload, and every one
  -- of them vouching for exactly the digest and size the catalog promises. A
  -- native-text file has no upload and is therefore not publishable here; it is
  -- already published by the 0206 receipt and never takes this path.
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
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
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
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
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

-- A file row is only 'stored' through its own published session. Enforced on
-- the file's own UPDATE, so the guarantee holds whichever order a publisher
-- chooses to write in: it cannot mark one file stored and rely on the set's
-- later update to notice.
CREATE FUNCTION guard_result_file_upload_stored() RETURNS trigger
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state='stored' AND OLD.state IS DISTINCT FROM 'stored' AND NOT EXISTS (
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
