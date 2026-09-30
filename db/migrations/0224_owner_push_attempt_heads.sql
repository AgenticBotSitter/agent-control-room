-- MIG-I: bounded, restart-safe retry metadata for owner phone notifications.
--
-- 0196 widens the COORDINATOR outbox guard for service incidents. It says
-- nothing about push delivery: `control_outbox` is an internal event feed that
-- no phone ever sees, and the guard admits only a fixed topic/aggregate shape.
-- The `needs_you` push this migration exists to make reliable therefore needs
-- its own durable record, and it is a separate one on purpose:
--
--   * The 0174 `owner_web_push_deliveries` ledger answers "has THIS browser
--     already been handed this (subscription,dedupe_key) pair". It is keyed by
--     subscription, not by the item, so it cannot answer "is this stall still
--     waiting to be retried", and it has no attempt counter, no next-attempt
--     time and no terminal state. A reservation that failed against a dead push
--     service is therefore invisible to any retry that did not consult it.
--   * This table is keyed by the OWNER ATTENTION ITEM, so one stall owns exactly
--     one row for its whole life. The unique (tenant_id, action_inbox_id) key is
--     the idempotence guarantee: a second dispatcher, a repeated loop tick, or a
--     host restart can only ever find the same row.
--
-- It records the RESERVATION, not the send. A row in state 'reserved' means a
-- dispatcher is, or was, part-way through handing this item to the push
-- service. 'delivered' is terminal and, because the item key is unique, a
-- delivered item can never be reserved again. That is what makes "never two
-- pushes for one stall" a property of the schema rather than of careful code.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_owner_push_attempt_heads (
  tenant_id text NOT NULL,
  action_inbox_id text NOT NULL,
  -- The deep link the owner's phone opens. Local product path only, exactly as
  -- src/web-push/v1/policy.ts validates, so a stored link can never be an open
  -- redirect even if the row were written by a compromised caller.
  link text NOT NULL CHECK (link ~ '^/(?:needs-me|morning|settings)$'),
  -- Bounded by construction: an item is attempted at most ATTEMPT_LIMIT times
  -- and then stops for good. Retrying forever is how a broken push service
  -- becomes a background process that never stops.
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  state text NOT NULL CHECK (state IN ('pending','reserved','delivered','failed')),
  -- The next time this item may be attempted. Backs off with the attempt count.
  next_attempt_at timestamptz NOT NULL,
  reserved_at timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  -- A safe reason only. Never an HTTP body, endpoint, or task text.
  safe_reason_code text CHECK (safe_reason_code IS NULL OR safe_reason_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, action_inbox_id),
  FOREIGN KEY (tenant_id, action_inbox_id) REFERENCES control_action_inbox(tenant_id, id) ON DELETE CASCADE,
  CHECK ((state='delivered') = (completed_at IS NOT NULL)),
  CHECK (state<>'reserved' OR reserved_at IS NOT NULL)
);

-- The claim query's only index: due, not-yet-delivered rows in due order. A
-- partial index on state IN ('pending','reserved') keeps the index small no
-- matter how many delivered items accumulate over the life of the installation.
CREATE INDEX control_owner_push_attempt_heads_due
  ON control_owner_push_attempt_heads(next_attempt_at, action_inbox_id)
  WHERE state IN ('pending','reserved');

REVOKE ALL ON control_owner_push_attempt_heads FROM PUBLIC;
