import { z } from "zod";
import {
  READY_FRONTIER_EVALUATION_V1,
  READY_FRONTIER_OPERATOR_PROJECTION_V1,
  READY_FRONTIER_POLICY_V1,
  READY_FRONTIER_PROPOSAL_V1,
  READY_FRONTIER_RESOURCE_CEILINGS_V1,
  READY_FRONTIER_SOURCE_V1,
  readyFrontierPlatformsV1,
  readyFrontierRiskClassesV1,
} from "./types";

export const readyFrontierIdSchemaV1 = z.string().min(3).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/);
export const readyFrontierSafeCodeSchemaV1 = z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._:-]*$/);
export const readyFrontierDigestSchemaV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const readyFrontierAuthTagSchemaV1 = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
export const readyFrontierTimeSchemaV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }, "invalid canonical instant");
const label = z.string().min(1).max(160);
const objective = z.string().min(1).max(480);
const nonNegativeInt = z.number().int().min(0);
const boundedCost = nonNegativeInt.max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCostMicrousd);
const risk = z.enum(readyFrontierRiskClassesV1);
const platform = z.enum(readyFrontierPlatformsV1);

export const readyFrontierProjectSourceSchemaV1 = z.object({
  projectId: readyFrontierIdSchemaV1,
  goalDigest: readyFrontierDigestSchemaV1,
  state: z.enum(["active", "paused", "blocked", "complete"]),
  targetShareBps: nonNegativeInt.max(10_000),
  recentProposalShareBps: nonNegativeInt.max(10_000),
  outstandingProposalCount: nonNegativeInt.max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxOutstandingPerProject),
}).strict();

export const readyFrontierRouteSourceSchemaV1 = z.object({
  routeId: readyFrontierIdSchemaV1,
  state: z.enum(["available", "degraded", "unavailable"]),
  availableProposalSlots: nonNegativeInt.max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxRouteSlots),
  maximumRisk: risk,
  maximumCostMicrousd: boundedCost,
  supportedPlatforms: z.array(platform).min(1).max(readyFrontierPlatformsV1.length),
  observedAt: readyFrontierTimeSchemaV1,
  evidenceDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierDependencyTruthSchemaV1 = z.object({
  candidateId: readyFrontierIdSchemaV1,
  projectId: readyFrontierIdSchemaV1,
  state: z.enum(["satisfied", "blocked", "unknown"]),
  evidenceDigest: readyFrontierDigestSchemaV1,
  observedAt: readyFrontierTimeSchemaV1,
}).strict();

export const readyFrontierCandidateSchemaV1 = z.object({
  candidateId: readyFrontierIdSchemaV1,
  projectId: readyFrontierIdSchemaV1,
  intentDigest: readyFrontierDigestSchemaV1,
  sourceKind: z.enum(["project_goal", "dependency_gap", "blocker_followup", "review_followup", "recurring_maintenance"]),
  title: label,
  objective,
  routeId: readyFrontierIdSchemaV1,
  platform,
  requiredCapability: readyFrontierSafeCodeSchemaV1,
  risk,
  estimatedCostMicrousd: boundedCost,
  priority: nonNegativeInt.max(100),
  downstreamUnlockCount: nonNegativeInt.max(1_000),
  createdAt: readyFrontierTimeSchemaV1,
  deadlineAt: readyFrontierTimeSchemaV1.nullable(),
  dependencyCandidateIds: z.array(readyFrontierIdSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxDependencies),
  reviewTruth: z.enum(["not_required", "accepted", "pending", "rejected"]),
  blockerCodes: z.array(readyFrontierSafeCodeSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxBlockers),
  evidenceDigests: z.array(readyFrontierDigestSchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxEvidenceDigests),
}).strict();

export const readyFrontierCanonicalWorkSchemaV1 = z.object({
  workItemId: readyFrontierIdSchemaV1,
  projectId: readyFrontierIdSchemaV1,
  intentDigest: readyFrontierDigestSchemaV1,
  state: z.enum(["proposal_pending", "proposed", "ready", "leased", "running", "waiting_approval", "succeeded", "failed", "cancelled", "rejected"]),
  observedAt: readyFrontierTimeSchemaV1,
  evidenceDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierPriorProposalSchemaV1 = z.object({
  proposalId: readyFrontierIdSchemaV1,
  projectId: readyFrontierIdSchemaV1,
  intentDigest: readyFrontierDigestSchemaV1,
  state: z.enum(["open", "expired", "dismissed", "materialized"]),
  observedAt: readyFrontierTimeSchemaV1,
  evidenceDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierSourceSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_SOURCE_V1),
  tenantId: readyFrontierIdSchemaV1,
  snapshotId: readyFrontierIdSchemaV1,
  sourceRevision: z.number().int().min(1).max(2_147_483_647),
  historyRevision: z.number().int().min(0).max(2_147_483_647),
  observedAt: readyFrontierTimeSchemaV1,
  projects: z.array(readyFrontierProjectSourceSchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProjects),
  routes: z.array(readyFrontierRouteSourceSchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxRoutes),
  dependencyTruth: z.array(readyFrontierDependencyTruthSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  candidates: z.array(readyFrontierCandidateSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  canonicalWork: z.array(readyFrontierCanonicalWorkSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  priorProposals: z.array(readyFrontierPriorProposalSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  retainsRawInputContent: z.literal(false),
  retainsUsableAccessData: z.literal(false),
  retainsPrivateLocators: z.literal(false),
  sourceDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierProjectPolicySchemaV1 = z.object({
  projectId: readyFrontierIdSchemaV1,
  enabled: z.boolean(),
  allowedRouteIds: z.array(readyFrontierIdSchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxRoutes),
  maximumRisk: risk,
  maximumCostMicrousdPerProposal: boundedCost,
  maximumCycleCostMicrousd: boundedCost,
  maxProposalsPerCycle: z.number().int().min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalsPerProject),
  maxOutstandingProposals: nonNegativeInt.max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxOutstandingPerProject),
  ownerPolicyDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierPolicySchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_POLICY_V1),
  tenantId: readyFrontierIdSchemaV1,
  policyId: readyFrontierIdSchemaV1,
  revision: z.number().int().min(1).max(2_147_483_647),
  policySource: z.literal("repository_fixture"),
  ownerPolicyVerified: z.literal(false),
  effectiveAt: readyFrontierTimeSchemaV1,
  expiresAt: readyFrontierTimeSchemaV1,
  maximumRisk: risk,
  maximumCostMicrousdPerProposal: boundedCost,
  maximumCycleCostMicrousd: boundedCost,
  maxProposalsPerCycle: z.number().int().min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalsPerCycle),
  maxProposalsPerRoute: z.number().int().min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxRouteSlots),
  maxSourceAgeSeconds: z.number().int().min(30).max(3_600),
  starvationBoundMinutes: z.number().int().min(READY_FRONTIER_RESOURCE_CEILINGS_V1.minStarvationBoundMinutes)
    .max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxStarvationBoundMinutes),
  proposalTtlSeconds: z.number().int().min(READY_FRONTIER_RESOURCE_CEILINGS_V1.minProposalTtlSeconds)
    .max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalTtlSeconds),
  projectPolicies: z.array(readyFrontierProjectPolicySchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProjects),
  proposalOnly: z.literal(true),
  requiresOwnerReviewBeforeMaterialization: z.literal(true),
  permitsAutomaticApproval: z.literal(false),
  permitsReadyTransition: z.literal(false),
  permitsClaimOrLease: z.literal(false),
  permitsDispatchOrExecution: z.literal(false),
  permitsProviderContact: z.literal(false),
  permitsExternalEffects: z.literal(false),
  policyDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierProposalSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PROPOSAL_V1),
  proposalId: readyFrontierIdSchemaV1,
  cycleId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  projectId: readyFrontierIdSchemaV1,
  candidateId: readyFrontierIdSchemaV1,
  intentDigest: readyFrontierDigestSchemaV1,
  goalDigest: readyFrontierDigestSchemaV1,
  sourceDigest: readyFrontierDigestSchemaV1,
  policyDigest: readyFrontierDigestSchemaV1,
  ownerPolicyDigest: readyFrontierDigestSchemaV1,
  ownerPolicyVerified: z.literal(false),
  title: label,
  objective,
  routeId: readyFrontierIdSchemaV1,
  platform,
  requiredCapability: readyFrontierSafeCodeSchemaV1,
  risk,
  estimatedCostMicrousd: boundedCost,
  priority: nonNegativeInt.max(100),
  rank: z.number().int().min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalsPerCycle),
  proposedAt: readyFrontierTimeSchemaV1,
  expiresAt: readyFrontierTimeSchemaV1,
  state: z.literal("proposal_only"),
  ownerReviewState: z.literal("required_not_requested"),
  createsCanonicalWork: z.literal(false),
  grantsApproval: z.literal(false),
  grantsReadyTransition: z.literal(false),
  grantsClaimOrLease: z.literal(false),
  grantsDispatchOrExecution: z.literal(false),
  grantsProviderAccess: z.literal(false),
  grantsExternalEffect: z.literal(false),
  proposalDigest: readyFrontierDigestSchemaV1,
  proposalAuthTag: readyFrontierAuthTagSchemaV1,
}).strict();

export const readyFrontierReasonCodeSchemaV1 = z.enum([
  "selected", "starvation_bound_reached", "project_inactive", "project_policy_missing", "project_policy_disabled",
  "dependency_unsatisfied", "dependency_unknown", "dependency_stale", "candidate_blocked", "review_pending", "review_rejected",
  "duplicate_canonical_intent", "duplicate_prior_proposal_intent", "duplicate_source_intent", "route_missing", "route_unavailable", "route_stale", "route_disallowed",
  "platform_unsupported", "risk_limit_exceeded", "proposal_cost_limit_exceeded", "deadline_expired",
  "project_capacity_exhausted", "route_capacity_exhausted", "cycle_capacity_exhausted", "cycle_cost_exhausted",
]);

export const readyFrontierDispositionSchemaV1 = z.object({
  candidateId: readyFrontierIdSchemaV1,
  projectId: readyFrontierIdSchemaV1,
  outcome: z.enum(["proposed", "blocked", "needs_review", "duplicate_suppressed", "deferred_capacity", "deferred_policy"]),
  reasonCodes: z.array(readyFrontierReasonCodeSchemaV1).min(1).max(8),
  score: z.number().finite().nullable(),
  proposalId: readyFrontierIdSchemaV1.nullable(),
}).strict();

export const readyFrontierEvaluationSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_EVALUATION_V1),
  cycleId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  sourceSnapshotId: readyFrontierIdSchemaV1,
  sourceRevision: z.number().int().min(1).max(2_147_483_647),
  sourceHistoryRevision: z.number().int().min(0).max(2_147_483_647),
  sourceDigest: readyFrontierDigestSchemaV1,
  policyId: readyFrontierIdSchemaV1,
  policyRevision: z.number().int().min(1).max(2_147_483_647),
  policyDigest: readyFrontierDigestSchemaV1,
  evaluatedAt: readyFrontierTimeSchemaV1,
  proposals: z.array(readyFrontierProposalSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalsPerCycle),
  dispositions: z.array(readyFrontierDispositionSchemaV1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  proposalCount: nonNegativeInt.max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalsPerCycle),
  blockedCount: nonNegativeInt.max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  needsReviewCount: nonNegativeInt.max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  duplicateSuppressedCount: nonNegativeInt.max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  deferredCount: nonNegativeInt.max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCandidates),
  totalEstimatedCostMicrousd: boundedCost,
  proposalOnly: z.literal(true),
  createdCanonicalWork: z.literal(false),
  createdAttempts: z.literal(false),
  createdLeases: z.literal(false),
  createdDispatches: z.literal(false),
  contactedProvider: z.literal(false),
  performedExternalEffect: z.literal(false),
  evaluationDigest: readyFrontierDigestSchemaV1,
  evaluationAuthTag: readyFrontierAuthTagSchemaV1,
}).strict();

export const readyFrontierOperatorProjectionSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_OPERATOR_PROJECTION_V1),
  cycleId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  sourceSnapshotId: readyFrontierIdSchemaV1,
  evaluatedAt: readyFrontierTimeSchemaV1,
  proposals: z.array(z.object({
    proposalId: readyFrontierIdSchemaV1, projectId: readyFrontierIdSchemaV1, title: label, routeId: readyFrontierIdSchemaV1,
    platform, risk, estimatedCostMicrousd: boundedCost, priority: nonNegativeInt.max(100),
    rank: z.number().int().min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalsPerCycle),
    ownerReviewState: z.literal("required_not_requested"),
  }).strict()).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProposalsPerCycle),
  projects: z.array(z.object({
    projectId: readyFrontierIdSchemaV1, proposalCount: nonNegativeInt, blockedCount: nonNegativeInt,
    needsReviewCount: nonNegativeInt, deferredCount: nonNegativeInt,
  }).strict()).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProjects),
  reasonCounts: z.array(z.object({ reasonCode: readyFrontierReasonCodeSchemaV1, count: z.number().int().min(1) }).strict()).max(32),
  proposalOnly: z.literal(true),
  ownerReviewRequired: z.literal(true),
  canApprove: z.literal(false),
  canReady: z.literal(false),
  canClaimOrLease: z.literal(false),
  canDispatchOrExecute: z.literal(false),
  projectionDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierCycleInputSchemaV1 = z.object({
  cycleId: readyFrontierIdSchemaV1,
  evaluatedAt: readyFrontierTimeSchemaV1,
  source: readyFrontierSourceSchemaV1,
  policy: readyFrontierPolicySchemaV1,
}).strict();
