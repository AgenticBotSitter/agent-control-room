-- "Save to my Mac", part 1 (plan v4.3 §2.6, MIG-C): the result-file catalog.
--
-- A result SET is what one approved attempt produced for one job. Its files are
-- the individual deliverables the owner downloads. This migration creates the
-- catalog only. It moves no bytes: the store itself is a sibling of
-- PersistentLocalArtifactStorageV1 on the Mac, and this table records the
-- catalog row its keys are derived from.
--
-- Threat model, from §2.6 hole H2:
--   * Storage keys are scoped PER PROJECT and DERIVED BY THIS MIGRATION, not
--     supplied by any caller. Two projects publishing identical bytes get two
--     different keys, and nothing anywhere answers "do you already have this
--     digest" — there is no such column, index or query to probe.
--   * The display name is a display name only. It is validated in the schema
--     (no path separators, no control characters, no quotes, no leading dot)
--     so it can never become a header, a path or a traversal, and no code path
--     uses it to build a storage path.
--   * Identity is bound: tenant, project, job and attempt must all agree with
--     the canonical rows, so a file can never be listed under a project it did
--     not come from.
--   * Limits live in the schema (32 files, 256 MiB per file, 512 MiB per set,
--     10 GiB installation quota), so no caller can store past them and the
--     refusal is a constraint, not an application convention.
--
-- The guards run as the invoker and call no helper function the web or any
-- other existing role would need EXECUTE on, exactly as 0140 does, so the
-- private-database preflight needs no extra definer-rights function and no
-- extra EXECUTE grant.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Result sets
-- ---------------------------------------------------------------------------

CREATE TABLE control_result_file_sets (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  set_id text NOT NULL CHECK (set_id ~ '^result-set:[a-f0-9]{32}$'),
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  -- Which producer wrote the bytes: a fleet worker id, or the literal local
  -- marker for work the Mac itself did. Never a hostname and never a free-form
  -- machine name the owner did not choose.
  producer_kind text NOT NULL CHECK (producer_kind IN ('native','fleet')),
  producer_id text NOT NULL CHECK (char_length(producer_id) BETWEEN 1 AND 180
    AND producer_id !~ '[[:cntrl:]]' AND producer_id !~ '[/\\]'),
  -- One attempt produces at most one set, so a retry cannot create a rival set
  -- for the same work.
  state text NOT NULL CHECK (state IN ('declared','stored','incomplete','quarantined')),
  -- 'native-text' is a result that already existed as the 64 KiB native text
  -- path and is now listed here too, so Project Files reads one catalog rather
  -- than two receipt tables. Those rows hold no store bytes.
  source_kind text NOT NULL CHECK (source_kind IN ('native-text','file-store')),
  -- The promise: exactly how many files this set will hold and how many bytes
  -- they will weigh. The set cannot reach 'stored' without matching it exactly.
  file_count integer NOT NULL CHECK (file_count BETWEEN 0 AND 32),
  total_bytes bigint NOT NULL CHECK (total_bytes BETWEEN 0 AND 536870912),
  -- The review target and the pipeline hand-off identity (plan §2.6). It is a
  -- promise at INSERT and a proof at 'stored', where the database recomputes it
  -- from the ordered catalog rows and refuses a digest that does not match.
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- Retention: an unaccepted set is swept after 90 days; an accepted set lives
  -- as long as the project plus a 90-day trash window. The state is recorded,
  -- never inferred by a reader.
  retention_state text NOT NULL CHECK (retention_state IN ('provisional','retained','trash','purged')),
  retained_until timestamptz,
  created_at timestamptz NOT NULL,
  stored_at timestamptz,
  accepted_at timestamptz,
  PRIMARY KEY (tenant_id, set_id),
  UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES control_jobs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES control_attempts(tenant_id, id) ON DELETE RESTRICT,
  -- A foreign key's column list maps POSITIONALLY onto the referenced key, so
  -- this names (job_id -> id, project_id -> project_id) and is what makes a set
  -- physically unable to name a job that belongs to another project. Writing it
  -- as (project_id, job_id) would still be accepted by PostgreSQL and would
  -- then compare the project against the job's id, refusing every valid row.
  FOREIGN KEY (tenant_id, job_id, project_id) REFERENCES control_jobs(tenant_id, id, project_id) ON DELETE RESTRICT,
  CHECK ((state='stored') = (stored_at IS NOT NULL)),
  CHECK (retention_state <> 'retained' OR accepted_at IS NOT NULL),
  CHECK (retained_until IS NULL OR retained_until > created_at),
  CHECK (created_at <= pg_catalog.statement_timestamp() + interval '1 minute')
);
-- The installation quota sums over retained and provisional sets, so the read
-- the guard performs has exactly one index to use.
CREATE INDEX control_result_file_sets_quota ON control_result_file_sets(tenant_id)
  WHERE retention_state IN ('provisional','retained');
CREATE INDEX control_result_file_sets_project ON control_result_file_sets(tenant_id, project_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Result files
-- ---------------------------------------------------------------------------

CREATE TABLE control_result_files (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  set_id text NOT NULL,
  -- Denormalised from the owning set by the insert guard, never a caller value.
  -- It is what makes the key's per-project uniqueness and the Project Files read
  -- one index each, instead of a join on every row read.
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  job_id text NOT NULL CHECK (job_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 32),
  file_id text NOT NULL CHECK (file_id ~ '^result-file:[a-f0-9]{32}$'),
  -- A display name, never a path. No separator, no control character, no quote,
  -- no leading dot and no `..`: a name that survives this can be echoed into a
  -- Content-Disposition header and shown to the owner, and cannot be used to
  -- address the filesystem.
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120
    AND display_name !~ '[[:cntrl:]]' AND display_name !~ '[/\\]'
    AND display_name !~ '"' AND display_name !~ '\.\.' AND display_name !~ '^\.'
    AND display_name ~ '^[A-Za-z0-9]'),
  declared_media_type text NOT NULL CHECK (declared_media_type IN
    ('text/plain','text/markdown','text/csv','application/json','image/png','image/jpeg',
     'image/gif','image/webp','application/pdf','application/zip','application/octet-stream')),
  -- What the bytes actually look like, sniffed by the writer. Declared and
  -- detected are both recorded, and they are allowed to disagree: that
  -- disagreement is itself a fact the owner must be able to see, so it is
  -- reported rather than resolved.
  detected_media_type text NOT NULL CHECK (detected_media_type IN
    ('text/plain','text/markdown','text/csv','application/json','image/png','image/jpeg',
     'image/gif','image/webp','application/pdf','application/zip','application/octet-stream')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 268435456),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- The opaque, project-scoped byte-store key. The insert guard OVERWRITES it
  -- with the value derived here, so no caller can choose, predict or replay
  -- another project's key. The same derivation is mirrored in
  -- `src/artifacts/v1/result-file-store.ts`, which is how the store finds the
  -- file on disk; the two are proven to agree in tests/result-file-store.test.ts.
  storage_key text NOT NULL CHECK (storage_key ~ '^crbf1-[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('declared','stored','quarantined','missing')),
  created_at timestamptz NOT NULL,
  stored_at timestamptz,
  PRIMARY KEY (tenant_id, set_id, ordinal),
  UNIQUE (tenant_id, file_id),
  -- Per-project uniqueness is what makes the key project-scoped. The same bytes
  -- in two projects are two rows with two different keys.
  UNIQUE (tenant_id, project_id, storage_key),
  FOREIGN KEY (tenant_id, set_id) REFERENCES control_result_file_sets(tenant_id, set_id) ON DELETE RESTRICT,
  -- One digest per set: two rows claiming the same bytes under different names
  -- is a refusal, not a second copy.
  UNIQUE (tenant_id, set_id, content_digest),
  CHECK ((state='stored') = (stored_at IS NOT NULL)),
  CHECK (created_at <= pg_catalog.statement_timestamp() + interval '1 minute')
);
CREATE INDEX control_result_files_set ON control_result_files(tenant_id, set_id, ordinal);
CREATE INDEX control_result_files_project ON control_result_files(tenant_id, project_id, created_at DESC, ordinal);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE FUNCTION guard_result_file_set_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE listed integer; sized bigint; occupied bigint;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'declared' OR NEW.stored_at IS NOT NULL OR NEW.accepted_at IS NOT NULL
      OR NEW.retention_state<>'provisional' OR NEW.retained_until IS NOT NULL THEN
      RAISE EXCEPTION 'result file set rejected' USING ERRCODE = '23514';
    END IF;
    -- Identity must agree with the canonical rows: the job belongs to this
    -- project, and the attempt is an attempt of that job. Without both, a file
    -- could be listed under a project it never came from.
    IF NOT EXISTS (SELECT 1 FROM public.control_attempts a WHERE a.tenant_id=NEW.tenant_id
        AND a.id=NEW.attempt_id AND a.job_id=NEW.job_id) THEN
      RAISE EXCEPTION 'result file set rejected' USING ERRCODE = '23514';
    END IF;
    -- A native-text set is exactly an already-published native artifact: it
    -- names a receipt for this project, job and attempt, and it holds no store
    -- bytes. That check is what stops the native path being re-labelled as a
    -- file-store set and backfilled with a digest nobody verified.
    IF NEW.source_kind='native-text' AND NOT EXISTS (SELECT 1 FROM public.control_native_artifact_receipts r
        WHERE r.tenant_id=NEW.tenant_id AND r.attempt_id=NEW.attempt_id AND r.job_id=NEW.job_id
          AND r.project_id=NEW.project_id) THEN
      RAISE EXCEPTION 'result file set rejected' USING ERRCODE = '23514';
    END IF;
    -- A file-store set must have work behind it: a canonical attempt in a state
    -- that can have produced output. A 'proposed' job cannot have a result set.
    IF NEW.source_kind='file-store' AND NOT EXISTS (SELECT 1 FROM public.control_attempts a
        WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.attempt_id
          AND a.state IN ('leased','running','waiting','succeeded','failed','orphaned')) THEN
      RAISE EXCEPTION 'result file set rejected' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Scope is immutable once declared: a set cannot be re-pointed at another
  -- project, job, attempt, producer or manifest after the fact.
  IF ROW(NEW.tenant_id,NEW.set_id,NEW.project_id,NEW.job_id,NEW.attempt_id,NEW.producer_kind,NEW.producer_id,
      NEW.source_kind,NEW.file_count,NEW.total_bytes,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.set_id,OLD.project_id,OLD.job_id,OLD.attempt_id,OLD.producer_kind,
      OLD.producer_id,OLD.source_kind,OLD.file_count,OLD.total_bytes,OLD.created_at)
    -- An unchanged state is allowed: a retention update legitimately touches a
    -- set that is already stored, and 0207's acceptance guard depends on it.
    OR NOT (NEW.state IS NOT DISTINCT FROM OLD.state
      OR (OLD.state,NEW.state) IN (('declared','stored'),('declared','incomplete'),('declared','quarantined'),
        ('incomplete','stored'),('incomplete','quarantined'),('stored','quarantined'))) THEN
    RAISE EXCEPTION 'result file set update rejected' USING ERRCODE = '23514';
  END IF;
  -- The proof and the quota apply to the TRANSITION into 'stored', not to every
  -- update of a set that is already stored. Checking them again on a later
  -- retention update would count the set's own bytes twice and refuse the
  -- owner's acceptance of a set that was legitimately published earlier.
  IF NEW.state='stored' AND OLD.state IS DISTINCT FROM 'stored' THEN
    -- The proof: exactly the promised files, every one of them stored, the
    -- promised byte total, and a manifest digest the database itself recomputes
    -- over the ordered rows. A caller cannot record a review target that does
    -- not cover the exact bytes in the catalog.
    SELECT count(*), coalesce(sum(size_bytes),0) INTO listed, sized
      FROM public.control_result_files f
      WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id AND f.state='stored';
    IF listed<>NEW.file_count OR sized<>NEW.total_bytes
      OR EXISTS (SELECT 1 FROM public.control_result_files f
        WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id AND f.state<>'stored')
      -- The manifest is recomputed here rather than accepted, so the review
      -- target cannot be a value the caller chose. `coalesce` covers the
      -- zero-file set: `string_agg` returns NULL there, and the empty string is
      -- the honest input rather than a skipped check.
      OR NEW.manifest_digest IS DISTINCT FROM ('sha256:' || pg_catalog.encode(pg_catalog.sha256(
           pg_catalog.convert_to(coalesce((
             SELECT string_agg(f.ordinal::text || ':' || f.storage_key || ':' || f.content_digest || ':'
                              || f.size_bytes::text, E'\n' ORDER BY f.ordinal)
               FROM public.control_result_files f
               WHERE f.tenant_id = NEW.tenant_id AND f.set_id = NEW.set_id
           ), ''), 'UTF8')), 'hex'))
      OR NEW.stored_at IS DISTINCT FROM (SELECT max(f.stored_at) FROM public.control_result_files f
        WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id AND f.state='stored') THEN
      RAISE EXCEPTION 'result file set update rejected' USING ERRCODE = '23514';
    END IF;
    -- The installation quota is 10 GiB across every provisional or retained set
    -- in the tenant. It refuses a new publication; it never evicts an accepted
    -- file, and it never rewrites a set that is already stored.
    SELECT coalesce(sum(s.total_bytes),0) INTO occupied FROM public.control_result_file_sets s
      WHERE s.tenant_id=NEW.tenant_id AND s.retention_state IN ('provisional','retained')
        AND s.set_id<>NEW.set_id;
    IF occupied+NEW.total_bytes>10737418240 THEN
      RAISE EXCEPTION 'result file set update rejected: installation quota' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Retention only ever moves toward keeping the bytes, then to trash, then to
  -- purged. Nothing can bring a purged set back without a new publication.
  IF NEW.retention_state IS DISTINCT FROM OLD.retention_state AND NOT (
      (OLD.retention_state,NEW.retention_state) IN (('provisional','retained'),('provisional','trash'),
        ('retained','trash'),('trash','purged'))) THEN
    RAISE EXCEPTION 'result file set update rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.accepted_at IS NOT NULL AND NEW.accepted_at < OLD.created_at THEN
    RAISE EXCEPTION 'result file set update rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_file_set_write() FROM PUBLIC;
CREATE TRIGGER control_result_file_sets_guard BEFORE INSERT OR UPDATE ON control_result_file_sets
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_set_write();

CREATE FUNCTION guard_result_file_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE owner_set public.control_result_file_sets%ROWTYPE; listed integer; sized bigint;
BEGIN
  SELECT * INTO owner_set FROM public.control_result_file_sets s
    WHERE s.tenant_id=NEW.tenant_id AND s.set_id=NEW.set_id;
  IF owner_set.set_id IS NULL OR owner_set.state<>'declared' THEN
    RAISE EXCEPTION 'result file rejected' USING ERRCODE = '23514';
  END IF;
  -- The denormalised project and job are the set's, never the caller's.
  NEW.project_id := owner_set.project_id;
  NEW.job_id := owner_set.job_id;
  -- The key is DERIVED here, from the tenant, the project, the file's own id and
  -- its digest. A supplied key is never used, so a worker cannot address another
  -- project's bytes and no probe can learn whether a digest exists elsewhere.
  NEW.storage_key := 'crbf1-'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'control-room.result-file-store/v1:'||NEW.tenant_id||':'||NEW.project_id||':'||NEW.file_id||':'
      ||NEW.content_digest, 'UTF8')), 'hex');
  IF NEW.state<>'declared' OR NEW.stored_at IS NOT NULL THEN
    RAISE EXCEPTION 'result file rejected' USING ERRCODE = '23514';
  END IF;
  -- A native-text set holds no store bytes, so it has exactly one catalog row
  -- naming the published native artifact. Otherwise the per-set limits are
  -- enforced against what the catalog already holds, so a caller cannot slip
  -- past 32 files or 512 MiB by splitting one set across several writers.
  IF owner_set.source_kind='native-text' THEN
    IF NEW.ordinal<>1 OR owner_set.file_count<>1 OR NEW.size_bytes>65536 THEN
      RAISE EXCEPTION 'result file rejected' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT count(*), coalesce(sum(size_bytes),0) INTO listed, sized
      FROM public.control_result_files f
      WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id;
    IF listed+1>owner_set.file_count OR sized+NEW.size_bytes>owner_set.total_bytes THEN
      RAISE EXCEPTION 'result file rejected' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_file_insert() FROM PUBLIC;
CREATE TRIGGER control_result_files_guard BEFORE INSERT ON control_result_files
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_insert();

CREATE FUNCTION guard_result_file_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id,NEW.set_id,NEW.project_id,NEW.job_id,NEW.ordinal,NEW.file_id,NEW.display_name,
      NEW.declared_media_type,NEW.detected_media_type,NEW.size_bytes,NEW.content_digest,NEW.storage_key,
      NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.set_id,OLD.project_id,OLD.job_id,OLD.ordinal,OLD.file_id,
      OLD.display_name,OLD.declared_media_type,OLD.detected_media_type,OLD.size_bytes,OLD.content_digest,
      OLD.storage_key,OLD.created_at) THEN
    RAISE EXCEPTION 'result file update rejected' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.state,NEW.state) IN (('declared','stored'),('declared','quarantined'),('declared','missing'),
    ('stored','quarantined'),('stored','missing'),('missing','stored'))) THEN
    RAISE EXCEPTION 'result file update rejected' USING ERRCODE = '23514';
  END IF;
  -- 'stored' is a claim about bytes, and a reader re-verifies the digest on
  -- every read. This trigger only refuses a backwards move, so a restore can
  -- put a verified file back without rewriting the rest of its catalog row.
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_file_update() FROM PUBLIC;
CREATE TRIGGER control_result_files_update_guard BEFORE UPDATE ON control_result_files
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_update();

-- History is append-only. A file is never deleted: it moves to 'missing' or
-- 'quarantined' and the catalog row survives as the record of what was
-- promised, which is exactly what a restore reconciles against.
CREATE TRIGGER control_result_files_no_delete BEFORE DELETE ON control_result_files
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_result_file_sets_no_delete BEFORE DELETE ON control_result_file_sets
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_result_files_no_truncate BEFORE TRUNCATE ON control_result_files
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_result_file_sets_no_truncate BEFORE TRUNCATE ON control_result_file_sets
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

-- A set reaches 'stored' only with exactly the files it declared, and it may
-- not be INSERTed with a file count it does not have. Deferred, so a writer may
-- insert the set and its files in either order in one transaction, and a
-- transaction that abandons half of them leaves nothing behind.
--
-- This is a CONSTRAINT trigger on INSERT as well as UPDATE, and that matters:
-- as an ordinary AFTER trigger it would fire before the writer's own files
-- exist, so a set claiming one file would be refused for having none. A
-- deferred trigger runs at COMMIT, when the transaction's inserts are all
-- visible, which is the only moment the claim can be checked at all.
CREATE FUNCTION enforce_result_file_set_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- The claim is proved on INSERT (a set is declared with the files it carries)
  -- and on any move INTO 'stored'. A later retention update on a set that is
  -- already stored changes no file and no count, and re-running the check there
  -- would refuse the owner's acceptance for a reason unrelated to it.
  IF NOT (TG_OP='INSERT' OR (NEW.state='stored' AND OLD.state IS DISTINCT FROM 'stored'))
    THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM public.control_result_files f
      WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id)<>NEW.file_count
    OR (SELECT coalesce(sum(f.size_bytes),0) FROM public.control_result_files f
      WHERE f.tenant_id=NEW.tenant_id AND f.set_id=NEW.set_id)<>NEW.total_bytes THEN
    RAISE EXCEPTION 'result file set committed without its declared files' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_result_file_set_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER control_result_file_sets_complete AFTER INSERT OR UPDATE ON control_result_file_sets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_result_file_set_complete();

REVOKE ALL ON control_result_file_sets, control_result_files FROM PUBLIC;
