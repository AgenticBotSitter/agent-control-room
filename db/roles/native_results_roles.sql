-- OFFLINE OPERATOR SETUP ONLY. Never executed by application startup.
-- One separate LOGIN may inherit only this fresh NOLOGIN role, with no ownership/admin rights.
BEGIN;
CREATE ROLE control_room_native_results NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_native_results;
GRANT SELECT ON workspaces, control_identities, control_role_grants, projects,
  control_jobs, control_workflows, control_requests, control_task_execution_plans,
  control_harness_runs, control_harness_run_events, control_native_review_plans,
  control_artifact_manifests, control_native_artifact_receipts,
  control_completion_gate_records, control_completion_gate_integrity, audit_events,
  control_audit_chain_heads TO control_room_native_results;
GRANT INSERT ON control_native_review_plans, control_completion_gate_records,
  audit_events, control_audit_chain_heads TO control_room_native_results;
GRANT UPDATE (result_lock) ON control_jobs TO control_room_native_results;
GRANT UPDATE (coordinator_lock) ON control_harness_runs, projects TO control_room_native_results;
GRANT UPDATE (web_lock) ON control_completion_gate_records TO control_room_native_results;
GRANT UPDATE (web_lock, revision, record_count, state_digest, state_auth_tag)
  ON control_completion_gate_integrity TO control_room_native_results;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_native_results;
COMMIT;
