-- Text-copy derivations, part 1 (plan v4.3 §2.7, MIG-E): the derivation record.
--
-- A "text copy" is a plain-text rendering of a result file, so the owner can
-- read an HTML page or a PDF in the app instead of downloading it. The
-- converter (src/converter/v1) produces the bytes; this migration records WHAT
-- WAS DERIVED, FROM WHAT, BY WHICH CONVERTER, and WHETHER IT WORKED.
--
-- The shape is the converter's own persistence handoff, bound to the MIG-C
-- result-file catalog rather than to an older artifact table. Every field the
-- converter reports is a column here, and the one thing it deliberately does NOT
-- own — the bytes — is a reference to a catalog file that already has its own
-- digest, size and storage key. So a derived text copy is not a second copy of
-- anything: it is a row pointing at a real catalog file, and the row cannot
-- claim a digest the catalog does not hold.
--
-- The refusal design, from §2.7:
--
--   * A derivation names ONE source file (FK to control_result_files) and binds
--     the source digest the converter actually hashed. A row whose digest does
--     not match the catalog file's digest is refused, so a derivation can never
--     describe bytes other than the ones it claims to have read.
--   * The uniqueness fence is over (source file, source digest, converter id,
--     converter version). An exact retry — same bytes, same converter — finds
--     the existing row and reuses it; CHANGED bytes produce a new derivation,
--     because a changed source digest is outside the fence. That is what makes
--     a re-run idempotent without making it a no-op for new content.
--   * Success requires a derived file. A row with status 'succeeded' and no
--     derived_file_id, or a row that names a file it did not produce, is
--     refused. Failure requires no derived file, because "no text copy" means
--     there are no bytes to point at.
--   * A derived file belongs to the SAME set as its source, and its content
--     digest is NOT the source digest. Those two are different documents, and a
--     row claiming the copy is byte-identical to its source is asserting
--     something false about the conversion.
--   * The diagnostic category is a closed vocabulary, so a reader can count
--     "why did this not convert" without parsing prose. It is nullable only on
--     success, where there is nothing to explain.
--
-- What is NOT here, deliberately: no column, index or query that answers "has
-- this content been derived anywhere else" across projects. A derivation is a
-- property of ONE file, and the owner's read path is per project (0208).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Derivations
-- ---------------------------------------------------------------------------

CREATE TABLE control_text_copy_derivations (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- A derivation is a fact about one attempt to convert one file, so the id is
  -- derived, never chosen: same shape as the catalog's own identifiers.
  derivation_id text NOT NULL CHECK (derivation_id ~ '^derivation:[a-f0-9]{32}$'),
  -- The source. Exactly one catalog file, and the digest is the one the
  -- converter hashed, which the insert guard compares against that file.
  source_file_id text NOT NULL,
  source_set_id text NOT NULL,
  source_content_digest text NOT NULL CHECK (source_content_digest ~ '^sha256:[a-f0-9]{64}$'),
  source_size_bytes bigint NOT NULL CHECK (source_size_bytes BETWEEN 0 AND 268435456),
  -- Which converter, and WHICH VERSION of it. A Readability upgrade must be
  -- able to produce a different result from the same bytes, and this is the
  -- only place that can be true.
  converter_id text NOT NULL CHECK (converter_id ~ '^control-room\.[a-z0-9][a-z0-9.-]{0,62}$'),
  converter_version text NOT NULL CHECK (converter_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  -- The closed vocabulary, matching TextCopyDiagnosticCategory exactly. It is a
  -- CHECK and not a lookup table on purpose: the list is part of the contract,
  -- the schema is where a value that is not in it must be refused, and adding a
  -- vocabulary entry must be a migration like any other change of contract.
  status text NOT NULL CHECK (status IN ('succeeded','no_text_copy')),
  diagnostic_category text,
  -- The bytes, as a reference to a catalog file rather than as a copy. Present
  -- exactly when the conversion succeeded.
  derived_file_id text,
  derived_set_id text,
  derived_content_digest text CHECK (derived_content_digest IS NULL OR derived_content_digest ~ '^sha256:[a-f0-9]{64}$'),
  derived_size_bytes bigint CHECK (derived_size_bytes IS NULL OR derived_size_bytes BETWEEN 0 AND 268435456),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, derivation_id),
  -- The uniqueness fence: an exact retry reuses the row, changed bytes do not.
  -- This is the index that makes a re-run idempotent, and it is deliberately
  -- NOT a digest-only index, so it cannot be used to ask "does this content
  -- exist elsewhere".
  UNIQUE (tenant_id, source_file_id, source_content_digest, converter_id, converter_version),
  FOREIGN KEY (tenant_id, source_file_id) REFERENCES control_result_files(tenant_id, file_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_set_id) REFERENCES control_result_file_sets(tenant_id, set_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, derived_file_id) REFERENCES control_result_files(tenant_id, file_id) ON DELETE RESTRICT,
  -- Success and failure are different shapes of row, and the database is what
  -- decides which one a writer is allowed to write.
  CONSTRAINT control_text_copy_derivations_success_needs_file
    CHECK ((status = 'succeeded') = (derived_file_id IS NOT NULL)),
  CONSTRAINT control_text_copy_derivations_file_needs_set
    CHECK ((derived_file_id IS NOT NULL) = (derived_set_id IS NOT NULL)),
  CONSTRAINT control_text_copy_derivations_file_needs_digest
    CHECK ((derived_file_id IS NOT NULL) = (derived_content_digest IS NOT NULL)),
  CONSTRAINT control_text_copy_derivations_file_needs_size
    CHECK ((derived_file_id IS NOT NULL) = (derived_size_bytes IS NOT NULL)),
  -- A copy is a different document from its source. A row claiming the two are
  -- byte-identical is asserting something false about the conversion, and would
  -- also let a "derived" row be satisfied by re-pointing at its own source.
  CONSTRAINT control_text_copy_derivations_copy_differs_from_source
    CHECK (derived_content_digest IS NULL OR derived_content_digest <> source_content_digest),
  -- A success has nothing to explain; a failure must say why.
  CONSTRAINT control_text_copy_derivations_success_has_no_diagnostic
    CHECK ((status = 'succeeded') = (diagnostic_category IS NULL)),
  CHECK (diagnostic_category IS NULL OR diagnostic_category IN
    ('none','invalid_input','input_too_large','not_supported_yet','converter_unavailable',
     'sandbox_unavailable','timeout','cancelled','memory_limit','resource_monitor_unavailable',
     'output_too_large','conversion_failed')),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (created_at <= pg_catalog.statement_timestamp() + interval '1 minute'),
  -- A row cannot sit unfinished forever: either it is a completed derivation or
  -- it is a typed refusal, and the refusal is recorded at once.
  CHECK (completed_at IS NOT NULL)
);
-- The owner's read path is per project, so the index follows the set.
CREATE INDEX control_text_copy_derivations_set
  ON control_text_copy_derivations(tenant_id, source_set_id, created_at DESC);
-- "Which converter version produced this?" is the question a re-run asks, and
-- it must not need a sequential scan of every derivation in the tenant.
CREATE INDEX control_text_copy_derivations_converter
  ON control_text_copy_derivations(tenant_id, converter_id, converter_version);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE FUNCTION guard_text_copy_derivation_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE source_file public.control_result_files%ROWTYPE;
  derived_file public.control_result_files%ROWTYPE;
BEGIN
  SELECT * INTO source_file FROM public.control_result_files f
    WHERE f.tenant_id = NEW.tenant_id AND f.file_id = NEW.source_file_id;
  -- The source must exist, belong to the set the row names, and be the exact
  -- bytes the converter hashed. Without the digest comparison a row could
  -- describe one file's derivation while citing another's identity.
  IF source_file.file_id IS NULL OR source_file.set_id IS DISTINCT FROM NEW.source_set_id
    OR source_file.content_digest IS DISTINCT FROM NEW.source_content_digest
    OR source_file.size_bytes IS DISTINCT FROM NEW.source_size_bytes THEN
    RAISE EXCEPTION 'text copy derivation rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'succeeded' THEN
    SELECT * INTO derived_file FROM public.control_result_files f
      WHERE f.tenant_id = NEW.tenant_id AND f.file_id = NEW.derived_file_id;
    -- The derived file must exist, be STORED (a derivation points at real
    -- bytes, not at a promise), sit in the same set as its source, and carry
    -- the digest and size the row records. A converter that produced its text
    -- copy into another set, or into a file that does not exist, is refused.
    IF derived_file.file_id IS NULL OR derived_file.set_id IS DISTINCT FROM NEW.source_set_id
      OR derived_file.file_id = NEW.source_file_id
      OR derived_file.state <> 'stored'
      OR derived_file.content_digest IS DISTINCT FROM NEW.derived_content_digest
      OR derived_file.size_bytes IS DISTINCT FROM NEW.derived_size_bytes THEN
      RAISE EXCEPTION 'text copy derivation rejected' USING ERRCODE = '23514';
    END IF;
    IF NEW.diagnostic_category IS NOT NULL AND NEW.diagnostic_category <> 'none' THEN
      RAISE EXCEPTION 'text copy derivation rejected' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_text_copy_derivation_insert() FROM PUBLIC;
CREATE TRIGGER control_text_copy_derivations_guard BEFORE INSERT ON control_text_copy_derivations
  FOR EACH ROW EXECUTE FUNCTION public.guard_text_copy_derivation_insert();

-- A derivation is a record of what happened. Rewriting it would make "this
-- converter produced this text" an assertion nobody can check, so the only
-- move permitted is completing a row that was left unfinished, exactly once.
CREATE FUNCTION guard_text_copy_derivation_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.derivation_id, NEW.source_file_id, NEW.source_set_id,
      NEW.source_content_digest, NEW.source_size_bytes, NEW.converter_id, NEW.converter_version,
      NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id, OLD.derivation_id, OLD.source_file_id, OLD.source_set_id,
      OLD.source_content_digest, OLD.source_size_bytes, OLD.converter_id, OLD.converter_version,
      OLD.created_at) THEN
    RAISE EXCEPTION 'text copy derivation update rejected' USING ERRCODE = '23514';
  END IF;
  IF OLD.completed_at IS NOT NULL THEN
    -- A finished derivation is final: its status, its diagnostic and the file it
    -- produced are the record, and there is no path back to "still running".
    RAISE EXCEPTION 'text copy derivation update rejected' USING ERRCODE = '23514';
  END IF;
  -- Finishing may only settle the three outcome columns, and it may only
  -- complete a row; the CHECK constraints then enforce success/failure shape.
  IF NEW.status IS DISTINCT FROM 'succeeded'
    AND NOT (NEW.derived_file_id IS NULL AND NEW.derived_set_id IS NULL
      AND NEW.derived_content_digest IS NULL AND NEW.derived_size_bytes IS NULL) THEN
    RAISE EXCEPTION 'text copy derivation update rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_text_copy_derivation_update() FROM PUBLIC;
CREATE TRIGGER control_text_copy_derivations_update_guard BEFORE UPDATE ON control_text_copy_derivations
  FOR EACH ROW EXECUTE FUNCTION public.guard_text_copy_derivation_update();

-- The derivation ledger is evidence. It is never deleted and never truncated, so
-- a later question ("was this file ever converted, and by what?") has an answer
-- that a caller cannot remove to free the uniqueness fence for a second attempt.
CREATE TRIGGER control_text_copy_derivations_no_delete BEFORE DELETE ON control_text_copy_derivations
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_text_copy_derivations_no_truncate BEFORE TRUNCATE ON control_text_copy_derivations
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

REVOKE ALL ON control_text_copy_derivations FROM PUBLIC;
