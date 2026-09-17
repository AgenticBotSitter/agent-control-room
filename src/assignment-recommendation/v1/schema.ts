import { z } from "zod";
import { reportedEffortVocabularyV1 } from "./types";

const safeId = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const label = z.string().min(1).max(180);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);
const platform = z.enum(["windows", "macos", "linux", "cloud"]);
const effort = z.enum(reportedEffortVocabularyV1);
const basis = z.enum(["platform_allowed_by_policy", "platform_outside_policy", "capability_matches_required", "capability_probe_current",
  "capability_probe_unverified", "capability_missing", "capability_expired", "telemetry_current", "telemetry_stale", "telemetry_missing",
  "scratch_sufficient", "scratch_insufficient", "benchmark_current", "benchmark_missing", "benchmark_expired", "benchmark_environment_mismatch",
  "signal_identity_mismatch", "capacity_available", "capacity_exhausted", "historical_outcome_accepted", "historical_outcome_conflicting",
  "historical_outcome_insufficient", "historical_outcome_incomparable", "effort_reported", "effort_unreported", "cost_reported_historical",
  "cost_unreported", "usage_reported_historical", "usage_unreported"]);
const limit = z.enum(["capacity_evidence_missing", "effort_unreported", "historical_sample_insufficient", "historical_outcome_conflicting",
  "historical_outcome_incomparable", "cost_unreported", "usage_unreported", "capability_unverified", "eligibility_incomplete", "no_eligible_candidate"]);
const capacity = z.object({ available: z.boolean().nullable(), activeTaskCount: z.number().int().nonnegative().nullable(),
  maxConcurrentTasks: z.number().int().min(1).max(8).nullable() }).strict();

export const assignmentRecommendationAlternativeSchemaV1 = z.object({ nodeId: safeId, label, platform, executorId: safeId,
  capabilityProbeId: safeId, eligible: z.boolean().nullable(), capacity, basis: z.array(basis).max(24) }).strict();

export const assignmentRecommendationProjectionSchemaV1 = z.object({
  contractVersion: z.literal("control-room-assignment-recommendation/v1"),
  projectId: safeId, jobId: safeId, inputDigest: digest, generatedAt: instant,
  state: z.enum(["recommended", "limited", "unavailable"]),
  recommendation: z.object({ nodeId: safeId, label, platform, executorId: safeId, capabilityProbeId: safeId, harness: label,
    effort, modelClass: z.string().min(1).max(80), costTradeoff: z.object({ cost: z.enum(["reported_historical", "unknown"]),
      usage: z.enum(["reported_historical", "unknown"]), sampleSize: z.number().int().nonnegative(),
      reportedMinutesMedian: z.number().nonnegative().optional(),
      // A median over an even sample is fractional (10 and 11 reported tokens -> 10.5), so a
      // reported median is any nonnegative number; only the underlying observations are counts.
      reportedTokensMedian: z.number().nonnegative().optional() }).strict(),
    capacity, basis: z.array(basis).max(24) }).strict().nullable(),
  alternatives: z.array(assignmentRecommendationAlternativeSchemaV1).max(64),
  limits: z.array(limit).max(16),
  explanation: z.string().min(1).max(600),
  authority: z.object({ startsWork: z.literal(false), assignsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.state === "unavailable" && value.recommendation !== null) context.addIssue({ code: "custom", path: ["recommendation"], message: "an unavailable projection carries no recommendation" });
  if (value.state !== "unavailable" && value.recommendation === null) context.addIssue({ code: "custom", path: ["recommendation"], message: "an offered projection must name a machine" });
  if (value.state === "recommended" && value.limits.length) context.addIssue({ code: "custom", path: ["limits"], message: "a full recommendation carries no limits" });
});