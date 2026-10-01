-- MIG-F: durable machine sessions, reported bot roster, append-only presence
-- history, and optional bot attribution on a fleet claim. Presence is display
-- evidence only; none of these records grants work or authority.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE fleet_worker_presence
  ADD COLUMN session_id text,
  ADD COLUMN presence_state text NOT NULL DEFAULT 'unreachable',
  ADD COLUMN state_changed_at timestamptz,
  ADD COLUMN graceful_offline_at timestamptz;
UPDATE fleet_worker_presence SET state_changed_at=last_seen_at;
ALTER TABLE fleet_worker_presence
  ALTER COLUMN state_changed_at SET NOT NULL,
  ALTER COLUMN presence_state DROP DEFAULT,
  ADD CONSTRAINT fleet_worker_presence_session_format CHECK (
    session_id IS NULL OR session_id ~ '^fleet-session:[a-f0-9]{32}$'),
  ADD CONSTRAINT fleet_worker_presence_state CHECK (presence_state IN ('online','offline','unreachable')),
  ADD CONSTRAINT fleet_worker_presence_offline_shape CHECK (
    (presence_state='offline')=(graceful_offline_at IS NOT NULL)),
  ADD CONSTRAINT fleet_worker_presence_times CHECK (
    graceful_offline_at IS NULL OR graceful_offline_at>=last_seen_at);

CREATE TABLE fleet_worker_agents (
  tenant_id text NOT NULL,
  worker_id text NOT NULL,
  agent_id text NOT NULL CHECK (agent_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  agent_kind text NOT NULL CHECK (agent_kind ~ '^[a-z][a-z0-9._-]{0,63}$'),
  enabled boolean NOT NULL,
  session_id text NOT NULL CHECK (session_id ~ '^fleet-session:[a-f0-9]{32}$'),
  presence_state text NOT NULL CHECK (presence_state IN ('online','offline','unreachable')),
  last_reported_at timestamptz NOT NULL,
  state_changed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,worker_id,agent_id),
  FOREIGN KEY (tenant_id,worker_id) REFERENCES fleet_workers(tenant_id,worker_id) ON DELETE RESTRICT,
  CHECK (enabled OR presence_state='offline')
);

CREATE TABLE fleet_presence_transitions (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  transition_id text NOT NULL CHECK (transition_id ~ '^fleet-presence:[a-f0-9]{32}$'),
  worker_id text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('machine','agent')),
  agent_id text,
  session_id text CHECK (session_id IS NULL OR session_id ~ '^fleet-session:[a-f0-9]{32}$'),
  from_state text CHECK (from_state IS NULL OR from_state IN ('online','offline','unreachable')),
  to_state text NOT NULL CHECK (to_state IN ('online','offline','unreachable')),
  source text NOT NULL CHECK (source IN ('connector','supervisor')),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,transition_id),
  FOREIGN KEY (tenant_id,worker_id) REFERENCES fleet_workers(tenant_id,worker_id) ON DELETE RESTRICT,
  CHECK ((subject_kind='machine' AND agent_id IS NULL) OR
    (subject_kind='agent' AND agent_id ~ '^[a-z][a-z0-9._-]{0,63}$')),
  CHECK (from_state IS NULL OR from_state<>to_state)
);

ALTER TABLE fleet_claims ADD COLUMN agent_id text
  CHECK (agent_id IS NULL OR agent_id ~ '^[a-z][a-z0-9._-]{0,63}$');

CREATE INDEX fleet_worker_agents_state ON fleet_worker_agents(tenant_id,presence_state,last_reported_at);
CREATE INDEX fleet_presence_transitions_subject
  ON fleet_presence_transitions(tenant_id,worker_id,agent_id,occurred_at DESC);

REVOKE ALL ON fleet_worker_agents, fleet_presence_transitions FROM PUBLIC;
