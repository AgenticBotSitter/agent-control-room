-- Durable, bounded replay claims for the GitHub App webhook receiver. The live
-- receiver must claim both the delivery ID and the verified body signature in
-- one transaction before publishing a wake-up hint.
CREATE TABLE control_github_webhook_replays (
  replay_key text PRIMARY KEY
    CHECK (replay_key ~ '^(delivery|signature):[A-Za-z0-9=:_-]{8,180}$'),
  recorded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > recorded_at)
);

CREATE INDEX idx_control_github_webhook_replays_expiry
  ON control_github_webhook_replays(expires_at);

CREATE FUNCTION guard_github_webhook_replay_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'github webhook replay mutation rejected';
END $$;
REVOKE ALL ON FUNCTION guard_github_webhook_replay_update() FROM PUBLIC;

CREATE TRIGGER control_github_webhook_replays_no_update
  BEFORE UPDATE ON control_github_webhook_replays
  FOR EACH ROW EXECUTE FUNCTION guard_github_webhook_replay_update();

CREATE FUNCTION guard_github_webhook_replay_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'live github webhook replay deletion rejected';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION guard_github_webhook_replay_delete() FROM PUBLIC;

CREATE TRIGGER control_github_webhook_replays_expired_delete_only
  BEFORE DELETE ON control_github_webhook_replays
  FOR EACH ROW EXECUTE FUNCTION guard_github_webhook_replay_delete();

CREATE TRIGGER control_github_webhook_replays_no_truncate
  BEFORE TRUNCATE ON control_github_webhook_replays
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
