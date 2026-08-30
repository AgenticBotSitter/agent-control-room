import type { WayfarerArtifactRoleV1 } from "./types";

export const WAYFARER_STORAGE_CONTRACT_V1 = "control-room-wayfarer-storage/v1" as const;
export const WAYFARER_LOCAL_STORE_ID_V1 = "store:wayfarer:local-private:v1" as const;
export const WAYFARER_R2_STORE_ID_V1 = "store:wayfarer:r2-private:v1" as const;
export const WAYFARER_LOCATOR_REGISTRY_ID_V1 = "registry:wayfarer:private-locators:v1" as const;

export type WayfarerStoreIdV1 = typeof WAYFARER_LOCAL_STORE_ID_V1 | typeof WAYFARER_R2_STORE_ID_V1;
export type WayfarerStorageClassV1 = "local_private" | "r2_private";
export type WayfarerStorageLifecycleStateV1 = "declared" | "reserved" | "write_marker_recorded" | "stored_unverified"
  | "verified" | "quarantined" | "ambiguous" | "retention_candidate" | "cleanup_proposed" | "released";

export interface WayfarerLogicalStoreV1 {
  storeId: WayfarerStoreIdV1;
  storageClass: WayfarerStorageClassV1;
  logicalNamespaceId: string;
  scopeIdentityDigest: string;
  locatorRegistryId: typeof WAYFARER_LOCATOR_REGISTRY_ID_V1;
  locatorReferenceMode: "digest_only";
  locatorValuesRemainBrokerPrivate: true;
  immutableObjectKeys: true;
  overwriteAllowed: false;
  requiresContentDigest: true;
  requiresExactSize: true;
  maximumObjectBytes: number;
  maximumReservationBytes: number;
  maximumOutstandingObjects: number;
  credentialBindingMode: "none" | "owner_configured_broker_private";
  adapterConfigured: false;
  adapterQualified: false;
  liveAccessAllowed: false;
  filesystemAccessAllowed: false;
  networkAccessAllowed: false;
  grantsExecutionAuthority: false;
}

export interface WayfarerLocatorCustodyV1 {
  locatorRegistryId: typeof WAYFARER_LOCATOR_REGISTRY_ID_V1;
  controlPlaneStoresLocatorValues: false;
  controlPlaneStoresPaths: false;
  controlPlaneStoresBucketNames: false;
  controlPlaneStoresAccountIdentifiers: false;
  controlPlaneStoresEndpoints: false;
  controlPlaneStoresSignedUrls: false;
  locatorResolutionRequiresSeparateAuthority: true;
  locatorResolutionAllowedByThisContract: false;
  locatorReferencesGrantAuthority: false;
}

export interface WayfarerStorageRetryPolicyV1 {
  maximumPreMarkerRetries: 1;
  automaticPostMarkerRetryAllowed: false;
  restartAfterMarkerDisposition: "terminal_ambiguous";
  unknownAfterMarkerDisposition: "terminal_ambiguous";
  integrityMismatchDisposition: "quarantine";
  ambiguityRequiresAuthoritativeReconciliation: true;
  ambiguityCanBeClearedByRetry: false;
}

export interface WayfarerStoragePolicyV1 {
  contractVersion: typeof WAYFARER_STORAGE_CONTRACT_V1;
  policyId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  packId: string;
  packDigest: string;
  stores: [WayfarerLogicalStoreV1, WayfarerLogicalStoreV1];
  locatorCustody: WayfarerLocatorCustodyV1;
  retryPolicy: WayfarerStorageRetryPolicyV1;
  allowedTransitions: Array<{ from: WayfarerStorageLifecycleStateV1; to: WayfarerStorageLifecycleStateV1 }>;
  storageIsCoordinationPlane: false;
  storesRawCredentials: false;
  storesArtifactBytesInControlPlane: false;
  automaticRetentionCleanupAllowed: false;
  legalHoldWins: true;
  syntheticEvaluationOnly: true;
  enablesFilesystemAdapter: false;
  enablesR2Adapter: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  createdAt: string;
  policyDigest: string;
}

export interface WayfarerStorageArtifactDeclarationV1 {
  artifactId: string;
  episodeId: string;
  role: WayfarerArtifactRoleV1;
  contentType: string;
  contentDigest: string;
  sizeBytes: number;
  createdAt: string;
}

export interface WayfarerCapacityReservationV1 {
  reservationId: string;
  storeId: WayfarerStoreIdV1;
  reservedObjectCount: 1;
  reservedBytes: number;
  expiresAt: string;
  state: "proposed";
  acquiredCapacity: false;
  canWrite: false;
  grantsExecutionAuthority: false;
  reservationDigest: string;
}

export interface WayfarerStoragePlanV1 {
  contractVersion: typeof WAYFARER_STORAGE_CONTRACT_V1;
  planId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  packId: string;
  packDigest: string;
  policyId: string;
  policyDigest: string;
  storeId: WayfarerStoreIdV1;
  storageClass: WayfarerStorageClassV1;
  artifact: WayfarerStorageArtifactDeclarationV1;
  artifactIdentityDigest: string;
  objectKeyDigest: string;
  locatorRefDigest: string;
  retentionClassId: string;
  capacityReservation: WayfarerCapacityReservationV1;
  lifecycleState: "declared";
  embedsBytes: false;
  containsLocatorValue: false;
  resolvesLocator: false;
  resolvesCredential: false;
  writesObject: false;
  createsEffectIntent: false;
  syntheticEvaluationOnly: true;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  plannedAt: string;
  planDigest: string;
}

export type WayfarerStorageObservationCodeV1 = "simulated_store_verified" | "definite_pre_marker_failure"
  | "capacity_unavailable_pre_marker" | "integrity_mismatch_after_marker" | "post_marker_outcome_unknown"
  | "restart_after_marker";

export interface WayfarerStorageAttemptObservationV1 {
  observationCode: WayfarerStorageObservationCodeV1;
  markerRecorded: boolean;
  observedContentDigest?: string;
  observedSizeBytes?: number;
  safeEvidenceDigest: string;
}

export interface WayfarerStorageAttemptOutcomeV1 {
  contractVersion: typeof WAYFARER_STORAGE_CONTRACT_V1;
  outcomeId: string;
  planId: string;
  planDigest: string;
  policyDigest: string;
  artifactIdentityDigest: string;
  expectedContentDigest: string;
  expectedSizeBytes: number;
  attemptNumber: 1 | 2;
  previousOutcomeDigest?: string;
  observation: WayfarerStorageAttemptObservationV1;
  disposition: "simulated_verified" | "definite_failure" | "capacity_blocked" | "quarantined" | "ambiguous";
  lifecycleState: "verified" | "released" | "quarantined" | "ambiguous";
  reservationDisposition: "simulated_consumed" | "released" | "quarantined" | "held_for_reconciliation";
  retryAllowed: boolean;
  retryReason: "definite_pre_marker_only" | "retry_limit_reached" | "post_marker_retry_forbidden" | "not_applicable";
  requiresReconciliation: boolean;
  locatorResolved: false;
  credentialResolved: false;
  bytesTransferred: false;
  filesystemUsed: false;
  networkUsed: false;
  objectStorageUsed: false;
  syntheticOnly: true;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  startedAt: string;
  settledAt: string;
  outcomeDigest: string;
}

export interface WayfarerRetentionProposalV1 {
  contractVersion: typeof WAYFARER_STORAGE_CONTRACT_V1;
  proposalId: string;
  planId: string;
  planDigest: string;
  policyDigest: string;
  outcomeDigest: string;
  retentionClassId: string;
  lifecycleState: "verified" | "quarantined";
  retentionClockEvidenceDigest: string;
  eligibleAfter: string;
  evaluatedAt: string;
  legalHoldActive: boolean;
  disposition: "not_due" | "blocked_by_legal_hold" | "owner_review_candidate";
  ownerReviewRequired: true;
  independentEvidenceRequired: true;
  cleanupCandidate: boolean;
  automaticallyScheduled: false;
  deletesObject: false;
  resolvesLocator: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  proposalDigest: string;
}

export interface WayfarerStorageCleanupReceiptV1 {
  contractVersion: typeof WAYFARER_STORAGE_CONTRACT_V1;
  cleanupId: string;
  planId: string;
  planDigest: string;
  outcomeDigest: string;
  reservationDisposition: WayfarerStorageAttemptOutcomeV1["reservationDisposition"];
  temporaryHandlesClosed: true;
  temporaryObjectsRemaining: false;
  locatorResolved: false;
  credentialResolved: false;
  objectDeleted: false;
  filesystemUsed: false;
  networkUsed: false;
  objectStorageUsed: false;
  cleanupIsDeletionEvidence: false;
  syntheticOnly: true;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  cleanedAt: string;
  cleanupDigest: string;
}
