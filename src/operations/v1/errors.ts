export type OperationsContractSafeCodeV1 =
  | "invalid_input"
  | "redaction_rejected"
  | "digest_mismatch"
  | "scope_mismatch"
  | "invalid_transition"
  | "evidence_missing"
  | "unsupported_action";

export class OperationsContractErrorV1 extends Error {
  constructor(readonly safeCode: OperationsContractSafeCodeV1) {
    super(safeCode);
    this.name = "OperationsContractErrorV1";
  }
}
