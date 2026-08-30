export type AgentTeamSafeCodeV1 =
  | "invalid_input"
  | "digest_mismatch"
  | "scope_mismatch"
  | "redaction_rejected"
  | "unknown_agent"
  | "room_budget_exceeded"
  | "presence_unproved"
  | "replay_drift"
  | "integrity_failed"
  | "record_not_found"
  | "sequence_conflict"
  | "capacity_exceeded";

export class AgentTeamContractErrorV1 extends Error {
  constructor(readonly safeCode: AgentTeamSafeCodeV1) {
    super(safeCode);
    this.name = "AgentTeamContractErrorV1";
  }
}
