export type ProjectWorkspaceSafeCodeV1 =
  | "invalid_input"
  | "invalid_read_scope"
  | "authentication_required"
  | "session_unavailable"
  | "catalog_unavailable"
  | "catalog_rollback"
  | "catalog_revoked"
  | "policy_denied"
  | "digest_mismatch"
  | "scope_mismatch"
  | "redaction_rejected"
  | "unsupported_action"
  | "not_found"
  | "replay_drift"
  | "integrity_failed"
  | "invalid_transition";

export class ProjectWorkspaceContractErrorV1 extends Error {
  constructor(readonly safeCode: ProjectWorkspaceSafeCodeV1) {
    super(safeCode);
    this.name = "ProjectWorkspaceContractErrorV1";
  }
}
