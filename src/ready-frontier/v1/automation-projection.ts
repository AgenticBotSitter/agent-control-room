import { sha256Digest } from "../../security";
import { parseReadyFrontierEvaluationV1 } from "./controller";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { parseReadyFrontierMaterializationV1 } from "./materialization";
import { parseReadyFrontierStandingPolicyV1 } from "./standing-policy";
import { readyFrontierAutomationProjectionSchemaV1 } from "./automation-schemas";
import {
  READY_FRONTIER_AUTOMATION_PROJECTION_V1,
  type ReadyFrontierAutomationProjectionV1,
  type ReadyFrontierStandingPolicyV1,
} from "./automation-types";
import { readyFrontierRiskClassesV1, type ReadyFrontierProposalV1 } from "./types";

function risk(value: string): number { return readyFrontierRiskClassesV1.indexOf(value as never); }
function policyAllows(proposal: ReadyFrontierProposalV1, policy: ReadyFrontierStandingPolicyV1, now: number): boolean {
  const project = policy.projectPolicies.find((item) => item.projectId === proposal.projectId);
  return policy.state === "active" && now >= Date.parse(policy.effectiveAt) && now < Date.parse(policy.expiresAt)
    && now >= Date.parse(proposal.proposedAt) && now < Date.parse(proposal.expiresAt)
    && now - Date.parse(proposal.proposedAt) <= policy.maximumProposalAgeSeconds * 1_000
    && Boolean(project?.enabled && project.allowedRouteIds.includes(proposal.routeId)
      && (project.allowedPlatforms.includes(proposal.platform) || project.allowedPlatforms.includes("any"))
      && project.allowedCapabilities.includes(proposal.requiredCapability) && risk(proposal.risk) <= risk(project.maximumRisk)
      && proposal.estimatedCostMicrousd <= project.maximumCostMicrousdPerWork);
}

export function projectReadyFrontierAutomationV1(input: { evaluation: unknown; standingPolicy?: unknown;
  receipts?: unknown[]; observedAt: string; evaluationIntegrityKey: unknown; policyIntegrityKey?: unknown }): ReadyFrontierAutomationProjectionV1 {
  const evaluation = parseReadyFrontierEvaluationV1(input.evaluation, input.evaluationIntegrityKey), now = Date.parse(input.observedAt);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== input.observedAt) throw new ReadyFrontierContractErrorV1("invalid_input");
  const policy = input.standingPolicy === undefined ? undefined
    : parseReadyFrontierStandingPolicyV1(input.standingPolicy, input.policyIntegrityKey);
  if (policy && policy.tenantId !== evaluation.tenantId) throw new ReadyFrontierContractErrorV1("scope_mismatch");
  const receipts = (input.receipts ?? []).map((receipt) => parseReadyFrontierMaterializationV1(receipt, input.evaluationIntegrityKey));
  if (receipts.some((receipt) => receipt.tenantId !== evaluation.tenantId || receipt.cycleId !== evaluation.cycleId)) {
    throw new ReadyFrontierContractErrorV1("scope_mismatch");
  }
  const receiptByProposal = new Map(receipts.map((receipt) => [receipt.proposalId, receipt]));
  if (receiptByProposal.size !== receipts.length) throw new ReadyFrontierContractErrorV1("replay_drift");
  const standingPolicyState = !policy ? "missing" : policy.state === "suspended" ? "suspended" : policy.state === "revoked" ? "revoked"
    : now < Date.parse(policy.effectiveAt) || now >= Date.parse(policy.expiresAt) ? "expired" : "repository_fixture_active";
  const projectIds = [...new Set(evaluation.proposals.map((proposal) => proposal.projectId))].sort();
  const unsigned: Omit<ReadyFrontierAutomationProjectionV1, "projectionDigest"> = {
    schema: READY_FRONTIER_AUTOMATION_PROJECTION_V1, tenantId: evaluation.tenantId, standingPolicyState,
    productionPolicyState: "not_enrolled", projects: projectIds.map((projectId) => ({ projectId,
      proposals: evaluation.proposals.filter((proposal) => proposal.projectId === projectId).map((proposal) => {
        const receipt = receiptByProposal.get(proposal.proposalId);
        if (receipt && (receipt.proposalDigest !== proposal.proposalDigest || receipt.evaluationDigest !== evaluation.evaluationDigest
          || !policy || receipt.standingPolicyDigest !== policy.policyDigest)) throw new ReadyFrontierContractErrorV1("replay_drift");
        const policyDisposition = !policy ? "policy_missing" : standingPolicyState !== "repository_fixture_active" ? "policy_inactive"
          : policyAllows(proposal, policy, now) ? "eligible_repository_simulation" : "policy_denied";
        return { proposalId: proposal.proposalId, title: proposal.title, policyDisposition,
          materializationState: receipt ? "materialized_proposed" as const : "not_requested" as const,
          ...(receipt ? { materializedJobId: receipt.job.id } : {}) };
      }) })), repositorySimulationOnly: true, canEnrollProductionPolicy: false, canMaterializeFromView: false,
    canApprove: false, canReady: false, canSchedule: false, canClaimOrLease: false, canDispatchOrExecute: false,
  };
  return parseExactReadyFrontierV1(readyFrontierAutomationProjectionSchemaV1,
    { ...unsigned, projectionDigest: sha256Digest(unsigned) }) as ReadyFrontierAutomationProjectionV1;
}

export function parseReadyFrontierAutomationProjectionV1(value: unknown): ReadyFrontierAutomationProjectionV1 {
  const projection = parseExactReadyFrontierV1(readyFrontierAutomationProjectionSchemaV1, value) as ReadyFrontierAutomationProjectionV1;
  const { projectionDigest, ...unsigned } = projection;
  if (sha256Digest(unsigned) !== projectionDigest) throw new ReadyFrontierContractErrorV1("digest_mismatch");
  return projection;
}
