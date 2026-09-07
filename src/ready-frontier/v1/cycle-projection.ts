import { sha256Digest } from "../../security";
import { parseReadyFrontierEvaluationV1 } from "./controller";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { readyFrontierCycleProjectionSchemaV1 } from "./integration-schemas";
import {
  READY_FRONTIER_CYCLE_PROJECTION_V1,
  type ReadyFrontierCycleGateViewV1,
  type ReadyFrontierCycleProjectionV1,
  type ReadyFrontierCycleProjectViewV1,
} from "./integration-types";
import type { ReadyFrontierDispositionV1, ReadyFrontierEvaluationV1 } from "./types";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function unsigned(value: ReadyFrontierCycleProjectionV1): Omit<ReadyFrontierCycleProjectionV1, "projectionDigest"> {
  const { projectionDigest: _digest, ...rest } = value; void _digest; return rest;
}
function itemId(evaluation: ReadyFrontierEvaluationV1, disposition: ReadyFrontierDispositionV1): string {
  return `frontier.item.${sha256Digest({ cycleId: evaluation.cycleId, candidateId: disposition.candidateId }).slice(7, 39)}`;
}
function gateLabel(outcome: ReadyFrontierDispositionV1["outcome"]): string {
  if (outcome === "blocked") return "Blocked by a verified gate";
  if (outcome === "needs_review") return "Waiting for review evidence";
  if (outcome === "deferred_capacity") return "Deferred by current capacity";
  if (outcome === "deferred_policy") return "Deferred by repository policy";
  return "Suppressed duplicate candidate";
}
function gateItem(evaluation: ReadyFrontierEvaluationV1, disposition: ReadyFrontierDispositionV1): ReadyFrontierCycleGateViewV1 {
  if (disposition.outcome === "proposed") fail("invalid_input");
  return { itemId: itemId(evaluation, disposition), outcome: disposition.outcome,
    label: gateLabel(disposition.outcome), reasonCodes: disposition.reasonCodes };
}

export function projectReadyFrontierCycleV1(value: unknown, integrityKeyValue: unknown): ReadyFrontierCycleProjectionV1 {
  const evaluation = parseReadyFrontierEvaluationV1(value, integrityKeyValue);
  const projectIds = [...new Set(evaluation.dispositions.map((item) => item.projectId))].sort();
  const projects: ReadyFrontierCycleProjectViewV1[] = projectIds.map((projectId) => {
    const dispositions = evaluation.dispositions.filter((item) => item.projectId === projectId);
    const proposed = dispositions.filter((item) => item.outcome === "proposed").map((disposition) => {
      const proposal = evaluation.proposals.find((item) => item.proposalId === disposition.proposalId);
      if (!proposal) fail("integrity_failed");
      return {
        itemId: itemId(evaluation, disposition), proposalId: proposal.proposalId, title: proposal.title,
        routeId: proposal.routeId, platform: proposal.platform, risk: proposal.risk,
        estimatedCostMicrousd: proposal.estimatedCostMicrousd, priority: proposal.priority, rank: proposal.rank,
        ownerReviewState: proposal.ownerReviewState, reasonCodes: disposition.reasonCodes,
      };
    }).sort((left, right) => left.rank - right.rank);
    const blocked = dispositions.filter((item) => item.outcome === "blocked").map((item) => gateItem(evaluation, item));
    const needsReview = dispositions.filter((item) => item.outcome === "needs_review").map((item) => gateItem(evaluation, item));
    const deferred = dispositions.filter((item) => item.outcome === "deferred_capacity" || item.outcome === "deferred_policy")
      .map((item) => gateItem(evaluation, item));
    return { projectId, proposed, blocked, needsReview, deferred,
      suppressedCount: dispositions.filter((item) => item.outcome === "duplicate_suppressed").length };
  });
  const material: Omit<ReadyFrontierCycleProjectionV1, "projectionDigest"> = {
    schema: READY_FRONTIER_CYCLE_PROJECTION_V1,
    cycleId: evaluation.cycleId,
    tenantId: evaluation.tenantId,
    sourceSnapshotId: evaluation.sourceSnapshotId,
    evaluatedAt: evaluation.evaluatedAt,
    projects,
    proposalCount: evaluation.proposalCount,
    blockedCount: evaluation.blockedCount,
    needsReviewCount: evaluation.needsReviewCount,
    deferredCount: evaluation.deferredCount,
    suppressedCount: evaluation.duplicateSuppressedCount,
    proposalOnly: true,
    ownerReviewRequired: true,
    canMaterializeCanonicalWork: false,
    canApprove: false,
    canReady: false,
    canClaimOrLease: false,
    canDispatchOrExecute: false,
    canContactProvider: false,
    canPerformExternalEffect: false,
  };
  return parseExactReadyFrontierV1(readyFrontierCycleProjectionSchemaV1, {
    ...material, projectionDigest: sha256Digest(material),
  }) as ReadyFrontierCycleProjectionV1;
}

export function parseReadyFrontierCycleProjectionV1(value: unknown): ReadyFrontierCycleProjectionV1 {
  const projection = parseExactReadyFrontierV1(readyFrontierCycleProjectionSchemaV1, value) as ReadyFrontierCycleProjectionV1;
  if (sha256Digest(unsigned(projection)) !== projection.projectionDigest
    || projection.proposalCount !== projection.projects.reduce((sum, project) => sum + project.proposed.length, 0)
    || projection.blockedCount !== projection.projects.reduce((sum, project) => sum + project.blocked.length, 0)
    || projection.needsReviewCount !== projection.projects.reduce((sum, project) => sum + project.needsReview.length, 0)
    || projection.deferredCount !== projection.projects.reduce((sum, project) => sum + project.deferred.length, 0)
    || projection.suppressedCount !== projection.projects.reduce((sum, project) => sum + project.suppressedCount, 0)
    || new Set(projection.projects.map((project) => project.projectId)).size !== projection.projects.length
    || projection.projects.some((project, index) => index > 0 && projection.projects[index - 1]!.projectId >= project.projectId)) {
    fail("digest_mismatch");
  }
  return projection;
}
