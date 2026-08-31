import type {
  ReadyFrontierProductionBoundaryAssessmentV1,
  ReadyFrontierProductionEvidenceClassV1,
  ReadyFrontierProductionGateCodeV1,
  ReadyFrontierProductionProofAuthorityV1,
} from "./production-boundary-types";

export const READY_FRONTIER_PRODUCTION_TRUST_BUNDLE_V1 =
  "control-room-ready-frontier-production-trust-bundle/v1" as const;
export const READY_FRONTIER_PRODUCTION_PROOF_ENVELOPE_V1 =
  "control-room-ready-frontier-production-proof-envelope/v1" as const;
export const READY_FRONTIER_PRODUCTION_INDEPENDENT_VERIFICATION_V1 =
  "control-room-ready-frontier-production-independent-verification/v1" as const;
export const READY_FRONTIER_PRODUCTION_PROOF_OBSERVATION_V1 =
  "control-room-ready-frontier-production-proof-observation/v1" as const;
export const READY_FRONTIER_PRODUCTION_PROOF_ASSESSMENT_V1 =
  "control-room-ready-frontier-production-proof-assessment/v1" as const;
export const READY_FRONTIER_PRODUCTION_PROOF_PROJECTION_V1 =
  "control-room-ready-frontier-production-proof-projection/v1" as const;
export const READY_FRONTIER_PRODUCTION_TRUST_MODE_V1 = "repository_fixture_only" as const;
export const READY_FRONTIER_PRODUCTION_PROOF_MAX_LIFETIME_SECONDS_V1 = 3_600 as const;

export type ReadyFrontierProductionTrustIdentityStateV1 = "active" | "revoked";

export interface ReadyFrontierProductionTrustIdentityV1 {
  identityId: string;
  keyId: string;
  publicKeySpki: string;
  keyDigest: string;
  independenceDomainDigest: string;
  proofAuthorities: ReadyFrontierProductionProofAuthorityV1[];
  authorizedGateCodes: ReadyFrontierProductionGateCodeV1[];
  canIndependentlyVerify: boolean;
  state: ReadyFrontierProductionTrustIdentityStateV1;
  revokedAt: string | null;
}

export interface ReadyFrontierProductionTrustBundleBodyV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_TRUST_BUNDLE_V1;
  bundleId: string;
  tenantId: string;
  workspaceId: string;
  trustMode: typeof READY_FRONTIER_PRODUCTION_TRUST_MODE_V1;
  revision: number;
  previousBundleDigest: string | null;
  ownerRootKeyId: string;
  issuedAt: string;
  expiresAt: string;
  identities: ReadyFrontierProductionTrustIdentityV1[];
  bodyDigest: string;
}

export interface ReadyFrontierProductionTrustBundleV1 {
  body: ReadyFrontierProductionTrustBundleBodyV1;
  signatureAlgorithm: "Ed25519";
  ownerSignature: string;
}

export interface ReadyFrontierProductionTrustAnchorV1 {
  trustMode: typeof READY_FRONTIER_PRODUCTION_TRUST_MODE_V1;
  tenantId: string;
  workspaceId: string;
  ownerRootKeyId: string;
  ownerRootPublicKeySpki: string;
  ownerRootKeyDigest: string;
}

export interface ReadyFrontierProductionProofBindingV1 {
  code: string;
  digest: string;
}

export interface ReadyFrontierProductionProofBodyV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_PROOF_ENVELOPE_V1;
  proofId: string;
  tenantId: string;
  workspaceId: string;
  planId: string;
  planDigest: string;
  assessmentId: string;
  assessmentDigest: string;
  gateCode: ReadyFrontierProductionGateCodeV1;
  requirementDigest: string;
  evidenceClass: ReadyFrontierProductionEvidenceClassV1;
  proofAuthority: ReadyFrontierProductionProofAuthorityV1;
  evidenceDigest: string;
  bindings: ReadyFrontierProductionProofBindingV1[];
  issuerIdentityId: string;
  issuerKeyId: string;
  trustBundleId: string;
  trustBundleRevision: number;
  trustBundleDigest: string;
  observedAt: string;
  issuedAt: string;
  expiresAt: string;
  bodyDigest: string;
}

export interface ReadyFrontierProductionIndependentVerificationV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_INDEPENDENT_VERIFICATION_V1;
  verifierIdentityId: string;
  verifierKeyId: string;
  proofBodyDigest: string;
  trustBundleDigest: string;
  verifiedAt: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}

export interface ReadyFrontierProductionProofEnvelopeV1 {
  body: ReadyFrontierProductionProofBodyV1;
  signatureAlgorithm: "Ed25519";
  issuerSignature: string;
  independentVerification: ReadyFrontierProductionIndependentVerificationV1 | null;
}

export interface ReadyFrontierProductionProofObservationV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_PROOF_OBSERVATION_V1;
  observationId: string;
  proofId: string;
  tenantId: string;
  workspaceId: string;
  planId: string;
  planDigest: string;
  assessmentId: string;
  assessmentDigest: string;
  gateCode: ReadyFrontierProductionGateCodeV1;
  requirementDigest: string;
  evidenceDigest: string;
  proofBodyDigest: string;
  envelopeDigest: string;
  trustBundleId: string;
  trustBundleRevision: number;
  trustBundleDigest: string;
  issuerIdentityId: string;
  issuerKeyId: string;
  verifierIdentityId: string | null;
  verifierKeyId: string | null;
  observedAt: string;
  issuedAt: string;
  expiresAt: string;
  receivedAt: string;
  trustMode: typeof READY_FRONTIER_PRODUCTION_TRUST_MODE_V1;
  status: "observed_unqualified";
  repositoryCanQualify: false;
  grantsApproval: false;
  grantsActivationAuthority: false;
  grantsClaimOrLease: false;
  grantsDispatchOrExecution: false;
  grantsExternalEffects: false;
  observationDigest: string;
}

export const readyFrontierProductionObservedGateStatusesV1 = [
  "unobserved", "observed_unqualified", "expired", "revoked", "superseded",
] as const;
export type ReadyFrontierProductionObservedGateStatusV1 =
  (typeof readyFrontierProductionObservedGateStatusesV1)[number];

export interface ReadyFrontierProductionGateObservationStatusV1 {
  gateCode: ReadyFrontierProductionGateCodeV1;
  status: ReadyFrontierProductionObservedGateStatusV1;
  proofId: string | null;
  observationId: string | null;
  observedAt: string | null;
  expiresAt: string | null;
}

export interface ReadyFrontierProductionProofAssessmentV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_PROOF_ASSESSMENT_V1;
  proofAssessmentId: string;
  tenantId: string;
  workspaceId: string;
  planId: string;
  planDigest: string;
  assessmentId: string;
  assessmentDigest: string;
  trustBundleId: string;
  trustBundleRevision: number;
  trustBundleDigest: string;
  trustMode: typeof READY_FRONTIER_PRODUCTION_TRUST_MODE_V1;
  gateStatuses: ReadyFrontierProductionGateObservationStatusV1[];
  blockingGateCodes: ReadyFrontierProductionGateCodeV1[];
  observedUnqualifiedCount: number;
  qualifiedProofCount: 0;
  remainingQualifiedProofCount: 9;
  state: "blocked_fixture_proof_only";
  safeReason: "protected_production_custody_unavailable";
  evaluatedAt: string;
  eligibleForOwnerApproval: false;
  eligibleForActivation: false;
  requiresProtectedProductionReassessment: true;
  requiresFreshStrongOwnerApproval: true;
  requiresIndependentSecurityReview: true;
  activationAuthorized: false;
  grantsApproval: false;
  grantsActivationAuthority: false;
  grantsClaimOrLease: false;
  grantsDispatchOrExecution: false;
  grantsExternalEffects: false;
  proofAssessmentDigest: string;
}

export interface ReadyFrontierProductionProofProjectionV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_PROOF_PROJECTION_V1;
  tenantId: string;
  workspaceId: string;
  planId: string;
  assessmentId: string;
  proofAssessmentId: string;
  status: "blocked_fixture_proof_only";
  safeReason: "protected_production_custody_unavailable";
  gateStatuses: Array<{
    gateCode: ReadyFrontierProductionGateCodeV1;
    status: ReadyFrontierProductionObservedGateStatusV1;
  }>;
  blockingGateCodes: ReadyFrontierProductionGateCodeV1[];
  observedUnqualifiedCount: number;
  qualifiedProofCount: 0;
  remainingQualifiedProofCount: 9;
  canActivateProduction: false;
  canConstructConsumer: false;
  canResolveProtectedReferences: false;
  canContactNetwork: false;
  canClaimOrLease: false;
  canDispatchOrExecute: false;
  projectionDigest: string;
}

export interface ReadyFrontierProductionProofVerificationInputV1 {
  envelope: ReadyFrontierProductionProofEnvelopeV1;
  assessment: ReadyFrontierProductionBoundaryAssessmentV1;
  trustBundle: ReadyFrontierProductionTrustBundleV1;
  receivedAt: string;
}
