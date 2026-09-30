BEGIN;
DROP INDEX fleet_presence_transitions_subject;
DROP INDEX fleet_worker_agents_state;
ALTER TABLE fleet_claims DROP COLUMN agent_id;
DROP TABLE fleet_presence_transitions;
DROP TABLE fleet_worker_agents;
ALTER TABLE fleet_worker_presence
  DROP CONSTRAINT fleet_worker_presence_times,
  DROP CONSTRAINT fleet_worker_presence_offline_shape,
  DROP CONSTRAINT fleet_worker_presence_state,
  DROP CONSTRAINT fleet_worker_presence_session_format,
  DROP COLUMN graceful_offline_at,
  DROP COLUMN state_changed_at,
  DROP COLUMN presence_state,
  DROP COLUMN session_id;
COMMIT;
