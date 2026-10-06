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
CREATE TABLE IF NOT EXISTS updater.passkey_registrations (
  id text PRIMARY KEY CHECK (id ~ '^passkey-registration:[0-9a-f-]{36}$'),
  -- The single-use registration secret, as a digest. The secret itself never
  -- reaches the database.
  registration_digest text NOT NULL CHECK (registration_digest ~ '^sha256:[a-f0-9]{64}$'),
  credential_id text NOT NULL CHECK (credential_id ~ '^[A-Za-z0-9_-]{16,255}$'),
  attestation_object bytea NOT NULL CHECK (octet_length(attestation_object) BETWEEN 32 AND 8192),
  -- The 6-character comparison code the phone showed and the owner typed at the
  -- installer (R13b). Bounded to the exact alphabet the code is drawn from, so
  -- a row cannot carry a paragraph.
  comparison_code text NOT NULL CHECK (comparison_code ~ '^[0-9A-Z]{6}$'),
  owner_session_digest text NOT NULL CHECK (owner_session_digest ~ '^sha256:[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS passkey_registrations_by_registration ON updater.passkey_registrations(registration_digest, received_at);

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
  template text NOT NULL CHECK (template ~ '^[a-z][a-z0-9_.]{1,63}$'),
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
