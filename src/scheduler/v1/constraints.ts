export const privacyClassesV1 = ["local", "private_tenant", "approved_provider"] as const;
export type PrivacyClassV1 = (typeof privacyClassesV1)[number];

export const qualityClassesV1 = ["unavailable", "provisional", "verified"] as const;
export type QualityClassV1 = (typeof qualityClassesV1)[number];

export type ConstraintRejectionV1 =
  | "cost_limit_exceeded"
  | "privacy_denied"
  | "quality_insufficient"
  | "deadline_missed"
  | "maintenance"
  | "resource_draining"
  | "invalid_candidate";

export interface SchedulingConstraintsV1 {
  cost?: {
    estimatedMicrousd: number;
    limitMicrousd: number;
  };
  privacy?: {
    privacyClass: PrivacyClassV1;
    allowedPrivacyClasses: PrivacyClassV1[];
  };
  quality?: {
    observed: QualityClassV1;
    minimum: QualityClassV1;
  };
  deadline?: {
    predictedFinishAt: string;
    deadlineAt: string;
    enforcement: "soft" | "hard";
  };
  resourceState?: "available" | "maintenance" | "draining";
}

function instant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function invalid(input: SchedulingConstraintsV1): boolean {
  if (input.cost && (!Number.isSafeInteger(input.cost.estimatedMicrousd) || input.cost.estimatedMicrousd < 0
    || !Number.isSafeInteger(input.cost.limitMicrousd) || input.cost.limitMicrousd < 0)) return true;
  if (input.privacy && (!privacyClassesV1.includes(input.privacy.privacyClass)
    || input.privacy.allowedPrivacyClasses.length === 0
    || new Set(input.privacy.allowedPrivacyClasses).size !== input.privacy.allowedPrivacyClasses.length
    || !input.privacy.allowedPrivacyClasses.every((value) => privacyClassesV1.includes(value)))) return true;
  if (input.quality && (!qualityClassesV1.includes(input.quality.observed) || !qualityClassesV1.includes(input.quality.minimum))) return true;
  if (input.deadline && (!instant(input.deadline.predictedFinishAt) || !instant(input.deadline.deadlineAt)
    || !["soft", "hard"].includes(input.deadline.enforcement))) return true;
  if (input.resourceState && !["available", "maintenance", "draining"].includes(input.resourceState)) return true;
  return false;
}

/** Evaluates declared scheduling facts only. Budget consumption and resource acquisition remain separate atomic operations. */
export function evaluateSchedulingConstraintsV1(input: SchedulingConstraintsV1): ConstraintRejectionV1[] {
  if (invalid(input)) return ["invalid_candidate"];
  const rejected: ConstraintRejectionV1[] = [];
  if (input.cost && input.cost.estimatedMicrousd > input.cost.limitMicrousd) rejected.push("cost_limit_exceeded");
  if (input.privacy && !input.privacy.allowedPrivacyClasses.includes(input.privacy.privacyClass)) rejected.push("privacy_denied");
  if (input.quality && qualityClassesV1.indexOf(input.quality.observed) < qualityClassesV1.indexOf(input.quality.minimum)) rejected.push("quality_insufficient");
  if (input.deadline?.enforcement === "hard" && Date.parse(input.deadline.predictedFinishAt) > Date.parse(input.deadline.deadlineAt)) rejected.push("deadline_missed");
  if (input.resourceState === "maintenance") rejected.push("maintenance");
  if (input.resourceState === "draining") rejected.push("resource_draining");
  return rejected.sort();
}
