-- OFFLINE OPERATOR SETUP ONLY. Never executed by application startup.
-- The fleet gateway is the control-side service that remote machine
-- connectors talk to. Its LOGIN may inherit ONLY this NOLOGIN role, with no
-- ADMIN option and no object ownership. Workers never receive this login.
--
-- Migration 0140 confines this class further: on shared canonical tables it
-- may only write rows tied to a fleet enrollment, a guarded fleet claim, or an
-- owner decision. It holds no grant on approvals, reviews, owner sessions,
-- delivery, results publication or settings.
BEGIN;
CREATE ROLE control_room_fleet_gateway NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
CREATE ROLE control_room_fleet_owner_authority NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_fleet_gateway;
GRANT USAGE ON SCHEMA public TO control_room_fleet_owner_authority;
-- The marker that identifies this privilege class to the 0140 guards.
GRANT SELECT ON fleet_gateway_role_anchor TO control_room_fleet_gateway;
GRANT EXECUTE ON FUNCTION fleet_claim_is_live(text,text,text) TO control_room_fleet_gateway;
GRANT EXECUTE ON FUNCTION redeem_fleet_enrollment(text,text,text,text,timestamptz) TO control_room_fleet_gateway;
-- The shared audit table's work-intake row policy reads these, as for the
-- coordinator and web roles. Neither grants any intake authority.
GRANT EXECUTE ON FUNCTION is_work_intake_session() TO control_room_fleet_gateway;
GRANT SELECT ON work_intake_tenant_binding TO control_room_fleet_gateway;
GRANT SELECT ON tenants, workspaces, projects, control_manual_project_heads, control_identities,
  control_role_grants, control_nodes, control_requests, control_workflows, control_jobs, control_attempts,
  control_leases, control_job_dependencies, control_task_model_selections, control_task_declared_scopes,
  control_assignment_lease_scopes, control_transition_events, control_outbox, audit_events,
  control_audit_chain_heads, fleet_enrollment_codes, fleet_workers, fleet_worker_credentials,
  fleet_enrollment_redemptions, fleet_worker_presence, fleet_worker_agents, fleet_presence_transitions,
  fleet_work_offers, fleet_claims, fleet_worker_events, fleet_results,
  fleet_result_files, fleet_result_reviews TO control_room_fleet_gateway;
-- Enrollment: one node, one proposal-only agent identity and grant, the worker
-- row and its first credential, all in the code-consuming transaction.
GRANT INSERT ON control_nodes, control_identities, control_role_grants, fleet_workers,
  fleet_worker_credentials, fleet_worker_presence, fleet_worker_agents, fleet_presence_transitions TO control_room_fleet_gateway;
GRANT UPDATE (state, ended_at) ON fleet_worker_credentials TO control_room_fleet_gateway;
GRANT UPDATE (session_id,presence_state,last_seen_at,connector_version,platform,state_changed_at,graceful_offline_at)
  ON fleet_worker_presence TO control_room_fleet_gateway;
GRANT UPDATE (display_name,agent_kind,enabled,session_id,presence_state,last_reported_at,state_changed_at)
  ON fleet_worker_agents TO control_room_fleet_gateway;
-- Revocation clean-up after the owner revoked the worker on the web path.
GRANT UPDATE (state, version, payload, updated_at) ON control_nodes TO control_room_fleet_gateway;
GRANT UPDATE (state, updated_at) ON control_identities TO control_room_fleet_gateway;
GRANT UPDATE (revoked_at, updated_at) ON control_role_grants TO control_room_fleet_gateway;
-- The shared canonical claim path and its lifecycle transitions.
GRANT INSERT ON control_attempts, control_leases, control_transition_events, control_outbox,
  audit_events, control_audit_chain_heads, control_assignment_lease_scopes,
  fleet_claims, fleet_worker_events, fleet_results, fleet_result_files TO control_room_fleet_gateway;
GRANT DELETE ON control_assignment_lease_scopes TO control_room_fleet_gateway;
GRANT UPDATE (state, version, payload, updated_at) ON control_requests, control_workflows,
  control_jobs, control_attempts, control_leases TO control_room_fleet_gateway;
GRANT UPDATE (expires_at, renewed_at) ON control_leases TO control_room_fleet_gateway;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_fleet_gateway;
-- 0111: a hand-off's required note is presented on the owner's task timeline,
-- exactly like the other lifecycle writers granted in 0107.
GRANT SELECT, INSERT ON control_project_event_stream_heads, control_project_events TO control_room_fleet_gateway;
GRANT UPDATE (last_sequence, last_event_digest, head_auth_tag, updated_at) ON control_project_event_stream_heads TO control_room_fleet_gateway;
-- Row-lock rights only, matching the coordinator's lock order.
GRANT UPDATE (coordinator_lock) ON tenants, control_manual_project_heads, projects TO control_room_fleet_gateway;
-- The 0156 claim guard is SECURITY INVOKER and reads the installation
-- operations mode as whoever inserts the attempt, so a claim login must be able
-- to read the mode or every claim it makes is refused, running included.
GRANT SELECT ON installation_operations_mode_revisions TO control_room_fleet_gateway;

-- The ordinary web login can present fleet data but cannot write any owner
-- decision. A separate protected login inherits only the owner-authority role
-- below; the browser never receives that login.
GRANT SELECT ON fleet_enrollment_codes, fleet_workers, fleet_worker_credentials, fleet_worker_presence,
  fleet_worker_agents, fleet_presence_transitions, fleet_enrollment_redemptions, fleet_work_offers, fleet_claims,
  fleet_worker_events, fleet_results, fleet_result_files,
  fleet_result_reviews TO control_room_private_web;

GRANT EXECUTE ON FUNCTION is_work_intake_session() TO control_room_fleet_owner_authority;
GRANT SELECT ON work_intake_tenant_binding TO control_room_fleet_owner_authority;
GRANT SELECT ON tenants, workspaces, projects, control_manual_project_heads,
  control_identities, control_role_grants, control_web_sessions, control_requests, control_workflows,
  control_jobs, control_attempts, control_leases, audit_events, control_audit_chain_heads,
  fleet_enrollment_codes, fleet_enrollment_redemptions, fleet_workers, fleet_worker_credentials,
  fleet_worker_presence, fleet_worker_agents, fleet_presence_transitions, fleet_work_offers, fleet_claims, fleet_worker_events, fleet_results,
  fleet_result_files, fleet_result_reviews TO control_room_fleet_owner_authority;
GRANT INSERT ON control_web_sessions, audit_events, control_audit_chain_heads,
  fleet_enrollment_codes, fleet_work_offers, fleet_result_reviews TO control_room_fleet_owner_authority;
GRANT UPDATE (web_lock) ON workspaces, control_identities, control_role_grants TO control_room_fleet_owner_authority;
GRANT UPDATE (revoked_at) ON control_web_sessions TO control_room_fleet_owner_authority;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_fleet_owner_authority;
GRANT UPDATE (state) ON fleet_enrollment_codes TO control_room_fleet_owner_authority;
GRANT UPDATE (state, revoked_at, revoked_by_identity_id) ON fleet_workers TO control_room_fleet_owner_authority;
GRANT UPDATE (state, ended_at) ON fleet_worker_credentials TO control_room_fleet_owner_authority;
GRANT UPDATE (state, closed_at, close_reason) ON fleet_work_offers TO control_room_fleet_owner_authority;
COMMIT;
