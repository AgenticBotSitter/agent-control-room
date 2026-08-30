export type PublicPackageContractSafeCodeV1 =
  | "invalid_input"
  | "redaction_rejected"
  | "digest_mismatch"
  | "classification_mismatch"
  | "compatibility_rejected"
  | "evidence_mismatch"
  | "signature_mismatch"
  | "publication_disabled";

export class PublicPackageContractErrorV1 extends Error {
  constructor(readonly safeCode: PublicPackageContractSafeCodeV1) {
    super(safeCode);
    this.name = "PublicPackageContractErrorV1";
  }
}
