import { z } from "zod";
import {
  readyFrontierAuthTagSchemaV1,
  readyFrontierCandidateSchemaV1,
  readyFrontierCanonicalWorkSchemaV1,
  readyFrontierDependencyTruthSchemaV1,
  readyFrontierDigestSchemaV1,
  readyFrontierIdSchemaV1,
  readyFrontierProjectSourceSchemaV1,
  readyFrontierReasonCodeSchemaV1,
  readyFrontierRouteSourceSchemaV1,
  readyFrontierSafeCodeSchemaV1,
  readyFrontierTimeSchemaV1,
} from "./schemas";
import {
  READY_FRONTIER_CANONICAL_READ_V1,
  READY_FRONTIER_CYCLE_PROJECTION_V1,
  READY_FRONTIER_MANUAL_CYCLE_REQUEST_V1,
  READY_FRONTIER_MANUAL_CYCLE_RESULT_V1,
} from "./integration-types";
import { READY_FRONTIER_RESOURCE_CEILINGS_V1, readyFrontierPlatformsV1, readyFrontierRiskClassesV1 } from "./types";

const projectIds = z.array(readyFrontierIdSchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProjects);
const revision = z.number().int().min(1).max(2_147_483_647);
const count = z.number().int().min(0).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates);
const canonicalBase = {
  schema: z.literal(READY_FRONTIER_CANONICAL_READ_V1),
  readGroupId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  revision,
  observedAt: readyFrontierTimeSchemaV1,
  projectIds,
  retainsRawInputContent: z.literal(false),
  retainsUsableAccessData: z.literal(false),
  retainsPrivateLocators: z.literal(false),
  payloadDigest: readyFrontierDigestSchemaV1,
  readDigest: readyFrontierDigestSchemaV1,
  readAuthTag: readyFrontierAuthTagSchemaV1,
};

const candidateRead = readyFrontierCandidateSchemaV1.omit({ reviewTruth: true, blockerCodes: true });
const attention = z.object({
  candidateId: readyFrontierIdSchemaV1,
  projectId: readyFrontierIdSchemaV1,
  reviewTruth: z.enum(["not_required", "accepted", "pending", "rejected"]),
  blockerCodes: z.array(readyFrontierSafeCodeSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxBlockers),
  observedAt: readyFrontierTimeSchemaV1,
  evidenceDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierCanonicalReadSchemaV1 = z.discriminatedUnion("channel", [
  z.object({ ...canonicalBase, channel: z.literal("projects"), payload: z.object({
    projects: z.array(readyFrontierProjectSourceSchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProjects),
  }).strict() }).strict(),
  z.object({ ...canonicalBase, channel: z.literal("work"), payload: z.object({
    candidates: z.array(candidateRead).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
    canonicalWork: z.array(readyFrontierCanonicalWorkSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
    dependencyTruth: z.array(readyFrontierDependencyTruthSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  }).strict() }).strict(),
  z.object({ ...canonicalBase, channel: z.literal("attention"), payload: z.object({
    attention: z.array(attention).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  }).strict() }).strict(),
  z.object({ ...canonicalBase, channel: z.literal("capacity"), payload: z.object({
    routes: z.array(readyFrontierRouteSourceSchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxRoutes),
  }).strict() }).strict(),
]);

export const readyFrontierManualCycleRequestSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_MANUAL_CYCLE_REQUEST_V1),
  requestId: readyFrontierIdSchemaV1,
  cycleId: readyFrontierIdSchemaV1,
  readGroupId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  sourceRevision: revision,
  historyRevision: z.number().int().min(0).max(2_147_483_647),
  sourceObservedAt: readyFrontierTimeSchemaV1,
  evaluatedAt: readyFrontierTimeSchemaV1,
  projectIds,
  manualTrigger: z.literal(true),
  scheduleId: z.null(),
  permitsAutomaticRun: z.literal(false),
  permitsCanonicalWorkCreation: z.literal(false),
  permitsApproval: z.literal(false),
  permitsReadyTransition: z.literal(false),
  permitsClaimOrLease: z.literal(false),
  permitsDispatchOrExecution: z.literal(false),
  permitsProviderContact: z.literal(false),
  permitsExternalEffects: z.literal(false),
}).strict();

export const readyFrontierManualCycleResultSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_MANUAL_CYCLE_RESULT_V1),
  requestId: readyFrontierIdSchemaV1,
  cycleId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  sourceDigest: readyFrontierDigestSchemaV1,
  evaluationDigest: readyFrontierDigestSchemaV1,
  projectionDigest: readyFrontierDigestSchemaV1,
  replayed: z.boolean(),
  proposalCount: count,
  evaluatedAt: readyFrontierTimeSchemaV1,
  manualTrigger: z.literal(true),
  scheduled: z.literal(false),
  createdCanonicalWork: z.literal(false),
  grantedApproval: z.literal(false),
  grantedReadyTransition: z.literal(false),
  createdClaimOrLease: z.literal(false),
  dispatchedOrExecuted: z.literal(false),
  contactedProvider: z.literal(false),
  performedExternalEffect: z.literal(false),
  resultDigest: readyFrontierDigestSchemaV1,
}).strict();

const gateItem = z.object({
  itemId: readyFrontierIdSchemaV1,
  outcome: z.enum(["blocked", "needs_review", "duplicate_suppressed", "deferred_capacity", "deferred_policy"]),
  label: z.string().min(1).max(96),
  reasonCodes: z.array(readyFrontierReasonCodeSchemaV1).min(1).max(8),
}).strict();

const proposalItem = z.object({
  itemId: readyFrontierIdSchemaV1,
  proposalId: readyFrontierIdSchemaV1,
  title: z.string().min(1).max(160),
  routeId: readyFrontierIdSchemaV1,
  platform: z.enum(readyFrontierPlatformsV1),
  risk: z.enum(readyFrontierRiskClassesV1),
  estimatedCostMicrousd: z.number().int().min(0).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCostMicrousd),
  priority: z.number().int().min(0).max(100),
  rank: z.number().int().min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalsPerCycle),
  ownerReviewState: z.literal("required_not_requested"),
  reasonCodes: z.array(readyFrontierReasonCodeSchemaV1).min(1).max(8),
}).strict();

export const readyFrontierCycleProjectionSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_CYCLE_PROJECTION_V1),
  cycleId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  sourceSnapshotId: readyFrontierIdSchemaV1,
  evaluatedAt: readyFrontierTimeSchemaV1,
  projects: z.array(z.object({
    projectId: readyFrontierIdSchemaV1,
    proposed: z.array(proposalItem).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalsPerProject),
    blocked: z.array(gateItem).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
    needsReview: z.array(gateItem).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
    deferred: z.array(gateItem).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
    suppressedCount: count,
  }).strict()).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProjects),
  proposalCount: count,
  blockedCount: count,
  needsReviewCount: count,
  deferredCount: count,
  suppressedCount: count,
  proposalOnly: z.literal(true),
  ownerReviewRequired: z.literal(true),
  canMaterializeCanonicalWork: z.literal(false),
  canApprove: z.literal(false),
  canReady: z.literal(false),
  canClaimOrLease: z.literal(false),
  canDispatchOrExecute: z.literal(false),
  canContactProvider: z.literal(false),
  canPerformExternalEffect: z.literal(false),
  projectionDigest: readyFrontierDigestSchemaV1,
}).strict();
