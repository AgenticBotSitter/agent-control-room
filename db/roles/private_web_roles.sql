-- OFFLINE OPERATOR SETUP ONLY, on a dedicated disposable/rehearsed database.
-- Never executed by startup. Fresh role only: existing installations need reviewed migration.
-- Database owner/migrator stays separate. Provision a separate LOGIN privately afterward,
-- granting ONLY membership in this NOLOGIN role, no ADMIN option, no object ownership.
BEGIN;
CREATE ROLE control_room_private_web NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- The separate private_web_database.sql must also be applied to the exact dedicated database.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
-- Function defaults are global; a per-schema revoke cannot undo the global PUBLIC default.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_private_web;
GRANT SELECT ON control_identities, control_role_grants, workspaces, control_web_sessions,
  adapter_registry, projects, control_manual_project_heads, control_web_project_commands,
  audit_events, control_audit_chain_heads, control_project_lifecycle_events,
  control_connection_registry_heads, control_connection_enrollments,
  control_connection_authenticated_telemetry_receipts, control_requests, control_workflows, control_jobs,
  control_attempts, control_harness_runs, control_harness_run_events, control_web_task_commands,
  control_artifact_manifests, control_native_artifact_receipts, control_completion_gate_records,
  control_completion_gate_integrity, control_web_task_review_commands, control_native_review_plans TO control_room_private_web;
GRANT UPDATE (web_lock) ON control_identities, control_role_grants, workspaces,
  control_connection_registry_heads, control_completion_gate_integrity, control_completion_gate_records TO control_room_private_web;
GRANT INSERT ON control_web_sessions, adapter_registry, projects, control_manual_project_heads,
  control_web_project_commands, audit_events, control_audit_chain_heads,
  control_requests, control_workflows, control_jobs, control_web_task_commands,
  control_completion_gate_records, control_web_task_review_commands TO control_room_private_web;
GRANT UPDATE (revision, record_count, state_digest, state_auth_tag) ON control_completion_gate_integrity TO control_room_private_web;
GRANT UPDATE (revoked_at) ON control_web_sessions TO control_room_private_web;
GRANT UPDATE (domain_state, source_version, normalized_state, updated_at) ON projects TO control_room_private_web;
GRANT UPDATE (lifecycle, version, updated_at) ON control_manual_project_heads TO control_room_private_web;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_private_web;
COMMIT;
