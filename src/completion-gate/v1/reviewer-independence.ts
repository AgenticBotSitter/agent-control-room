import type { CompletionAcceptanceProfileV1, CompletionPrincipalV1 } from "./types";

export type ReviewerIndependencePolicyV1 = "different_worker" | "different_model_family";

export type ReviewerIndependenceSafeCodeV1 = "reviewer_not_independent" | "reviewer_provenance_missing";

export class ReviewerIndependenceErrorV1 extends Error {
  constructor(readonly safeCode: ReviewerIndependenceSafeCodeV1) {
    super(safeCode);
    this.name = "ReviewerIndependenceErrorV1";
  }
}

export function reviewerSeparationForPolicyV1(policy: ReviewerIndependencePolicyV1): CompletionAcceptanceProfileV1["reviewerSeparation"] {
  return Object.freeze({
    actor: true,
    worker: true,
    agentProfile: true,
    harness: true,
    modelFamily: policy === "different_model_family",
  });
}

/**
 * Quality reviewers fail closed on every configured provenance axis. Human
 * owners are deliberately exempt from agent provenance checks, but never from
 * actor separation: an identity still cannot review a target it produced.
 */
export function assertReviewerIndependentV1(producer: CompletionPrincipalV1, reviewer: CompletionPrincipalV1,
  separation: CompletionAcceptanceProfileV1["reviewerSeparation"]): void {
  const axes: readonly [keyof typeof separation, keyof CompletionPrincipalV1][] = [
    ["actor", "actorId"], ["worker", "workerId"], ["agentProfile", "agentProfileId"],
    ["harness", "harness"], ["modelFamily", "modelFamily"],
  ];
  for (const [policy, field] of axes) {
    if (!separation[policy] || reviewer.actorType === "human" && policy !== "actor") continue;
    const source = producer[field], candidate = reviewer[field];
    if (typeof source !== "string" || typeof candidate !== "string")
      throw new ReviewerIndependenceErrorV1("reviewer_provenance_missing");
    if (source === candidate) throw new ReviewerIndependenceErrorV1("reviewer_not_independent");
  }
}
