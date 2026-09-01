export type IdeaLabSafeCodeV1 = "invalid_input" | "redaction_rejected" | "scope_mismatch" | "state_conflict"
  | "not_found" | "integrity_failed" | "duplicate_record" | "panel_incomplete" | "project_conflict" | "authorization_denied";

export class IdeaLabErrorV1 extends Error {
  constructor(readonly safeCode: IdeaLabSafeCodeV1) { super(safeCode); this.name = "IdeaLabErrorV1"; }
}
