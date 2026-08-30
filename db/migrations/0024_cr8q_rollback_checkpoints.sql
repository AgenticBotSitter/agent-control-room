-- CR-8Q: database-local heads carry a monotonic revision that is pinned by an
-- owner-controlled checkpoint outside the protected database/ledger domain.

ALTER TABLE control_completion_gate_integrity
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE control_completion_gate_integrity ALTER COLUMN revision DROP DEFAULT;

ALTER TABLE control_telegram_integrity
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE control_telegram_integrity ALTER COLUMN revision DROP DEFAULT;
