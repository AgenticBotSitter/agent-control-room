-- Forward-only correction for SQL NULL/three-valued logic in the original trigger.
-- A version-1 record must supply every hash; legacy version-0 rows remain valid.
-- Validate existing rows. If invalid history exists, stop for operator review rather
-- than filling in invented hashes, rewriting audit history, or skipping validation.
ALTER TABLE audit_events ADD CONSTRAINT ck_audit_chain_v1_required_hashes
  CHECK (chain_version <> 1 OR
    (event_digest IS NOT NULL AND prev_hash IS NOT NULL AND event_hash IS NOT NULL));
