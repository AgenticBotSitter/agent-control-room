import { z } from "zod";
import {
  consequentialApprovalDecisionSchemaV1,
  consequentialApprovalRequestSchemaV1,
  type ConsequentialApprovalDecisionV1,
  type ConsequentialApprovalRequestV1,
} from "../../../completion-gate/v1";
import { sha256Digest } from "../../../security";
import { contentBloomsControlLifecycleDigestV1, parseContentBloomsControlStateV1 } from "./control";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseExactContentBloomsV1 } from "./exact";
import { parseContentBloomsOperationalRecordV1 } from "./records";
import { parseContentBloomsAdapterReleaseV1 } from "./release";
import { parseContentBloomsRouteComparisonV1, parseContentBloomsTranscriptionRouteObservationV1 } from "./route-comparison";
import { contentBloomsDigestSchemaV1, contentBloomsSafeIdSchemaV1, contentBloomsTimeSchemaV1 } from "./schemas";
import {
  CONTENT_BLOOMS_PLACEMENT_COMMAND_V1,
  CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1,
  CONTENT_BLOOMS_PLACEMENT_DESTINATION_V1,
  CONTENT_BLOOMS_PLACEMENT_SOURCE_OPERATION_V1,
  type ContentBloomsAdapterControlStateV1,
  type ContentBloomsAdapterReleaseV1,
  type ContentBloomsPlacementAmbiguityReceiptV1,
  type ContentBloomsPlacementAuthorizationV1,
  type ContentBloomsPlacementDeclarationV1,
  type ContentBloomsPlacementOutcomeReceiptV1,
  type ContentBloomsPlacementRequestV1,
  type ContentBloomsPlacementSourceReceiptV1,
} from "./types";

const sourceVersionSchemaV1 = z.string().min(1).max(180).refine(
  (value) => [...value].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f),
);
const placementIdempotencyKeySchemaV1 = z.string().regex(/^cb-placement:[a-f0-9]{64}$/);

const placementDeclarationInputSchemaV1 = z.object({
  declarationId: contentBloomsSafeIdSchemaV1,
  readRelease: z.unknown(),
  commandSchemaDigest: contentBloomsDigestSchemaV1,
  sourceReceiptSchemaDigest: contentBloomsDigestSchemaV1,
  conformanceEvidenceDigest: contentBloomsDigestSchemaV1,
  acceptanceProfileDigest: contentBloomsDigestSchemaV1,
  acceptedReviewDigest: contentBloomsDigestSchemaV1,
  completionSnapshotDigest: contentBloomsDigestSchemaV1,
  producerIdentityDigest: contentBloomsDigestSchemaV1,
  reviewerIdentityDigest: contentBloomsDigestSchemaV1,
  acceptedAt: contentBloomsTimeSchemaV1,
}).strict().superRefine((value, context) => {
  if (value.producerIdentityDigest === value.reviewerIdentityDigest) {
    context.addIssue({ code: "custom", message: "placement declaration requires producer-independent acceptance" });
  }
});

const placementDeclarationSchemaV1 = z.object({
  schemaVersion: z.literal(CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1),
  declarationId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  readReleaseDigest: contentBloomsDigestSchemaV1,
  coreAdapterContractVersion: z.literal("control-room-project-adapter/v1"),
  command: z.literal(CONTENT_BLOOMS_PLACEMENT_COMMAND_V1),
  sourceOperation: z.literal(CONTENT_BLOOMS_PLACEMENT_SOURCE_OPERATION_V1),
  destination: z.literal(CONTENT_BLOOMS_PLACEMENT_DESTINATION_V1),
  minimumRisk: z.literal("medium"),
  requiredFactor: z.literal("strong"),
  commandSchemaDigest: contentBloomsDigestSchemaV1,
  sourceReceiptSchemaDigest: contentBloomsDigestSchemaV1,
  conformanceEvidenceDigest: contentBloomsDigestSchemaV1,
  acceptanceProfileDigest: contentBloomsDigestSchemaV1,
  acceptedReviewDigest: contentBloomsDigestSchemaV1,
  completionSnapshotDigest: contentBloomsDigestSchemaV1,
  producerIdentityDigest: contentBloomsDigestSchemaV1,
  reviewerIdentityDigest: contentBloomsDigestSchemaV1,
  reviewedAndAccepted: z.literal(true),
  acceptedAt: contentBloomsTimeSchemaV1,
  sourceIdempotencyContract: z.literal("stable_key_echo_required"),
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  sourceOwnsDomainTransitions: z.literal(true),
  requestChangesPreferenceOnly: z.literal(true),
  controlRoomMayAssign: z.literal(false),
  controlRoomMayLease: z.literal(false),
  controlRoomMayMutateSourceDirectly: z.literal(false),
  requiresStrongApproval: z.literal(true),
  requiresSeparateNodeAttestation: z.literal(true),
  requiresDurableEffectClaim: z.literal(true),
  requiresPreEffectMarker: z.literal(true),
  requiresCurrentLifecycleMatch: z.literal(true),
  retryFromAmbiguityAllowed: z.literal(false),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  declarationDigest: contentBloomsDigestSchemaV1,
}).strict().superRefine((value, context) => {
  if (value.producerIdentityDigest === value.reviewerIdentityDigest) {
    context.addIssue({ code: "custom", message: "placement declaration requires producer-independent acceptance" });
  }
});

const placementRequestInputSchemaV1 = z.object({
  declaration: z.unknown(),
  readRelease: z.unknown(),
  controlState: z.unknown(),
  workItem: z.unknown(),
  routeComparison: z.unknown(),
  selectedRoute: z.unknown(),
  requestId: contentBloomsSafeIdSchemaV1,
  jobId: contentBloomsSafeIdSchemaV1,
  attemptId: contentBloomsSafeIdSchemaV1,
  effectIntentId: contentBloomsSafeIdSchemaV1,
  reasonCode: contentBloomsSafeIdSchemaV1,
  requestedByActorDigest: contentBloomsDigestSchemaV1,
  requestedAt: contentBloomsTimeSchemaV1,
  expiresAt: contentBloomsTimeSchemaV1,
}).strict();

const placementRequestSchemaV1 = z.object({
  schemaVersion: z.literal(CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1),
  requestId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  declarationDigest: contentBloomsDigestSchemaV1,
  readReleaseDigest: contentBloomsDigestSchemaV1,
  controlStateDigest: contentBloomsDigestSchemaV1,
  controlLifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  controlLifecycleDigest: contentBloomsDigestSchemaV1,
  jobId: contentBloomsSafeIdSchemaV1,
  attemptId: contentBloomsSafeIdSchemaV1,
  effectIntentId: contentBloomsSafeIdSchemaV1,
  workItemSourceRecordId: contentBloomsSafeIdSchemaV1,
  expectedSourceVersion: sourceVersionSchemaV1,
  expectedSourceChecksum: contentBloomsDigestSchemaV1,
  expectedWorkItemRecordDigest: contentBloomsDigestSchemaV1,
  routeComparisonDigest: contentBloomsDigestSchemaV1,
  selectedRouteId: contentBloomsSafeIdSchemaV1,
  selectedRouteDigest: contentBloomsDigestSchemaV1,
  routeValidUntil: contentBloomsTimeSchemaV1,
  reasonCode: contentBloomsSafeIdSchemaV1,
  requestedByActorDigest: contentBloomsDigestSchemaV1,
  requestedAt: contentBloomsTimeSchemaV1,
  expiresAt: contentBloomsTimeSchemaV1,
  command: z.literal(CONTENT_BLOOMS_PLACEMENT_COMMAND_V1),
  sourceOperation: z.literal(CONTENT_BLOOMS_PLACEMENT_SOURCE_OPERATION_V1),
  destination: z.literal(CONTENT_BLOOMS_PLACEMENT_DESTINATION_V1),
  risk: z.literal("medium"),
  requiredFactor: z.literal("strong"),
  idempotencyKey: placementIdempotencyKeySchemaV1,
  operationDigest: contentBloomsDigestSchemaV1,
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  sourceOwnsDomainTransitions: z.literal(true),
  preferenceRequestOnly: z.literal(true),
  controlRoomMayAssign: z.literal(false),
  controlRoomMayLease: z.literal(false),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  requestDigest: contentBloomsDigestSchemaV1,
}).strict();

const placementAuthorizationInputSchemaV1 = z.object({
  request: z.unknown(),
  approvalRequest: z.unknown(),
  approvalDecision: z.unknown(),
}).strict();

const placementAuthorizationSchemaV1 = z.object({
  schemaVersion: z.literal(CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1),
  authorizationId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  declarationDigest: contentBloomsDigestSchemaV1,
  readReleaseDigest: contentBloomsDigestSchemaV1,
  requestId: contentBloomsSafeIdSchemaV1,
  requestDigest: contentBloomsDigestSchemaV1,
  jobId: contentBloomsSafeIdSchemaV1,
  attemptId: contentBloomsSafeIdSchemaV1,
  effectIntentId: contentBloomsSafeIdSchemaV1,
  operationDigest: contentBloomsDigestSchemaV1,
  idempotencyKey: placementIdempotencyKeySchemaV1,
  approvalRequestId: contentBloomsSafeIdSchemaV1,
  approvalRequestDigest: contentBloomsDigestSchemaV1,
  approvalDecisionId: contentBloomsSafeIdSchemaV1,
  approvalDecisionDigest: contentBloomsDigestSchemaV1,
  approvalDecision: z.literal("approved"),
  authorizedAt: contentBloomsTimeSchemaV1,
  expiresAt: contentBloomsTimeSchemaV1,
  approvalRecordsMustBeResolvedAuthoritatively: z.literal(true),
  requiresCurrentLifecycleMatch: z.literal(true),
  requiresSeparateNodeAttestation: z.literal(true),
  requiresDurableEffectClaim: z.literal(true),
  requiresPreEffectMarker: z.literal(true),
  singleUse: z.literal(true),
  sameEffectRetryAfterAmbiguityAllowed: z.literal(false),
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  controlRoomMayAssign: z.literal(false),
  controlRoomMayLease: z.literal(false),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  authorizationDigest: contentBloomsDigestSchemaV1,
}).strict();

const placementSourceReceiptInputSchemaV1 = z.object({
  request: z.unknown(),
  authorization: z.unknown(),
  sourceReceiptId: contentBloomsSafeIdSchemaV1,
  sourceCommandId: contentBloomsSafeIdSchemaV1.optional(),
  sourceIdempotencyKey: placementIdempotencyKeySchemaV1,
  disposition: z.enum(["accepted", "already_applied", "rejected"]),
  appliedSourceVersion: sourceVersionSchemaV1.optional(),
  observedSourceVersionDigest: contentBloomsDigestSchemaV1.optional(),
  safeReasonCode: z.enum([
    "stale_source_version",
    "work_not_eligible",
    "route_unavailable",
    "source_policy_denied",
    "request_expired",
    "source_rejected",
  ]).optional(),
  dispatchClaimDigest: contentBloomsDigestSchemaV1,
  preEffectMarkerDigest: contentBloomsDigestSchemaV1,
  authenticatedTransportEvidenceDigest: contentBloomsDigestSchemaV1,
  dispatchedAt: contentBloomsTimeSchemaV1,
  sourceObservedAt: contentBloomsTimeSchemaV1,
  receivedAt: contentBloomsTimeSchemaV1,
}).strict();

const placementSourceReceiptSchemaV1 = z.object({
  schemaVersion: z.literal(CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1),
  receiptId: contentBloomsSafeIdSchemaV1,
  sourceReceiptId: contentBloomsSafeIdSchemaV1,
  sourceCommandId: contentBloomsSafeIdSchemaV1.optional(),
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  requestId: contentBloomsSafeIdSchemaV1,
  requestDigest: contentBloomsDigestSchemaV1,
  authorizationId: contentBloomsSafeIdSchemaV1,
  authorizationDigest: contentBloomsDigestSchemaV1,
  declarationDigest: contentBloomsDigestSchemaV1,
  readReleaseDigest: contentBloomsDigestSchemaV1,
  operationDigest: contentBloomsDigestSchemaV1,
  idempotencyKey: placementIdempotencyKeySchemaV1,
  sourceIdempotencyKey: placementIdempotencyKeySchemaV1,
  workItemSourceRecordId: contentBloomsSafeIdSchemaV1,
  expectedSourceVersion: sourceVersionSchemaV1,
  selectedRouteId: contentBloomsSafeIdSchemaV1,
  selectedRouteDigest: contentBloomsDigestSchemaV1,
  disposition: z.enum(["accepted", "already_applied", "rejected"]),
  preferenceRecorded: z.boolean(),
  appliedSourceVersion: sourceVersionSchemaV1.optional(),
  observedSourceVersionDigest: contentBloomsDigestSchemaV1.optional(),
  safeReasonCode: z.enum([
    "stale_source_version",
    "work_not_eligible",
    "route_unavailable",
    "source_policy_denied",
    "request_expired",
    "source_rejected",
  ]).optional(),
  dispatchClaimDigest: contentBloomsDigestSchemaV1,
  preEffectMarkerDigest: contentBloomsDigestSchemaV1,
  authenticatedTransportEvidenceDigest: contentBloomsDigestSchemaV1,
  authorizedAt: contentBloomsTimeSchemaV1,
  authorizationExpiresAt: contentBloomsTimeSchemaV1,
  requestExpiresAt: contentBloomsTimeSchemaV1,
  routeValidUntil: contentBloomsTimeSchemaV1,
  dispatchedAt: contentBloomsTimeSchemaV1,
  sourceObservedAt: contentBloomsTimeSchemaV1,
  receivedAt: contentBloomsTimeSchemaV1,
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  sourceOwnsDomainTransitions: z.literal(true),
  controlRoomMayAssign: z.literal(false),
  controlRoomMayLease: z.literal(false),
  sameEffectRetryProhibited: z.literal(true),
  requiresSourceReconciliation: z.literal(false),
  requestAndAuthorizationMustBeResolvedAuthoritatively: z.literal(true),
  claimAndMarkerMustBeResolvedDurably: z.literal(true),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  receiptDigest: contentBloomsDigestSchemaV1,
}).strict();

const placementAmbiguityInputSchemaV1 = z.object({
  request: z.unknown(),
  authorization: z.unknown(),
  dispatchClaimDigest: contentBloomsDigestSchemaV1,
  preEffectMarkerDigest: contentBloomsDigestSchemaV1,
  ambiguityEvidenceDigest: contentBloomsDigestSchemaV1,
  dispatchedAt: contentBloomsTimeSchemaV1,
  raisedAt: contentBloomsTimeSchemaV1,
}).strict();

const placementAmbiguitySchemaV1 = z.object({
  schemaVersion: z.literal(CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1),
  receiptId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  requestId: contentBloomsSafeIdSchemaV1,
  requestDigest: contentBloomsDigestSchemaV1,
  authorizationId: contentBloomsSafeIdSchemaV1,
  authorizationDigest: contentBloomsDigestSchemaV1,
  declarationDigest: contentBloomsDigestSchemaV1,
  readReleaseDigest: contentBloomsDigestSchemaV1,
  operationDigest: contentBloomsDigestSchemaV1,
  idempotencyKey: placementIdempotencyKeySchemaV1,
  dispatchClaimDigest: contentBloomsDigestSchemaV1,
  preEffectMarkerDigest: contentBloomsDigestSchemaV1,
  ambiguityEvidenceDigest: contentBloomsDigestSchemaV1,
  authorizedAt: contentBloomsTimeSchemaV1,
  authorizationExpiresAt: contentBloomsTimeSchemaV1,
  requestExpiresAt: contentBloomsTimeSchemaV1,
  routeValidUntil: contentBloomsTimeSchemaV1,
  dispatchedAt: contentBloomsTimeSchemaV1,
  raisedAt: contentBloomsTimeSchemaV1,
  disposition: z.literal("ambiguous"),
  sourceReceiptObserved: z.literal(false),
  sameEffectRetryProhibited: z.literal(true),
  requiresSourceReconciliation: z.literal(true),
  newAuthorizationRequiredForAnyNewEffect: z.literal(true),
  requestAndAuthorizationMustBeResolvedAuthoritatively: z.literal(true),
  claimAndMarkerMustBeResolvedDurably: z.literal(true),
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  controlRoomMayAssign: z.literal(false),
  controlRoomMayLease: z.literal(false),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  receiptDigest: contentBloomsDigestSchemaV1,
}).strict();

const preDispatchInputSchemaV1 = z.object({
  request: z.unknown(),
  authorization: z.unknown(),
  declaration: z.unknown(),
  readRelease: z.unknown(),
  controlState: z.unknown(),
  checkedAt: contentBloomsTimeSchemaV1,
}).strict();

const outcomeBindingInputSchemaV1 = z.object({
  request: z.unknown(),
  authorization: z.unknown(),
  outcome: z.unknown(),
}).strict();

function sameScope(
  left: { tenantId: string; workspaceId: string; projectId: string; adapterId: string },
  right: { tenantId: string; workspaceId: string; projectId: string; adapterId: string },
): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId
    && left.projectId === right.projectId && left.adapterId === right.adapterId;
}

function before(later: string, earlier: string): boolean {
  return Date.parse(later) >= Date.parse(earlier);
}

function withoutDeclarationDigest(value: ContentBloomsPlacementDeclarationV1): Omit<ContentBloomsPlacementDeclarationV1, "declarationDigest"> {
  const { declarationDigest: _declarationDigest, ...unsigned } = value;
  void _declarationDigest;
  return unsigned;
}

function requestIdempotencyMaterial(value: Pick<ContentBloomsPlacementRequestV1,
  "tenantId" | "workspaceId" | "projectId" | "adapterId" | "declarationDigest" | "readReleaseDigest"
  | "controlLifecycleRevision" | "controlLifecycleDigest" | "jobId" | "attemptId" | "effectIntentId"
  | "workItemSourceRecordId" | "expectedSourceVersion" | "expectedSourceChecksum" | "expectedWorkItemRecordDigest"
  | "routeComparisonDigest" | "selectedRouteId" | "selectedRouteDigest"
>): Record<string, unknown> {
  return {
    tenantId: value.tenantId,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    adapterId: value.adapterId,
    declarationDigest: value.declarationDigest,
    readReleaseDigest: value.readReleaseDigest,
    controlLifecycleRevision: value.controlLifecycleRevision,
    controlLifecycleDigest: value.controlLifecycleDigest,
    jobId: value.jobId,
    attemptId: value.attemptId,
    effectIntentId: value.effectIntentId,
    workItemSourceRecordId: value.workItemSourceRecordId,
    expectedSourceVersion: value.expectedSourceVersion,
    expectedSourceChecksum: value.expectedSourceChecksum,
    expectedWorkItemRecordDigest: value.expectedWorkItemRecordDigest,
    routeComparisonDigest: value.routeComparisonDigest,
    selectedRouteId: value.selectedRouteId,
    selectedRouteDigest: value.selectedRouteDigest,
  };
}

function placementIdempotencyKey(value: Parameters<typeof requestIdempotencyMaterial>[0]): string {
  return `cb-placement:${sha256Digest(requestIdempotencyMaterial(value)).slice(7)}`;
}

function placementOperationDigest(value: Pick<ContentBloomsPlacementRequestV1,
  "tenantId" | "projectId" | "jobId" | "attemptId" | "idempotencyKey"
>): string {
  return sha256Digest({
    tenantId: value.tenantId,
    projectId: value.projectId,
    jobId: value.jobId,
    attemptId: value.attemptId,
    operation: CONTENT_BLOOMS_PLACEMENT_COMMAND_V1,
    destination: CONTENT_BLOOMS_PLACEMENT_DESTINATION_V1,
    idempotencyKey: value.idempotencyKey,
    risk: "medium",
  });
}

function withoutRequestDigest(value: ContentBloomsPlacementRequestV1): Omit<ContentBloomsPlacementRequestV1, "requestDigest"> {
  const { requestDigest: _requestDigest, ...unsigned } = value;
  void _requestDigest;
  return unsigned;
}

function withoutAuthorizationDigest(value: ContentBloomsPlacementAuthorizationV1): Omit<ContentBloomsPlacementAuthorizationV1, "authorizationDigest"> {
  const { authorizationDigest: _authorizationDigest, ...unsigned } = value;
  void _authorizationDigest;
  return unsigned;
}

function withoutSourceReceiptDigest(value: ContentBloomsPlacementSourceReceiptV1): Omit<ContentBloomsPlacementSourceReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = value;
  void _receiptDigest;
  return unsigned;
}

function withoutAmbiguityDigest(value: ContentBloomsPlacementAmbiguityReceiptV1): Omit<ContentBloomsPlacementAmbiguityReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = value;
  void _receiptDigest;
  return unsigned;
}

function requireRequestAuthorizationBinding(
  request: ContentBloomsPlacementRequestV1,
  authorization: ContentBloomsPlacementAuthorizationV1,
): void {
  if (!sameScope(request, authorization) || authorization.requestId !== request.requestId
    || authorization.requestDigest !== request.requestDigest
    || authorization.declarationDigest !== request.declarationDigest
    || authorization.readReleaseDigest !== request.readReleaseDigest
    || authorization.jobId !== request.jobId || authorization.attemptId !== request.attemptId
    || authorization.effectIntentId !== request.effectIntentId
    || authorization.operationDigest !== request.operationDigest
    || authorization.idempotencyKey !== request.idempotencyKey) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
}

function requireDispatchChronology(
  request: ContentBloomsPlacementRequestV1,
  authorization: ContentBloomsPlacementAuthorizationV1,
  dispatchedAt: string,
): void {
  if (!before(dispatchedAt, authorization.authorizedAt)
    || Date.parse(dispatchedAt) >= Date.parse(authorization.expiresAt)
    || Date.parse(dispatchedAt) >= Date.parse(request.expiresAt)
    || Date.parse(dispatchedAt) >= Date.parse(request.routeValidUntil)) {
    throw new ContentBloomsContractErrorV1("request_expired");
  }
}

export function buildContentBloomsPlacementDeclarationV1(inputValue: unknown): ContentBloomsPlacementDeclarationV1 {
  const input = parseExactContentBloomsV1(placementDeclarationInputSchemaV1, inputValue);
  const release = parseContentBloomsAdapterReleaseV1(input.readRelease);
  if (!before(input.acceptedAt, release.acceptedAt)) throw new ContentBloomsContractErrorV1("sequence_invalid");
  const unsigned: Omit<ContentBloomsPlacementDeclarationV1, "declarationDigest"> = {
    schemaVersion: CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1,
    declarationId: input.declarationId,
    tenantId: release.tenantId,
    workspaceId: release.workspaceId,
    projectId: release.projectId,
    adapterId: release.adapterId,
    readReleaseDigest: release.releaseDigest,
    coreAdapterContractVersion: "control-room-project-adapter/v1",
    command: CONTENT_BLOOMS_PLACEMENT_COMMAND_V1,
    sourceOperation: CONTENT_BLOOMS_PLACEMENT_SOURCE_OPERATION_V1,
    destination: CONTENT_BLOOMS_PLACEMENT_DESTINATION_V1,
    minimumRisk: "medium",
    requiredFactor: "strong",
    commandSchemaDigest: input.commandSchemaDigest,
    sourceReceiptSchemaDigest: input.sourceReceiptSchemaDigest,
    conformanceEvidenceDigest: input.conformanceEvidenceDigest,
    acceptanceProfileDigest: input.acceptanceProfileDigest,
    acceptedReviewDigest: input.acceptedReviewDigest,
    completionSnapshotDigest: input.completionSnapshotDigest,
    producerIdentityDigest: input.producerIdentityDigest,
    reviewerIdentityDigest: input.reviewerIdentityDigest,
    reviewedAndAccepted: true,
    acceptedAt: input.acceptedAt,
    sourceIdempotencyContract: "stable_key_echo_required",
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    requestChangesPreferenceOnly: true,
    controlRoomMayAssign: false,
    controlRoomMayLease: false,
    controlRoomMayMutateSourceDirectly: false,
    requiresStrongApproval: true,
    requiresSeparateNodeAttestation: true,
    requiresDurableEffectClaim: true,
    requiresPreEffectMarker: true,
    requiresCurrentLifecycleMatch: true,
    retryFromAmbiguityAllowed: false,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(placementDeclarationSchemaV1, {
    ...unsigned,
    declarationDigest: sha256Digest(unsigned),
  }) as ContentBloomsPlacementDeclarationV1;
}

export function parseContentBloomsPlacementDeclarationV1(value: unknown): ContentBloomsPlacementDeclarationV1 {
  const declaration = parseExactContentBloomsV1(placementDeclarationSchemaV1, value) as ContentBloomsPlacementDeclarationV1;
  if (sha256Digest(withoutDeclarationDigest(declaration)) !== declaration.declarationDigest) {
    throw new ContentBloomsContractErrorV1("release_untrusted");
  }
  return declaration;
}

export function buildContentBloomsPlacementRequestV1(inputValue: unknown): ContentBloomsPlacementRequestV1 {
  const input = parseExactContentBloomsV1(placementRequestInputSchemaV1, inputValue);
  const declaration = parseContentBloomsPlacementDeclarationV1(input.declaration);
  const release = parseContentBloomsAdapterReleaseV1(input.readRelease);
  const state = parseContentBloomsControlStateV1(input.controlState);
  const workItem = parseContentBloomsOperationalRecordV1(input.workItem);
  const comparison = parseContentBloomsRouteComparisonV1(input.routeComparison);
  const route = parseContentBloomsTranscriptionRouteObservationV1(input.selectedRoute);
  if (![release, state, workItem, comparison, route].every((value) => sameScope(declaration, value))) {
    throw new ContentBloomsContractErrorV1("scope_mismatch");
  }
  if (declaration.readReleaseDigest !== release.releaseDigest || state.activeReleaseDigest !== release.releaseDigest) {
    throw new ContentBloomsContractErrorV1("release_untrusted");
  }
  if (state.status !== "enabled" || !state.readsEligible) throw new ContentBloomsContractErrorV1("adapter_disabled");
  if (workItem.kind !== "work_item" || workItem.operation !== "upsert"
    || (workItem.projection as { requiredCapability?: string }).requiredCapability !== "transcription:whisper") {
    throw new ContentBloomsContractErrorV1("authority_conflation");
  }
  if (comparison.workItemSourceRecordId !== workItem.sourceRecordId
    || comparison.workItemRecordDigest !== workItem.recordDigest
    || !comparison.consideredRouteDigests.includes(route.routeDigest)) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  const eligible = comparison.eligibleRoutes.find((candidate) => candidate.routeId === route.routeId);
  if (!eligible || eligible.routeDigest !== route.routeDigest || route.verification !== "verified" || route.state === "offline") {
    throw new ContentBloomsContractErrorV1("authority_conflation");
  }
  if (![release.acceptedAt,declaration.acceptedAt,state.updatedAt,workItem.observedAt,comparison.comparedAt,route.observedAt]
    .every((time) => before(input.requestedAt, time))) {
    throw new ContentBloomsContractErrorV1("sequence_invalid");
  }
  if (Date.parse(input.expiresAt) <= Date.parse(input.requestedAt)
    || Date.parse(input.expiresAt) > Date.parse(route.validUntil)) {
    throw new ContentBloomsContractErrorV1("request_expired");
  }
  const lifecycleDigest = contentBloomsControlLifecycleDigestV1(state);
  const base = {
    schemaVersion: CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1,
    requestId: input.requestId,
    tenantId: declaration.tenantId,
    workspaceId: declaration.workspaceId,
    projectId: declaration.projectId,
    adapterId: declaration.adapterId,
    declarationDigest: declaration.declarationDigest,
    readReleaseDigest: release.releaseDigest,
    controlStateDigest: state.stateDigest,
    controlLifecycleRevision: state.lifecycleRevision,
    controlLifecycleDigest: lifecycleDigest,
    jobId: input.jobId,
    attemptId: input.attemptId,
    effectIntentId: input.effectIntentId,
    workItemSourceRecordId: workItem.sourceRecordId,
    expectedSourceVersion: workItem.sourceVersion,
    expectedSourceChecksum: workItem.sourceChecksum,
    expectedWorkItemRecordDigest: workItem.recordDigest,
    routeComparisonDigest: comparison.comparisonDigest,
    selectedRouteId: route.routeId,
    selectedRouteDigest: route.routeDigest,
    routeValidUntil: route.validUntil,
    reasonCode: input.reasonCode,
    requestedByActorDigest: input.requestedByActorDigest,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
    command: CONTENT_BLOOMS_PLACEMENT_COMMAND_V1,
    sourceOperation: CONTENT_BLOOMS_PLACEMENT_SOURCE_OPERATION_V1,
    destination: CONTENT_BLOOMS_PLACEMENT_DESTINATION_V1,
    risk: "medium" as const,
    requiredFactor: "strong" as const,
  };
  const idempotencyKey = placementIdempotencyKey(base);
  const operationDigest = placementOperationDigest({ ...base, idempotencyKey });
  const unsigned: Omit<ContentBloomsPlacementRequestV1, "requestDigest"> = {
    ...base,
    idempotencyKey,
    operationDigest,
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    preferenceRequestOnly: true,
    controlRoomMayAssign: false,
    controlRoomMayLease: false,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(placementRequestSchemaV1, {
    ...unsigned,
    requestDigest: sha256Digest(unsigned),
  }) as ContentBloomsPlacementRequestV1;
}

export function parseContentBloomsPlacementRequestV1(value: unknown): ContentBloomsPlacementRequestV1 {
  const request = parseExactContentBloomsV1(placementRequestSchemaV1, value) as ContentBloomsPlacementRequestV1;
  if (Date.parse(request.expiresAt) <= Date.parse(request.requestedAt)
    || Date.parse(request.expiresAt) > Date.parse(request.routeValidUntil)
    || placementIdempotencyKey(request) !== request.idempotencyKey
    || placementOperationDigest(request) !== request.operationDigest
    || sha256Digest(withoutRequestDigest(request)) !== request.requestDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return request;
}

export function requireExactContentBloomsPlacementRequestReplayV1(
  existingValue: unknown,
  candidateValue: unknown,
): ContentBloomsPlacementRequestV1 {
  const existing = parseContentBloomsPlacementRequestV1(existingValue);
  const candidate = parseContentBloomsPlacementRequestV1(candidateValue);
  if (existing.requestId !== candidate.requestId && existing.idempotencyKey !== candidate.idempotencyKey) {
    throw new ContentBloomsContractErrorV1("invalid_input");
  }
  if (existing.requestId !== candidate.requestId || existing.idempotencyKey !== candidate.idempotencyKey
    || existing.requestDigest !== candidate.requestDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return existing;
}

export function buildContentBloomsPlacementAuthorizationV1(inputValue: unknown): ContentBloomsPlacementAuthorizationV1 {
  const input = parseExactContentBloomsV1(placementAuthorizationInputSchemaV1, inputValue);
  const request = parseContentBloomsPlacementRequestV1(input.request);
  const approvalRequest = parseExactContentBloomsV1(
    consequentialApprovalRequestSchemaV1,
    input.approvalRequest,
  ) as ConsequentialApprovalRequestV1;
  const approvalDecision = parseExactContentBloomsV1(
    consequentialApprovalDecisionSchemaV1,
    input.approvalDecision,
  ) as ConsequentialApprovalDecisionV1;
  if (approvalRequest.tenantId !== request.tenantId || approvalRequest.projectId !== request.projectId
    || approvalRequest.jobId !== request.jobId || approvalRequest.attemptId !== request.attemptId
    || approvalRequest.effectIntentId !== request.effectIntentId
    || approvalRequest.operationDigest !== request.operationDigest || approvalRequest.risk !== request.risk
    || approvalRequest.requiredFactor !== "strong" || approvalRequest.grantsExecutionAuthority !== false) {
    throw new ContentBloomsContractErrorV1("approval_required");
  }
  if (Date.parse(approvalRequest.requestedAt) < Date.parse(request.requestedAt)
    || Date.parse(approvalRequest.requestedAt) >= Date.parse(request.expiresAt)
    || Date.parse(approvalRequest.expiresAt) > Date.parse(request.expiresAt)) {
    throw new ContentBloomsContractErrorV1("request_expired");
  }
  if (approvalDecision.tenantId !== request.tenantId || approvalDecision.projectId !== request.projectId
    || approvalDecision.requestId !== approvalRequest.id
    || approvalDecision.requestDigest !== sha256Digest(approvalRequest)
    || approvalDecision.operationDigest !== request.operationDigest
    || approvalDecision.factor !== "strong" || approvalDecision.decidedBy.actorType !== "human"
    || !approvalDecision.requiresSeparateNodeAttestation || approvalDecision.grantsExecutionAuthority !== false) {
    throw new ContentBloomsContractErrorV1("approval_required");
  }
  if (approvalDecision.decision !== "approved") throw new ContentBloomsContractErrorV1("approval_denied");
  if (Date.parse(approvalDecision.decidedAt) < Date.parse(approvalRequest.requestedAt)
    || Date.parse(approvalDecision.decidedAt) >= Date.parse(approvalRequest.expiresAt)
    || Date.parse(approvalDecision.decidedAt) >= Date.parse(request.expiresAt)
    || Date.parse(approvalDecision.expiresAt) > Date.parse(approvalRequest.expiresAt)
    || Date.parse(approvalDecision.expiresAt) > Date.parse(request.expiresAt)) {
    throw new ContentBloomsContractErrorV1("request_expired");
  }
  const approvalRequestDigest = sha256Digest(approvalRequest);
  const approvalDecisionDigest = sha256Digest(approvalDecision);
  const unsigned: Omit<ContentBloomsPlacementAuthorizationV1, "authorizationDigest"> = {
    schemaVersion: CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1,
    authorizationId: `cb-placement-auth:${sha256Digest({ requestDigest: request.requestDigest, approvalDecisionDigest }).slice(7, 39)}`,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    adapterId: request.adapterId,
    declarationDigest: request.declarationDigest,
    readReleaseDigest: request.readReleaseDigest,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    jobId: request.jobId,
    attemptId: request.attemptId,
    effectIntentId: request.effectIntentId,
    operationDigest: request.operationDigest,
    idempotencyKey: request.idempotencyKey,
    approvalRequestId: approvalRequest.id,
    approvalRequestDigest,
    approvalDecisionId: approvalDecision.id,
    approvalDecisionDigest,
    approvalDecision: "approved",
    authorizedAt: approvalDecision.decidedAt,
    expiresAt: approvalDecision.expiresAt,
    approvalRecordsMustBeResolvedAuthoritatively: true,
    requiresCurrentLifecycleMatch: true,
    requiresSeparateNodeAttestation: true,
    requiresDurableEffectClaim: true,
    requiresPreEffectMarker: true,
    singleUse: true,
    sameEffectRetryAfterAmbiguityAllowed: false,
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    controlRoomMayAssign: false,
    controlRoomMayLease: false,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(placementAuthorizationSchemaV1, {
    ...unsigned,
    authorizationDigest: sha256Digest(unsigned),
  }) as ContentBloomsPlacementAuthorizationV1;
}

export function parseContentBloomsPlacementAuthorizationV1(value: unknown): ContentBloomsPlacementAuthorizationV1 {
  const authorization = parseExactContentBloomsV1(
    placementAuthorizationSchemaV1,
    value,
  ) as ContentBloomsPlacementAuthorizationV1;
  const expectedId = `cb-placement-auth:${sha256Digest({
    requestDigest: authorization.requestDigest,
    approvalDecisionDigest: authorization.approvalDecisionDigest,
  }).slice(7, 39)}`;
  if (authorization.authorizationId !== expectedId
    || Date.parse(authorization.expiresAt) <= Date.parse(authorization.authorizedAt)
    || sha256Digest(withoutAuthorizationDigest(authorization)) !== authorization.authorizationDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return authorization;
}

export function requireExactContentBloomsPlacementAuthorizationReplayV1(
  existingValue: unknown,
  candidateValue: unknown,
): ContentBloomsPlacementAuthorizationV1 {
  const existing = parseContentBloomsPlacementAuthorizationV1(existingValue);
  const candidate = parseContentBloomsPlacementAuthorizationV1(candidateValue);
  if (existing.authorizationId !== candidate.authorizationId) throw new ContentBloomsContractErrorV1("invalid_input");
  if (existing.authorizationDigest !== candidate.authorizationDigest) throw new ContentBloomsContractErrorV1("replay_drift");
  return existing;
}

export function assertContentBloomsPlacementPreDispatchV1(inputValue: unknown): {
  request: ContentBloomsPlacementRequestV1;
  authorization: ContentBloomsPlacementAuthorizationV1;
  declaration: ContentBloomsPlacementDeclarationV1;
  readRelease: ContentBloomsAdapterReleaseV1;
  controlState: ContentBloomsAdapterControlStateV1;
} {
  const input = parseExactContentBloomsV1(preDispatchInputSchemaV1, inputValue);
  const request = parseContentBloomsPlacementRequestV1(input.request);
  const authorization = parseContentBloomsPlacementAuthorizationV1(input.authorization);
  const declaration = parseContentBloomsPlacementDeclarationV1(input.declaration);
  const release = parseContentBloomsAdapterReleaseV1(input.readRelease);
  const state = parseContentBloomsControlStateV1(input.controlState);
  requireRequestAuthorizationBinding(request, authorization);
  if (![request,authorization,release,state].every((value) => sameScope(declaration, value))) {
    throw new ContentBloomsContractErrorV1("scope_mismatch");
  }
  if (declaration.declarationDigest !== request.declarationDigest
    || declaration.readReleaseDigest !== release.releaseDigest
    || request.readReleaseDigest !== release.releaseDigest) {
    throw new ContentBloomsContractErrorV1("release_untrusted");
  }
  if (state.status !== "enabled" || !state.readsEligible) throw new ContentBloomsContractErrorV1("adapter_disabled");
  if (state.activeReleaseDigest !== release.releaseDigest) throw new ContentBloomsContractErrorV1("release_untrusted");
  if (state.lifecycleRevision !== request.controlLifecycleRevision
    || contentBloomsControlLifecycleDigestV1(state) !== request.controlLifecycleDigest) {
    throw new ContentBloomsContractErrorV1("stale_state");
  }
  if (!before(input.checkedAt, authorization.authorizedAt)
    || Date.parse(input.checkedAt) >= Date.parse(authorization.expiresAt)
    || Date.parse(input.checkedAt) >= Date.parse(request.expiresAt)
    || Date.parse(input.checkedAt) >= Date.parse(request.routeValidUntil)) {
    throw new ContentBloomsContractErrorV1("request_expired");
  }
  return { request, authorization, declaration, readRelease: release, controlState: state };
}

export function buildContentBloomsPlacementSourceReceiptV1(inputValue: unknown): ContentBloomsPlacementSourceReceiptV1 {
  const input = parseExactContentBloomsV1(placementSourceReceiptInputSchemaV1, inputValue);
  const request = parseContentBloomsPlacementRequestV1(input.request);
  const authorization = parseContentBloomsPlacementAuthorizationV1(input.authorization);
  requireRequestAuthorizationBinding(request, authorization);
  requireDispatchChronology(request, authorization, input.dispatchedAt);
  if (input.sourceIdempotencyKey !== request.idempotencyKey) {
    throw new ContentBloomsContractErrorV1("source_receipt_invalid");
  }
  if (new Set([
    input.dispatchClaimDigest,
    input.preEffectMarkerDigest,
    input.authenticatedTransportEvidenceDigest,
  ]).size !== 3) throw new ContentBloomsContractErrorV1("source_receipt_invalid");
  if (!before(input.sourceObservedAt, input.dispatchedAt) || !before(input.receivedAt, input.sourceObservedAt)) {
    throw new ContentBloomsContractErrorV1("sequence_invalid");
  }
  const accepted = input.disposition === "accepted" || input.disposition === "already_applied";
  if (accepted !== (input.appliedSourceVersion !== undefined)
    || accepted !== (input.sourceCommandId !== undefined)
    || accepted === (input.safeReasonCode !== undefined)
    || (input.disposition === "accepted" && input.appliedSourceVersion === request.expectedSourceVersion)
    || (input.safeReasonCode === "stale_source_version") !== (input.observedSourceVersionDigest !== undefined)) {
    throw new ContentBloomsContractErrorV1("source_receipt_invalid");
  }
  const unsigned: Omit<ContentBloomsPlacementSourceReceiptV1, "receiptDigest"> = {
    schemaVersion: CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1,
    receiptId: `cb-placement-source:${sha256Digest({ requestDigest: request.requestDigest, sourceReceiptId: input.sourceReceiptId }).slice(7, 39)}`,
    sourceReceiptId: input.sourceReceiptId,
    ...(input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId }),
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    adapterId: request.adapterId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    authorizationId: authorization.authorizationId,
    authorizationDigest: authorization.authorizationDigest,
    declarationDigest: request.declarationDigest,
    readReleaseDigest: request.readReleaseDigest,
    operationDigest: request.operationDigest,
    idempotencyKey: request.idempotencyKey,
    sourceIdempotencyKey: input.sourceIdempotencyKey,
    workItemSourceRecordId: request.workItemSourceRecordId,
    expectedSourceVersion: request.expectedSourceVersion,
    selectedRouteId: request.selectedRouteId,
    selectedRouteDigest: request.selectedRouteDigest,
    disposition: input.disposition,
    preferenceRecorded: accepted,
    ...(input.appliedSourceVersion === undefined ? {} : { appliedSourceVersion: input.appliedSourceVersion }),
    ...(input.observedSourceVersionDigest === undefined ? {} : { observedSourceVersionDigest: input.observedSourceVersionDigest }),
    ...(input.safeReasonCode === undefined ? {} : { safeReasonCode: input.safeReasonCode }),
    dispatchClaimDigest: input.dispatchClaimDigest,
    preEffectMarkerDigest: input.preEffectMarkerDigest,
    authenticatedTransportEvidenceDigest: input.authenticatedTransportEvidenceDigest,
    authorizedAt: authorization.authorizedAt,
    authorizationExpiresAt: authorization.expiresAt,
    requestExpiresAt: request.expiresAt,
    routeValidUntil: request.routeValidUntil,
    dispatchedAt: input.dispatchedAt,
    sourceObservedAt: input.sourceObservedAt,
    receivedAt: input.receivedAt,
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    controlRoomMayAssign: false,
    controlRoomMayLease: false,
    sameEffectRetryProhibited: true,
    requiresSourceReconciliation: false,
    requestAndAuthorizationMustBeResolvedAuthoritatively: true,
    claimAndMarkerMustBeResolvedDurably: true,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(placementSourceReceiptSchemaV1, {
    ...unsigned,
    receiptDigest: sha256Digest(unsigned),
  }) as ContentBloomsPlacementSourceReceiptV1;
}

export function parseContentBloomsPlacementSourceReceiptV1(value: unknown): ContentBloomsPlacementSourceReceiptV1 {
  const receipt = parseExactContentBloomsV1(placementSourceReceiptSchemaV1, value) as ContentBloomsPlacementSourceReceiptV1;
  const accepted = receipt.disposition === "accepted" || receipt.disposition === "already_applied";
  const expectedId = `cb-placement-source:${sha256Digest({
    requestDigest: receipt.requestDigest,
    sourceReceiptId: receipt.sourceReceiptId,
  }).slice(7, 39)}`;
  if (receipt.receiptId !== expectedId || receipt.sourceIdempotencyKey !== receipt.idempotencyKey
    || new Set([
      receipt.dispatchClaimDigest,
      receipt.preEffectMarkerDigest,
      receipt.authenticatedTransportEvidenceDigest,
    ]).size !== 3
    || accepted !== receipt.preferenceRecorded
    || accepted !== (receipt.appliedSourceVersion !== undefined)
    || accepted !== (receipt.sourceCommandId !== undefined)
    || accepted === (receipt.safeReasonCode !== undefined)
    || (receipt.disposition === "accepted" && receipt.appliedSourceVersion === receipt.expectedSourceVersion)
    || (receipt.safeReasonCode === "stale_source_version") !== (receipt.observedSourceVersionDigest !== undefined)
    || !before(receipt.dispatchedAt, receipt.authorizedAt)
    || Date.parse(receipt.dispatchedAt) >= Date.parse(receipt.authorizationExpiresAt)
    || Date.parse(receipt.dispatchedAt) >= Date.parse(receipt.requestExpiresAt)
    || Date.parse(receipt.dispatchedAt) >= Date.parse(receipt.routeValidUntil)
    || !before(receipt.sourceObservedAt, receipt.dispatchedAt)
    || !before(receipt.receivedAt, receipt.sourceObservedAt)
    || sha256Digest(withoutSourceReceiptDigest(receipt)) !== receipt.receiptDigest) {
    throw new ContentBloomsContractErrorV1("source_receipt_invalid");
  }
  return receipt;
}

export function buildContentBloomsPlacementAmbiguityReceiptV1(inputValue: unknown): ContentBloomsPlacementAmbiguityReceiptV1 {
  const input = parseExactContentBloomsV1(placementAmbiguityInputSchemaV1, inputValue);
  const request = parseContentBloomsPlacementRequestV1(input.request);
  const authorization = parseContentBloomsPlacementAuthorizationV1(input.authorization);
  requireRequestAuthorizationBinding(request, authorization);
  requireDispatchChronology(request, authorization, input.dispatchedAt);
  if (new Set([
    input.dispatchClaimDigest,
    input.preEffectMarkerDigest,
    input.ambiguityEvidenceDigest,
  ]).size !== 3) throw new ContentBloomsContractErrorV1("effect_ambiguous");
  if (!before(input.raisedAt, input.dispatchedAt)) throw new ContentBloomsContractErrorV1("sequence_invalid");
  const unsigned: Omit<ContentBloomsPlacementAmbiguityReceiptV1, "receiptDigest"> = {
    schemaVersion: CONTENT_BLOOMS_PLACEMENT_CONTRACT_V1,
    receiptId: `cb-placement-ambiguous:${sha256Digest({
      requestDigest: request.requestDigest,
      dispatchClaimDigest: input.dispatchClaimDigest,
      preEffectMarkerDigest: input.preEffectMarkerDigest,
    }).slice(7, 39)}`,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    adapterId: request.adapterId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    authorizationId: authorization.authorizationId,
    authorizationDigest: authorization.authorizationDigest,
    declarationDigest: request.declarationDigest,
    readReleaseDigest: request.readReleaseDigest,
    operationDigest: request.operationDigest,
    idempotencyKey: request.idempotencyKey,
    dispatchClaimDigest: input.dispatchClaimDigest,
    preEffectMarkerDigest: input.preEffectMarkerDigest,
    ambiguityEvidenceDigest: input.ambiguityEvidenceDigest,
    authorizedAt: authorization.authorizedAt,
    authorizationExpiresAt: authorization.expiresAt,
    requestExpiresAt: request.expiresAt,
    routeValidUntil: request.routeValidUntil,
    dispatchedAt: input.dispatchedAt,
    raisedAt: input.raisedAt,
    disposition: "ambiguous",
    sourceReceiptObserved: false,
    sameEffectRetryProhibited: true,
    requiresSourceReconciliation: true,
    newAuthorizationRequiredForAnyNewEffect: true,
    requestAndAuthorizationMustBeResolvedAuthoritatively: true,
    claimAndMarkerMustBeResolvedDurably: true,
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    controlRoomMayAssign: false,
    controlRoomMayLease: false,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(placementAmbiguitySchemaV1, {
    ...unsigned,
    receiptDigest: sha256Digest(unsigned),
  }) as ContentBloomsPlacementAmbiguityReceiptV1;
}

export function parseContentBloomsPlacementAmbiguityReceiptV1(value: unknown): ContentBloomsPlacementAmbiguityReceiptV1 {
  const receipt = parseExactContentBloomsV1(placementAmbiguitySchemaV1, value) as ContentBloomsPlacementAmbiguityReceiptV1;
  const expectedId = `cb-placement-ambiguous:${sha256Digest({
    requestDigest: receipt.requestDigest,
    dispatchClaimDigest: receipt.dispatchClaimDigest,
    preEffectMarkerDigest: receipt.preEffectMarkerDigest,
  }).slice(7, 39)}`;
  if (receipt.receiptId !== expectedId
    || new Set([
      receipt.dispatchClaimDigest,
      receipt.preEffectMarkerDigest,
      receipt.ambiguityEvidenceDigest,
    ]).size !== 3
    || !before(receipt.dispatchedAt, receipt.authorizedAt)
    || Date.parse(receipt.dispatchedAt) >= Date.parse(receipt.authorizationExpiresAt)
    || Date.parse(receipt.dispatchedAt) >= Date.parse(receipt.requestExpiresAt)
    || Date.parse(receipt.dispatchedAt) >= Date.parse(receipt.routeValidUntil)
    || !before(receipt.raisedAt, receipt.dispatchedAt)
    || sha256Digest(withoutAmbiguityDigest(receipt)) !== receipt.receiptDigest) {
    throw new ContentBloomsContractErrorV1("effect_ambiguous");
  }
  return receipt;
}

export function parseContentBloomsPlacementOutcomeReceiptV1(value: unknown): ContentBloomsPlacementOutcomeReceiptV1 {
  const candidate = parseExactContentBloomsV1(z.union([
    placementSourceReceiptSchemaV1,
    placementAmbiguitySchemaV1,
  ]), value) as ContentBloomsPlacementOutcomeReceiptV1;
  return candidate.disposition === "ambiguous"
    ? parseContentBloomsPlacementAmbiguityReceiptV1(candidate)
    : parseContentBloomsPlacementSourceReceiptV1(candidate);
}

export function assertContentBloomsPlacementOutcomeBindingV1(inputValue: unknown): ContentBloomsPlacementOutcomeReceiptV1 {
  const input = parseExactContentBloomsV1(outcomeBindingInputSchemaV1, inputValue);
  const request = parseContentBloomsPlacementRequestV1(input.request);
  const authorization = parseContentBloomsPlacementAuthorizationV1(input.authorization);
  const outcome = parseContentBloomsPlacementOutcomeReceiptV1(input.outcome);
  requireRequestAuthorizationBinding(request, authorization);
  if (!sameScope(request, outcome)
    || outcome.requestId !== request.requestId || outcome.requestDigest !== request.requestDigest
    || outcome.authorizationId !== authorization.authorizationId
    || outcome.authorizationDigest !== authorization.authorizationDigest
    || outcome.declarationDigest !== request.declarationDigest
    || outcome.readReleaseDigest !== request.readReleaseDigest
    || outcome.operationDigest !== request.operationDigest
    || outcome.idempotencyKey !== request.idempotencyKey
    || outcome.authorizedAt !== authorization.authorizedAt
    || outcome.authorizationExpiresAt !== authorization.expiresAt
    || outcome.requestExpiresAt !== request.expiresAt
    || outcome.routeValidUntil !== request.routeValidUntil) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return outcome;
}

export function requireExactContentBloomsPlacementOutcomeReplayV1(
  existingValue: unknown,
  candidateValue: unknown,
): ContentBloomsPlacementOutcomeReceiptV1 {
  const existing = parseContentBloomsPlacementOutcomeReceiptV1(existingValue);
  const candidate = parseContentBloomsPlacementOutcomeReceiptV1(candidateValue);
  if (existing.requestId !== candidate.requestId || existing.authorizationId !== candidate.authorizationId) {
    throw new ContentBloomsContractErrorV1("invalid_input");
  }
  if (existing.receiptId !== candidate.receiptId || existing.receiptDigest !== candidate.receiptDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return existing;
}
