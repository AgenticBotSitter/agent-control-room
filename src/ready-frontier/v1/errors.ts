export type ReadyFrontierSafeCodeV1 =
  | "invalid_input"
  | "redaction_rejected"
  | "scope_mismatch"
  | "digest_mismatch"
  | "integrity_failed"
  | "replay_drift"
  | "capacity_exceeded"
  | "policy_inactive"
  | "policy_denied"
  | "stale_proposal";

export class ReadyFrontierContractErrorV1 extends Error {
  constructor(readonly safeCode: ReadyFrontierSafeCodeV1) {
    super(safeCode);
    this.name = "ReadyFrontierContractErrorV1";
  }
}
