export const READY_FRONTIER_CONTRACT_V1 = "control-room-ready-frontier/v1" as const;
export const READY_FRONTIER_SOURCE_V1 = "control-room-ready-frontier-source/v1" as const;
export const READY_FRONTIER_POLICY_V1 = "control-room-ready-frontier-policy/v1" as const;
export const READY_FRONTIER_PROPOSAL_V1 = "control-room-ready-frontier-proposal/v1" as const;
export const READY_FRONTIER_EVALUATION_V1 = "control-room-ready-frontier-evaluation/v1" as const;
export const READY_FRONTIER_OPERATOR_PROJECTION_V1 = "control-room-ready-frontier-operator-projection/v1" as const;

export const READY_FRONTIER_RESOURCE_CEILINGS_V1 = Object.freeze({
  maxProjects: 24,
  maxRoutes: 24,
  maxCandidates: 200,
  maxDependencies: 16,
  maxBlockers: 8,
  maxEvidenceDigests: 12,
  maxProposalsPerCycle: 32,
  maxProposalsPerProject: 8,
  maxRouteSlots: 16,
  maxOutstandingPerProject: 32,
  maxCostMicrousd: 100_000_000,
  minStarvationBoundMinutes: 60,
  maxStarvationBoundMinutes: 10_080,
  minProposalTtlSeconds: 300,
  maxProposalTtlSeconds: 86_400,
} as const);

export const readyFrontierRiskClassesV1 = ["low", "medium", "high", "critical"] as const;
export type ReadyFrontierRiskClassV1 = (typeof readyFrontierRiskClassesV1)[number];
export const readyFrontierPlatformsV1 = ["any", "macos", "windows", "linux", "cloud"] as const;
export type ReadyFrontierPlatformV1 = (typeof readyFrontierPlatformsV1)[number];

export interface ReadyFrontierProjectSourceV1 {
  projectId: string;
  goalDigest: string;
  state: "active" | "paused" | "blocked" | "complete";
  targetShareBps: number;
  recentProposalShareBps: number;
  outstandingProposalCount: number;
}

export interface ReadyFrontierRouteSourceV1 {
  routeId: string;
  state: "available" | "degraded" | "unavailable";
  availableProposalSlots: number;
  maximumRisk: ReadyFrontierRiskClassV1;
  maximumCostMicrousd: number;
  supportedPlatforms: ReadyFrontierPlatformV1[];
  observedAt: string;
  evidenceDigest: string;
}

export interface ReadyFrontierDependencyTruthV1 {
  candidateId: string;
  projectId: string;
  state: "satisfied" | "blocked" | "unknown";
  evidenceDigest: string;
  observedAt: string;
}

export interface ReadyFrontierCandidateV1 {
  candidateId: string;
  projectId: string;
  intentDigest: string;
  sourceKind: "project_goal" | "dependency_gap" | "blocker_followup" | "review_followup" | "recurring_maintenance";
  title: string;
  objective: string;
  routeId: string;
  platform: ReadyFrontierPlatformV1;
  requiredCapability: string;
  risk: ReadyFrontierRiskClassV1;
  estimatedCostMicrousd: number;
  priority: number;
  downstreamUnlockCount: number;
  createdAt: string;
  deadlineAt: string | null;
  dependencyCandidateIds: string[];
  reviewTruth: "not_required" | "accepted" | "pending" | "rejected";
  blockerCodes: string[];
  evidenceDigests: string[];
}

export interface ReadyFrontierCanonicalWorkTruthV1 {
  workItemId: string;
  projectId: string;
  intentDigest: string;
  state: "proposal_pending" | "proposed" | "ready" | "leased" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled" | "rejected";
  observedAt: string;
  evidenceDigest: string;
}

export interface ReadyFrontierPriorProposalTruthV1 {
  proposalId: string;
  projectId: string;
  intentDigest: string;
  state: "open" | "expired" | "dismissed" | "materialized";
  observedAt: string;
  evidenceDigest: string;
}

export interface ReadyFrontierSourceSnapshotV1 {
  schema: typeof READY_FRONTIER_SOURCE_V1;
  tenantId: string;
  snapshotId: string;
  sourceRevision: number;
  historyRevision: number;
  observedAt: string;
  projects: ReadyFrontierProjectSourceV1[];
  routes: ReadyFrontierRouteSourceV1[];
  dependencyTruth: ReadyFrontierDependencyTruthV1[];
  candidates: ReadyFrontierCandidateV1[];
  canonicalWork: ReadyFrontierCanonicalWorkTruthV1[];
  priorProposals: ReadyFrontierPriorProposalTruthV1[];
  retainsRawInputContent: false;
  retainsUsableAccessData: false;
  retainsPrivateLocators: false;
  sourceDigest: string;
}

export interface ReadyFrontierProjectPolicyV1 {
  projectId: string;
  enabled: boolean;
  allowedRouteIds: string[];
  maximumRisk: ReadyFrontierRiskClassV1;
  maximumCostMicrousdPerProposal: number;
  maximumCycleCostMicrousd: number;
  maxProposalsPerCycle: number;
  maxOutstandingProposals: number;
  ownerPolicyDigest: string;
}

export interface ReadyFrontierPolicyV1 {
  schema: typeof READY_FRONTIER_POLICY_V1;
  tenantId: string;
  policyId: string;
  revision: number;
  policySource: "repository_fixture";
  ownerPolicyVerified: false;
  effectiveAt: string;
  expiresAt: string;
  maximumRisk: ReadyFrontierRiskClassV1;
  maximumCostMicrousdPerProposal: number;
  maximumCycleCostMicrousd: number;
  maxProposalsPerCycle: number;
  maxProposalsPerRoute: number;
  maxSourceAgeSeconds: number;
  starvationBoundMinutes: number;
  proposalTtlSeconds: number;
  projectPolicies: ReadyFrontierProjectPolicyV1[];
  proposalOnly: true;
  requiresOwnerReviewBeforeMaterialization: true;
  permitsAutomaticApproval: false;
  permitsReadyTransition: false;
  permitsClaimOrLease: false;
  permitsDispatchOrExecution: false;
  permitsProviderContact: false;
  permitsExternalEffects: false;
  policyDigest: string;
}

export type ReadyFrontierDispositionOutcomeV1 =
  | "proposed"
  | "blocked"
  | "needs_review"
  | "duplicate_suppressed"
  | "deferred_capacity"
  | "deferred_policy";

export type ReadyFrontierReasonCodeV1 =
  | "selected"
  | "starvation_bound_reached"
  | "project_inactive"
  | "project_policy_missing"
  | "project_policy_disabled"
  | "dependency_unsatisfied"
  | "dependency_unknown"
  | "dependency_stale"
  | "candidate_blocked"
  | "review_pending"
  | "review_rejected"
  | "duplicate_canonical_intent"
  | "duplicate_prior_proposal_intent"
  | "duplicate_source_intent"
  | "route_missing"
  | "route_unavailable"
  | "route_stale"
  | "route_disallowed"
  | "platform_unsupported"
  | "risk_limit_exceeded"
  | "proposal_cost_limit_exceeded"
  | "deadline_expired"
  | "project_capacity_exhausted"
  | "route_capacity_exhausted"
  | "cycle_capacity_exhausted"
  | "cycle_cost_exhausted";

export interface ReadyFrontierProposalV1 {
  schema: typeof READY_FRONTIER_PROPOSAL_V1;
  proposalId: string;
  cycleId: string;
  tenantId: string;
  projectId: string;
  candidateId: string;
  intentDigest: string;
  goalDigest: string;
  sourceDigest: string;
  policyDigest: string;
  ownerPolicyDigest: string;
  ownerPolicyVerified: false;
  title: string;
  objective: string;
  routeId: string;
  platform: ReadyFrontierPlatformV1;
  requiredCapability: string;
  risk: ReadyFrontierRiskClassV1;
  estimatedCostMicrousd: number;
  priority: number;
  rank: number;
  proposedAt: string;
  expiresAt: string;
  state: "proposal_only";
  ownerReviewState: "required_not_requested";
  createsCanonicalWork: false;
  grantsApproval: false;
  grantsReadyTransition: false;
  grantsClaimOrLease: false;
  grantsDispatchOrExecution: false;
  grantsProviderAccess: false;
  grantsExternalEffect: false;
  proposalDigest: string;
  proposalAuthTag: string;
}

export interface ReadyFrontierDispositionV1 {
  candidateId: string;
  projectId: string;
  outcome: ReadyFrontierDispositionOutcomeV1;
  reasonCodes: ReadyFrontierReasonCodeV1[];
  score: number | null;
  proposalId: string | null;
}

export interface ReadyFrontierEvaluationV1 {
  schema: typeof READY_FRONTIER_EVALUATION_V1;
  cycleId: string;
  tenantId: string;
  sourceSnapshotId: string;
  sourceRevision: number;
  sourceHistoryRevision: number;
  sourceDigest: string;
  policyId: string;
  policyRevision: number;
  policyDigest: string;
  evaluatedAt: string;
  proposals: ReadyFrontierProposalV1[];
  dispositions: ReadyFrontierDispositionV1[];
  proposalCount: number;
  blockedCount: number;
  needsReviewCount: number;
  duplicateSuppressedCount: number;
  deferredCount: number;
  totalEstimatedCostMicrousd: number;
  proposalOnly: true;
  createdCanonicalWork: false;
  createdAttempts: false;
  createdLeases: false;
  createdDispatches: false;
  contactedProvider: false;
  performedExternalEffect: false;
  evaluationDigest: string;
  evaluationAuthTag: string;
}

export interface ReadyFrontierOperatorProposalV1 {
  proposalId: string;
  projectId: string;
  title: string;
  routeId: string;
  platform: ReadyFrontierPlatformV1;
  risk: ReadyFrontierRiskClassV1;
  estimatedCostMicrousd: number;
  priority: number;
  rank: number;
  ownerReviewState: "required_not_requested";
}

export interface ReadyFrontierOperatorProjectV1 {
  projectId: string;
  proposalCount: number;
  blockedCount: number;
  needsReviewCount: number;
  deferredCount: number;
}

export interface ReadyFrontierOperatorProjectionV1 {
  schema: typeof READY_FRONTIER_OPERATOR_PROJECTION_V1;
  cycleId: string;
  tenantId: string;
  sourceSnapshotId: string;
  evaluatedAt: string;
  proposals: ReadyFrontierOperatorProposalV1[];
  projects: ReadyFrontierOperatorProjectV1[];
  reasonCounts: Array<{ reasonCode: ReadyFrontierReasonCodeV1; count: number }>;
  proposalOnly: true;
  ownerReviewRequired: true;
  canApprove: false;
  canReady: false;
  canClaimOrLease: false;
  canDispatchOrExecute: false;
  projectionDigest: string;
}

export interface ReadyFrontierCycleInputV1 {
  cycleId: string;
  evaluatedAt: string;
  source: ReadyFrontierSourceSnapshotV1;
  policy: ReadyFrontierPolicyV1;
}
