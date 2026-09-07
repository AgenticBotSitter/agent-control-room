-- OFFLINE OPERATOR SETUP ONLY. Never executed by application startup.
-- Dedicated, separately rehearsed database; fresh NOLOGIN role only. A private LOGIN
-- may inherit ONLY this role without ADMIN option or database/object ownership.
BEGIN;
CREATE ROLE control_room_task_coordinator NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_task_coordinator;
GRANT SELECT ON tenants, workspaces, control_identities, control_role_grants, control_web_sessions,
  projects, control_manual_project_heads, control_requests, control_workflows, control_jobs,
  control_attempts, control_leases, control_task_execution_plans, control_nodes, control_node_keys,
  control_node_fleet_current, control_job_dependencies, control_transition_events, control_outbox,
  audit_events, control_audit_chain_heads, control_completion_gate_integrity, control_completion_gate_records,
  control_native_approval_packets, control_native_task_queue, control_native_delivery_preparations, control_native_delivery_envelopes, control_native_transmission_intents, control_native_delivery_receipts,
  control_harness_runs, control_harness_run_events, control_native_review_plans, control_artifact_manifests, control_native_artifact_receipts
  TO control_room_task_coordinator;
GRANT INSERT ON control_web_sessions, control_requests, control_workflows, control_jobs,
  control_attempts, control_leases, control_task_execution_plans, control_transition_events,
  control_outbox, audit_events, control_audit_chain_heads, control_native_approval_packets, control_native_task_queue, control_native_delivery_preparations, control_native_delivery_envelopes, control_native_transmission_intents, control_native_delivery_receipts TO control_room_task_coordinator;
GRANT UPDATE (state, version, payload, updated_at) ON control_requests, control_workflows,
  control_jobs, control_attempts, control_leases TO control_room_task_coordinator;
GRANT UPDATE (coordinator_lock) ON tenants, control_nodes, control_node_keys, control_manual_project_heads, projects
  TO control_room_task_coordinator;
GRANT UPDATE (web_lock) ON control_identities, control_role_grants, workspaces,
  control_completion_gate_integrity TO control_room_task_coordinator;
GRANT UPDATE (revoked_at) ON control_web_sessions TO control_room_task_coordinator;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_task_coordinator;
GRANT INSERT ON control_completion_gate_records TO control_room_task_coordinator;
GRANT UPDATE (coordinator_lock) ON control_harness_runs TO control_room_task_coordinator;
GRANT UPDATE (web_lock) ON control_completion_gate_records TO control_room_task_coordinator;
GRANT UPDATE (revision, record_count, state_digest, state_auth_tag) ON control_completion_gate_integrity TO control_room_task_coordinator;
COMMIT;
