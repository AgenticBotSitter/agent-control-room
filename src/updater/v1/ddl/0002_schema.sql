-- Schema `updater`: the updater's own tables, guards, grants and size bounds.
--
-- This file is the updater's FIXED DDL (design §9.1, R10a), applied at install
-- time by the updater itself, idempotently, from updater/<ver>/ddl/. It is NOT
-- the release migration ledger: nothing in db/migrations/ creates, alters,
-- grants or drops anything in this schema, and the migrator — the account that
-- owns and runs the release ledger, and the account whose SQL a candidate
-- controls — holds no privilege here at all, not even USAGE.
--
-- WHY A SEPARATE SCHEMA (R10). In the release ledger the tables would be owned
-- by the account that executes candidate SQL, so a candidate could rewrite the
-- plan it is asking the owner to approve. Here the owner is the deployer login,
-- which is reachable only by peer authentication from a root process
-- (0001_deployer_role.sql), so the same class of attack has no path in.
--
-- HOW THE BOUNDARIES ARE ENFORCED, and which layer does what:
--
--   * ACLs      stop the web login, the migrator and the service logins from
--               reading, changing or deleting anything here, and give the web
--               login exactly the narrow reads and inserts §9.1/§5.3/§5.6 name.
--   * CHECKs    bound every byte a lower-trust caller can write (R16), so a
--               junk row is refused by the database and never reaches a parser.
--   * Triggers  enforce the state machines, the single-open-plan rule, the run
--               lease and the owner-session requirement on the four tables the
--               web can insert into. A trigger is what a table-wide INSERT grant
--               cannot be talked out of: the row is checked by the table's own
--               code whatever the session believes it is.
--
-- SEARCH_PATH (R10b). Every function below declares
-- `SET search_path = pg_catalog, updater, pg_temp` and schema-qualifies every
-- object it touches, so a candidate that can create objects in `public` cannot
-- shadow a table or function a guard reads. `pg_temp` is last, which is the
-- order that stops a temp object from being found first. The updater's own
-- connection sets the same path (see src/updater/v1/connection.ts); the schema
-- being present in every function's path is what lets a trigger body say
-- `updater.runs` and have it mean the one table here.
--
-- NO ROW IN ANY TABLE HERE CARRIES AUTHORITY. An approval row is evidence the
-- web received an assertion; the updater verifies that assertion itself against
-- its own passkey file and its own plan file before any effect (design §5.3).
-- The guards below make the rows well-formed and non-replayable; they cannot
-- make an assertion valid.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
-- The schema itself is created by 0000_bootstrap.sql, which runs once as the
-- installer's bootstrap superuser. This file does NOT create it: `CREATE SCHEMA`
-- needs CREATE on the DATABASE, the deployer role must not hold that (it would
-- be a database-level privilege the Mac-local grant-convergence tool refuses as
-- unreachable-from-here), and a login that can create schemas in the release
-- database is a login the migrator's blast radius would grow into. The result is
-- that everything below runs under the deployer's own authority, which is the
-- point: if any statement here ever needed more than "I own schema `updater`",
-- it would fail here rather than in production.
--
-- What replaces the lost "did the right thing happen" assurance is the owner
-- check below, which is the same check 0000 performs: a schema named `updater`
-- that is owned by anyone other than the deployer is refused, on every apply.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
      WHERE n.nspname = 'updater' AND r.rolname = 'control_room_deployer') THEN
    RAISE EXCEPTION 'updater schema missing or not owned by control_room_deployer; run 0000_bootstrap.sql first'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- PUBLIC holds nothing here, and neither does any role that is not the deployer.
-- This is the first statement that matters after CREATE SCHEMA: a new schema
-- grants its owner everything and PUBLIC nothing, but an operator tool that
-- ran `GRANT ALL ON ALL TABLES IN SCHEMA` earlier would have changed that, and
-- this is applied on every start.
REVOKE ALL ON SCHEMA updater FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The two bound helpers, defined BEFORE the tables that CHECK on them
-- ---------------------------------------------------------------------------
-- A CHECK constraint may not contain a subquery, so the transports bound cannot
-- be written inline: `cardinality() <= 8` is fine, but "no element longer than 32
-- bytes" needs `unnest`, and PostgreSQL refuses that with `0A000`. An IMMUTABLE
-- function is the supported way to express it, and putting it here rather than in
-- 0003 is what lets `CREATE TABLE` use it — a function defined later in the file
-- would not exist yet.
--
-- IMMUTABLE IS NOT DECORATIVE. It is what makes the function usable in a CHECK
-- at all, and it is also what makes it safe: the result depends only on its
-- argument and not on the session, the clock or any table, so a row's legality
-- cannot change under it. Both are `LANGUAGE sql` over one expression each, so
-- there is no plpgsql and no way to smuggle a statement in.
--
-- `pg_temp` LAST, like every other routine in this schema (R10b), so an object a
-- candidate created cannot be found by one of these names first.
CREATE OR REPLACE FUNCTION updater.bounded_transports(value text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, updater, pg_temp AS $$
  SELECT cardinality(value) <= 8
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(value) AS t WHERE pg_catalog.length(t) > 32)
$$;
REVOKE ALL ON FUNCTION updater.bounded_transports(text[]) FROM PUBLIC;

-- The add-mode assertion's pairing, as a predicate rather than a five-branch
-- CHECK, so the table, the ALTER and any future caller all ask the same question.
-- `auth_user_handle` is deliberately absent: a user handle is optional on an
-- assertion (a discoverable credential returns one, an allow-list one may not),
-- so its absence cannot make the set partial.
CREATE OR REPLACE FUNCTION updater.authorization_complete(credential_id text, authenticator_data bytea,
  client_data_json bytea, signature bytea) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, updater, pg_temp AS $$
  SELECT (credential_id IS NULL AND authenticator_data IS NULL AND client_data_json IS NULL
      AND signature IS NULL)
    OR (credential_id IS NOT NULL AND authenticator_data IS NOT NULL AND client_data_json IS NOT NULL
      AND signature IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION updater.authorization_complete(text, bytea, bytea, bytea) FROM PUBLIC;

-- EXECUTE FOR THE WEB LOGIN IS REQUIRED, NOT OPTIONAL — and both GRANTs come
-- AFTER both REVOKEs on purpose.
--
-- WHY IT IS REQUIRED. A CHECK constraint is evaluated as the role doing the
-- INSERT, so a function named inside one is CALLED AS THAT ROLE. `CREATE FUNCTION`
-- grants EXECUTE to PUBLIC by default, so the web could already evaluate these —
-- but the moment either is REVOKEd from PUBLIC without a grant back, every web
-- insert here fails with `permission denied for function`, which is a refusal
-- that looks like a permissions mistake rather than a missing grant. This is the
-- same lesson `scripts/mac-local/database-upgrade-grants.mjs` already records for
-- MIG-I's push-endpoint allow list (0227): in a comment there, and as a named
-- grant here.
--
-- WHY THE ORDER. REVOKE closes the PUBLIC default that CREATE FUNCTION installed;
-- GRANT then re-opens exactly one named caller for the one statement shape that
-- needs it. Granting first and revoking second would leave the web with no
-- EXECUTE at all, and `CREATE OR REPLACE FUNCTION` on the next startup would
-- restore the PUBLIC default — so the close must be the last thing that runs
-- before the reopen.
--
-- WHAT EXECUTE CONVEYS HERE: nothing. Both are IMMUTABLE, pure SQL over their own
-- arguments, own no object and reach no table. All it grants is the ability to
-- ask whether a value is inside a bound, which is the entire question a CHECK
-- asks. The deployer keeps its implicit owner privilege and the migrator still
-- holds no USAGE on the schema at all.
GRANT EXECUTE ON FUNCTION updater.bounded_transports(text[]) TO control_room_private_web;
GRANT EXECUTE ON FUNCTION updater.authorization_complete(text, bytea, bytea, bytea)
  TO control_room_private_web;

-- ---------------------------------------------------------------------------
-- plans — one row per install/update proposal the updater has written
-- ---------------------------------------------------------------------------
-- The authoritative copy of a plan is `updater-state/plans/<id>.json` on disk
-- (design §5.2). This row is the display projection the web renders the Install
-- card from, and the row that carries `plan_digest`, so a page that shows one
-- plan while the updater holds another is visible rather than silent.
--
-- `plan_json` is bounded at 64 KiB (R16). The whole v2 plan with its candidate,
-- artifact, database, updaterDerived and botSays blocks is a few kilobytes;
-- 64 KiB leaves room for every bounded field and refuses a payload that is
-- trying to be something else.
CREATE TABLE IF NOT EXISTS updater.plans (
  plan_id text PRIMARY KEY CHECK (plan_id ~ '^[A-Za-z0-9._-]{1,80}$'),
  installation_id text NOT NULL CHECK (installation_id ~ '^[A-Za-z0-9._-]{1,80}$'),
  kind text NOT NULL CHECK (kind IN ('code','database','updater','setting','rollback')),
  state text NOT NULL CHECK (state IN ('building','ready_for_approval','approved','approval_required',
    'refused_build','superseded','done')),
  -- The updater's own classification of the candidate (design §10.2). `classes`
  -- is the set; the individual booleans exist because the owner card and the
  -- §9.7 refusals both ask about one class at a time and a card that has to
  -- parse an array to answer "is this updater-class" is a card that can be
  -- wrong quietly.
  classes text[] NOT NULL CHECK (classes <@ ARRAY['code','database','protected','dependency','updater']::text[]
    AND cardinality(classes) BETWEEN 1 AND 5),
  changes_database boolean NOT NULL,
  changes_updater boolean NOT NULL,
  plan_digest text NOT NULL CHECK (plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  plan_json jsonb NOT NULL CHECK (jsonb_typeof(plan_json) = 'object'
    AND octet_length(plan_json::text) <= 65536),
  -- `kind = 'updater'` and a plan that switches self-update On are the two
  -- shapes that need the root-rendered Mac confirmation as well as the passkey
  -- (§5.4, R4a). Stored as data so the updater and the web cannot disagree about
  -- which plans those are.
  needs_mac_confirm boolean NOT NULL
    CHECK (needs_mac_confirm = (kind = 'updater' OR kind = 'setting')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_by_plan_id text,
  CONSTRAINT plans_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT plans_not_superseded_by_itself CHECK (superseded_by_plan_id IS NULL
    OR superseded_by_plan_id <> plan_id),
  CONSTRAINT plans_superseded_only_when_named CHECK ((state = 'superseded') = (superseded_by_plan_id IS NOT NULL)),
  CONSTRAINT plans_digest_matches_kind CHECK (plan_json->>'schema' = 'control-room.install-plan/v2'
    AND plan_json->>'planId' = plan_id AND plan_json->>'kind' = kind)
);

CREATE INDEX IF NOT EXISTS plans_open ON updater.plans(created_at, plan_id)
  WHERE state IN ('building','ready_for_approval','approved','approval_required');
CREATE INDEX IF NOT EXISTS plans_expiry ON updater.plans(expires_at);

-- ---------------------------------------------------------------------------
-- plan_approvals — the web's INSERT-only assertion rows
-- ---------------------------------------------------------------------------
-- Every column here is bytes from a passkey assertion plus what the web knows.
-- The sizes are the design's (R16): authenticator_data <= 1 KiB,
-- client_data_json <= 4 KiB, signature <= 512 B, user_handle <= 128 B. A row
-- larger than that is refused by the CHECK before any parser sees it, which is
-- what "inputs over the CHECK bounds never reach the parser" means.
--
-- `id` is a caller-chosen idempotency key, so a retried Face ID sheet cannot
-- create a second row for one assertion and the updater cannot be handed the
-- same assertion twice under two identities. The nonce is what the updater
-- itself burns (§5.3 step 7), so the design's replay rule is enforced by the
-- updater's own nonces.log; this table is the evidence, not the authority.
CREATE TABLE IF NOT EXISTS updater.plan_approvals (
  id text PRIMARY KEY CHECK (id ~ '^approval:[0-9a-f-]{36}$'),
  plan_id text NOT NULL REFERENCES updater.plans(plan_id) ON DELETE RESTRICT,
  credential_id text NOT NULL CHECK (credential_id ~ '^[A-Za-z0-9_-]{16,255}$'),
  authenticator_data bytea NOT NULL CHECK (octet_length(authenticator_data) BETWEEN 32 AND 1024),
  client_data_json bytea NOT NULL CHECK (octet_length(client_data_json) BETWEEN 1 AND 4096),
  signature bytea NOT NULL CHECK (octet_length(signature) BETWEEN 32 AND 512),
  user_handle bytea CHECK (user_handle IS NULL OR octet_length(user_handle) <= 128),
  -- The session that inserted the row. NOT NULL and bound to a live, unrevoked,
  -- unexpired owner web session by the guard below: an approval with no owner
  -- session behind it is refused, which is R16's "owner session required" and
  -- the §5.4 "stolen cookie cannot install" row.
  owner_session_digest text NOT NULL CHECK (owner_session_digest ~ '^sha256:[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_approvals_pending ON updater.plan_approvals(received_at, id);

-- ---------------------------------------------------------------------------
-- plan_approval_outcomes — the updater's verdict on each approval row
-- ---------------------------------------------------------------------------
-- Append-only. One row per approval the updater has decided, so the web can
-- show "refused" next to a plan without reading the journal, and so the §5.3
-- aggregation (one journal line and one push per plan per hour, R16) has a
-- database-side count to aggregate over. `refusal_reason` is a bounded token,
-- never free text: a reason is a code the updater chose, not anything a caller
-- supplied.
CREATE TABLE IF NOT EXISTS updater.plan_approval_outcomes (
  approval_id text PRIMARY KEY REFERENCES updater.plan_approvals(id) ON DELETE RESTRICT,
  plan_id text NOT NULL REFERENCES updater.plans(plan_id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('accepted','refused')),
  refusal_reason text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_outcome_reason_matches_outcome CHECK (
    (outcome = 'refused' AND refusal_reason ~ '^[a-z][a-z0-9_]{1,63}$')
    OR (outcome = 'accepted' AND refusal_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS plan_approval_outcomes_by_plan ON updater.plan_approval_outcomes(plan_id, decided_at);

-- ---------------------------------------------------------------------------
-- passkey_registrations — the web's INSERT-only attestation rows
-- ---------------------------------------------------------------------------
-- §5.1 step 4. Raw attestation bytes, bounded, INSERT only, owner session
-- required. The installer's one-row rule (exactly one registration for this R,
-- R13a) is checked by the updater from its own file, not here: this table
-- deliberately allows more than one row per R so the race that rule exists to
-- catch is VISIBLE, and the installer refuses and restarts when it sees two.
-- So there is NO UNIQUE constraint on `registration_digest` and there must never
-- be one: a unique index would make the second racer's INSERT raise instead of
-- land, and the race would become invisible rather than refused (review §5 P-1).
--
-- A WebAuthn registration response is FOUR fields, not one. Item 7's table held
-- the attestation and the comparison code, so `registrationRows` could not hand
-- the wrapper a response it would accept — the wrapper's parser refuses a
-- missing clientDataJSON before the library is ever called. The additions below
-- close that, and their bounds ARE the wrapper's bounds, so an over-bound
-- response is refused by the database and never reaches a parser (R16).
CREATE TABLE IF NOT EXISTS updater.passkey_registrations (
  id text PRIMARY KEY CHECK (id ~ '^passkey-registration:[0-9a-f-]{36}$'),
  -- The single-use registration secret, as a digest. The secret itself never
  -- reaches the database.
  registration_digest text NOT NULL CHECK (registration_digest ~ '^sha256:[a-f0-9]{64}$'),
  credential_id text NOT NULL CHECK (credential_id ~ '^[A-Za-z0-9_-]{16,255}$'),
  attestation_object bytea NOT NULL CHECK (octet_length(attestation_object) BETWEEN 32 AND 8192),
  -- §5.1 steps 3 and 6. The wrapper bounds clientDataJSON at 1..4096 bytes and
  -- refuses any base64url that does not round-trip exactly, so the column's
  -- bound is the same 1..4096 and no more (review §5 P-1). The bound itself is
  -- installed by the ALTER below rather than written here, so that a fresh
  -- install and an upgraded one get it from the SAME statement and the two
  -- cannot drift; see the note at that ALTER.
  client_data_json bytea NOT NULL,
  -- The transports the browser reported, bounded exactly as the wrapper bounds
  -- them: at most 8 entries, each at most 32 bytes. An empty array is legal and
  -- means the browser reported none. Bound installed by the ALTER below.
  transports text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- The 6-character comparison code the phone showed and the owner typed at the
  -- installer (R13b). Bounded to the exact alphabet the code is drawn from, so
  -- a row cannot carry a paragraph.
  comparison_code text NOT NULL CHECK (comparison_code ~ '^[0-9A-Z]{6}$'),
  owner_session_digest text NOT NULL CHECK (owner_session_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- -------------------------------------------------------------------------
  -- `passkey add`'s existing-passkey assertion (§5.1 step 7). NULL on the
  -- initial registration, and NULL is the cooling-off route: no assertion means
  -- the new key enters its 24 h cooling-off rather than being active at once.
  --
  -- These are an ASSERTION's bytes, so they carry `plan_approvals`' bounds:
  -- authenticator_data 37..1024 (the wrapper's floor is rpIdHash + flags +
  -- signCount = 37), client_data_json 1..4096, signature 32..512, user_handle
  -- at most 128. The pairing CHECK makes the set all-null or all-present, so a
  -- row cannot carry a credential id with no signature: an incomplete assertion
  -- is not a weaker assertion, it is a parse error waiting to happen.
  -- -------------------------------------------------------------------------
  auth_credential_id text CHECK (auth_credential_id IS NULL OR auth_credential_id ~ '^[A-Za-z0-9_-]{16,255}$'),
  auth_authenticator_data bytea
    CHECK (auth_authenticator_data IS NULL OR octet_length(auth_authenticator_data) BETWEEN 37 AND 1024),
  auth_client_data_json bytea
    CHECK (auth_client_data_json IS NULL OR octet_length(auth_client_data_json) BETWEEN 1 AND 4096),
  auth_signature bytea CHECK (auth_signature IS NULL OR octet_length(auth_signature) BETWEEN 32 AND 512),
  auth_user_handle bytea CHECK (auth_user_handle IS NULL OR octet_length(auth_user_handle) <= 128),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS passkey_registrations_by_registration ON updater.passkey_registrations(registration_digest, received_at);

-- The three new columns are ALTERs as well as parts of the CREATE above, and
-- that is not redundancy — it is the only way both installs work.
--
-- WHY. The updater applies this file at every startup, and `CREATE TABLE IF NOT
-- EXISTS` does NOT add a column to a table that already exists. So an install
-- that already has item 7's shape keeps its shape, and without the ALTERs every
-- insert fails on a missing NOT NULL column: right for a new install, wrong for
-- an upgrade.
--
-- WHY THE BOUNDS ARE ONLY IN THE ALTERs. A CHECK written inline in the CREATE
-- would fire on a new install and then the named ALTER below would try to add a
-- SECOND constraint — which for the same columns means two enforcement points
-- that can drift apart. Every bound for these three columns is therefore
-- installed by exactly one named `ADD CONSTRAINT`, on both paths, so there is one
-- statement to read and one to mutate. The loader sends this whole file as one
-- query, so the CREATE and its ALTERs commit together: there is no window in
-- which the columns exist without their bounds.
--
-- The temporary default satisfies NOT NULL on the pre-existing table and is
-- dropped again immediately, so the end state is NOT NULL with no default: a new
-- row must carry real client data. An old installation is upgraded before the
-- web login can insert here, and a web insert that did somehow supply the empty
-- default is refused by the length CHECK regardless.
ALTER TABLE updater.passkey_registrations ADD COLUMN IF NOT EXISTS
  client_data_json bytea NOT NULL DEFAULT ''::bytea;
ALTER TABLE updater.passkey_registrations ALTER COLUMN client_data_json DROP DEFAULT;
ALTER TABLE updater.passkey_registrations ADD COLUMN IF NOT EXISTS
  transports text[] NOT NULL DEFAULT ARRAY[]::text[];
-- The five `auth_*` columns arrive the same way, and they have to arrive HERE,
-- before the pairing CHECK below names them: on item 7's table that CHECK was the
-- first statement to reference a column that did not exist, and the upgrade
-- stopped with 42703 (review passkey2 DB-3). All five are nullable with no
-- default, so an existing row gains NULLs, which is the "no assertion" shape the
-- pairing CHECK accepts.
ALTER TABLE updater.passkey_registrations ADD COLUMN IF NOT EXISTS auth_credential_id text;
ALTER TABLE updater.passkey_registrations ADD COLUMN IF NOT EXISTS auth_authenticator_data bytea;
ALTER TABLE updater.passkey_registrations ADD COLUMN IF NOT EXISTS auth_client_data_json bytea;
ALTER TABLE updater.passkey_registrations ADD COLUMN IF NOT EXISTS auth_signature bytea;
ALTER TABLE updater.passkey_registrations ADD COLUMN IF NOT EXISTS auth_user_handle bytea;
-- Their bounds are written inline in the CREATE above, so a fresh install gets
-- them under PostgreSQL's generated names (`<table>_<column>_check`). An
-- upgraded table got the columns from the ALTERs, which carry no CHECK, so the
-- same constraints are added here UNDER THE SAME NAMES and with the same text.
-- Same names is what makes "fresh" and "upgraded" one catalog rather than two
-- that merely behave alike, and the upgrade lane compares the two catalogs
-- constraint by constraint. Added if and only if absent, so a fresh install and
-- every restart skip all five. No NOT VALID: every pre-existing row holds NULL
-- in these columns, which each CHECK accepts.
DO $$
DECLARE
  bound record;
BEGIN
  FOR bound IN SELECT * FROM (VALUES
      ('passkey_registrations_auth_credential_id_check',
       'CHECK (auth_credential_id IS NULL OR auth_credential_id ~ ''^[A-Za-z0-9_-]{16,255}$'')'),
      ('passkey_registrations_auth_authenticator_data_check',
       'CHECK (auth_authenticator_data IS NULL OR octet_length(auth_authenticator_data) BETWEEN 37 AND 1024)'),
      ('passkey_registrations_auth_client_data_json_check',
       'CHECK (auth_client_data_json IS NULL OR octet_length(auth_client_data_json) BETWEEN 1 AND 4096)'),
      ('passkey_registrations_auth_signature_check',
       'CHECK (auth_signature IS NULL OR octet_length(auth_signature) BETWEEN 32 AND 512)'),
      ('passkey_registrations_auth_user_handle_check',
       'CHECK (auth_user_handle IS NULL OR octet_length(auth_user_handle) <= 128)')) AS v(name, definition)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'updater' AND t.relname = 'passkey_registrations' AND c.conname = bound.name) THEN
      EXECUTE pg_catalog.format('ALTER TABLE updater.passkey_registrations ADD CONSTRAINT %I %s',
        bound.name, bound.definition);
    END IF;
  END LOOP;
END;
$$;
-- ADD COLUMN carries no column CHECK, so each bound is installed here, which is
-- the only place it is written. Each is added NOT VALID and validated in the
-- next statement, so an existing installation is checked row by row and a row
-- that cannot satisfy the bound is a row no verifier could have accepted.
--
-- On an item-7 table that already HOLDS a registration row, that row has the
-- empty default for `client_data_json` and the VALIDATE below refuses the whole
-- apply, loudly. That is stated rather than engineered around: item 7 had no
-- writer for this table (the web's insert path is item 10a's), so no item-7
-- install can hold such a row, and one that somehow did holds a response the
-- wrapper would refuse anyway. The upgrade lane proves the path for an item-7
-- schema with rows in the tables item 7 did write.
--
-- WHY EACH IS WRAPPED IN A `DO` BLOCK. PostgreSQL has no `ADD CONSTRAINT IF NOT
-- EXISTS`, and the updater applies this file at EVERY startup (design §9.1). The
-- unguarded form therefore fails on the second apply with `constraint "..."
-- already exists` — an updater that cannot restart. `tests/updater-schema-
-- postgres.test.ts` asserts that a second apply "changes nothing and refuses
-- nothing", and it caught exactly this, which is that assertion earning its
-- place. Every ADD CONSTRAINT in this schema is wrapped the same way, and the
-- wrapper is idempotent rather than merely quiet: the constraint is added if and
-- only if it is absent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'updater' AND t.relname = 'passkey_registrations'
       AND c.conname = 'passkey_registrations_client_data_bound') THEN
    ALTER TABLE updater.passkey_registrations ADD CONSTRAINT passkey_registrations_client_data_bound CHECK (octet_length(client_data_json) BETWEEN 1 AND 4096) NOT VALID;
  END IF;
END;
$$;
ALTER TABLE updater.passkey_registrations VALIDATE CONSTRAINT passkey_registrations_client_data_bound;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'updater' AND t.relname = 'passkey_registrations'
       AND c.conname = 'passkey_registrations_transports_bound') THEN
    ALTER TABLE updater.passkey_registrations ADD CONSTRAINT passkey_registrations_transports_bound CHECK (updater.bounded_transports(transports)) NOT VALID;
  END IF;
END;
$$;
ALTER TABLE updater.passkey_registrations VALIDATE CONSTRAINT passkey_registrations_transports_bound;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'updater' AND t.relname = 'passkey_registrations'
       AND c.conname = 'passkey_registrations_authorization_pair') THEN
    ALTER TABLE updater.passkey_registrations ADD CONSTRAINT passkey_registrations_authorization_pair CHECK (updater.authorization_complete(auth_credential_id, auth_authenticator_data,
    auth_client_data_json, auth_signature)) NOT VALID;
  END IF;
END;
$$;
ALTER TABLE updater.passkey_registrations VALIDATE CONSTRAINT passkey_registrations_authorization_pair;

-- ---------------------------------------------------------------------------
-- passkey_open_registrations — what the updater published for the web to use
-- ---------------------------------------------------------------------------
-- P-1's requirement, and the reason the web can be refused anything else: the
-- web may only render or accept a registration the updater itself opened. Two
-- consequences make that worth a table rather than a code check on the web:
--
--   * `options_json` is the updater's OWN `PasskeyAuthorityV1.registrationOptions`,
--     byte for byte. The challenge, the RP ID, the origin and the credential
--     lists therefore cannot be re-derived or "helpfully" adjusted by the
--     release process — there is nothing on the web side to compute them from.
--     P-2's parity requirement is met by construction rather than by a test that
--     has to keep passing.
--   * the guard in 0003 refuses any row whose digest is unknown, already
--     consumed, or expired at the DATABASE clock, and caps the rows per digest
--     so a flood stays bounded while a genuine two-row race stays visible.
--
-- The updater owns this table and is the only writer. The web gets SELECT on
-- five columns and nothing else: it can ask "is this digest open, and what
-- should I show" and cannot open one, extend one, or mark one consumed.
CREATE TABLE IF NOT EXISTS updater.passkey_open_registrations (
  registration_digest text PRIMARY KEY CHECK (registration_digest ~ '^sha256:[a-f0-9]{64}$'),
  installation_id text NOT NULL CHECK (installation_id ~ '^[A-Za-z0-9._-]{1,80}$'),
  mode text NOT NULL CHECK (mode IN ('initial','add')),
  -- The exact bytes the web must hand `navigator.credentials.create`. 16 KiB
  -- covers the whole options object with room to spare and refuses a payload
  -- that is trying to be something else; the object must be an OBJECT, so a
  -- JSON array or a bare string cannot stand in for it.
  options_json jsonb NOT NULL CHECK (jsonb_typeof(options_json) = 'object'
    AND octet_length(options_json::text) <= 16384),
  -- §5.1 step 7. Present exactly when `mode = 'add'`, and never otherwise, so an
  -- initial registration cannot acquire an add-challenge after the fact.
  authorization_challenge text CHECK (authorization_challenge IS NULL
    OR authorization_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Set by the updater when it consumes the registration (used or refused). A
  -- consumed row stays, so a late web insert is refused by name rather than by a
  -- silent expiry race.
  consumed_at timestamptz,
  CONSTRAINT passkey_open_registration_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT passkey_open_registration_challenge_matches_mode CHECK (
    (mode = 'add' AND authorization_challenge IS NOT NULL)
    OR (mode = 'initial' AND authorization_challenge IS NULL)),
  CONSTRAINT passkey_open_registration_consumed_at_after_creation
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- approval_refusals — one row per refused approval, the idempotency ledger
-- ---------------------------------------------------------------------------
-- R16's "refusals are aggregated per plan per hour". `recordApprovalRefusal`
-- claims an approval here with ON CONFLICT DO NOTHING, and only a row that was
-- actually claimed may bump the bucket — so re-processing one approval row (a
-- retried NOTIFY, a re-read of the queue) cannot increment the count a second
-- time, and cannot re-earn the "first in this hour" flag.
--
-- Append-only like every other evidence table, and `reason` is a bounded token
-- the updater chose, never free text a caller supplied.
CREATE TABLE IF NOT EXISTS updater.approval_refusals (
  approval_id text PRIMARY KEY CHECK (approval_id ~ '^approval:[0-9a-f-]{36}$'),
  plan_id text NOT NULL REFERENCES updater.plans(plan_id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{1,63}$'),
  -- The bucket is the DATABASE's hour, never the caller's clock: an updater with
  -- a skewed clock must not be able to open a second bucket for the same hour.
  bucket_start timestamptz NOT NULL DEFAULT now() - (EXTRACT(epoch FROM pg_catalog.now())
    - EXTRACT(epoch FROM pg_catalog.date_trunc('hour', pg_catalog.now()))) * interval '1 second',
  observed_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- approval_refusal_buckets — the per-plan-per-hour aggregate and its delivery
-- ---------------------------------------------------------------------------
-- One row per (plan, hour), which is what makes "one journal line and one push
-- per plan per hour" a database property rather than a convention in the caller.
--
-- `first_in_hour` is the INSERT's own `approval_id`, so "the first refusal of
-- this hour" is decided by which row created the bucket — under concurrency, by
-- the row that won the upsert — and not by a read-then-write a caller could
-- interleave.
--
-- The two delivery timestamps are P-4's durable-delivery contract: the updater
-- sets `journaled_at` only after the journal line is fsynced and `pushed_at`
-- only after the push row is committed, and it re-drives any bucket whose two
-- are not both set at startup. So a sink that failed after the count was
-- committed cannot lose the hourly alert, and a re-drive cannot duplicate it:
-- both are keyed on the bucket, and the push row carries the same idempotency
-- key.
CREATE TABLE IF NOT EXISTS updater.approval_refusal_buckets (
  plan_id text NOT NULL REFERENCES updater.plans(plan_id) ON DELETE RESTRICT,
  bucket_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 1),
  first_in_hour text NOT NULL CHECK (first_in_hour ~ '^approval:[0-9a-f-]{36}$'),
  -- The most recent approval folded into this bucket, so the updater can tell a
  -- replayed approval from a new one without reading the ledger table.
  last_approval_id text NOT NULL CHECK (last_approval_id ~ '^approval:[0-9a-f-]{36}$'),
  journaled_at timestamptz,
  pushed_at timestamptz,
  PRIMARY KEY (plan_id, bucket_start),
  CONSTRAINT approval_refusal_bucket_delivery_after_bucket CHECK (
    (journaled_at IS NULL OR journaled_at >= bucket_start)
    AND (pushed_at IS NULL OR pushed_at >= bucket_start))
);
CREATE INDEX IF NOT EXISTS approval_refusal_buckets_undelivered
  ON updater.approval_refusal_buckets(bucket_start, plan_id)
  WHERE journaled_at IS NULL OR pushed_at IS NULL;

-- ---------------------------------------------------------------------------
-- owner_requests — phone controls that reduce risk or only measure
-- ---------------------------------------------------------------------------
-- §5.6. `control_room_private_web` inserts with an owner session; the updater
-- acts on them with its own checks and the row carries no authority beyond "the
-- owner session asked". The `requires_passkey` column is the R14b split: the
-- requests that reduce risk need only a session, the ones that change what is
-- installed need a passkey assertion in `plan_approvals` for a `kind:rollback`
-- or `kind:setting` plan. `handled_at` is set by the updater, never by the web.
CREATE TABLE IF NOT EXISTS updater.owner_requests (
  id text PRIMARY KEY CHECK (id ~ '^owner-request:[0-9a-f-]{36}$'),
  request_kind text NOT NULL CHECK (request_kind IN ('pause','resume','stop','backup_now','check_and_continue',
    'repair_serve','rollback','serve_accepted','passkey_added')),
  requires_passkey boolean NOT NULL,
  -- A passkey-backed request cites the approval row that carries the assertion,
  -- so the updater can tie the request to the exact plan digest the owner
  -- signed. A session-only request leaves it NULL. The CHECK makes the pairing
  -- exact in both directions: a row cannot demand a passkey and not name one.
  approval_id text REFERENCES updater.plan_approvals(id) ON DELETE RESTRICT,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'
    AND octet_length(detail::text) <= 4096),
  owner_session_digest text NOT NULL CHECK (owner_session_digest ~ '^sha256:[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz,
  handled_outcome text CHECK (handled_outcome IS NULL OR handled_outcome IN ('acted','refused','ignored')),
  CONSTRAINT owner_request_passkey_pairing CHECK (
    (requires_passkey AND approval_id IS NOT NULL) OR (NOT requires_passkey AND approval_id IS NULL)),
  CONSTRAINT owner_request_handled_shape CHECK (
    (handled_at IS NULL AND handled_outcome IS NULL) OR (handled_at IS NOT NULL AND handled_outcome IS NOT NULL)),
  CONSTRAINT owner_request_handled_after_request CHECK (handled_at IS NULL OR handled_at >= requested_at)
);
CREATE INDEX IF NOT EXISTS owner_requests_unhandled ON updater.owner_requests(requested_at, id) WHERE handled_at IS NULL;

-- ---------------------------------------------------------------------------
-- push_queue — the web queues, the updater sends (R12)
-- ---------------------------------------------------------------------------
-- The VAPID private key is root-only, so the web can never send a push itself
-- (design §12). It writes a bounded template id plus bounded text fields; the
-- updater renders them, allow-lists the endpoint and sends. `template` is the
-- only thing that decides wording, and the two prefixes the design reserves are
-- enforced here: only the updater's own events may use
-- 'control-room-updater', and nothing but the updater writes rows at all, so a
-- web-inserted row can never claim that prefix.
CREATE TABLE IF NOT EXISTS updater.push_queue (
  id text PRIMARY KEY CHECK (id ~ '^push:[0-9a-f-]{36}$'),
  -- P-4: the caller-chosen key that makes a re-drive safe. The refusal
  -- aggregation's key is `passkey-refusal:<planId>:<bucketStart>`, so a bucket
  -- whose push sink failed can be re-driven at startup without a second alert
  -- reaching the phone. It is UNIQUE, not merely indexed: an idempotency key
  -- that does not refuse a duplicate is not an idempotency key.
  -- The alphabet is base64url PLUS `:` `.`, `-` and `_`, and the first character
  -- is constrained separately from the rest.
  --
  -- WHY THE TWO RANGES. The key is `<prefix>:<credentialId>:<suffix>`: a
  -- lowercase-word prefix, a base64url credential id (which carries UPPERCASE and
  -- DIGITS, and is the part the earlier draft refused), and a lowercase suffix.
  -- A single `[a-z][a-z0-9:._~-]*` pattern therefore had to either admit an
  -- uppercase first character — which would let a key look like a credential id
  -- — or exclude the credential id entirely. The first version did the latter, so
  -- every REAL cooling-off key was refused by this CHECK while the fixture's
  -- (lowercase) keys passed: a fixture less demanding than production, which is
  -- the worst way for a fixture to be wrong.
  --
  -- So: first character lowercase, remainder the full base64url alphabet with the
  -- four separators. The credential id can then be a key component and a key
  -- still cannot be mistaken for one.
  idempotency_key text CHECK (idempotency_key IS NULL
    OR (idempotency_key ~ '^[a-z]' AND idempotency_key ~ '^[A-Za-z0-9:._~-]{2,191}$')),
  -- The template alphabet INCLUDES `-`, and it must: the updater's own reserved
  -- prefix is `control-room-updater`, and the pattern used to be
  -- `^[a-z][a-z0-9_.]{1,63}$`. So the updater's own template ids could never be
  -- inserted at all, and the guard below that reserves the prefix
  -- (`only the updater may use its own push template`) was a rule about a
  -- namespace nothing could reach — which is why it passed for the wrong reason
  -- when item 10a tried to enqueue a real cooling-off notice and PostgreSQL
  -- refused the row on the CHECK instead. Measured, not assumed: that is what the
  -- first real-PG run of the cooling-off enqueue showed.
  --
  -- `-` is safe here because a template id is a fixed token chosen by the code
  -- that renders it, never parsed as a path or interpolated into SQL, and the
  -- guard above still decides WHO may use the prefix.
  template text NOT NULL CHECK (template ~ '^[a-z][a-z0-9._-]{1,63}$'),
  -- Fixed-template arguments only. `title` is a plan title the updater itself
  -- wrote; everything else is a code, not prose.
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 400),
  link_path text CHECK (link_path IS NULL OR link_path ~ '^/[A-Za-z0-9/._~-]{0,200}$'),
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 20),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT push_sent_shape CHECK ((sent_at IS NULL) OR attempts > 0)
);
-- The column arrives by ALTER for the same reason the registration columns did:
-- an install that already has item 7's shape must be upgraded, not skipped. It
-- comes BEFORE the index that names it; the other order failed on item 7's
-- table (review passkey2 DB-3).
ALTER TABLE updater.push_queue ADD COLUMN IF NOT EXISTS idempotency_key text;
-- Two bounds that `CREATE TABLE IF NOT EXISTS` does not bring to item 7's table,
-- under the names a fresh install gives them:
--
--   * `push_queue_idempotency_key_check`, the key's alphabet, which the ALTER
--     above could not carry;
--   * `push_queue_template_check`, which item 7 wrote WITHOUT `-`. Left alone,
--     an upgraded queue would refuse every `control-room-updater.*` template,
--     so the cooling-off enqueue would fail on exactly the installs that already
--     have an owner to warn. It is replaced only when its text lacks the `-`
--     range; widening a CHECK cannot invalidate a row the narrower one accepted.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'updater' AND t.relname = 'push_queue'
       AND c.conname = 'push_queue_idempotency_key_check') THEN
    ALTER TABLE updater.push_queue ADD CONSTRAINT push_queue_idempotency_key_check
      CHECK (idempotency_key IS NULL
        OR (idempotency_key ~ '^[a-z]' AND idempotency_key ~ '^[A-Za-z0-9:._~-]{2,191}$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'updater' AND t.relname = 'push_queue'
       AND c.conname = 'push_queue_template_check'
       AND pg_catalog.strpos(pg_catalog.pg_get_constraintdef(c.oid), 'a-z0-9._-') > 0) THEN
    ALTER TABLE updater.push_queue DROP CONSTRAINT IF EXISTS push_queue_template_check;
    ALTER TABLE updater.push_queue ADD CONSTRAINT push_queue_template_check
      CHECK (template ~ '^[a-z][a-z0-9._-]{1,63}$');
  END IF;
END;
$$;
-- A PARTIAL unique index, so the web's un-keyed pushes are unaffected while the
-- updater's keyed ones refuse a duplicate exactly. `CREATE UNIQUE INDEX IF NOT
-- EXISTS` is idempotent for the same reason every other statement here is.
CREATE UNIQUE INDEX IF NOT EXISTS push_queue_idempotency ON updater.push_queue(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS push_queue_unsent ON updater.push_queue(queued_at, id) WHERE sent_at IS NULL;

-- ---------------------------------------------------------------------------
-- runs — one update run, with its lease (design §7.2)
-- ---------------------------------------------------------------------------
-- The states are §8.1's, verbatim, including the two "do nothing on your own"
-- states: `uncertain` (the updater measures and waits for the owner's
-- check-and-continue) and `attended_upgrade_required` (it refuses and changes
-- nothing). Neither is a failure to be retried automatically, and both are in
-- the CHECK so no caller can invent a state the updater's own resume rules do
-- not handle.
--
-- `lease_token` is the updater's boot id (§7.2, SI-06). `acquire()` returns an
-- active run only with a matching token, or when the previous holder's PG
-- session is gone; the trigger below is the database half of that, so a second
-- updater process cannot hold a run even if the application logic is wrong.
CREATE TABLE IF NOT EXISTS updater.runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^run:[0-9a-f-]{36}$'),
  plan_id text NOT NULL REFERENCES updater.plans(plan_id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('approved','prechecked','staged','quick_backup','draining','quiesced',
    'backup_verified','preimage_taken','migrating','migrated','switched','restarted','healthy','succeeded',
    'rollback_started','restore_started','db_restored','code_restored','rolled_back','needs_attention',
    'uncertain','attended_upgrade_required','refused')),
  -- The class that decided this run's path. A code run and a database run take
  -- different steps, and the trigger's successor table is driven by this column,
  -- so a run cannot take a database step without a database class.
  run_class text NOT NULL CHECK (run_class IN ('code','database','updater','rollback','setting')),
  lease_token text NOT NULL CHECK (lease_token ~ '^[A-Za-z0-9._-]{1,80}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'
    AND octet_length(detail::text) <= 16384),
  CONSTRAINT runs_finished_shape CHECK ((finished_at IS NULL) = (state NOT IN
    ('succeeded','rolled_back','needs_attention','refused'))),
  CONSTRAINT runs_finished_after_start CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT runs_plan_run_pair UNIQUE (plan_id, run_id)
);

-- At most one live run, database-wide. A partial unique index is the whole
-- guarantee: two concurrent inserts cannot both see zero live rows, because the
-- second one waits for the first to commit and then fails. This is the
-- "20 updater processes -> one lease" case (P6) enforced by the database rather
-- than by a lock the callers could forget to take.
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_live ON updater.runs((true)) WHERE finished_at IS NULL;

-- ---------------------------------------------------------------------------
-- run_events — the DB display mirror of the journal (design §11, R10c)
-- ---------------------------------------------------------------------------
-- The journal FILE is the authority and is never regenerated from these rows
-- (R10c: v1's "regenerate the file from DB" is removed). These rows are written
-- by the updater login only after the file line is fsynced, and they are what
-- the web SELECTs. So the trigger forbids the web entirely (no INSERT grant) and
-- forbids UPDATE/DELETE on everyone: a display mirror that could be rewritten
-- is not a mirror.
--
-- `ordinal` is per run and strictly increasing; `state` is §8.1's state
-- vocabulary; `detail` is bounded at 16 KiB like the deploy journal's.
CREATE TABLE IF NOT EXISTS updater.run_events (
  run_id text NOT NULL REFERENCES updater.runs(run_id) ON DELETE RESTRICT,
  ordinal bigint NOT NULL CHECK (ordinal >= 1),
  state text NOT NULL CHECK (state IN ('approved','prechecked','staged','quick_backup','draining','quiesced',
    'backup_verified','preimage_taken','migrating','migrated','switched','restarted','healthy','succeeded',
    'rollback_started','restore_started','db_restored','code_restored','rolled_back','needs_attention',
    'uncertain','attended_upgrade_required','refused')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'
    AND octet_length(detail::text) <= 16384),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, ordinal)
);
CREATE INDEX IF NOT EXISTS run_events_by_time ON updater.run_events(recorded_at, run_id, ordinal);

-- ---------------------------------------------------------------------------
-- heartbeat — the updater's 30 s timer (design §7.5, R20b)
-- ---------------------------------------------------------------------------
-- A singleton row, written from a dedicated timer so a long synchronous step
-- never looks like a hang, and read by the web to show "Updater not responding"
-- at 3 minutes. The web has no INSERT here, so a compromised release cannot
-- fake a heartbeat to hide a dead updater; it has no UPDATE either.
CREATE TABLE IF NOT EXISTS updater.heartbeat (
  singleton boolean PRIMARY KEY CHECK (singleton),
  boot_id text NOT NULL CHECK (boot_id ~ '^[A-Za-z0-9._-]{1,80}$'),
  lease_token text NOT NULL CHECK (lease_token ~ '^[A-Za-z0-9._-]{1,80}$'),
  -- The updater's own idea of the state it is in, for the web's banner. It is
  -- display only; `runs.state` is what the state machine governs.
  reported_state text NOT NULL CHECK (reported_state IN ('idle','watching','building','awaiting_approval',
    'running','rolled_back','uncertain','attended_upgrade_required','paused','stopped')),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  step text CHECK (step IS NULL OR step ~ '^[a-z][a-z0-9_]{1,63}$')
);
INSERT INTO updater.heartbeat (singleton, boot_id, lease_token, reported_state)
  VALUES (true, 'not-yet-started', 'not-yet-started', 'idle')
  ON CONFLICT (singleton) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Grants: the web login's exact surface (design §9.1, §5.3, §5.6, R12, R16)
-- ---------------------------------------------------------------------------
-- Read the display tables. Column-scoped where a table-wide read would hand
-- over more than any reader needs: `plan_approvals` holds the owner's assertion
-- bytes, and the Install page needs only to know which plans have an approval
-- and what the updater decided about it. `plan_json` and the assertion columns
-- stay unreadable to the web; the web is served the plan by the updater-derived
-- card path, and the assertion bytes are the updater's business.
--
-- The deploy store's own lesson is applied here: cook/deploygrant narrowed
-- `control_deploy_approvals` from a table-wide SELECT to
-- `(tenant_id, id, candidate_id, decision_id)` for exactly this reason, and this
-- schema is where that lesson has the most force, because the columns it holds
-- are the owner's Face ID.
REVOKE ALL ON SCHEMA updater FROM PUBLIC;
GRANT USAGE ON SCHEMA updater TO control_room_private_web;

GRANT SELECT ON updater.plans, updater.plan_approval_outcomes, updater.runs,
  updater.run_events, updater.heartbeat TO control_room_private_web;
GRANT SELECT (id, plan_id, received_at) ON updater.plan_approvals TO control_room_private_web;
-- `owner_requests` has no plan_id: a phone control is not bound to a plan, only
-- a passkey-backed one is bound to an approval. Listing a column that does not
-- exist is a hard error at GRANT time, which is the right outcome — the column
-- list is asserted against the table, not parsed.
GRANT SELECT (id, request_kind, requires_passkey, requested_at, handled_at, handled_outcome)
  ON updater.owner_requests TO control_room_private_web;
GRANT SELECT (id, template, title, queued_at, sent_at) ON updater.push_queue TO control_room_private_web;
GRANT SELECT (id, credential_id, registration_digest, received_at) ON updater.passkey_registrations
  TO control_room_private_web;
-- P-2's read side, and the only thing item 10a adds to the web's reach. Five
-- columns: the digest, the mode, the exact options object, the add-challenge and
-- the expiry. Not `consumed_at`, because a web page that could see "consumed"
-- would be rendering a state it cannot act on; and not `installation_id`, because
-- the options object already carries the RP ID the page needs.
--
-- The web cannot INSERT here, so it cannot open a registration of its own: the
-- only writer is the updater, and only from its own passkey ledger. That is the
-- whole reason a compromised release cannot mint a registration challenge.
GRANT SELECT (registration_digest, mode, options_json, authorization_challenge, expires_at)
  ON updater.passkey_open_registrations TO control_room_private_web;
-- The web's USABLE read (review passkey2 DB-8). The column grant above cannot
-- tell the web that a registration was consumed, because `consumed_at` is
-- withheld — so a web that read the table directly would serve the options of a
-- finished registration and the owner would only find out at the insert. This
-- view is the same five columns filtered to what is actually open, evaluated as
-- its owner (the deployer), so the web learns "still open" without ever reading
-- `consumed_at` or `created_at`. `security_barrier` keeps a caller-supplied
-- predicate from being pushed below the filter, so a leaky function in the web's
-- WHERE clause cannot observe a consumed row.
CREATE OR REPLACE VIEW updater.passkey_open_registrations_web WITH (security_barrier = true) AS
  SELECT o.registration_digest, o.mode, o.options_json, o.authorization_challenge, o.expires_at
    FROM updater.passkey_open_registrations o
   WHERE o.consumed_at IS NULL AND o.expires_at > pg_catalog.now();
REVOKE ALL ON updater.passkey_open_registrations_web FROM PUBLIC;
GRANT SELECT ON updater.passkey_open_registrations_web TO control_room_private_web;
-- Neither refusal table is granted at all. The web has no business knowing that
-- an approval was refused — the updater's journal and the phone are the channels
-- for that — and a read grant would turn `approval_refusals` into a place where a
-- web-insertable plan id could be observed to accumulate refusals. The web is not
-- in the INSERT list below either, so the whole aggregation is the updater's.

-- INSERT only, on the four tables the design names and no others. There is no
-- UPDATE, no DELETE and no TRUNCATE anywhere for this login, which is why the
-- mutable-looking columns (`handled_at`, `sent_at`) are updater-only: the web can
-- queue a push and an owner request and assert an approval, and can change
-- nothing it has written.
GRANT INSERT ON updater.plan_approvals, updater.passkey_registrations,
  updater.owner_requests, updater.push_queue TO control_room_private_web;
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA updater FROM control_room_private_web;

-- A default-privilege grant is how a future table in this schema would silently
-- become readable by every role, so it is closed here as well as on the tables.
ALTER DEFAULT PRIVILEGES IN SCHEMA updater REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA updater REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA updater REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- The deployer is the owner and needs no grant on its own objects, but the
-- sequence-free design means nothing else is missing. Stated explicitly so the
-- intent is checkable: every privilege on every object in this schema is either
-- the owner's implicit one or the web login's six statements above.
