import { evaluateFleetEligibility, type FleetEligibilityReason } from "../../node-fleet/v1/eligibility";
import type { FleetSignalEnvelope } from "../../node-fleet/v1/schemas";
import type {
  AssignmentRecommendationBasisV1,
  AssignmentRecommendationCandidateV1,
  AssignmentRecommendationCostTradeoffV1,
  AssignmentRecommendationHistoryRowV1,
  AssignmentRecommendationLimitV1,
  AssignmentRecommendationPolicyV1,
  ReportedEffortV1,
} from "./types";

/** Same shape the public model-outcome report accepts for a reported model class. A row whose
 *  class does not match is not comparable and is never averaged with one that does. */
const reportedModelClass = /^[A-Za-z0-9][A-Za-z0-9 ._:/+()-]{0,79}$/;
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
/** Fewer observations than this cannot support a recommendation; the surface says unknown. */
export const MIN_HISTORY_SAMPLE_V1 = 2;

const reasonBasis: Record<FleetEligibilityReason, AssignmentRecommendationBasisV1> = {
  signal_identity_mismatch: "signal_identity_mismatch",
  telemetry_missing: "telemetry_missing",
  telemetry_stale: "telemetry_stale",
  scratch_insufficient: "scratch_insufficient",
  capability_missing: "capability_missing",
  capability_expired: "capability_expired",
  capability_unverified: "capability_probe_unverified",
  benchmark_missing: "benchmark_missing",
  benchmark_expired: "benchmark_expired",
  benchmark_environment_mismatch: "benchmark_environment_mismatch",
};

export interface CandidateEvidenceV1 {
  candidate: AssignmentRecommendationCandidateV1;
  eligible: boolean;
  capacityAvailable: boolean;
  platformAllowed: boolean;
  capabilityMatchesRequired: boolean;
  eligibilityReasons: FleetEligibilityReason[];
  basis: AssignmentRecommendationBasisV1[];
}

export interface HistoryEvidenceV1 {
  sampleSize: number;
  modelClass: string;
  effort: ReportedEffortV1;
  costTradeoff: AssignmentRecommendationCostTradeoffV1;
  basis: AssignmentRecommendationBasisV1[];
  limits: AssignmentRecommendationLimitV1[];
}

/** A candidate is usable only when its identifiers are well formed; a malformed candidate is
 *  dropped rather than echoed, so the projection can never carry an unvalidated identifier. */
export function isWellFormedCandidateV1(candidate: AssignmentRecommendationCandidateV1): boolean {
  return safeId.test(candidate.nodeId) && safeId.test(candidate.executorId) && safeId.test(candidate.capabilityProbeId)
    && candidate.label.trim().length > 0 && candidate.label.length <= 180
    && Number.isSafeInteger(candidate.maxConcurrentTasks) && candidate.maxConcurrentTasks >= 1 && candidate.maxConcurrentTasks <= 8
    && Number.isSafeInteger(candidate.activeTaskCount) && candidate.activeTaskCount >= 0
    && Number.isSafeInteger(candidate.requiredScratchBytes) && candidate.requiredScratchBytes >= 0
    && Number.isSafeInteger(candidate.leaseSeconds) && candidate.leaseSeconds > 0;
}

/**
 * Reuses the canonical fleet eligibility function for one candidate. The only inputs are
 * persisted, authenticated fleet signals for that node plus the packet's own policy; no
 * provider, host or agent is contacted, and nothing is cached or written.
 */
export function evaluateCandidateEvidenceV1(candidate: AssignmentRecommendationCandidateV1,
  policy: AssignmentRecommendationPolicyV1, signals: FleetSignalEnvelope[], now: string): CandidateEvidenceV1 {
  const platformAllowed = policy.allowedPlatforms.includes(candidate.platform);
  const capabilityMatchesRequired = candidate.capabilityProbeId === policy.requiredCapability;
  const result = evaluateFleetEligibility({
    now,
    signals: signals.filter((signal) => signal.nodeId === candidate.nodeId),
    requiredScratchBytes: candidate.requiredScratchBytes,
    requiredCapabilityProbeId: candidate.capabilityProbeId,
    requireVerifiedCapability: policy.requireVerifiedCapability,
    ...(policy.requiredBenchmarkId ? { requiredBenchmarkId: policy.requiredBenchmarkId } : {}),
  });
  const capacityAvailable = candidate.activeTaskCount < candidate.maxConcurrentTasks;
  const basis: AssignmentRecommendationBasisV1[] = [
    platformAllowed ? "platform_allowed_by_policy" : "platform_outside_policy",
    capacityAvailable ? "capacity_available" : "capacity_exhausted",
  ];
  if (capabilityMatchesRequired && platformAllowed) basis.push("capability_matches_required");
  if (result.eligible && capabilityMatchesRequired && platformAllowed) basis.unshift("capability_probe_current", "telemetry_current", "scratch_sufficient");
  for (const reason of result.reasons) {
    const mapped = reasonBasis[reason];
    if (!basis.includes(mapped)) basis.push(mapped);
  }
  return {
    candidate,
    eligible: result.eligible && platformAllowed && capabilityMatchesRequired,
    capacityAvailable,
    platformAllowed,
    capabilityMatchesRequired,
    eligibilityReasons: result.reasons,
    basis,
  };
}

interface GroupV1 {
  key: string;
  modelClass: string;
  effort: ReportedEffortV1;
  accepted: number;
  total: number;
  minutes: number[];
  tokens: number[];
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 100) / 100;
}

/**
 * Historical model-outcome evidence for one capability probe. Rows are grouped by reported
 * model class and reported effort exactly as the public model-outcome report groups them, so
 * an incomparable class or an unreported effort can never be presented as a recommendation.
 */
export function evaluateHistoryEvidenceV1(candidate: AssignmentRecommendationCandidateV1,
  history: AssignmentRecommendationHistoryRowV1[]): HistoryEvidenceV1 {
  const all = history.filter((row) => row.capabilityProbeId === candidate.capabilityProbeId);
  const comparable = all.filter((row) => reportedModelClass.test(row.modelClass) && row.effort !== "unknown");
  const groups = new Map<string, GroupV1>();
  for (const row of comparable) {
    const key = `${row.modelClass}\u0000${row.effort}`;
    const group = groups.get(key) ?? { key, modelClass: row.modelClass, effort: row.effort, accepted: 0, total: 0, minutes: [], tokens: [] };
    group.total += 1;
    if (row.outcome === "accepted") group.accepted += 1;
    if (typeof row.reportedMinutes === "number" && Number.isFinite(row.reportedMinutes) && row.reportedMinutes >= 0) group.minutes.push(row.reportedMinutes);
    if (typeof row.reportedTokens === "number" && Number.isSafeInteger(row.reportedTokens) && row.reportedTokens >= 0) group.tokens.push(row.reportedTokens);
    groups.set(key, group);
  }
  const ranked = [...groups.values()].filter((group) => group.total >= MIN_HISTORY_SAMPLE_V1)
    .sort((left, right) => (right.accepted / right.total) - (left.accepted / left.total) || right.total - left.total || left.key.localeCompare(right.key));
  const unknown: HistoryEvidenceV1 = {
    sampleSize: 0,
    modelClass: "unreported",
    effort: "unknown",
    costTradeoff: { cost: "unknown", usage: "unknown", sampleSize: 0 },
    basis: [],
    limits: [],
  };
  const unreportedBasis: AssignmentRecommendationBasisV1[] = ["cost_unreported", "usage_unreported"];
  const unreportedLimits: AssignmentRecommendationLimitV1[] = ["cost_unreported", "usage_unreported"];
  if (!ranked.length) {
    // No comparable group is a statement about history, never a licence to guess a class.
    return comparable.length ? {
      ...unknown,
      basis: ["historical_outcome_insufficient", ...unreportedBasis],
      limits: ["historical_sample_insufficient", ...unreportedLimits],
    } : {
      ...unknown,
      basis: [all.length ? "historical_outcome_incomparable" : "historical_outcome_insufficient", ...unreportedBasis],
      limits: [all.length ? "historical_outcome_incomparable" : "historical_sample_insufficient", ...unreportedLimits],
    };
  }
  const [winner, runnerUp] = ranked;
  if (runnerUp && runnerUp.accepted / runnerUp.total === winner.accepted / winner.total) {
    return {
      ...unknown,
      basis: ["historical_outcome_conflicting", ...unreportedBasis],
      limits: ["historical_outcome_conflicting", ...unreportedLimits],
    };
  }
  const minutesMedian = median(winner.minutes), tokensMedian = median(winner.tokens);
  return {
    sampleSize: winner.total,
    modelClass: winner.modelClass,
    effort: winner.effort,
    costTradeoff: {
      cost: minutesMedian === undefined ? "unknown" : "reported_historical",
      usage: tokensMedian === undefined ? "unknown" : "reported_historical",
      sampleSize: winner.total,
      ...(minutesMedian === undefined ? {} : { reportedMinutesMedian: minutesMedian }),
      ...(tokensMedian === undefined ? {} : { reportedTokensMedian: tokensMedian }),
    },
    basis: [
      "historical_outcome_accepted",
      minutesMedian === undefined ? "cost_unreported" : "cost_reported_historical",
      tokensMedian === undefined ? "usage_unreported" : "usage_reported_historical",
      "effort_reported",
    ],
    limits: [
      ...(minutesMedian === undefined ? (["cost_unreported"] as AssignmentRecommendationLimitV1[]) : []),
      ...(tokensMedian === undefined ? (["usage_unreported"] as AssignmentRecommendationLimitV1[]) : []),
    ],
  };
}