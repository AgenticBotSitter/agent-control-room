-- Run as the schema owner (control_room_schema_owner) after migrations have
-- applied. This file is the table/sequence/function-level grants portion of
-- the production role setup; the role CREATE statements live in
-- db/roles/production_roles.sql and run during bootstrap as the bootstrap
-- superuser. Splitting them lets the migrator session apply table-level
-- grants after migrations without needing CREATEROLE privilege.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO control_room_application, control_room_reader, control_room_backup,
  control_room_schedule_admissions;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO control_room_application;
GRANT DELETE ON projects, work_items, executions, blockers, attention_items, machine_nodes, worker_runtimes, agent_identities
  TO control_room_application;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO control_room_reader, control_room_backup;

REVOKE UPDATE, DELETE, TRUNCATE ON
  audit_events, projection_changes, command_receipts, control_transition_events,
  control_policy_decisions, control_approval_consumptions, control_audit_anchors,
  node_protocol_replay
  FROM control_room_application, control_room_reader, control_room_backup;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public
  FROM control_room_reader, control_room_backup;

-- The migration ledger is operator/migrator state: application, reader, backup
-- and scheduler roles can never read it (least-privilege denial proof).
REVOKE ALL ON control_room_schema_migrations
  FROM control_room_application, control_room_reader, control_room_backup, control_room_schedule_admissions;

-- Schedule-admission service (issue #120): the narrow write path for
-- control_scheduled_task_admissions plus SELECT on exactly the tables it
-- references. No UPDATE/DELETE (the table is append-only), no DDL, and the
-- read-only web role (control_room_reader) never gains this INSERT.
GRANT SELECT, INSERT ON control_scheduled_task_admissions TO control_room_schedule_admissions;
GRANT SELECT ON workspaces, projects, control_schedule_occurrences, control_schedules,
  control_requests, control_workflows, control_jobs TO control_room_schedule_admissions;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM control_room_application, control_room_reader, control_room_backup, control_room_schedule_admissions;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM control_room_application, control_room_reader, control_room_backup, control_room_schedule_admissions;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM control_room_application, control_room_reader, control_room_backup, control_room_schedule_admissions;
