import { sha256Digest } from "../../security";
import { buildReadyFrontierReadyPolicyV1 } from "./ready-policy";
import { projectReadyFrontierPromotionV1 } from "./promotion-projection";
import { buildReadyFrontierRepositoryFixtureEvaluationV1, readyFrontierRepositoryFixtureEvaluationKeyV1 } from "./integration-fixture";
import { buildReadyFrontierStandingPolicyFixtureV1, readyFrontierRepositoryFixtureStandingPolicyKeyV1 } from "./automation-fixture";
import {
  READY_FRONTIER_PROMOTION_REQUEST_V1,
  READY_FRONTIER_READY_POLICY_V1,
  type ReadyFrontierPromotionBuildInputV1,
  type ReadyFrontierPromotionProjectionV1,
  type ReadyFrontierPromotionRequestV1,
  type ReadyFrontierReadyPolicyV1,
} from "./ready-policy-types";
import type { ReadyFrontierMaterializationReceiptV1, ReadyFrontierStandingPolicyV1 } from "./automation-types";
import type { ReadyFrontierEvaluationV1, ReadyFrontierRiskClassV1 } from "./types";

const readyPolicyKey = () => new Uint8Array(32).fill(0x72);
export function readyFrontierRepositoryFixtureReadyPolicyKeyV1(): Uint8Array { return readyPolicyKey(); }

export function buildReadyFrontierReadyPolicyFixtureV1(evaluation: ReadyFrontierEvaluationV1,
  standingPolicy: ReadyFrontierStandingPolicyV1, integrityKeyValue: unknown = readyPolicyKey(),
  input: Partial<Pick<ReadyFrontierReadyPolicyV1, "policyId" | "revision" | "previousPolicyDigest" |
    "action" | "state" | "recordedAt" | "effectiveAt" | "expiresAt">> = {}): ReadyFrontierReadyPolicyV1 {
  const projectIds = [...new Set(evaluation.proposals.map((proposal) => proposal.projectId))].sort();
  const riskRank: ReadyFrontierRiskClassV1[] = ["low", "medium", "high", "critical"];
  return buildReadyFrontierReadyPolicyV1({
    schema: READY_FRONTIER_READY_POLICY_V1, tenantId: evaluation.tenantId, workspaceId: standingPolicy.workspaceId,
    policyId: input.policyId ?? "frontier.ready-policy.repository.0001", revision: input.revision ?? 1,
    previousPolicyDigest: input.previousPolicyDigest ?? null, action: input.action ?? "enroll",
    state: input.state ?? "active", parentStandingPolicyId: standingPolicy.policyId,
    parentStandingPolicyRevision: standingPolicy.revision, parentStandingPolicyDigest: standingPolicy.policyDigest,
    separateReadyReviewDigest: sha256Digest({ fixture: "separate-ready-review", standingPolicyDigest: standingPolicy.policyDigest }),
    activationScope: "repository_simulation", ownerActorDigest: sha256Digest({ fixture: "ready-owner-actor" }),
    ownerAuthenticationEvidenceDigest: sha256Digest({ fixture: "ready-owner-authentication-evidence" }),
    evidenceSource: "repository_fixture", repositoryReviewFixtureAccepted: true,
    productionOwnerAuthenticationVerified: false, productionIndependentReviewVerified: false,
    recordedAt: input.recordedAt ?? "2026-08-30T18:03:10.000Z",
    effectiveAt: input.effectiveAt ?? "2026-08-30T18:03:20.000Z",
    expiresAt: input.expiresAt ?? "2026-08-30T19:00:00.000Z", maximumMaterializationAgeSeconds: 3_600,
    maximumActiveReadyGlobal: 3,
    projectPolicies: projectIds.map((projectId) => {
      const proposals = evaluation.proposals.filter((proposal) => proposal.projectId === projectId);
      const maximumRisk = proposals.reduce<ReadyFrontierRiskClassV1>((current, proposal) =>
        riskRank.indexOf(proposal.risk) > riskRank.indexOf(current) ? proposal.risk : current, "low");
      const routeIds = [...new Set(proposals.map((proposal) => proposal.routeId))].sort();
      return { projectId, enabled: true, allowedRouteIds: routeIds,
        allowedPlatforms: [...new Set(proposals.map((proposal) => proposal.platform))].sort(),
        allowedCapabilities: [...new Set(proposals.map((proposal) => proposal.requiredCapability))].sort(),
        maximumRisk, maximumCostMicrousdPerWork: Math.max(...proposals.map((proposal) => proposal.estimatedCostMicrousd)),
        maximumActiveReady: 1, resourceKey: `frontier.ready.${routeIds[0]}`,
        reservationUnits: 1, resourceCapacityUnits: 1, reservationTtlSeconds: 300 };
    }), permitsAutomaticReadyTransition: true, permitsDatabaseSchedulerReservation: true,
    permitsInternalJobberHandoff: true, handoffTransport: "canonical_outbox",
    permitsAutomaticApproval: false, permitsScheduleCreation: false, permitsClaimOrLease: false,
    permitsDispatchOrExecution: false, permitsProviderContact: false, permitsAgentMessage: false,
    permitsGitHubMutation: false, permitsExternalEffects: false,
  }, integrityKeyValue);
}

export function buildReadyFrontierPromotionRequestFixtureV1(materialization: ReadyFrontierMaterializationReceiptV1,
  readyPolicy: ReadyFrontierReadyPolicyV1, input: Partial<Pick<ReadyFrontierPromotionRequestV1,
    "requestId" | "requestedAt" | "promotedAt" | "reservationExpiresAt">> = {}): ReadyFrontierPromotionRequestV1 {
  return { schema: READY_FRONTIER_PROMOTION_REQUEST_V1,
    requestId: input.requestId ?? "frontier.promotion-request.0001", tenantId: materialization.tenantId,
    workspaceId: materialization.workspaceId, materializationReceiptId: materialization.receiptId,
    materializationReceiptDigest: materialization.receiptDigest, jobId: materialization.job.id,
    standingPolicyId: materialization.standingPolicyId, standingPolicyRevision: materialization.standingPolicyRevision,
    standingPolicyDigest: materialization.standingPolicyDigest, readyPolicyId: readyPolicy.policyId,
    readyPolicyRevision: readyPolicy.revision, readyPolicyDigest: readyPolicy.policyDigest,
    requestedAt: input.requestedAt ?? "2026-08-30T18:03:30.000Z",
    promotedAt: input.promotedAt ?? "2026-08-30T18:04:00.000Z",
    reservationExpiresAt: input.reservationExpiresAt ?? "2026-08-30T18:09:00.000Z",
    trigger: "standing_ready_policy_repository_simulation", repositorySimulationOnly: true,
    createsApproval: false, createsSchedule: false, permitsReadyTransition: true,
    permitsDatabaseSchedulerReservation: true, permitsInternalJobberHandoff: true,
    permitsClaimOrLease: false, permitsDispatchOrExecution: false, permitsProviderContact: false,
    permitsAgentMessage: false, permitsGitHubMutation: false, permitsExternalEffects: false };
}

export function buildReadyFrontierPromotionEnvelopeFixtureV1(materialization: ReadyFrontierMaterializationReceiptV1,
  readyPolicy: ReadyFrontierReadyPolicyV1): ReadyFrontierPromotionBuildInputV1 {
  return { request: buildReadyFrontierPromotionRequestFixtureV1(materialization, readyPolicy),
    materializationReceipt: materialization };
}

/** Honest server fixture: the repository ready policy is visible, but no job is claimed to be promoted. */
export function buildReadyFrontierPromotionProjectionFixtureV1(): ReadyFrontierPromotionProjectionV1 {
  const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1();
  const evaluationKey = readyFrontierRepositoryFixtureEvaluationKeyV1();
  const standingKey = readyFrontierRepositoryFixtureStandingPolicyKeyV1();
  const readyKey = readyPolicyKey();
  try {
    const standing = buildReadyFrontierStandingPolicyFixtureV1(standingKey);
    const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, readyKey);
    return projectReadyFrontierPromotionV1({ tenantId: evaluation.tenantId, readyPolicy, receipts: [],
      observedAt: "2026-08-30T18:04:00.000Z", evaluationIntegrityKey: evaluationKey,
      readyPolicyIntegrityKey: readyKey });
  } finally { evaluationKey.fill(0); standingKey.fill(0); readyKey.fill(0); }
}
