import { sha256Digest } from "../../security";
import { buildReadyFrontierPolicyV1, buildReadyFrontierSourceV1 } from "./controller";
import {
  READY_FRONTIER_POLICY_V1,
  READY_FRONTIER_SOURCE_V1,
  type ReadyFrontierCandidateV1,
  type ReadyFrontierCycleInputV1,
} from "./types";

const observedAt = "2026-08-30T18:00:00.000Z";
const evaluatedAt = "2026-08-30T18:02:00.000Z";
const digest = (value: string) => sha256Digest({ fixture: "cr11b-auto-000", value });

function candidate(input: Partial<ReadyFrontierCandidateV1> & Pick<ReadyFrontierCandidateV1,
  "candidateId" | "projectId" | "title" | "objective">): ReadyFrontierCandidateV1 {
  return {
    intentDigest: digest(`intent:${input.candidateId}`), sourceKind: "project_goal", routeId: "route.repo.agent",
    platform: "any", requiredCapability: "capability.repository.build", risk: "low", estimatedCostMicrousd: 250_000,
    priority: 60, downstreamUnlockCount: 1, createdAt: "2026-08-30T12:00:00.000Z", deadlineAt: null,
    dependencyCandidateIds: [], reviewTruth: "not_required", blockerCodes: [], evidenceDigests: [digest(`evidence:${input.candidateId}`)],
    ...input,
  };
}

export function buildReadyFrontierFixtureV1(): ReadyFrontierCycleInputV1 {
  const duplicateIntent = digest("intent:duplicate-source"), canonicalIntent = digest("intent:canonical-existing");
  const source = buildReadyFrontierSourceV1({
    schema: READY_FRONTIER_SOURCE_V1, tenantId: "tenant.owner", snapshotId: "frontier.snapshot.0001", sourceRevision: 1,
    historyRevision: 0,
    observedAt,
    projects: [
      { projectId: "project.abs-news", goalDigest: digest("goal:abs"), state: "active", targetShareBps: 4_000,
        recentProposalShareBps: 500, outstandingProposalCount: 0 },
      { projectId: "project.content-blooms", goalDigest: digest("goal:content-blooms"), state: "active", targetShareBps: 2_500,
        recentProposalShareBps: 2_000, outstandingProposalCount: 0 },
      { projectId: "project.wayfarer", goalDigest: digest("goal:wayfarer"), state: "active", targetShareBps: 3_500,
        recentProposalShareBps: 4_000, outstandingProposalCount: 1 },
    ],
    routes: [
      { routeId: "route.architect", state: "available", availableProposalSlots: 2, maximumRisk: "medium",
        maximumCostMicrousd: 2_000_000, supportedPlatforms: ["any", "cloud", "linux", "macos", "windows"], observedAt,
        evidenceDigest: digest("route:architect") },
      { routeId: "route.repo.agent", state: "available", availableProposalSlots: 3, maximumRisk: "medium",
        maximumCostMicrousd: 1_000_000, supportedPlatforms: ["any", "linux", "macos", "windows"], observedAt,
        evidenceDigest: digest("route:repo-agent") },
    ],
    dependencyTruth: [
      { candidateId: "dependency.abs.source-review", projectId: "project.abs-news", state: "blocked",
        evidenceDigest: digest("dependency:abs-source-review"), observedAt },
      { candidateId: "dependency.wayfarer.contract", projectId: "project.wayfarer", state: "satisfied",
        evidenceDigest: digest("dependency:wayfarer-contract"), observedAt },
    ],
    candidates: [
      candidate({ candidateId: "candidate.abs.research", projectId: "project.abs-news", title: "Research a verified AI release",
        objective: "Prepare a source-backed research brief for owner review.", priority: 88, downstreamUnlockCount: 3 }),
      candidate({ candidateId: "candidate.abs.blocked-source", projectId: "project.abs-news", title: "Write from an unreviewed source",
        objective: "Prepare a guide only after the source review completes.", dependencyCandidateIds: ["dependency.abs.source-review"] }),
      candidate({ candidateId: "candidate.abs.canonical-duplicate", projectId: "project.abs-news", title: "Repeat existing research",
        objective: "This exact intent already exists in canonical work.", intentDigest: canonicalIntent }),
      candidate({ candidateId: "candidate.abs.high-risk", projectId: "project.abs-news", title: "Change live publication settings",
        objective: "Propose a live configuration change.", risk: "high", routeId: "route.architect" }),
      candidate({ candidateId: "candidate.abs.over-cost", projectId: "project.abs-news", title: "Oversized research batch",
        objective: "Prepare an oversized batch that exceeds the proposal ceiling.", estimatedCostMicrousd: 4_000_000 }),
      candidate({ candidateId: "candidate.content.article", projectId: "project.content-blooms", title: "Draft a source-backed article",
        objective: "Prepare one evidence-bound article draft for owner review.", priority: 72, downstreamUnlockCount: 2 }),
      candidate({ candidateId: "candidate.content.needs-review", projectId: "project.content-blooms", title: "Research a pending topic",
        objective: "Wait for the source decision before preparing research.", reviewTruth: "pending" }),
      candidate({ candidateId: "candidate.content.blocked", projectId: "project.content-blooms", title: "Prepare a held release",
        objective: "Wait until the declared content hold is resolved.", blockerCodes: ["content_hold"] }),
      candidate({ candidateId: "candidate.wayfarer.starved", projectId: "project.wayfarer", title: "Document the Unreal setup",
        objective: "Prepare an exact setup guide from the accepted repository contract.", routeId: "route.architect", platform: "windows",
        priority: 20, downstreamUnlockCount: 1, createdAt: "2026-08-28T12:00:00.000Z",
        dependencyCandidateIds: ["dependency.wayfarer.contract"] }),
      candidate({ candidateId: "candidate.wayfarer.duplicate-a", projectId: "project.wayfarer", title: "Duplicate render guide A",
        objective: "A duplicate source intent that must not be selected.", intentDigest: duplicateIntent }),
      candidate({ candidateId: "candidate.wayfarer.duplicate-b", projectId: "project.wayfarer", title: "Duplicate render guide B",
        objective: "A second duplicate source intent that must not be selected.", intentDigest: duplicateIntent }),
      candidate({ candidateId: "candidate.wayfarer.missing-route", projectId: "project.wayfarer", title: "Use an unknown route",
        objective: "A candidate whose declared route has no current evidence.", routeId: "route.unknown" }),
    ],
    canonicalWork: [
      { workItemId: "work.abs.existing", projectId: "project.abs-news", intentDigest: canonicalIntent, state: "proposed",
        observedAt, evidenceDigest: digest("work:abs-existing") },
    ],
    priorProposals: [],
    retainsRawInputContent: false, retainsUsableAccessData: false, retainsPrivateLocators: false,
  });
  const projectPolicy = (projectId: string) => ({
    projectId, enabled: true, allowedRouteIds: ["route.architect", "route.repo.agent"], maximumRisk: "medium" as const,
    maximumCostMicrousdPerProposal: 1_000_000, maximumCycleCostMicrousd: 2_000_000, maxProposalsPerCycle: 2,
    maxOutstandingProposals: 4, ownerPolicyDigest: digest(`owner-policy:${projectId}`),
  });
  const policy = buildReadyFrontierPolicyV1({
    schema: READY_FRONTIER_POLICY_V1, tenantId: "tenant.owner", policyId: "frontier.policy.owner.0001", revision: 1,
    policySource: "repository_fixture", ownerPolicyVerified: false,
    effectiveAt: "2026-08-30T17:00:00.000Z", expiresAt: "2026-08-31T17:00:00.000Z", maximumRisk: "medium",
    maximumCostMicrousdPerProposal: 1_000_000, maximumCycleCostMicrousd: 3_000_000, maxProposalsPerCycle: 4,
    maxProposalsPerRoute: 3, maxSourceAgeSeconds: 300, starvationBoundMinutes: 1_440, proposalTtlSeconds: 3_600,
    projectPolicies: [projectPolicy("project.abs-news"), projectPolicy("project.content-blooms"), projectPolicy("project.wayfarer")],
    proposalOnly: true, requiresOwnerReviewBeforeMaterialization: true, permitsAutomaticApproval: false,
    permitsReadyTransition: false, permitsClaimOrLease: false, permitsDispatchOrExecution: false, permitsProviderContact: false,
    permitsExternalEffects: false,
  });
  return { cycleId: "frontier.cycle.0001", evaluatedAt, source, policy };
}
