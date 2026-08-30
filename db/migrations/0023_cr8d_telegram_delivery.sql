-- CR-8D: protected Telegram allowlist, callback/update replay, and delivery state.
-- Raw chat ids, secrets, callback tokens, and provider message ids are forbidden.

CREATE TABLE control_telegram_recipients (
  tenant_id text NOT NULL, recipient_id text NOT NULL, chat_id_digest text NOT NULL CHECK (chat_id_digest ~ '^sha256:[a-f0-9]{64}$'),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[a-f0-9]{64}$'), policy_auth_tag text NOT NULL CHECK (policy_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  policy jsonb NOT NULL, verified_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY (tenant_id,recipient_id)
);
CREATE TABLE control_telegram_recipient_policy_events (
  tenant_id text NOT NULL, recipient_id text NOT NULL, policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  prior_policy_digest text CHECK (prior_policy_digest ~ '^sha256:[a-f0-9]{64}$'), policy_auth_tag text NOT NULL CHECK (policy_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  policy jsonb NOT NULL, occurred_at timestamptz NOT NULL, PRIMARY KEY (tenant_id,recipient_id,policy_digest),
  FOREIGN KEY (tenant_id,recipient_id) REFERENCES control_telegram_recipients(tenant_id,recipient_id) ON DELETE RESTRICT
);
CREATE TABLE control_telegram_callbacks (
  tenant_id text NOT NULL, callback_id text NOT NULL, project_id text NOT NULL, recipient_id text NOT NULL,
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'), record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  record jsonb NOT NULL, issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY (tenant_id,callback_id),
  FOREIGN KEY (tenant_id,recipient_id) REFERENCES control_telegram_recipients(tenant_id,recipient_id) ON DELETE RESTRICT
);
CREATE TABLE control_telegram_updates (
  tenant_id text NOT NULL, update_id bigint NOT NULL, observation_digest text NOT NULL CHECK (observation_digest ~ '^sha256:[a-f0-9]{64}$'),
  observation_auth_tag text NOT NULL CHECK (observation_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'), observation jsonb NOT NULL, observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,update_id)
);
CREATE TABLE control_telegram_callback_receipts (
  tenant_id text NOT NULL, callback_id text NOT NULL, update_id bigint NOT NULL, proposal_digest text NOT NULL CHECK (proposal_digest ~ '^sha256:[a-f0-9]{64}$'),
  proposal_auth_tag text NOT NULL CHECK (proposal_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'), proposal jsonb NOT NULL, recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,callback_id), UNIQUE (tenant_id,update_id),
  FOREIGN KEY (tenant_id,callback_id) REFERENCES control_telegram_callbacks(tenant_id,callback_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,update_id) REFERENCES control_telegram_updates(tenant_id,update_id) ON DELETE RESTRICT
);
CREATE TABLE control_telegram_deliveries (
  tenant_id text NOT NULL, delivery_id text NOT NULL, project_id text NOT NULL, recipient_id text NOT NULL, idempotency_key text NOT NULL,
  presentation_digest text NOT NULL CHECK (presentation_digest ~ '^sha256:[a-f0-9]{64}$'), presentation jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','sending','retry_wait','delivered','ambiguous','dead_letter')),
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 0 AND 3), next_attempt_at timestamptz NOT NULL, claim_id text, claim_expires_at timestamptz, last_claim_id text,
  provider_receipt_digest text CHECK (provider_receipt_digest ~ '^sha256:[a-f0-9]{64}$'), safe_reason_code text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  state_auth_tag text NOT NULL CHECK (state_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'), PRIMARY KEY (tenant_id,delivery_id), UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,recipient_id) REFERENCES control_telegram_recipients(tenant_id,recipient_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((state='sending') = (claim_id IS NOT NULL AND claim_expires_at IS NOT NULL)),
  CHECK ((state='delivered') = (provider_receipt_digest IS NOT NULL))
);
CREATE INDEX idx_control_telegram_delivery_ready ON control_telegram_deliveries(tenant_id,state,next_attempt_at,created_at,delivery_id);

-- A tenant-wide authenticated state head detects privileged row deletion in
-- every Telegram queue, callback, receipt, policy, and delivery table.
CREATE TABLE control_telegram_integrity (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  record_count bigint NOT NULL CHECK (record_count >= 0),
  state_digest text NOT NULL CHECK (state_digest ~ '^sha256:[a-f0-9]{64}$'),
  state_auth_tag text NOT NULL CHECK (state_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$')
);

CREATE TRIGGER control_telegram_recipients_delete_guard BEFORE DELETE ON control_telegram_recipients FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_telegram_recipient_policy_events_append_only BEFORE UPDATE OR DELETE ON control_telegram_recipient_policy_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_telegram_callbacks_append_only BEFORE UPDATE OR DELETE ON control_telegram_callbacks FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_telegram_updates_append_only BEFORE UPDATE OR DELETE ON control_telegram_updates FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_telegram_callback_receipts_append_only BEFORE UPDATE OR DELETE ON control_telegram_callback_receipts FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
