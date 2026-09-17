import type { FleetSignalEnvelope } from "../../node-fleet/v1/schemas";

export const ASSIGNMENT_RECOMMENDATION_CONTRACT_V1 = "control-room-assignment-recommendation/v1" as const;

export type AssignmentPlatformV1 = "windows" | "macos" | "linux" | "cloud";

/**
 * Reported-effort vocabulary. Byte-identical to the set `scripts/public-model-outcomes.mjs`
 * accepts for a reported `Worker-Effort` field, so a historical row parsed from the public
 * report and a row read here stay comparable. `tests/vps-built-assignment.test.mjs` asserts
 * the parity, so drift on either side fails a test instead of silently producing a value the
 * other side calls incomparable.
 */
export const reportedEffortVocabularyV1 = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown"] as const;
export type ReportedEffortV1 = (typeof reportedEffortVocabularyV1)[number];

export type AssignmentRecommendationStateV1 = "recommended" | "limited" | "unavailable";

/** Why a projection is not fully evidenced. Every entry is an honest statement about
 *  evidence the recommendation does not have, never a warning about the product itself. */
export type AssignmentRecommendationLimitV1 =
  | "capacity_evidence_missing"
  | "effort_unreported"
  | "historical_sample_insufficient"
  | "historical_outcome_conflicting"
  | "historical_outcome_incomparable"
  | "cost_unreported"
  | "usage_unreported"
  | "capability_unverified"
  | "eligibility_incomplete"
  | "no_eligible_candidate";

/** The exact reason a recommendation was produced. These are the capability, platform,
 *  capacity and policy facts the surface is allowed to show, and they are the only ones. */
export type AssignmentRecommendationBasisV1 =
  | "platform_allowed_by_policy"
  | "platform_outside_policy"
  | "capability_matches_required"
  | "capability_probe_current"
  | "capability_probe_unverified"
  | "capability_missing"
  | "capability_expired"
  | "telemetry_current"
  | "telemetry_stale"
  | "telemetry_missing"
  | "scratch_sufficient"
  | "scratch_insufficient"
  | "benchmark_current"
  | "benchmark_missing"
  | "benchmark_expired"
  | "benchmark_environment_mismatch"
  | "signal_identity_mismatch"
  | "capacity_available"
  | "capacity_exhausted"
  | "historical_outcome_accepted"
  | "historical_outcome_conflicting"
  | "historical_outcome_insufficient"
  | "historical_outcome_incomparable"
  | "effort_reported"
  | "effort_unreported"
  | "cost_reported_historical"
  | "cost_unreported"
  | "usage_reported_historical"
  | "usage_unreported";

export interface AssignmentRecommendationPolicyV1 {
  /** The capability the work itself requires, e.g. `harness.hermes.native.runs.v1`. */
  requiredCapability: string;
  requireVerifiedCapability: boolean;
  requiredScratchBytes: number;
  requiredBenchmarkId?: string;
  allowedPlatforms: AssignmentPlatformV1[];
}

export interface AssignmentRecommendationCandidateV1 {
  nodeId: string;
  label: string;
  platform: AssignmentPlatformV1;
  executorId: string;
  capabilityProbeId: string;
  maxConcurrentTasks: number;
  activeTaskCount: number;
  leaseSeconds: number;
  requiredScratchBytes: number;
}

/** One historical model-outcome observation. Shape is the grouping the public model-outcome
 *  report already produces: reported model class, reported effort, and the resulting outcome.
 *  Nothing here is inferred from a provider, a price list or a live agent. */
export interface AssignmentRecommendationHistoryRowV1 {
  capabilityProbeId: string;
  modelClass: string;
  effort: ReportedEffortV1;
  outcome: "accepted" | "changes_required" | "blocked";
  recordedAt: string;
  reportedMinutes?: number;
  reportedTokens?: number;
}

export interface AssignmentRecommendationInputV1 {
  now: string;
  projectId: string;
  jobId: string;
  inputDigest: string;
  policy: AssignmentRecommendationPolicyV1;
  candidates: AssignmentRecommendationCandidateV1[];
  signals: FleetSignalEnvelope[];
  history: AssignmentRecommendationHistoryRowV1[];
}

export interface AssignmentRecommendationCapacityV1 {
  available: boolean;
  activeTaskCount: number;
  maxConcurrentTasks: number;
}

export interface AssignmentRecommendationAlternativeV1 {
  nodeId: string;
  label: string;
  platform: AssignmentPlatformV1;
  executorId: string;
  capabilityProbeId: string;
  eligible: boolean;
  capacity: AssignmentRecommendationCapacityV1;
  basis: AssignmentRecommendationBasisV1[];
}

export interface AssignmentRecommendationCostTradeoffV1 {
  cost: "reported_historical" | "unknown";
  usage: "reported_historical" | "unknown";
  sampleSize: number;
  reportedMinutesMedian?: number;
  reportedTokensMedian?: number;
}

export interface AssignmentRecommendationChoiceV1 {
  nodeId: string;
  label: string;
  platform: AssignmentPlatformV1;
  executorId: string;
  capabilityProbeId: string;
  /** Harness implied by the capability probe; `unreported` when the probe is not a known one. */
  harness: string;
  /** Recommended effort, or `unknown` when the evidence does not support a class. */
  effort: ReportedEffortV1;
  modelClass: string;
  costTradeoff: AssignmentRecommendationCostTradeoffV1;
  capacity: AssignmentRecommendationCapacityV1;
  basis: AssignmentRecommendationBasisV1[];
}

/**
 * A read-only, project-scoped recommendation. It owns no command, no reservation and no
 * provider call: `authority` is literal `false` on every field, and the module exports no
 * function that writes, assigns, starts or reserves anything.
 */
export interface AssignmentRecommendationProjectionV1 {
  contractVersion: typeof ASSIGNMENT_RECOMMENDATION_CONTRACT_V1;
  projectId: string;
  jobId: string;
  inputDigest: string;
  generatedAt: string;
  state: AssignmentRecommendationStateV1;
  recommendation: AssignmentRecommendationChoiceV1 | null;
  alternatives: AssignmentRecommendationAlternativeV1[];
  limits: AssignmentRecommendationLimitV1[];
  explanation: string;
  authority: { startsWork: false; assignsWork: false; grantsExecutionAuthority: false };
}

export interface AssignmentRecommendationScopeV1 {
  projectId: string;
  jobId: string;
  inputDigest: string;
}