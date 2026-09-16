-- Durable, content-free wake-up hints produced only after GitHub webhook
-- admission succeeds. GitHub remains canonical; these rows grant no work,
-- review, or merge authority and may be pruned only after expiry.
CREATE TABLE control_github_worker_wake_hints (
  hint_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE
    CHECK (delivery_id ~ '^[A-Za-z0-9-]{8,100}$'),
  source text NOT NULL CHECK (source = 'github-app-webhook'),
  repository text NOT NULL
    CHECK (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  event text NOT NULL CHECK (event IN
    ('issues','issue_comment','pull_request','pull_request_review','check_suite','workflow_run')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{1,63}$'),
  issue_or_pull_number integer CHECK (issue_or_pull_number IS NULL OR issue_or_pull_number > 0),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > recorded_at)
);

CREATE INDEX idx_control_github_worker_wake_hints_cursor
  ON control_github_worker_wake_hints(hint_id);
CREATE INDEX idx_control_github_worker_wake_hints_expiry
  ON control_github_worker_wake_hints(expires_at);

CREATE FUNCTION guard_github_worker_wake_hint_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'github worker wake hint mutation rejected';
END $$;
REVOKE ALL ON FUNCTION guard_github_worker_wake_hint_update() FROM PUBLIC;

CREATE TRIGGER control_github_worker_wake_hints_no_update
  BEFORE UPDATE ON control_github_worker_wake_hints
  FOR EACH ROW EXECUTE FUNCTION guard_github_worker_wake_hint_update();

CREATE FUNCTION guard_github_worker_wake_hint_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'live github worker wake hint deletion rejected';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION guard_github_worker_wake_hint_delete() FROM PUBLIC;

CREATE TRIGGER control_github_worker_wake_hints_expired_delete_only
  BEFORE DELETE ON control_github_worker_wake_hints
  FOR EACH ROW EXECUTE FUNCTION guard_github_worker_wake_hint_delete();

CREATE TRIGGER control_github_worker_wake_hints_no_truncate
  BEFORE TRUNCATE ON control_github_worker_wake_hints
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
