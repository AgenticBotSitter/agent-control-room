-- OFFLINE OPERATOR TEMPLATE ONLY. No login, queue privileges or startup execution.
BEGIN;
CREATE ROLE control_room_news_coordinator NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_news_coordinator;
GRANT SELECT ON tenants, workspaces, projects, control_manual_project_heads, control_identities,
  control_role_grants, control_web_sessions, control_requests, control_workflows, control_jobs,
  control_attempts, control_leases, control_nodes, control_job_dependencies, control_transition_events,
  control_outbox, control_approvals, control_effect_intents, control_approval_consumptions,
  control_policy_decisions, control_abs_feed_plans, control_abs_source_settings, audit_events, control_audit_chain_heads TO control_room_news_coordinator;
GRANT INSERT ON control_web_sessions, control_requests, control_workflows, control_jobs, control_attempts,
  control_leases, control_transition_events, control_outbox, control_approvals, control_effect_intents,
  control_approval_consumptions, control_policy_decisions, control_abs_feed_plans, audit_events,
  control_audit_chain_heads TO control_room_news_coordinator;
GRANT UPDATE (state, version, payload, updated_at) ON control_jobs, control_attempts, control_leases,
  control_approvals, control_effect_intents TO control_room_news_coordinator;
GRANT UPDATE (coordinator_lock) ON tenants, projects, control_manual_project_heads, control_nodes TO control_room_news_coordinator;
GRANT UPDATE (web_lock) ON workspaces, control_identities, control_role_grants TO control_room_news_coordinator;
GRANT UPDATE (revoked_at) ON control_web_sessions TO control_room_news_coordinator;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_news_coordinator;
COMMIT;
