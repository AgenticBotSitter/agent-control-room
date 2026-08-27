export type AllocationRejection = "dependency_unsatisfied" | "fleet_ineligible" | "route_unavailable" | "maintenance" | "budget_exhausted" | "resource_unavailable" | "manual_assignment_required";

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

/** Pure, stable allocation order. Authority and atomic reservations remain downstream boundaries. */
export function chooseAllocationV1(candidates: AllocationCandidateV1[]): AllocationDecisionV1 {
  const rejected = candidates.filter((candidate) => candidate.exclusions?.length).map((candidate) => ({
    projectId: candidate.projectId, workItemId: candidate.workItemId, routeId: candidate.routeId, reasons: [...(candidate.exclusions ?? [])].sort(),
  })).sort((a, b) => `${a.projectId}:${a.workItemId}:${a.routeId}`.localeCompare(`${b.projectId}:${b.workItemId}:${b.routeId}`));
  const eligible = candidates.filter((candidate) => !candidate.exclusions?.length).map((candidate) => {
    const fairShareDebt = Math.max(0, candidate.targetShare - candidate.recentShareUsed);
    const score = fairShareDebt * 2 + candidate.priority * 1.5 + Math.min(candidate.queueAgeMinutes, 1_440) * 0.02
      + candidate.downstreamUnlockCount * 4 + candidate.deadlineRisk * 10 - candidate.estimatedCostUsd * 20;
    return { candidate, fairShareDebt, score };
  }).sort((a, b) => b.score - a.score || `${a.candidate.projectId}:${a.candidate.workItemId}:${a.candidate.routeId}`.localeCompare(`${b.candidate.projectId}:${b.candidate.workItemId}:${b.candidate.routeId}`));
  const winner = eligible[0];
  if (!winner) return { explanation: ["No candidate satisfies the hard scheduling rules."], rejected };
  return {
    selected: { projectId: winner.candidate.projectId, workItemId: winner.candidate.workItemId, routeId: winner.candidate.routeId },
    score: Math.round(winner.score * 100) / 100,
    explanation: [
      `Selected after ${winner.fairShareDebt.toFixed(2)} fair-share debt points.`,
      "Priority, deadline risk, queue age, downstream impact, and estimated cost were scored after hard exclusions.",
      "This decision is not an execution grant or resource reservation.",
    ],
    rejected,
  };
}
