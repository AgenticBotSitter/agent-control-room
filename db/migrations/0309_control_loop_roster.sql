-- Additive B6 model roster master. The production migrator owns transaction/ledger.
-- The database is the one master; <install>/roster/roster-export.tsv is a read-only
-- export of it. Rows carry only export structure (no tab, CR or LF in a field; no
-- name that makes its line a "#" comment or blank, which cr would skip unchecked):
-- every roster rule (launchers, roles, efforts, nicks, grades) belongs to the
-- tools' `cr models check`, which the product runs on each candidate before commit.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
CREATE TABLE control_loop_roster_models (
  tenant_id text NOT NULL REFERENCES tenants(id) CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  name text NOT NULL CHECK (name <> '' AND translate(name, E'\t\r\n', '') = name AND name !~ '^[[:space:]]*(#|$)'),
  position bigint NOT NULL CHECK (position BETWEEN 1 AND 10000),
  launcher text NOT NULL CHECK (translate(launcher, E'\t\r\n', '') = launcher),
  provider text NOT NULL CHECK (translate(provider, E'\t\r\n', '') = provider),
  family text NOT NULL CHECK (translate(family, E'\t\r\n', '') = family),
  model_class text NOT NULL CHECK (translate(model_class, E'\t\r\n', '') = model_class),
  roles text NOT NULL CHECK (translate(roles, E'\t\r\n', '') = roles),
  efforts text NOT NULL CHECK (translate(efforts, E'\t\r\n', '') = efforts),
  default_effort text NOT NULL CHECK (translate(default_effort, E'\t\r\n', '') = default_effort),
  cost text NOT NULL CHECK (translate(cost, E'\t\r\n', '') = cost),
  on_off text NOT NULL CHECK (translate(on_off, E'\t\r\n', '') = on_off),
  note text NOT NULL CHECK (translate(note, E'\t\r\n', '') = note),
  nick text NOT NULL CHECK (translate(nick, E'\t\r\n', '') = nick),
  max_build_grade text NOT NULL CHECK (translate(max_build_grade, E'\t\r\n', '') = max_build_grade),
  updated_by text NOT NULL CHECK (updated_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, name),
  UNIQUE (tenant_id, position)
);
-- One row per tenant. Its existence is the "seeded" flag; seedFromTsv is the only writer of a new row.
CREATE TABLE control_loop_roster_state (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  exported_version bigint CHECK (exported_version BETWEEN 1 AND 9007199254740991 AND exported_version <= version),
  exported_sha256 text CHECK (exported_sha256 ~ '^[a-f0-9]{64}$'),
  seeded_from text NOT NULL CHECK (seeded_from ~ '^(export-file|tools-seed):[a-f0-9]{64}$'),
  last_idempotency_key text CHECK (last_idempotency_key ~ '^[A-Za-z0-9:_-]{16,100}$'),
  last_request_digest text CHECK (last_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL,
  CHECK ((last_idempotency_key IS NULL) = (last_request_digest IS NULL))
);
