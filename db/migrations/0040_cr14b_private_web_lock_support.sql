-- Row-lock privilege without authority-bearing UPDATE permissions. Always false.
ALTER TABLE control_identities ADD COLUMN web_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_identities_web_lock CHECK (web_lock IS FALSE);
ALTER TABLE control_role_grants ADD COLUMN web_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_role_grants_web_lock CHECK (web_lock IS FALSE);
ALTER TABLE workspaces ADD COLUMN web_lock boolean NOT NULL DEFAULT false
  CONSTRAINT workspaces_web_lock CHECK (web_lock IS FALSE);
ALTER TABLE control_connection_registry_heads ADD COLUMN web_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_connection_registry_heads_web_lock CHECK (web_lock IS FALSE);

-- Revocation cannot be cleared, shifted, or used to replace an assertion binding.
CREATE FUNCTION protect_private_web_session() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.tenant_id, NEW.token_digest, NEW.identity_id, NEW.issued_at, NEW.expires_at)
    IS DISTINCT FROM (OLD.tenant_id, OLD.token_digest, OLD.identity_id, OLD.issued_at, OLD.expires_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'private session is immutable except first revocation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER control_web_sessions_revocation_guard BEFORE UPDATE ON control_web_sessions
  FOR EACH ROW EXECUTE FUNCTION protect_private_web_session();
