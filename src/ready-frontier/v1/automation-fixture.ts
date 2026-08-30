import { sha256Digest } from "../../security";
import { projectReadyFrontierAutomationV1 } from "./automation-projection";
import { buildReadyFrontierRepositoryFixtureEvaluationV1, readyFrontierRepositoryFixtureEvaluationKeyV1 } from "./integration-fixture";
import { buildReadyFrontierStandingPolicyV1 } from "./standing-policy";
import {
  READY_FRONTIER_MATERIALIZATION_REQUEST_V1,
  READY_FRONTIER_STANDING_POLICY_V1,
  type ReadyFrontierAutomationProjectionV1,
  type ReadyFrontierMaterializationRequestV1,
  type ReadyFrontierStandingPolicyV1,
} from "./automation-types";
import type { ReadyFrontierEvaluationV1, ReadyFrontierRiskClassV1 } from "./types";

const policyKey = () => new Uint8Array(32).fill(0x53);
export function readyFrontierRepositoryFixtureStandingPolicyKeyV1(): Uint8Array { return policyKey(); }

export function buildReadyFrontierStandingPolicyFixtureV1(integrityKeyValue: unknown = policyKey(),
  input: Partial<Pick<ReadyFrontierStandingPolicyV1, "policyId" | "revision" | "previousPolicyDigest" | "action" | "state" |
    "recordedAt" | "effectiveAt" | "expiresAt">> = {}): ReadyFrontierStandingPolicyV1 {
  const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1();
  const projectIds = [...new Set(evaluation.proposals.map((proposal) => proposal.projectId))].sort();
  const riskRank: ReadyFrontierRiskClassV1[] = ["low", "medium", "high", "critical"];
  return buildReadyFrontierStandingPolicyV1({
    schema: READY_FRONTIER_STANDING_POLICY_V1, tenantId: evaluation.tenantId, workspaceId: "workspace.control-room",
    policyId: input.policyId ?? "frontier.standing-policy.repository.0001", revision: input.revision ?? 1,
    previousPolicyDigest: input.previousPolicyDigest ?? null, action: input.action ?? "enroll", state: input.state ?? "active",
    activationScope: "repository_simulation", ownerActorDigest: sha256Digest({ fixture: "owner-actor" }),
    ownerAuthenticationEvidenceDigest: sha256Digest({ fixture: "owner-authentication-evidence" }),
    evidenceSource: "repository_fixture", productionOwnerAuthenticationVerified: false,
    recordedAt: input.recordedAt ?? "2026-08-30T17:00:00.000Z", effectiveAt: input.effectiveAt ?? "2026-08-30T17:30:00.000Z",
    expiresAt: input.expiresAt ?? "2026-08-31T17:00:00.000Z", maximumProposalAgeSeconds: 3_600,
    projectPolicies: projectIds.map((projectId) => {
      const proposals = evaluation.proposals.filter((proposal) => proposal.projectId === projectId);
      const maximumRisk = proposals.reduce<ReadyFrontierRiskClassV1>((current, proposal) =>
        riskRank.indexOf(proposal.risk) > riskRank.indexOf(current) ? proposal.risk : current, "low");
      return { projectId, enabled: true, allowedRouteIds: [...new Set(proposals.map((proposal) => proposal.routeId))].sort(),
        allowedPlatforms: [...new Set(proposals.map((proposal) => proposal.platform))].sort(),
        allowedCapabilities: [...new Set(proposals.map((proposal) => proposal.requiredCapability))].sort(),
        maximumRisk, maximumCostMicrousdPerWork: Math.max(...proposals.map((proposal) => proposal.estimatedCostMicrousd)) };
    }), permitsRepositorySimulationMaterialization: true, materializesProposedWorkOnly: true,
    requiresSeparateReadyReview: true, permitsAutomaticApproval: false, permitsReadyTransition: false,
    permitsScheduling: false, permitsClaimOrLease: false, permitsDispatchOrExecution: false,
    permitsProviderContact: false, permitsAgentMessage: false, permitsGitHubMutation: false, permitsExternalEffects: false,
  }, integrityKeyValue);
}

export function buildReadyFrontierMaterializationRequestFixtureV1(evaluation: ReadyFrontierEvaluationV1,
  policy: ReadyFrontierStandingPolicyV1, proposalIndex = 0): ReadyFrontierMaterializationRequestV1 {
  const proposal = evaluation.proposals[proposalIndex]; if (!proposal) throw new Error("fixture proposal missing");
  return { schema: READY_FRONTIER_MATERIALIZATION_REQUEST_V1, requestId: `frontier.materialization-request.${proposalIndex + 1}`,
    tenantId: evaluation.tenantId, workspaceId: policy.workspaceId, cycleId: evaluation.cycleId,
    proposalId: proposal.proposalId, proposalDigest: proposal.proposalDigest, evaluationDigest: evaluation.evaluationDigest,
    sourceDigest: evaluation.sourceDigest, frontierPolicyDigest: evaluation.policyDigest, standingPolicyId: policy.policyId,
    standingPolicyRevision: policy.revision, standingPolicyDigest: policy.policyDigest, requestedAt: "2026-08-30T18:02:30.000Z",
    materializedAt: "2026-08-30T18:03:00.000Z", authorityExpiresAt: "2026-08-30T19:00:00.000Z",
    trigger: "standing_policy_repository_simulation", scheduleId: null, repositorySimulationOnly: true,
    permitsApproval: false, permitsReadyTransition: false, permitsScheduling: false, permitsClaimOrLease: false,
    permitsDispatchOrExecution: false, permitsProviderContact: false, permitsAgentMessage: false,
    permitsGitHubMutation: false, permitsExternalEffects: false };
}

/** Honest server fixture: policy eligibility is visible, but no canonical materialization is claimed. */
export function buildReadyFrontierAutomationProjectionFixtureV1(): ReadyFrontierAutomationProjectionV1 {
  const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1(), standingKey = policyKey(), evaluationKey = readyFrontierRepositoryFixtureEvaluationKeyV1();
  try {
    const policy = buildReadyFrontierStandingPolicyFixtureV1(standingKey);
    return projectReadyFrontierAutomationV1({ evaluation, standingPolicy: policy, receipts: [],
      observedAt: "2026-08-30T18:03:00.000Z", evaluationIntegrityKey: evaluationKey, policyIntegrityKey: standingKey });
  } finally { standingKey.fill(0); evaluationKey.fill(0); }
}
