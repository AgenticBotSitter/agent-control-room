-- Exact authenticated retries are safe delivery duplicates, not new work.
-- Legacy rows remain NULL and therefore can never qualify as exact duplicates.
ALTER TABLE node_protocol_replay ADD COLUMN frame_digest text;
ALTER TABLE node_protocol_replay ADD CONSTRAINT ck_node_protocol_replay_frame_digest
  CHECK (frame_digest IS NULL OR frame_digest ~ '^sha256:[a-f0-9]{64}$');

