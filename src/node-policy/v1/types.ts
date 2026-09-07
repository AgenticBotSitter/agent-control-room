import type { AuthorityEnvelope } from "../../domain/v1/types";

export const NODE_POLICY_CONTRACT_V1 = "control-room-node-policy/v1" as const;
export const NODE_CEILING_SCHEMA_V1 = "control-room.node-authority-ceiling/v1" as const;
export const SERVER_TRUST_BUNDLE_SCHEMA_V1 = "control-room.server-trust-bundle/v1" as const;
export const APPROVAL_ATTESTATION_SCHEMA_V1 = "control-room.owner-approval-attestation/v1" as const;

export const riskClasses = ["low", "medium", "high", "critical"] as const;
export const externalEffectPolicies = ["none", "preauthorized", "approval_required"] as const;
export const keyAvailabilityStates = ["available", "locked", "interaction_required", "missing", "corrupt", "permission_denied", "unavailable_platform"] as const;
export const localDenialDetails = [
  "ceiling_missing",
  "ceiling_tampered",
  "ceiling_rollback",
  "authority_invalid",
  "authority_expired",
  "authority_not_yet_valid",
  "executor_not_allowed",
  "operation_not_allowed",
  "credential_not_allowed",
  "filesystem_target_not_allowed",
  "network_destination_not_allowed",
  "risk_exceeded",
  "effect_policy_exceeded",
  "approval_missing",
  "approval_invalid",
  "approval_expired",
  "duration_exceeded",
  "cost_unmeasurable",
  "cost_exceeded",
  "concurrency_exceeded",
  "keystore_unavailable",
  "paused",
  "effect_in_progress",
  "effect_ambiguous",
  "storage_unavailable",
] as const;
export const wireDenialCategories = ["policy", "expired", "approval_required", "effect_in_progress", "ambiguous", "maintenance", "storage"] as const;
export const nodePrivateKeyProviders = ["macos_keychain", "windows_dpapi_current_user", "encrypted_file", "memory_test"] as const;
export const nodePrivateKeyModes = ["native", "encrypted_file", "test"] as const;
export const unwrapSecretSourceKinds = ["protected_file", "file_descriptor", "platform_secret"] as const;
export const protectedStoreFailureCodes = [
  "locked",
  "interaction_required",
  "missing",
  "corrupt",
  "permission_denied",
  "unavailable_platform",
  "key_not_unlocked",
  "disposed",
  "invalid_configuration",
  "invalid_bundle",
  "rollback_detected",
  "recovery_required",
] as const;

export type RiskClass = (typeof riskClasses)[number];
export type ExternalEffectPolicy = (typeof externalEffectPolicies)[number];
export type KeyAvailabilityState = (typeof keyAvailabilityStates)[number];
export type LocalDenialDetail = (typeof localDenialDetails)[number];
export type WireDenialCategory = (typeof wireDenialCategories)[number];
export type NodePrivateKeyProvider = (typeof nodePrivateKeyProviders)[number];
export type NodePrivateKeyMode = (typeof nodePrivateKeyModes)[number];
export type UnwrapSecretSourceKind = (typeof unwrapSecretSourceKinds)[number];
export type ProtectedStoreFailureCode = (typeof protectedStoreFailureCodes)[number];

export interface NodeAuthorityCeilingV1 {
  schema: typeof NODE_CEILING_SCHEMA_V1;
  tenantId: string;
  nodeId: string;
  version: number;
  issuedAt: string;
  issuerKeyId: string;
  projectIds: string[];
  executorIds: string[];
  operationIds: string[];
  credentialRefs: string[];
  filesystemRoots: string[];
  networkDestinations: string[];
  maxRisk: RiskClass;
  externalEffects: ExternalEffectPolicy;
  maxDurationSeconds: number;
  maxConcurrentEffects: number;
  maxCostUsd?: string;
  bodyDigest: string;
}

export interface SignedNodeAuthorityCeilingV1 {
  body: NodeAuthorityCeilingV1;
  signatureAlgorithm: "Ed25519";
  signature: string;
}

export type NodeAuthorityCeilingBodyV1 = NodeAuthorityCeilingV1;

export interface ServerTrustKeyV1 {
  keyId: string;
  algorithm: "ed25519";
  spki: string;
  state: "active" | "retired" | "revoked";
}

export interface TrustBundleShrinkAuthorizationV1 {
  keyId: string;
  bundleBodyDigest: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}

export interface ServerTrustBundleBodyV1 {
  schema: typeof SERVER_TRUST_BUNDLE_SCHEMA_V1;
  tenantId: string;
  nodeClass: string;
  epoch: number;
  issuedAt: string;
  ownerRootKeyId: string;
  keys: ServerTrustKeyV1[];
  bodyDigest: string;
}

export interface OwnerSignedTrustBundleV1 {
  body: ServerTrustBundleBodyV1;
  signatureAlgorithm: "Ed25519";
  signature: string;
  shrinkAuthorization?: TrustBundleShrinkAuthorizationV1;
}

export interface OwnerApprovalAttestationBodyV1 {
  schema: typeof APPROVAL_ATTESTATION_SCHEMA_V1;
  tenantId: string;
  nodeId?: string;
  nodeClass?: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  operationDigest: string;
  risk: RiskClass;
  decision: "approved";
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  approvalKeyId: string;
  bodyDigest: string;
}

export interface OwnerApprovalAttestationV1 {
  body: OwnerApprovalAttestationBodyV1;
  signatureAlgorithm: "Ed25519";
  signature: string;
}

export type NormalizedTargetV1 =
  | { kind: "none" }
  | { kind: "filesystem"; canonicalPath: string }
  | { kind: "network"; canonicalDestination: string };

export interface NormalizedLocalPolicyRequestV1 {
  contractVersion: typeof NODE_POLICY_CONTRACT_V1;
  requestId: string;
  tenantId: string;
  nodeId: string;
  nodeClass: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  executorId: string;
  operationId: string;
  operationDigest: string;
  /** Optional executor-specific immutable payload commitment, included in operation identity. */
  payloadDigest?: string;
  authorityDigest: string;
  credentialRefs: string[];
  target: NormalizedTargetV1;
  risk: RiskClass;
  externalEffect: boolean;
  estimatedDurationSeconds: number;
  estimatedCostUsd?: string;
  occurredAt: string;
  approval?: OwnerApprovalAttestationV1;
}

export interface ExecutorCapabilityV1 {
  contractVersion: typeof NODE_POLICY_CONTRACT_V1;
  executorId: string;
  operationIds: string[];
  externalEffectOperationIds: string[];
  targetKinds: Array<NormalizedTargetV1["kind"]>;
  supportsCancellation: boolean;
  supportsNetworkIdentityEnforcement: boolean;
  costMeter: "none" | "monotonic_reservable";
}

export type LocalPolicyDecisionV1 = {
  contractVersion: typeof NODE_POLICY_CONTRACT_V1;
  requestId: string;
  accepted: true;
  requestDigest: string;
  ceilingDigest: string;
  authorityDigest: string;
  decidedAt: string;
} | {
  contractVersion: typeof NODE_POLICY_CONTRACT_V1;
  requestId: string;
  accepted: false;
  detail: LocalDenialDetail;
  wireCategory: WireDenialCategory;
  requestDigest: string;
  ceilingDigest: string;
  authorityDigest: string;
  decidedAt: string;
};

export interface WireDenialReceiptV1 {
  contractVersion: typeof NODE_POLICY_CONTRACT_V1;
  receiptId: string;
  relatedMessageId: string;
  jobId: string;
  attemptId: string;
  category: WireDenialCategory;
  occurredAt: string;
}

export interface KeyAvailabilityV1 {
  state: KeyAvailabilityState;
  keyReferenceId: string;
  observedAt: string;
}

export interface KeyReferenceV1 {
  contractVersion: typeof NODE_POLICY_CONTRACT_V1;
  keyId: string;
  referenceId: string;
  provider: NodePrivateKeyProvider;
  mode: NodePrivateKeyMode;
  algorithm: "Ed25519";
}

export interface PinnedOwnerKeyV1 {
  keyId: string;
  algorithm: "ed25519";
  spki: string;
  fingerprint: string;
}

export interface OwnerPinSetV1 {
  ceilingProvisioningKey: PinnedOwnerKeyV1;
  serverTrustRootKey: PinnedOwnerKeyV1;
  trustShrinkKeys: PinnedOwnerKeyV1[];
}

export interface VerifiedLeaseAuthorityV1 {
  tenantId: string;
  nodeId: string;
  jobId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  validFrom: string;
  expiresAt: string;
  authorityDigest: string;
  authority: AuthorityEnvelope;
  parentAuthorities: AuthorityEnvelope[];
}

export interface ResolvedApprovalKeyV1 {
  keyId: string;
  publicKeySpki: string;
}

export interface LocalPolicyEvaluationInputV1 {
  request: NormalizedLocalPolicyRequestV1;
  ceiling: NodeAuthorityCeilingV1;
  lease: VerifiedLeaseAuthorityV1;
  executor: ExecutorCapabilityV1;
  keyAvailability: KeyAvailabilityV1;
  approvalKey?: ResolvedApprovalKeyV1;
  activeExternalEffects: number;
}

export type SignedNodePolicyArtifactV1 = SignedNodeAuthorityCeilingV1 | OwnerSignedTrustBundleV1 | OwnerApprovalAttestationV1;
