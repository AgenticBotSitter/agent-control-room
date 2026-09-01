export class ProjectEventErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_input" | "project_not_found" | "integrity_failed" |
    "replay_conflict" | "source_unavailable") {
    super(safeCode); this.name = "ProjectEventErrorV1";
  }
}
