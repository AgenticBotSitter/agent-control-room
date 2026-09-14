/**
 * Bounded failure codes for the project-coordination engine. Every rejection
 * returns one of these codes; raw agent result text, credentials and provider
 * detail never reach a caller through an error message.
 */
export type ProjectCoordinationSafeCodeV1 =
  | "invalid_input"
  | "coordinator_absent"
  | "coordinator_revoked"
  | "coordinator_version_stale"
  | "coordinator_human_only_operation"
  | "coordinator_replay_conflict"
  | "owner_authority_missing"
  | "proposal_content_invalid"
  | "proposal_content_too_large"
  | "proposal_duplicate_key"
  | "proposal_schema_mismatch"
  | "proposal_project_mismatch"
  | "proposal_evidence_mismatch"
  | "proposal_evidence_stale"
  | "proposal_limit_exceeded"
  | "proposal_not_accepted"
  | "proposal_already_adopted"
  | "policy_inactive"
  | "policy_expired"
  | "policy_revoked"
  | "policy_route_mismatch"
  | "policy_action_not_permitted"
  | "policy_task_allowance_exhausted"
  | "policy_cost_allowance_exhausted"
  | "policy_cost_unknown"
  | "policy_concurrency_exhausted"
  | "adoption_replay_conflict"
  | "resource_declaration_missing"
  | "resource_declaration_invalid"
  | "resource_declaration_changed"
  | "resource_conflict"
  | "resource_disjoint_write_not_permitted"
  | "resource_workspace_not_distinct"
  | "resource_workspace_unverified"
  | "resource_job_not_current"
  | "resource_attempt_not_current"
  | "resource_lease_not_current"
  | "resource_lease_expired"
  | "resource_legacy_work_unreconciled"
  | "resource_admission_absent"
  | "resource_admission_retired"
  | "resource_admission_replay_conflict"
  | "retirement_evidence_invalid"
  | "retirement_evidence_unauthorized"
  | "retirement_replay_conflict"
  | "no_start_release_unsupported";

export class ProjectCoordinationErrorV1 extends Error {
  constructor(readonly safeCode: ProjectCoordinationSafeCodeV1) {
    super(safeCode);
    this.name = "ProjectCoordinationErrorV1";
  }
}

export function failProjectCoordinationV1(code: ProjectCoordinationSafeCodeV1): never {
  throw new ProjectCoordinationErrorV1(code);
}
