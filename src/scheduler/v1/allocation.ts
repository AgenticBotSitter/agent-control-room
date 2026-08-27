export type AllocationRejection = "dependency_unsatisfied" | "fleet_ineligible" | "route_unavailable" | "maintenance" | "budget_exhausted" | "resource_unavailable" | "manual_assignment_required" | "invalid_candidate";

export interface AllocationCandidateV1 {
  projectId: string;
  workItemId: string;
  routeId: string;
  targetShare: number;
  recentShareUsed: number;
  priority: number;
  queueAgeMinutes: number;
  downstreamUnlockCount: number;
  deadlineRisk: number;
  estimatedCostUsd: number;
  exclusions?: AllocationRejection[];
}

export interface AllocationDecisionV1 {
  selected?: Pick<AllocationCandidateV1, "projectId" | "workItemId" | "routeId">;
  score?: number;
  explanation: string[];
  rejected: Array<Pick<AllocationCandidateV1, "projectId" | "workItemId" | "routeId"> & { reasons: AllocationRejection[] }>;
}

export const STARVATION_BOUND_MINUTES_V1 = 1_440;

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
function invalid(candidate: AllocationCandidateV1): boolean {
  return ![candidate.projectId, candidate.workItemId, candidate.routeId].every((value) => safeId.test(value))
    || !Number.isFinite(candidate.targetShare) || candidate.targetShare < 0 || candidate.targetShare > 100
    || !Number.isFinite(candidate.recentShareUsed) || candidate.recentShareUsed < 0 || candidate.recentShareUsed > 1_000
    || !Number.isInteger(candidate.priority) || candidate.priority < 0 || candidate.priority > 100
    || !Number.isFinite(candidate.queueAgeMinutes) || candidate.queueAgeMinutes < 0
    || !Number.isSafeInteger(candidate.downstreamUnlockCount) || candidate.downstreamUnlockCount < 0
    || !Number.isFinite(candidate.deadlineRisk) || candidate.deadlineRisk < 0 || candidate.deadlineRisk > 1
    || !Number.isFinite(candidate.estimatedCostUsd) || candidate.estimatedCostUsd < 0;
}

/** Pure, stable allocation order. Authority and atomic reservations remain downstream boundaries. */
export function chooseAllocationV1(candidates: AllocationCandidateV1[]): AllocationDecisionV1 {
  const rejected = candidates.filter((candidate) => invalid(candidate) || candidate.exclusions?.length).map((candidate) => ({
    projectId: candidate.projectId, workItemId: candidate.workItemId, routeId: candidate.routeId, reasons: invalid(candidate) ? ["invalid_candidate" as const] : [...(candidate.exclusions ?? [])].sort(),
  })).sort((a, b) => `${a.projectId}:${a.workItemId}:${a.routeId}`.localeCompare(`${b.projectId}:${b.workItemId}:${b.routeId}`));
  const eligible = candidates.filter((candidate) => !invalid(candidate) && !candidate.exclusions?.length).map((candidate) => {
    const fairShareDebt = Math.max(0, candidate.targetShare - candidate.recentShareUsed);
    const score = fairShareDebt * 2 + candidate.priority * 1.5 + Math.min(candidate.queueAgeMinutes, 1_440) * 0.02
      + candidate.downstreamUnlockCount * 4 + candidate.deadlineRisk * 10 - candidate.estimatedCostUsd * 20;
    return { candidate, fairShareDebt, score };
  });
  const stableKey = (value: typeof eligible[number]) => `${value.candidate.projectId}:${value.candidate.workItemId}:${value.candidate.routeId}`;
  const starved = eligible.filter((value) => value.candidate.queueAgeMinutes >= STARVATION_BOUND_MINUTES_V1)
    .sort((a, b) => b.candidate.queueAgeMinutes - a.candidate.queueAgeMinutes || stableKey(a).localeCompare(stableKey(b)));
  const winner = starved[0] ?? eligible.sort((a, b) => b.score - a.score || stableKey(a).localeCompare(stableKey(b)))[0];
  if (!winner) return { explanation: ["No candidate satisfies the hard scheduling rules."], rejected };
  return {
    selected: { projectId: winner.candidate.projectId, workItemId: winner.candidate.workItemId, routeId: winner.candidate.routeId },
    score: Math.round(winner.score * 100) / 100,
    explanation: [
      ...(starved.length ? [`Starvation bound reached after ${STARVATION_BOUND_MINUTES_V1} queued minutes; the oldest eligible work wins.`] : []),
      `Selected after ${winner.fairShareDebt.toFixed(2)} fair-share debt points.`,
      "Priority, deadline risk, queue age, downstream impact, and estimated cost were scored after hard exclusions.",
      "This decision is not an execution grant or resource reservation.",
    ],
    rejected,
  };
}
