import { z } from "zod";
import {
  CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
  CONTENT_BLOOMS_AUTHORITY_MODE_V1,
  CONTENT_BLOOMS_READ_OPERATIONS_V1,
  CONTENT_BLOOMS_SOURCE_SYSTEM_V1,
} from "./types";

export const contentBloomsDigestSchemaV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const contentBloomsTimeSchemaV1 = z.string().datetime({ offset: true });
export const contentBloomsSafeIdSchemaV1 = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const safeCode = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const boundedLabel = z.string().min(1).max(180);
const boundedSummary = z.string().min(1).max(500);
const sourceVersion = z.string().min(1).max(180).refine(
  (value) => [...value].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f),
  "source version contains a control character",
);
const cursor = z.string().min(1).max(512).refine(
  (value) => [...value].every((character) => character.charCodeAt(0) >= 0x21 && character.charCodeAt(0) <= 0x7e),
  "cursor must be bounded visible ASCII",
);
const percentage = z.number().min(0).max(100);
const relativeDeepLink = z.string().min(1).max(500).refine((value) => {
  if (!value.startsWith("/") || value.startsWith("//") || /[?#%\\]/.test(value)) return false;
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}, "deep link must be a safe relative source path");

const normalizedState = z.enum([
  "planned", "ready", "running", "waiting", "blocked", "needs_attention", "review", "complete", "failed", "cancelled",
]);

export const contentBloomsProjectProjectionSchemaV1 = z.object({
  title: boundedLabel,
  normalizedState,
  domainState: safeCode,
  health: z.enum(["healthy", "watch", "at_risk", "blocked"]),
  progressPercent: percentage.optional(),
  forecastAt: contentBloomsTimeSchemaV1.optional(),
  attentionCount: z.number().int().min(0).max(100_000),
  blockerCount: z.number().int().min(0).max(100_000),
  priority: z.number().int().min(0).max(100),
  deepLinkPath: relativeDeepLink.optional(),
}).strict();

export const contentBloomsWorkItemProjectionSchemaV1 = z.object({
  title: boundedLabel,
  normalizedState,
  domainState: safeCode,
  priority: z.number().int().min(0).max(100),
  progressPercent: percentage.optional(),
  requiredCapability: safeCode.optional(),
  allowedRouteIds: z.array(contentBloomsSafeIdSchemaV1).max(32).optional(),
  blockedBySourceRecordIds: z.array(contentBloomsSafeIdSchemaV1).max(100).optional(),
  downstreamUnlockCount: z.number().int().min(0).max(100_000).optional(),
  createdAt: contentBloomsTimeSchemaV1,
  updatedAt: contentBloomsTimeSchemaV1,
  deepLinkPath: relativeDeepLink.optional(),
}).strict();

export const contentBloomsExecutionProjectionSchemaV1 = z.object({
  workItemSourceRecordId: contentBloomsSafeIdSchemaV1,
  attempt: z.number().int().positive().max(1_000_000),
  state: z.enum(["queued", "leased", "running", "paused", "succeeded", "failed"]),
  routeId: contentBloomsSafeIdSchemaV1.optional(),
  progressPercent: percentage.optional(),
  sourceLeaseOwnerDigest: contentBloomsDigestSchemaV1.optional(),
  sourceLeaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  leaseObservedAt: contentBloomsTimeSchemaV1.optional(),
  startedAt: contentBloomsTimeSchemaV1.optional(),
  finishedAt: contentBloomsTimeSchemaV1.optional(),
  safeFailureCode: safeCode.optional(),
}).strict().superRefine((value, context) => {
  const leased = value.state === "leased" || value.state === "running" || value.state === "paused";
  const completeLease = value.sourceLeaseOwnerDigest !== undefined
    && value.sourceLeaseEpoch !== undefined
    && value.leaseObservedAt !== undefined;
  if (leased !== completeLease) context.addIssue({ code: "custom", message: "source lease evidence must be complete exactly while source work is leased" });
  if (value.finishedAt && !value.startedAt) context.addIssue({ code: "custom", message: "finished execution requires startedAt" });
});

export const contentBloomsBlockerProjectionSchemaV1 = z.object({
  workItemSourceRecordId: contentBloomsSafeIdSchemaV1.optional(),
  blockerType: safeCode,
  title: boundedLabel,
  severity: z.enum(["info", "warning", "critical"]),
  responsibleRole: z.enum(["system", "operator", "customer", "project", "provider"]),
  safeRemedy: boundedSummary.optional(),
  openedAt: contentBloomsTimeSchemaV1,
  deepLinkPath: relativeDeepLink.optional(),
}).strict();

export const contentBloomsWorkerProjectionSchemaV1 = z.object({
  workerRefDigest: contentBloomsDigestSchemaV1,
  displayLabel: z.string().min(1).max(120),
  platform: z.enum(["windows", "macos", "linux", "cloud"]),
  state: z.enum(["online", "idle", "busy", "draining", "degraded", "offline", "maintenance"]),
  routeIds: z.array(contentBloomsSafeIdSchemaV1).max(64),
  observedAt: contentBloomsTimeSchemaV1,
}).strict();

export const contentBloomsAttentionProjectionSchemaV1 = z.object({
  workItemSourceRecordId: contentBloomsSafeIdSchemaV1.optional(),
  attentionType: z.enum(["approval", "question", "review", "decision"]),
  title: boundedLabel,
  summary: boundedSummary,
  dueAt: contentBloomsTimeSchemaV1.optional(),
  createdAt: contentBloomsTimeSchemaV1,
  deepLinkPath: relativeDeepLink.optional(),
}).strict();

export const contentBloomsProjectionSchemasByKindV1 = {
  project: contentBloomsProjectProjectionSchemaV1,
  work_item: contentBloomsWorkItemProjectionSchemaV1,
  execution: contentBloomsExecutionProjectionSchemaV1,
  blocker: contentBloomsBlockerProjectionSchemaV1,
  worker: contentBloomsWorkerProjectionSchemaV1,
  attention: contentBloomsAttentionProjectionSchemaV1,
} as const;

export const contentBloomsOperationalRecordSchemaV1 = z.object({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  kind: z.enum(["project", "work_item", "execution", "blocker", "worker", "attention"]),
  operation: z.enum(["upsert", "remove"]),
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  sourceRecordId: contentBloomsSafeIdSchemaV1,
  sourceVersion,
  observedAt: contentBloomsTimeSchemaV1,
  projection: z.unknown().optional(),
  sourceChecksum: contentBloomsDigestSchemaV1,
  recordDigest: contentBloomsDigestSchemaV1,
}).strict().superRefine((value, context) => {
  if (value.operation === "upsert" && value.projection === undefined) {
    context.addIssue({ code: "custom", message: "upsert record requires a projection" });
  }
  if (value.operation === "remove" && value.projection !== undefined) {
    context.addIssue({ code: "custom", message: "remove record cannot carry a projection" });
  }
});

const exactReadOperations = z.tuple(CONTENT_BLOOMS_READ_OPERATIONS_V1.map((operation) => z.literal(operation)) as [
  z.ZodLiteral<"getProjectSummary">,
  z.ZodLiteral<"listWorkItems">,
  z.ZodLiteral<"listExecutions">,
  z.ZodLiteral<"listBlockers">,
  z.ZodLiteral<"listWorkers">,
  z.ZodLiteral<"listAttentionItems">,
  z.ZodLiteral<"readChanges">,
]);

export const contentBloomsAdapterReleaseSchemaV1 = z.object({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  releaseId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  sourceSystem: z.literal(CONTENT_BLOOMS_SOURCE_SYSTEM_V1),
  authorityMode: z.literal(CONTENT_BLOOMS_AUTHORITY_MODE_V1),
  coreAdapterContractVersion: z.literal("control-room-project-adapter/v1"),
  projectType: z.literal("content-operations"),
  supportedReadOperations: exactReadOperations,
  supportedCommands: z.tuple([]),
  redactionPolicyVersion: safeCode,
  adapterPackageDigest: contentBloomsDigestSchemaV1,
  projectionSchemaDigest: contentBloomsDigestSchemaV1,
  conformanceEvidenceDigest: contentBloomsDigestSchemaV1,
  acceptanceProfileDigest: contentBloomsDigestSchemaV1,
  acceptedReviewDigest: contentBloomsDigestSchemaV1,
  completionSnapshotDigest: contentBloomsDigestSchemaV1,
  producerIdentityDigest: contentBloomsDigestSchemaV1,
  reviewerIdentityDigest: contentBloomsDigestSchemaV1,
  reviewedAndAccepted: z.literal(true),
  acceptedAt: contentBloomsTimeSchemaV1,
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  sourceOwnsDomainTransitions: z.literal(true),
  controlRoomMayLease: z.literal(false),
  controlRoomMayMutateSource: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  releaseDigest: contentBloomsDigestSchemaV1,
}).strict().superRefine((value, context) => {
  if (value.producerIdentityDigest === value.reviewerIdentityDigest) {
    context.addIssue({ code: "custom", message: "adapter release requires producer-independent acceptance" });
  }
});

export const contentBloomsReadRequestSchemaV1 = z.object({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  requestId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  expectedReleaseDigest: contentBloomsDigestSchemaV1,
  operation: z.enum(CONTENT_BLOOMS_READ_OPERATIONS_V1),
  afterCursor: cursor.optional(),
  limit: z.number().int().min(1).max(100),
  requestedAt: contentBloomsTimeSchemaV1,
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  requestDigest: contentBloomsDigestSchemaV1,
}).strict().superRefine((value, context) => {
  if (value.operation === "getProjectSummary" && (value.afterCursor !== undefined || value.limit !== 1)) {
    context.addIssue({ code: "custom", message: "project summary is an unpaginated singleton read" });
  }
});

export const contentBloomsReadPageSchemaV1 = z.object({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  pageId: contentBloomsSafeIdSchemaV1,
  requestId: contentBloomsSafeIdSchemaV1,
  requestDigest: contentBloomsDigestSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  releaseDigest: contentBloomsDigestSchemaV1,
  operation: z.enum(CONTENT_BLOOMS_READ_OPERATIONS_V1),
  afterCursor: cursor.optional(),
  nextCursor: cursor,
  hasMore: z.boolean(),
  sourceSnapshotVersion: sourceVersion,
  sourceObservedAt: contentBloomsTimeSchemaV1,
  records: z.array(contentBloomsOperationalRecordSchemaV1).max(100),
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  sourceOwnsDomainTransitions: z.literal(true),
  controlRoomMayLease: z.literal(false),
  controlRoomMayMutateSource: z.literal(false),
  pageDigest: contentBloomsDigestSchemaV1,
}).strict();

export const contentBloomsReadReceiptSchemaV1 = z.object({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  receiptId: contentBloomsSafeIdSchemaV1,
  requestId: contentBloomsSafeIdSchemaV1,
  requestDigest: contentBloomsDigestSchemaV1,
  pageId: contentBloomsSafeIdSchemaV1,
  pageDigest: contentBloomsDigestSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  releaseDigest: contentBloomsDigestSchemaV1,
  controlStateDigest: contentBloomsDigestSchemaV1,
  operation: z.enum(CONTENT_BLOOMS_READ_OPERATIONS_V1),
  sourceSnapshotVersion: sourceVersion,
  nextCursorDigest: contentBloomsDigestSchemaV1,
  recordDigests: z.array(contentBloomsDigestSchemaV1).max(100),
  recordCount: z.number().int().min(0).max(100),
  sourceObservedAt: contentBloomsTimeSchemaV1,
  recordedAt: contentBloomsTimeSchemaV1,
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  sourceOwnsDomainTransitions: z.literal(true),
  controlRoomMayLease: z.literal(false),
  controlRoomMayMutateSource: z.literal(false),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  receiptDigest: contentBloomsDigestSchemaV1,
}).strict();

export const contentBloomsAdapterControlStateSchemaV1 = z.object({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  stateId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  lifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["disabled", "enabled"]),
  configuredReleaseDigest: contentBloomsDigestSchemaV1.optional(),
  activeReleaseDigest: contentBloomsDigestSchemaV1.optional(),
  previousReleaseDigests: z.array(contentBloomsDigestSchemaV1).max(50),
  lastCommittedCursorDigest: contentBloomsDigestSchemaV1.optional(),
  lastReadReceiptDigest: contentBloomsDigestSchemaV1.optional(),
  updatedAt: contentBloomsTimeSchemaV1,
  readsEligible: z.boolean(),
  commandsEnabled: z.literal(false),
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  sourceOwnsDomainTransitions: z.literal(true),
  controlRoomMayLease: z.literal(false),
  controlRoomMayMutateSource: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  stateDigest: contentBloomsDigestSchemaV1,
}).strict().superRefine((value, context) => {
  const enabled = value.status === "enabled";
  if (enabled !== value.readsEligible || enabled !== (value.activeReleaseDigest !== undefined)
    || (enabled && value.activeReleaseDigest !== value.configuredReleaseDigest)) {
    context.addIssue({ code: "custom", message: "enabled state, read eligibility, configured release, and active release must agree" });
  }
  if ((value.activeReleaseDigest && value.previousReleaseDigests.includes(value.activeReleaseDigest))
    || (value.configuredReleaseDigest && value.previousReleaseDigests.includes(value.configuredReleaseDigest))) {
    context.addIssue({ code: "custom", message: "configured release cannot also be previous" });
  }
});

export const contentBloomsControlTransitionSchemaV1 = z.object({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  transitionId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  action: z.enum(["enable_release", "disable", "rollback_release"]),
  expectedStateDigest: contentBloomsDigestSchemaV1,
  targetReleaseDigest: contentBloomsDigestSchemaV1.optional(),
  requestedByActorDigest: contentBloomsDigestSchemaV1,
  reasonCode: safeCode,
  requestedAt: contentBloomsTimeSchemaV1,
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  transitionDigest: contentBloomsDigestSchemaV1,
}).strict().superRefine((value, context) => {
  const requiresTarget = value.action === "enable_release" || value.action === "rollback_release";
  if (requiresTarget !== (value.targetReleaseDigest !== undefined)) {
    context.addIssue({ code: "custom", message: "transition target does not match action" });
  }
});

export const contentBloomsControlTransitionReceiptSchemaV1 = z.object({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  receiptId: contentBloomsSafeIdSchemaV1,
  transitionId: contentBloomsSafeIdSchemaV1,
  transitionDigest: contentBloomsDigestSchemaV1,
  action: z.enum(["enable_release", "disable", "rollback_release"]),
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  beforeStateDigest: contentBloomsDigestSchemaV1,
  afterStateDigest: contentBloomsDigestSchemaV1,
  beforeLifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  afterLifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  beforeLifecycleDigest: contentBloomsDigestSchemaV1,
  afterLifecycleDigest: contentBloomsDigestSchemaV1,
  configuredReleaseDigest: contentBloomsDigestSchemaV1.optional(),
  activeReleaseDigest: contentBloomsDigestSchemaV1.optional(),
  previousReleaseDigests: z.array(contentBloomsDigestSchemaV1).max(50),
  preservedCursorDigest: contentBloomsDigestSchemaV1.optional(),
  preservedReadReceiptDigest: contentBloomsDigestSchemaV1.optional(),
  appliedAt: contentBloomsTimeSchemaV1,
  status: z.literal("applied"),
  commandsEnabled: z.literal(false),
  controlRoomMayLease: z.literal(false),
  controlRoomMayMutateSource: z.literal(false),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  receiptDigest: contentBloomsDigestSchemaV1,
}).strict();
