import type { FleetSignalEnvelope } from "../../node-fleet/v1/schemas";
import { evaluateCandidateEvidenceV1, evaluateHistoryEvidenceV1, isWellFormedCandidateV1, type CandidateEvidenceV1 } from "./evidence";
import {
  ASSIGNMENT_RECOMMENDATION_CONTRACT_V1,
  type AssignmentRecommendationAlternativeV1,
  type AssignmentRecommendationBasisV1,
  type AssignmentRecommendationCandidateV1,
  type AssignmentRecommendationInputV1,
  type AssignmentRecommendationLimitV1,
  type AssignmentRecommendationProjectionV1,
  type AssignmentRecommendationScopeV1,
} from "./types";

/** Harness implied by a canonical capability probe. An unknown probe stays `unreported`
 *  instead of being mapped to a plausible harness; the parity test pins the Codex id to
 *  `CODEX_APP_SERVER_CAPABILITY` in src/harness/codex-v1/delivery-contract.ts. */
export const harnessByProbeIdV1: Readonly<Record<string, string>> = Object.freeze({
  "harness.hermes.native.runs.v1": "hermes-native",
  "harness.codex.app-server.v1": "codex-app-server",
});

export function harnessForProbeV1(capabilityProbeId: string): string {
  return harnessByProbeIdV1[capabilityProbeId] ?? "unreported";
}

function summarizeReasons(evidence: CandidateEvidenceV1[]): string {
  const reasons = [...new Set(evidence.flatMap((item) => item.basis
    .filter((basis) => !["platform_allowed_by_policy", "capacity_available", "capability_matches_required", "capability_probe_current", "telemetry_current", "scratch_sufficient"].includes(basis))))];
  return reasons.length ? reasons.slice(0, 4).join(", ") : "no candidate was offered for this task";
}

function rank(evidence: CandidateEvidenceV1[]): CandidateEvidenceV1[] {
  return [...evidence].sort((left, right) => Number(right.eligible) - Number(left.eligible)
    || Number(right.capacityAvailable) - Number(left.capacityAvailable)
    || (right.candidate.maxConcurrentTasks - right.candidate.activeTaskCount) - (left.candidate.maxConcurrentTasks - left.candidate.activeTaskCount)
    || left.candidate.nodeId.localeCompare(right.candidate.nodeId));
}

function alternative(evidence: CandidateEvidenceV1): AssignmentRecommendationAlternativeV1 {
  return {
    nodeId: evidence.candidate.nodeId,
    label: evidence.candidate.label,
    platform: evidence.candidate.platform,
    executorId: evidence.candidate.executorId,
    capabilityProbeId: evidence.candidate.capabilityProbeId,
    eligible: evidence.eligible,
    capacity: {
      available: evidence.capacityAvailable,
      activeTaskCount: evidence.candidate.activeTaskCount,
      maxConcurrentTasks: evidence.candidate.maxConcurrentTasks,
    },
    basis: evidence.basis,
  };
}

/**
 * The whole recommendation surface: a total, deterministic, effect-free function over
 * evidence the caller already holds. It reads no store, calls no provider, reserves no
 * capacity and returns nothing a caller can execute — `authority` is literal false.
 */
export function evaluateAssignmentRecommendationV1(input: AssignmentRecommendationInputV1): AssignmentRecommendationProjectionV1 {
  const candidates = input.candidates.filter(isWellFormedCandidateV1);
  const evidence = rank(candidates.map((candidate) => evaluateCandidateEvidenceV1(candidate, input.policy, input.signals, input.now)));
  const usable = evidence.filter((item) => item.eligible && item.capacityAvailable);
  const alternatives = evidence.map(alternative);
  const base = {
    contractVersion: ASSIGNMENT_RECOMMENDATION_CONTRACT_V1,
    projectId: input.projectId,
    jobId: input.jobId,
    inputDigest: input.inputDigest,
    generatedAt: input.now,
    alternatives,
    authority: { startsWork: false, assignsWork: false, grantsExecutionAuthority: false } as const,
  };
  if (!usable.length) {
    const eligibilityIncomplete = evidence.some((item) => item.eligible && !item.capacityAvailable) || evidence.some((item) => item.eligibilityReasons.length > 0);
    const limits: AssignmentRecommendationLimitV1[] = [ "no_eligible_candidate", ...(eligibilityIncomplete ? (["eligibility_incomplete"] as AssignmentRecommendationLimitV1[]) : []) ];
    return { ...base, state: "unavailable", recommendation: null, limits,
      explanation: `No offered machine is currently eligible for this task (${summarizeReasons(evidence)}). Nothing is reserved and no work is started.` };
  }
  const chosen = usable[0], history = evaluateHistoryEvidenceV1(chosen.candidate, input.history);
  const effortUnknown = history.effort === "unknown";
  const basis: AssignmentRecommendationBasisV1[] = [...chosen.basis, ...history.basis];
  if (effortUnknown && !history.basis.includes("historical_outcome_conflicting") && !history.basis.includes("historical_outcome_insufficient")
    && !history.basis.includes("historical_outcome_incomparable")) basis.push("effort_unreported");
  if (input.policy.requireVerifiedCapability && chosen.eligibilityReasons.includes("capability_unverified")) basis.push("capability_probe_unverified");
  const limits: AssignmentRecommendationLimitV1[] = [...history.limits,
    ...(effortUnknown ? (["effort_unreported"] as AssignmentRecommendationLimitV1[]) : []),
    ...(input.policy.requireVerifiedCapability && chosen.eligibilityReasons.includes("capability_unverified") ? (["capability_unverified"] as AssignmentRecommendationLimitV1[]) : [])];
  const uniqueLimits = [...new Set(limits)];
  const free = chosen.candidate.maxConcurrentTasks - chosen.candidate.activeTaskCount;
  return {
    ...base,
    state: uniqueLimits.length ? "limited" : "recommended",
    recommendation: {
      nodeId: chosen.candidate.nodeId,
      label: chosen.candidate.label,
      platform: chosen.candidate.platform,
      executorId: chosen.candidate.executorId,
      capabilityProbeId: chosen.candidate.capabilityProbeId,
      harness: harnessForProbeV1(chosen.candidate.capabilityProbeId),
      effort: history.effort,
      modelClass: history.modelClass,
      costTradeoff: history.costTradeoff,
      capacity: { available: chosen.capacityAvailable, activeTaskCount: chosen.candidate.activeTaskCount, maxConcurrentTasks: chosen.candidate.maxConcurrentTasks },
      basis: [...new Set(basis)],
    },
    limits: uniqueLimits,
    explanation: `${chosen.candidate.label} (${chosen.candidate.platform}) matches ${input.policy.requiredCapability} and has ${free} of ${chosen.candidate.maxConcurrentTasks} slot(s) free. `
      + (uniqueLimits.length ? `Recommendation is limited: ${uniqueLimits.join(", ")}.` : "Effort, cost and usage rest on reported historical outcomes.")
      + " Choosing a different eligible machine still goes through the same protected assignment check; this recommendation assigns nothing.",
  };
}

/** The scope guard the presentation uses: a projection is usable only for the exact project,
 *  task and input digest it was computed for. */
export function recommendationScopeMatchesV1(projection: Pick<AssignmentRecommendationProjectionV1, "projectId" | "jobId" | "inputDigest">,
  scope: AssignmentRecommendationScopeV1): boolean {
  return projection.projectId === scope.projectId && projection.jobId === scope.jobId && projection.inputDigest === scope.inputDigest;
}

/**
 * The honest projection for the browser assignment surface, which can read configured routes
 * only. Capability, capacity, effort, cost and usage evidence for this task is not reachable
 * there, so the surface reports it as unknown rather than guessing.
 */
export function evaluateConfiguredRouteRecommendationV1(input: {
  now: string; projectId: string; jobId: string; inputDigest: string;
  candidates: Array<{ nodeId: string; label: string; platform: AssignmentRecommendationCandidateV1["platform"] }>;
  requiredCapability?: string; allowedPlatforms?: AssignmentRecommendationCandidateV1["platform"][];
}): AssignmentRecommendationProjectionV1 {
  const allowed = input.allowedPlatforms ?? ["windows", "macos", "linux", "cloud"];
  const candidates: AssignmentRecommendationCandidateV1[] = input.candidates.filter((candidate) => allowed.includes(candidate.platform))
    .map((candidate) => ({ ...candidate, executorId: "executor:unreported", capabilityProbeId: input.requiredCapability ?? "unreported",
      maxConcurrentTasks: 1, activeTaskCount: 0, leaseSeconds: 1, requiredScratchBytes: 0 }));
  const limits: AssignmentRecommendationLimitV1[] = ["capacity_evidence_missing", "effort_unreported", "cost_unreported", "usage_unreported", "eligibility_incomplete"];
  if (!candidates.length) return { contractVersion: ASSIGNMENT_RECOMMENDATION_CONTRACT_V1, projectId: input.projectId, jobId: input.jobId,
    inputDigest: input.inputDigest, generatedAt: input.now, state: "unavailable", recommendation: null, alternatives: [],
    limits: ["no_eligible_candidate"], explanation: "No configured machine matches this task's platform. Nothing is reserved and no work is started.",
    authority: { startsWork: false, assignsWork: false, grantsExecutionAuthority: false } };
  const chosen = [...candidates].sort((left, right) => left.nodeId.localeCompare(right.nodeId))[0];
  return {
    contractVersion: ASSIGNMENT_RECOMMENDATION_CONTRACT_V1,
    projectId: input.projectId, jobId: input.jobId, inputDigest: input.inputDigest, generatedAt: input.now,
    state: "limited",
    recommendation: {
      nodeId: chosen.nodeId, label: chosen.label, platform: chosen.platform, executorId: chosen.executorId,
      capabilityProbeId: chosen.capabilityProbeId, harness: harnessForProbeV1(chosen.capabilityProbeId),
      effort: "unknown", modelClass: "unreported",
      costTradeoff: { cost: "unknown", usage: "unknown", sampleSize: 0 },
      capacity: { available: true, activeTaskCount: 0, maxConcurrentTasks: 1 },
      basis: ["platform_allowed_by_policy"],
    },
    alternatives: candidates.map((candidate) => ({ nodeId: candidate.nodeId, label: candidate.label, platform: candidate.platform,
      executorId: candidate.executorId, capabilityProbeId: candidate.capabilityProbeId, eligible: true,
      capacity: { available: true, activeTaskCount: 0, maxConcurrentTasks: 1 }, basis: ["platform_allowed_by_policy"] as AssignmentRecommendationBasisV1[] })),
    limits,
    explanation: `${chosen.label} (${chosen.platform}) is a configured machine for this task. Capability, capacity, effort, cost and usage evidence is not readable here and stays unknown; `
      + "it is verified by the protected assignment check, and choosing any other configured machine goes through that same check. This recommendation assigns nothing.",
    authority: { startsWork: false, assignsWork: false, grantsExecutionAuthority: false },
  };
}

export { evaluateCandidateEvidenceV1, evaluateHistoryEvidenceV1 };
export type { FleetSignalEnvelope };