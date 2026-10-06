export type WorkIntakeSafeCodeV1 = "credential_inactive" | "no_matching_grant" | "replay_conflict"
  | "batch_not_found" | "integrity_failed" | "invalid_input" | "project_inactive";
export class WorkIntakeErrorV1 extends Error {
  constructor(readonly safeCode: WorkIntakeSafeCodeV1) { super(safeCode); this.name = "WorkIntakeErrorV1"; }
}
export function failWorkIntakeV1(code: WorkIntakeSafeCodeV1): never { throw new WorkIntakeErrorV1(code); }