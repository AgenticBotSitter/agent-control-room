export const CONTENT_BLOOMS_ADAPTER_CONTRACT_V1 = "control-room-content-blooms-adapter/v1" as const;
export const CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1 = "control-room-content-blooms-placement/v1" as const;
export const CONTENT_BLOOMS_SOURCE_SYSTEM_V1 = "content-blooms" as const;
export const CONTENT_BLOOMS_AUTHORITY_MODE_V1 = "source_scheduled" as const;
export const CONTENT_BLOOMS_PLACEMENT_COMMAND_V1 = "setWorkerPreference" as const;
export const CONTENT_BLOOMS_PLACEMENT_SOURCE_OPERATION_V1 = "request_transcription_route_preference" as const;
export const CONTENT_BLOOMS_PLACEMENT_DESTINATION_V1 = "content-blooms:source-scheduled" as const;

export const CONTENT_BLOOMS_READ_OPERATIONS_V1 = [
  "getProjectSummary",
  "listWorkItems",
  "listExecutions",
  "listBlockers",
  "listWorkers",
  "listAttentionItems",
  "readChanges",
] as const;

export type ContentBloomsReadOperationV1 = (typeof CONTENT_BLOOMS_READ_OPERATIONS_V1)[number];
export type ContentBloomsRecordKindV1 = "project" | "work_item" | "execution" | "blocker" | "worker" | "attention";

export interface ContentBloomsProjectProjectionV1 {
  title: string;
  normalizedState: "planned" | "ready" | "running" | "waiting" | "blocked" | "needs_attention" | "review" | "complete" | "failed" | "cancelled";
  domainState: string;
  health: "healthy" | "watch" | "at_risk" | "blocked";
  progressPercent?: number;
  forecastAt?: string;
  attentionCount: number;
  blockerCount: number;
  priority: number;
  deepLinkPath?: string;
}

export interface ContentBloomsWorkItemProjectionV1 {
  title: string;
  normalizedState: ContentBloomsProjectProjectionV1["normalizedState"];
  domainState: string;
  priority: number;
  progressPercent?: number;
  requiredCapability?: string;
  allowedRouteIds?: string[];
  blockedBySourceRecordIds?: string[];
  downstreamUnlockCount?: number;
  createdAt: string;
  updatedAt: string;
  deepLinkPath?: string;
}

export interface ContentBloomsExecutionProjectionV1 {
  workItemSourceRecordId: string;
  attempt: number;
  state: "queued" | "leased" | "running" | "paused" | "succeeded" | "failed";
  routeId?: string;
  progressPercent?: number;
  sourceLeaseOwnerDigest?: string;
  sourceLeaseEpoch?: number;
  leaseObservedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  safeFailureCode?: string;
}

export interface ContentBloomsBlockerProjectionV1 {
  workItemSourceRecordId?: string;
  blockerType: string;
  title: string;
  severity: "info" | "warning" | "critical";
  responsibleRole: "system" | "operator" | "customer" | "project" | "provider";
  safeRemedy?: string;
  openedAt: string;
  deepLinkPath?: string;
}

export interface ContentBloomsWorkerProjectionV1 {
  workerRefDigest: string;
  displayLabel: string;
  platform: "windows" | "macos" | "linux" | "cloud";
  state: "online" | "idle" | "busy" | "draining" | "degraded" | "offline" | "maintenance";
  routeIds: string[];
  observedAt: string;
}

export interface ContentBloomsAttentionProjectionV1 {
  workItemSourceRecordId?: string;
  attentionType: "approval" | "question" | "review" | "decision";
  title: string;
  summary: string;
  dueAt?: string;
  createdAt: string;
  deepLinkPath?: string;
}

export type ContentBloomsProjectionV1 =
  | ContentBloomsProjectProjectionV1
  | ContentBloomsWorkItemProjectionV1
  | ContentBloomsExecutionProjectionV1
  | ContentBloomsBlockerProjectionV1
  | ContentBloomsWorkerProjectionV1
  | ContentBloomsAttentionProjectionV1;

export interface ContentBloomsOperationalRecordV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  kind: ContentBloomsRecordKindV1;
  operation: "upsert" | "remove";
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  sourceRecordId: string;
  sourceVersion: string;
  observedAt: string;
  projection?: ContentBloomsProjectionV1;
  sourceChecksum: string;
  recordDigest: string;
}

export interface ContentBloomsAdapterReleaseV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  releaseId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  sourceSystem: typeof CONTENT_BLOOMS_SOURCE_SYSTEM_V1;
  authorityMode: typeof CONTENT_BLOOMS_AUTHORITY_MODE_V1;
  coreAdapterContractVersion: "control-room-project-adapter/v1";
  projectType: "content-operations";
  supportedReadOperations: ContentBloomsReadOperationV1[];
  supportedCommands: [];
  redactionPolicyVersion: string;
  adapterPackageDigest: string;
  projectionSchemaDigest: string;
  conformanceEvidenceDigest: string;
  acceptanceProfileDigest: string;
  acceptedReviewDigest: string;
  completionSnapshotDigest: string;
  producerIdentityDigest: string;
  reviewerIdentityDigest: string;
  reviewedAndAccepted: true;
  acceptedAt: string;
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  sourceOwnsDomainTransitions: true;
  controlRoomMayLease: false;
  controlRoomMayMutateSource: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
  releaseDigest: string;
}

export interface ContentBloomsReadRequestV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  expectedReleaseDigest: string;
  operation: ContentBloomsReadOperationV1;
  afterCursor?: string;
  limit: number;
  requestedAt: string;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  requestDigest: string;
}

export interface ContentBloomsReadPageV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  pageId: string;
  requestId: string;
  requestDigest: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  releaseDigest: string;
  operation: ContentBloomsReadOperationV1;
  afterCursor?: string;
  nextCursor: string;
  hasMore: boolean;
  sourceSnapshotVersion: string;
  sourceObservedAt: string;
  records: ContentBloomsOperationalRecordV1[];
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  sourceOwnsDomainTransitions: true;
  controlRoomMayLease: false;
  controlRoomMayMutateSource: false;
  pageDigest: string;
}

export interface ContentBloomsReadReceiptV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  receiptId: string;
  requestId: string;
  requestDigest: string;
  pageId: string;
  pageDigest: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  releaseDigest: string;
  controlStateDigest: string;
  operation: ContentBloomsReadOperationV1;
  sourceSnapshotVersion: string;
  nextCursorDigest: string;
  recordDigests: string[];
  recordCount: number;
  sourceObservedAt: string;
  recordedAt: string;
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  sourceOwnsDomainTransitions: true;
  controlRoomMayLease: false;
  controlRoomMayMutateSource: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export interface ContentBloomsAdapterControlStateV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  stateId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  revision: number;
  lifecycleRevision: number;
  status: "disabled" | "enabled";
  configuredReleaseDigest?: string;
  activeReleaseDigest?: string;
  previousReleaseDigests: string[];
  lastCommittedCursorDigest?: string;
  lastReadReceiptDigest?: string;
  updatedAt: string;
  readsEligible: boolean;
  commandsEnabled: false;
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  sourceOwnsDomainTransitions: true;
  controlRoomMayLease: false;
  controlRoomMayMutateSource: false;
  grantsNetworkAuthority: false;
  grantsExecutionAuthority: false;
  stateDigest: string;
}

export interface ContentBloomsControlTransitionV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  transitionId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  action: "enable_release" | "disable" | "rollback_release";
  expectedStateDigest: string;
  targetReleaseDigest?: string;
  requestedByActorDigest: string;
  reasonCode: string;
  requestedAt: string;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  transitionDigest: string;
}

export interface ContentBloomsControlTransitionReceiptV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  receiptId: string;
  transitionId: string;
  transitionDigest: string;
  action: ContentBloomsControlTransitionV1["action"];
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  beforeStateDigest: string;
  afterStateDigest: string;
  beforeLifecycleRevision: number;
  afterLifecycleRevision: number;
  beforeLifecycleDigest: string;
  afterLifecycleDigest: string;
  configuredReleaseDigest?: string;
  activeReleaseDigest?: string;
  previousReleaseDigests: string[];
  preservedCursorDigest?: string;
  preservedReadReceiptDigest?: string;
  appliedAt: string;
  status: "applied";
  commandsEnabled: false;
  controlRoomMayLease: false;
  controlRoomMayMutateSource: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export interface ContentBloomsValidatedReadV1 {
  page: ContentBloomsReadPageV1;
  records: ContentBloomsOperationalRecordV1[];
  nextCursor: string;
  receipt: ContentBloomsReadReceiptV1;
}

export interface ContentBloomsTranscriptionRouteObservationV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  routeId: string;
  workerRefDigest: string;
  platform: "macos" | "windows" | "linux";
  runtimeClass: "whisper_mlx" | "whisper_cuda" | "whisper_cpu";
  state: "idle" | "busy" | "offline";
  verification: "verified" | "provisional" | "expired" | "unavailable";
  estimatedDurationSeconds: number;
  estimatedCostMilliUsd: number;
  qualityRank: number;
  privacyClass: "local" | "approved_provider" | "restricted";
  benchmarkVersion: string;
  benchmarkDigest: string;
  observedAt: string;
  validUntil: string;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  routeDigest: string;
}

export interface ContentBloomsRouteComparisonPolicyV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  policyId: string;
  maxCostMilliUsd: number;
  minimumQualityRank: number;
  allowedPrivacyClasses: Array<"local" | "approved_provider" | "restricted">;
  allowBusy: boolean;
  durationWeight: number;
  costWeight: number;
  qualityWeight: number;
  privacyWeight: number;
  policyDigest: string;
}

export interface ContentBloomsRankedRouteV1 {
  routeId: string;
  routeDigest: string;
  score: number;
  rank: number;
}

export interface ContentBloomsRouteComparisonV1 {
  contractVersion: typeof CONTENT_BLOOMS_ADAPTER_CONTRACT_V1;
  comparisonId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  workItemSourceRecordId: string;
  workItemRecordDigest: string;
  policyId: string;
  policyDigest: string;
  consideredRouteDigests: string[];
  eligibleRoutes: ContentBloomsRankedRouteV1[];
  rejectedRouteIds: string[];
  recommendedRouteId?: string;
  comparedAt: string;
  disposition: "source_preference_observation";
  sourceMustDecide: true;
  controlRoomMayAssign: false;
  grantsApproval: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  comparisonDigest: string;
}

export type ContentBloomsPlacementRejectionCodeV1 =
  | "stale_source_version"
  | "work_not_eligible"
  | "route_unavailable"
  | "source_policy_denied"
  | "request_expired"
  | "source_rejected";

export interface ContentBloomsPlacementDeclarationV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1;
  declarationId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  readReleaseDigest: string;
  coreAdapterContractVersion: "control-room-project-adapter/v1";
  command: typeof CONTENT_BLOOMS_PLACEMENT_COMMAND_V1;
  sourceOperation: typeof CONTENT_BLOOMS_PLACEMENT_SOURCE_OPERATION_V1;
  destination: typeof CONTENT_BLOOMS_PLACEMENT_DESTINATION_V1;
  minimumRisk: "medium";
  requiredFactor: "strong";
  commandSchemaDigest: string;
  sourceReceiptSchemaDigest: string;
  conformanceEvidenceDigest: string;
  acceptanceProfileDigest: string;
  acceptedReviewDigest: string;
  completionSnapshotDigest: string;
  producerIdentityDigest: string;
  reviewerIdentityDigest: string;
  reviewedAndAccepted: true;
  acceptedAt: string;
  sourceIdempotencyContract: "stable_key_echo_required";
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  sourceOwnsDomainTransitions: true;
  requestChangesPreferenceOnly: true;
  controlRoomMayAssign: false;
  controlRoomMayLease: false;
  controlRoomMayMutateSourceDirectly: false;
  requiresStrongApproval: true;
  requiresSeparateNodeAttestation: true;
  requiresDurableEffectClaim: true;
  requiresPreEffectMarker: true;
  requiresCurrentLifecycleMatch: true;
  retryFromAmbiguityAllowed: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  declarationDigest: string;
}

export interface ContentBloomsPlacementRequestV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  declarationDigest: string;
  readReleaseDigest: string;
  controlStateDigest: string;
  controlLifecycleRevision: number;
  controlLifecycleDigest: string;
  jobId: string;
  attemptId: string;
  effectIntentId: string;
  workItemSourceRecordId: string;
  expectedSourceVersion: string;
  expectedSourceChecksum: string;
  expectedWorkItemRecordDigest: string;
  routeComparisonDigest: string;
  selectedRouteId: string;
  selectedRouteDigest: string;
  routeValidUntil: string;
  reasonCode: string;
  requestedByActorDigest: string;
  requestedAt: string;
  expiresAt: string;
  command: typeof CONTENT_BLOOMS_PLACEMENT_COMMAND_V1;
  sourceOperation: typeof CONTENT_BLOOMS_PLACEMENT_SOURCE_OPERATION_V1;
  destination: typeof CONTENT_BLOOMS_PLACEMENT_DESTINATION_V1;
  risk: "medium";
  requiredFactor: "strong";
  idempotencyKey: string;
  operationDigest: string;
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  sourceOwnsDomainTransitions: true;
  preferenceRequestOnly: true;
  controlRoomMayAssign: false;
  controlRoomMayLease: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  requestDigest: string;
}

export interface ContentBloomsPlacementAuthorizationV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1;
  authorizationId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  declarationDigest: string;
  readReleaseDigest: string;
  requestId: string;
  requestDigest: string;
  jobId: string;
  attemptId: string;
  effectIntentId: string;
  operationDigest: string;
  idempotencyKey: string;
  approvalRequestId: string;
  approvalRequestDigest: string;
  approvalDecisionId: string;
  approvalDecisionDigest: string;
  approvalDecision: "approved";
  authorizedAt: string;
  expiresAt: string;
  approvalRecordsMustBeResolvedAuthoritatively: true;
  requiresCurrentLifecycleMatch: true;
  requiresSeparateNodeAttestation: true;
  requiresDurableEffectClaim: true;
  requiresPreEffectMarker: true;
  singleUse: true;
  sameEffectRetryAfterAmbiguityAllowed: false;
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  controlRoomMayAssign: false;
  controlRoomMayLease: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  authorizationDigest: string;
}

export interface ContentBloomsPlacementSourceReceiptV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1;
  receiptId: string;
  sourceReceiptId: string;
  sourceCommandId?: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  requestId: string;
  requestDigest: string;
  authorizationId: string;
  authorizationDigest: string;
  declarationDigest: string;
  readReleaseDigest: string;
  operationDigest: string;
  idempotencyKey: string;
  sourceIdempotencyKey: string;
  workItemSourceRecordId: string;
  expectedSourceVersion: string;
  selectedRouteId: string;
  selectedRouteDigest: string;
  disposition: "accepted" | "already_applied" | "rejected";
  preferenceRecorded: boolean;
  appliedSourceVersion?: string;
  observedSourceVersionDigest?: string;
  safeReasonCode?: ContentBloomsPlacementRejectionCodeV1;
  dispatchClaimDigest: string;
  preEffectMarkerDigest: string;
  authenticatedTransportEvidenceDigest: string;
  authorizedAt: string;
  authorizationExpiresAt: string;
  requestExpiresAt: string;
  routeValidUntil: string;
  dispatchedAt: string;
  sourceObservedAt: string;
  receivedAt: string;
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  sourceOwnsDomainTransitions: true;
  controlRoomMayAssign: false;
  controlRoomMayLease: false;
  sameEffectRetryProhibited: true;
  requiresSourceReconciliation: false;
  requestAndAuthorizationMustBeResolvedAuthoritatively: true;
  claimAndMarkerMustBeResolvedDurably: true;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export interface ContentBloomsPlacementAmbiguityReceiptV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1;
  receiptId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  requestId: string;
  requestDigest: string;
  authorizationId: string;
  authorizationDigest: string;
  declarationDigest: string;
  readReleaseDigest: string;
  operationDigest: string;
  idempotencyKey: string;
  dispatchClaimDigest: string;
  preEffectMarkerDigest: string;
  ambiguityEvidenceDigest: string;
  authorizedAt: string;
  authorizationExpiresAt: string;
  requestExpiresAt: string;
  routeValidUntil: string;
  dispatchedAt: string;
  raisedAt: string;
  disposition: "ambiguous";
  sourceReceiptObserved: false;
  sameEffectRetryProhibited: true;
  requiresSourceReconciliation: true;
  newAuthorizationRequiredForAnyNewEffect: true;
  requestAndAuthorizationMustBeResolvedAuthoritatively: true;
  claimAndMarkerMustBeResolvedDurably: true;
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  controlRoomMayAssign: false;
  controlRoomMayLease: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export type ContentBloomsPlacementOutcomeReceiptV1 =
  | ContentBloomsPlacementSourceReceiptV1
  | ContentBloomsPlacementAmbiguityReceiptV1;
