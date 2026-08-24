import type { OwnerSignedTrustBundleV1, KeyAvailabilityV1, KeyReferenceV1 } from "./types";
import type { ProtectedStoreFailureCode } from "./types";

const safeMessages: Record<ProtectedStoreFailureCode, string> = {
  locked: "Protected store is locked",
  interaction_required: "Protected store requires operator interaction",
  missing: "Protected store material is missing",
  corrupt: "Protected store material is corrupt",
  permission_denied: "Protected store permission was denied",
  unavailable_platform: "Protected store is unavailable on this platform",
  key_not_unlocked: "Node signing key is not unlocked",
  disposed: "Protected store has been disposed",
  invalid_configuration: "Protected store configuration is invalid",
  invalid_bundle: "Signed trust bundle is invalid",
  rollback_detected: "Protected store rollback was detected",
  recovery_required: "Protected store recovery requires the pending owner artifact",
};

export class ProtectedStoreError extends Error {
  readonly name = "ProtectedStoreError";

  constructor(readonly code: ProtectedStoreFailureCode) {
    super(safeMessages[code]);
  }
}

export interface NodePrivateKeyStore {
  reference(): KeyReferenceV1;
  availability(): Promise<KeyAvailabilityV1>;
  unlock(): Promise<void>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  lock(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ServerTrustStore {
  currentEpoch(): Promise<number>;
  resolveServerKey(keyId: string): Promise<Uint8Array | undefined>;
  applyOwnerSignedBundle(bundle: OwnerSignedTrustBundleV1): Promise<void>;
}

export interface ApprovalTrustStore {
  resolveApprovalKey(keyId: string): Promise<Uint8Array | undefined>;
}
