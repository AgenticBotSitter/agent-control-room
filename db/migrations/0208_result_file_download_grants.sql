-- "Save to my Mac", part 1 (plan v4.3 §2.6, MIG-C): the download grant ledger.
--
-- The owner download route (plan §2.6) is: owner authority + result-read
-- grant; a short-lived token bound to project, result set, file, hash, size and
-- expiry; attachment-only; nosniff; sandbox CSP; streamed; no public links and
-- no raw object-store URLs.
--
-- The route already refuses an unauthenticated or out-of-scope request. What
-- this table adds is the part the route alone cannot prove: that a token was
-- issued for THIS session, for THIS project, for THIS file, with the hash and
-- size the file actually has, and that it has not already been spent. One row
-- per issued token, append-only, so:
--
--   * a token minted by one owner session is useless to another (the row names
--     the issuing session's token digest, and the route re-checks the live
--     session against it);
--   * a token for project A cannot be replayed against project B, because the
--     row's project is compared to the request's project in the same query;
--   * a token for file X cannot be replayed against file Y, because the row's
--     file, hash and size are all compared before a single byte is read;
--   * an expired or already-spent token is refused, so a link left in a chat
--     window stops working at its own expiry rather than living forever.
--
-- There is deliberately no column, index or query that answers "does this
-- content digest exist for another project" (H2). The row is per download
-- grant, not a content index, and the download route never joins across
-- projects.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_result_file_download_grants (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  grant_id text NOT NULL CHECK (grant_id ~ '^result-grant:[a-f0-9]{32}$'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  set_id text NOT NULL,
  file_id text NOT NULL,
  -- The session that was authorised when the token was minted. A different
  -- session cannot spend it even inside the token's lifetime.
  issued_to_token_digest text NOT NULL CHECK (issued_to_token_digest ~ '^sha256:[a-f0-9]{64}$'),
  issued_to_identity_id text NOT NULL,
  -- The exact bytes this token names. A row whose file no longer matches these
  -- three values cannot be spent, so a catalog row that changed underneath a
  -- live link refuses rather than serving different content.
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 268435456),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  spent_at timestamptz,
  PRIMARY KEY (tenant_id, grant_id),
  -- One live grant per (session, file, expiry) so a double-clicked Download
  -- reuses its row rather than minting an unbounded list of them.
  UNIQUE (tenant_id, issued_to_token_digest, file_id, expires_at),
  FOREIGN KEY (tenant_id, set_id) REFERENCES control_result_file_sets(tenant_id, set_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, file_id) REFERENCES control_result_files(tenant_id, file_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, issued_to_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  -- Five minutes, as the existing task file ticket uses. Longer would outlive
  -- the owner's session on a shared machine; shorter would break a slow phone
  -- download of a 256 MiB file.
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes'),
  CHECK (issued_at <= pg_catalog.statement_timestamp() + interval '1 minute'),
  CHECK (spent_at IS NULL OR (spent_at >= issued_at AND spent_at < expires_at))
);
CREATE INDEX control_result_file_download_grants_session
  ON control_result_file_download_grants(tenant_id, issued_to_token_digest, expires_at DESC);

-- Only the issuing identity's own live owner session may hold the grant, at the
-- database clock. This is what makes a worker login useless here even if a
-- future change ever handed it INSERT: an agent identity is not a human, and a
-- fleet worker has no web session at all.
CREATE FUNCTION guard_result_file_download_grant_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE owner_set public.control_result_file_sets%ROWTYPE;
BEGIN
  SELECT * INTO owner_set FROM public.control_result_file_sets s
    WHERE s.tenant_id = NEW.tenant_id AND s.set_id = NEW.set_id;
  -- The file must be present and actually stored, must belong to the set the
  -- grant names, and must carry exactly the hash and size the grant records.
  -- The grant's own project must then be that file's project, so no row can
  -- name one project and point at another project's file.
  IF owner_set.set_id IS NULL OR owner_set.project_id IS DISTINCT FROM NEW.project_id
    OR NOT EXISTS (SELECT 1 FROM public.control_result_files f
      WHERE f.tenant_id = NEW.tenant_id AND f.set_id = NEW.set_id AND f.file_id = NEW.file_id
        AND f.state = 'stored' AND f.content_digest = NEW.content_digest AND f.size_bytes = NEW.size_bytes) THEN
    RAISE EXCEPTION 'result file download grant rejected' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.control_web_sessions s
      JOIN public.control_identities i ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
      JOIN public.control_role_grants g ON g.tenant_id = i.tenant_id AND g.identity_id = i.id
      WHERE s.tenant_id = NEW.tenant_id AND s.token_digest = NEW.issued_to_token_digest
        AND s.identity_id = NEW.issued_to_identity_id AND s.revoked_at IS NULL
        AND s.expires_at > NEW.issued_at
        AND i.actor_type = 'human' AND i.state = 'active'
        AND g.role_key = 'owner' AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > NEW.issued_at)
        AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'tasks.results.read')
        AND (g.project_ids ? '*' OR g.project_ids ? NEW.project_id)) THEN
    RAISE EXCEPTION 'result file download grant needs the owner session' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_file_download_grant_insert() FROM PUBLIC;
CREATE TRIGGER control_result_file_download_grants_guard BEFORE INSERT ON control_result_file_download_grants
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_download_grant_insert();

-- A grant is spent once, inside its own window, and never unspent. Everything
-- else about the row is immutable, so a spent grant cannot be re-armed.
CREATE FUNCTION guard_result_file_download_grant_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.grant_id, NEW.project_id, NEW.set_id, NEW.file_id, NEW.issued_to_token_digest,
      NEW.issued_to_identity_id, NEW.content_digest, NEW.size_bytes, NEW.issued_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.tenant_id, OLD.grant_id, OLD.project_id, OLD.set_id, OLD.file_id,
      OLD.issued_to_token_digest, OLD.issued_to_identity_id, OLD.content_digest, OLD.size_bytes,
      OLD.issued_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'result file download grant update rejected' USING ERRCODE = '23514';
  END IF;
  IF OLD.spent_at IS NOT NULL OR NEW.spent_at IS NULL
    OR NEW.spent_at < OLD.issued_at OR NEW.spent_at >= OLD.expires_at
    OR NEW.spent_at > pg_catalog.statement_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'result file download grant update rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_file_download_grant_update() FROM PUBLIC;
CREATE TRIGGER control_result_file_download_grants_update_guard BEFORE UPDATE ON control_result_file_download_grants
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_download_grant_update();

-- The grant ledger is evidence of what the owner downloaded. It is never
-- deleted, so a later question ("who was given this file?") has a record, and
-- so a spent grant cannot be removed to free the unique key for re-minting.
CREATE TRIGGER control_result_file_download_grants_no_delete BEFORE DELETE ON control_result_file_download_grants
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_result_file_download_grants_no_truncate BEFORE TRUNCATE ON control_result_file_download_grants
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

REVOKE ALL ON control_result_file_download_grants FROM PUBLIC;
