-- Production migration ledger. Applied exactly once per migration file by
-- deploy/postgres/apply-migrations.mjs inside the same transaction as the file.
-- db/migrations/*.sql contents are read-only inputs; this table is the only
-- production schema object owned by the #63 package (DDL lives here, not there).
CREATE TABLE IF NOT EXISTS control_room_schema_migrations (
  filename text PRIMARY KEY CHECK (filename ~ '^[0-9]{4}_[a-z0-9_]+\.sql$|^db/'),
  digest text NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  ledger_order integer NOT NULL CHECK (ledger_order >= 1),
  pre_schema_digest text NOT NULL CHECK (pre_schema_digest ~ '^sha256:[a-f0-9]{64}$'),
  post_schema_digest text NOT NULL CHECK (post_schema_digest ~ '^sha256:[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON control_room_schema_migrations FROM PUBLIC;
