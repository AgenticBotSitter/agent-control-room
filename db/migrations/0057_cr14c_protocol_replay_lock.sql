-- Permit row locking without allowing replay identity or expiration mutation.
ALTER TABLE node_protocol_replay ADD COLUMN replay_lock boolean NOT NULL DEFAULT false CHECK (replay_lock IS FALSE);
