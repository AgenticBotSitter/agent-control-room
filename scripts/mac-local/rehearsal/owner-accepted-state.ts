// Post-acceptance review-state guard for the Mac-local rehearsal journey
// (scripts/mac-local/rehearsal/journey.ts).
//
// Why this module exists: after the owner's accept POST returns 201, the review
// target reads `pending` ONLY while the automatic structure verification is still
// unrecorded. A background quality sweep (`setInterval(..., 2_000)` in
// src/web/v1/mac-local-default-task-provider.ts) runs that verification
// autonomously, and the next read then derives `ready`. The journey used to assert
// the bare scalar `=== "pending"`, which is a race against that sweep — CI job
// "Full Mac-local rehearsal" failed that way on #404 run 36506721943.
//
// The guard is a DERIVATION, not a widened bound. The results page's `status`,
// `missingVerificationScenarioIds` and `verifications` all come from ONE
// completion-gate snapshot (src/web/v1/task-service.ts), so exactly one status is
// correct for the evidence that page carries, and it is computed here with the
// same rule the store uses (src/completion-gate/v1/store.ts). A genuinely wrong
// status still fails; only the two provably-correct orders pass.
//
// The guard trusts no single one of those fields: it CROSS-CHECKS the missing set
// against the recorded verifications, so a page whose two views of the
// verification set disagree is refused rather than believed. The profile's
// scenario ids are needed for exactly one thing the page cannot supply — the
// store's `blocked` rule, which distinguishes a REQUIRED verification from one
// that is merely recorded.

/** The subset of one results page this guard reads. */
export type OwnerAcceptedReviewPage = {
  status: string;
  /** Required scenarios not yet satisfied by a passed verification. */
  missingVerificationScenarioIds: readonly string[];
  /** Every recorded verification, so a lying missing-set can be caught. */
  verifications: readonly { scenarioId: string; outcome: string }[];
  /** Saved reviews recorded against this target. */
  reviews: readonly { decision: string; authority: string }[];
  /** Open findings force `changes_requested` ahead of any other terminal state. */
  openFindingCount: number;
};

export type OwnerAcceptedExpectation = Readonly<{
  /** The decision the owner just recorded. */
  decision: "accepted" | "changes_requested";
  /** The acceptance profile's required scenario ids. */
  requiredVerificationScenarioIds: readonly string[];
  /** Independent accepted completion-gate reviews the profile requires. */
  minimumIndependentReviews: number;
}>;

export type OwnerAcceptedStateVerdict =
  Readonly<{ ok: true; status: string } | { ok: false; status: string; problem: string }>;

/** Distinct accepted completion-gate reviews, counted as the store counts them. */
function acceptedReviewCountV1(reviews: readonly { decision: string; authority: string }[]): number {
  return reviews.filter(review => review.authority === "completion_gate" && review.decision === "accepted").length;
}

/** The store's `blocked` term: a REQUIRED scenario that did not pass blocks. */
function blockedVerificationV1(page: OwnerAcceptedReviewPage, expectation: OwnerAcceptedExpectation): boolean {
  const required = new Set(expectation.requiredVerificationScenarioIds);
  return page.verifications.some(verification => required.has(verification.scenarioId) && verification.outcome !== "passed");
}

/**
 * The exact status the completion-gate snapshot rule yields for this evidence.
 *
 * Rule order matches `CompletionGateStoreV1` (findings, then blocked verification,
 * then the missing set, then the review count). A revision (`superseded`) and
 * `revision_limit_reached` are not modelled: this journey records exactly one
 * decision and no revision, so both would be a distinct failure rather than a
 * state this guard has to accommodate. `verification_blocked` IS modelled,
 * because the automatic sweep's own verifier can record a non-passing outcome.
 */
export function expectedOwnerAcceptedStatusV1(
  page: OwnerAcceptedReviewPage,
  expectation: OwnerAcceptedExpectation,
): string {
  // An open finding outranks the verification state (store.ts checks findings first).
  if (page.openFindingCount > 0) return "changes_requested";
  if (blockedVerificationV1(page, expectation)) return "verification_blocked";
  // An owner acceptance is a saved quality vote, not automatic completion: while
  // any required verification is still missing the target stays `pending`, and
  // only a passed verification for every required scenario (the background
  // quality sweep's job) may carry it to `ready`.
  return page.missingVerificationScenarioIds.length === 0
    && acceptedReviewCountV1(page.reviews) >= expectation.minimumIndependentReviews ? "ready" : "pending";
}

/**
 * Check the page the journey read against the evidence that same page reports.
 * Returns a verdict carrying the observed status, so the caller can assert rather
 * than this throwing from inside a rehearsal helper.
 */
export function checkOwnerAcceptedStateV1(
  page: OwnerAcceptedReviewPage,
  expectation: OwnerAcceptedExpectation,
): OwnerAcceptedStateVerdict {
  const savedDecision = page.reviews.find(review => review.decision === expectation.decision
    && review.authority === "completion_gate");
  if (!savedDecision) {
    return { ok: false, status: page.status,
      problem: `no completion-gate review with decision ${JSON.stringify(expectation.decision)} is saved on this target` };
  }
  // One direction of the gate's invariant, and the one that carries the race:
  // `ready` is only derivable when nothing required is missing. The converse does
  // NOT hold — a target whose verifications all passed can still read
  // `changes_requested` because an open finding outranks it — so this must not be
  // applied in both directions.
  if (page.status === "ready" && page.missingVerificationScenarioIds.length > 0) {
    return { ok: false, status: page.status,
      problem: `review status "ready" disagrees with missingVerificationScenarioIds=`
        + `${JSON.stringify([...page.missingVerificationScenarioIds])} in the same page` };
  }
  // Cross-check the two product-computed views of the verification set against
  // each other. Without this, a page claiming nothing is missing while carrying a
  // non-passing verification would be read as `ready`, which the store would never
  // derive. The scenario list is what makes a verification REQUIRED rather than
  // merely recorded, so this check cannot be dropped in favour of the missing set.
  const recordedRequired = new Set(expectation.requiredVerificationScenarioIds);
  const passedRequired = new Set(page.verifications.filter(verification => verification.outcome === "passed"
    && recordedRequired.has(verification.scenarioId)).map(verification => verification.scenarioId));
  const derivedMissing = [...recordedRequired].filter(scenarioId => !passedRequired.has(scenarioId)).sort();
  const reportedMissing = [...page.missingVerificationScenarioIds].sort();
  if (derivedMissing.join("|") !== reportedMissing.join("|")) {
    return { ok: false, status: page.status,
      problem: `the page's two views of the verification set disagree: verifications imply missing=`
        + `${JSON.stringify(derivedMissing)}, missingVerificationScenarioIds=${JSON.stringify(reportedMissing)}` };
  }
  const expected = expectedOwnerAcceptedStatusV1(page, expectation);
  if (page.status !== expected) {
    return { ok: false, status: page.status,
      problem: `review status must be the value the completion gate derives for the verifications this page reports: `
        + `expected ${JSON.stringify(expected)}, observed ${JSON.stringify(page.status)}, `
        + `missingVerificationScenarioIds=${JSON.stringify(reportedMissing)}, `
        + `savedReviews=${page.reviews.length}, openFindings=${page.openFindingCount}` };
  }
  return { ok: true, status: page.status };
}

/** The one-line message the rehearsal prints when this guard bites. */
export function ownerAcceptedStateMessageV1(agentKind: string, decision: "accepted" | "changes_requested"): string {
  return `${agentKind}: ${decision === "accepted"
    ? "owner acceptance is a quality vote: the target must be pending until the automatic structure verification passes, then ready"
    : "a changes-requested review must leave the target changes_requested"}`;
}
