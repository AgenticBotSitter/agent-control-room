export type ContentBloomsContractSafeCodeV1 =
  | "invalid_input"
  | "redaction_rejected"
  | "scope_mismatch"
  | "authority_conflation"
  | "release_untrusted"
  | "adapter_disabled"
  | "stale_state"
  | "replay_drift"
  | "rollback_invalid"
  | "cursor_drift"
  | "sequence_invalid"
  | "source_unavailable"
  | "approval_required"
  | "approval_denied"
  | "request_expired"
  | "source_receipt_invalid"
  | "effect_in_progress"
  | "effect_ambiguous";

export class ContentBloomsContractErrorV1 extends Error {
  constructor(readonly safeCode: ContentBloomsContractSafeCodeV1) {
    super(safeCode);
    this.name = "ContentBloomsContractErrorV1";
  }
}
