// The post-acceptance review-status guard used by the Mac-local rehearsal
// journey (scripts/mac-local/rehearsal/journey.ts).
//
// This test is the deterministic reproduction of the CI flake in the "Full
// Mac-local rehearsal" job. The sweep that flips the status runs on a 2s timer
// inside the rehearsal's own task host, so its interleaving with the journey's
// next read cannot be forced from the journey. It IS fully determined by the
// evidence the results page carries, and these cases drive both real orders plus
// every status that must still be refused.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { checkOwnerAcceptedStateV1, expectedOwnerAcceptedStatusV1,
  ownerAcceptedStateMessageV1 } from "../scripts/mac-local/rehearsal/owner-accepted-state";
import { createMacLocalOwnerReviewProfileV1, MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1,
  MAC_LOCAL_TEXT_SCENARIO_V1 } from "../src/web/v1/mac-local-owner-review-profile";

const profile = createMacLocalOwnerReviewProfileV1({ tenantId: "tenant:mac-local", projectId: "project:alpha",
  ownerIdentityId: "identity:owner", projectCreatedAt: "2026-09-28T12:00:00.000Z" });
const required = profile.requiredVerificationScenarioIds;
const accepted = { decision: "accepted" as const, requiredVerificationScenarioIds: required,
  minimumIndependentReviews: profile.minimumIndependentReviews };
const changed = { decision: "changes_requested" as const, requiredVerificationScenarioIds: required,
  minimumIndependentReviews: profile.minimumIndependentReviews };
const savedReview = { decision: "accepted", authority: "completion_gate" };

/** The page the journey reads, in each of the two orders the real sweep allows. */
const sweepHasNotRunYet = { status: "pending", missingVerificationScenarioIds: [MAC_LOCAL_TEXT_SCENARIO_V1],
  verifications: [{ scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, outcome: "passed" }],
  reviews: [savedReview], openFindingCount: 0 };
const sweepHasRun = { status: "ready", missingVerificationScenarioIds: [],
  verifications: required.map(scenarioId => ({ scenarioId, outcome: "passed" })),
  reviews: [savedReview], openFindingCount: 0 };

test("the v2 Mac-local profile requires the human scenario and the automatic text scenario", () => {
  assert.deepEqual(required, [MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, MAC_LOCAL_TEXT_SCENARIO_V1]);
  assert.equal(profile.minimumIndependentReviews, 1);
});

test("owner acceptance is pending until the automatic sweep passes, then ready", () => {
  // The sweep has not yet recorded the automatic structure scenario: pending.
  assert.equal(expectedOwnerAcceptedStatusV1(sweepHasNotRunYet, accepted), "pending");
  assert.equal(checkOwnerAcceptedStateV1(sweepHasNotRunYet, accepted).ok, true);
  // The sweep has: nothing required is missing, so the same accept derives ready.
  // This is the case that failed on main, where journey.ts:506 asserted a bare "pending".
  assert.equal(expectedOwnerAcceptedStatusV1(sweepHasRun, accepted), "ready");
  assert.equal(checkOwnerAcceptedStateV1(sweepHasRun, accepted).ok, true);
});

test("the saved owner decision must be present in the reviews the page reports", () => {
  for (const reviews of [[], [{ decision: "commented", authority: "completion_gate" }],
    [{ decision: "changes_requested", authority: "completion_gate" }]]) {
    const verdict = checkOwnerAcceptedStateV1({ ...sweepHasNotRunYet, reviews }, accepted);
    assert.equal(verdict.ok, false, `reviews ${JSON.stringify(reviews)} must not satisfy an acceptance`);
    assert.match(verdict.ok ? "" : verdict.problem, /no completion-gate review with decision/u);
  }
});

test("the page's two views of the verification set must agree", () => {
  // Mutation-survivor case. Every other guard either accepts or refuses this page
  // on its own, so the cross-check needs a case where the two product-computed
  // views disagree AND nothing else fires: missing=[] claims every required
  // scenario passed, but no verification for the text scenario is recorded at all.
  const lying = { status: "ready", missingVerificationScenarioIds: [],
    verifications: [{ scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, outcome: "passed" }],
    reviews: [savedReview], openFindingCount: 0 };
  const verdict = checkOwnerAcceptedStateV1(lying, accepted);
  assert.equal(verdict.ok, false, "a missing set that no recorded verification supports must be refused");
  assert.match(verdict.ok ? "" : verdict.problem, /two views of the verification set disagree/u);
  // The other direction: a scenario reported as missing whose verification did pass.
  const understated = { status: "pending", missingVerificationScenarioIds: [...required],
    verifications: required.map(scenarioId => ({ scenarioId, outcome: "passed" })),
    reviews: [savedReview], openFindingCount: 0 };
  const second = checkOwnerAcceptedStateV1(understated, accepted);
  assert.equal(second.ok, false, "a missing set that contradicts a passed verification must be refused");
  assert.match(second.ok ? "" : second.problem, /two views of the verification set disagree/u);
});

test("an advisory accepted review does not satisfy an owner acceptance", () => {
  // Self-review finding: the two checks in the guard must use the same notion of
  // "an owner review". The count rule already filtered on authority; the
  // decision-presence check did not, so an advisory accept satisfied it.
  const advisory = { ...sweepHasNotRunYet, reviews: [{ decision: "accepted", authority: "advisory" }] };
  const verdict = checkOwnerAcceptedStateV1(advisory, accepted);
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.problem, /no completion-gate review with decision/u);
  // And it must not count toward the gate vote either.
  const voting = { ...sweepHasRun, reviews: [{ decision: "accepted", authority: "advisory" }] };
  assert.equal(expectedOwnerAcceptedStatusV1(voting, accepted), "pending");
});

test("a lying missing set cannot be used to claim ready", () => {
  // Self-review BLOCKING finding: with only the missing set and no `verifications`
  // cross-check, this page read as ready. The store derives verification_blocked,
  // so claiming ready is wrong and must be refused.
  const lying = { status: "ready", missingVerificationScenarioIds: [],
    verifications: [{ scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, outcome: "passed" },
      { scenarioId: MAC_LOCAL_TEXT_SCENARIO_V1, outcome: "failed" }],
    reviews: [savedReview], openFindingCount: 0 };
  const verdict = checkOwnerAcceptedStateV1(lying, accepted);
  assert.equal(verdict.ok, false, "a non-passing verification must never be accepted as ready");
  // And the status the guard DOES derive for that evidence is verification_blocked.
  assert.equal(expectedOwnerAcceptedStatusV1(lying, accepted), "verification_blocked");
});

test("a non-passing required verification derives verification_blocked", () => {
  for (const outcome of ["failed", "blocked", "inconclusive"]) {
    // A non-passing verification is NOT in the store's `passed` set, so the store
    // reports the scenario as missing AND blocked. This fixture initially claimed
    // missing=[] and the guard's cross-check refused it, which is that check
    // working: a failed verification is not a satisfied one.
    const page = { status: "verification_blocked", missingVerificationScenarioIds: [MAC_LOCAL_TEXT_SCENARIO_V1],
      verifications: [{ scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, outcome: "passed" },
        { scenarioId: MAC_LOCAL_TEXT_SCENARIO_V1, outcome }],
      reviews: [savedReview], openFindingCount: 0 };
    assert.equal(expectedOwnerAcceptedStatusV1(page, accepted), "verification_blocked",
      `outcome ${outcome} must block`);
    assert.equal(checkOwnerAcceptedStateV1(page, accepted).ok, true,
      `the store's own verification_blocked output for outcome ${outcome} must be accepted, not fought`);
  }
});

test("a non-passing verification that is NOT required does not block", () => {
  const page = { ...sweepHasRun, verifications: [...sweepHasRun.verifications,
    { scenarioId: "scenario:unrelated", outcome: "failed" }] };
  assert.equal(expectedOwnerAcceptedStatusV1(page, accepted), "ready");
  assert.equal(checkOwnerAcceptedStateV1(page, accepted).ok, true);
});

test("an open finding outranks a blocking verification", () => {
  const page = { ...sweepHasRun, verifications: [...sweepHasRun.verifications,
    { scenarioId: MAC_LOCAL_TEXT_SCENARIO_V1, outcome: "failed" }], openFindingCount: 1 };
  assert.equal(expectedOwnerAcceptedStatusV1(page, accepted), "changes_requested",
    "findings are checked before blocked verification, as the store does");
});

test("a profile requiring more independent reviews stays pending", () => {
  const one = { ...sweepHasRun, reviews: [savedReview] };
  assert.equal(expectedOwnerAcceptedStatusV1(one, { ...accepted, minimumIndependentReviews: 2 }), "pending");
  assert.equal(expectedOwnerAcceptedStatusV1({ ...one, reviews: [savedReview, savedReview] },
    { ...accepted, minimumIndependentReviews: 2 }), "ready");
});

test("a status that the reported evidence does not support is refused", () => {
  for (const wrong of ["changes_requested", "verification_blocked", "revision_limit_reached", "superseded", "", "READY"]) {
    const verdict = checkOwnerAcceptedStateV1({ ...sweepHasNotRunYet, status: wrong }, accepted);
    assert.equal(verdict.ok, false, `status ${JSON.stringify(wrong)} must be refused while a scenario is still missing`);
  }
  const early = checkOwnerAcceptedStateV1({ ...sweepHasRun, status: "pending" }, accepted);
  assert.equal(early.ok, false, "ready evidence reported as pending must be refused");
});

test("ready must not be claimed while a required scenario is still missing", () => {
  const inconsistent = { status: "ready", missingVerificationScenarioIds: [MAC_LOCAL_TEXT_SCENARIO_V1],
    verifications: [{ scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, outcome: "passed" }],
    reviews: [savedReview], openFindingCount: 0 };
  const verdict = checkOwnerAcceptedStateV1(inconsistent, accepted);
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.problem, /disagrees with missingVerificationScenarioIds/u);
});

test("a changes-requested target may have every verification passed and still not be ready", () => {
  // The converse of the ready invariant is NOT an invariant: open findings outrank
  // passed verifications in the gate's derivation, so this page is legal.
  const legal = { status: "changes_requested", missingVerificationScenarioIds: [],
    verifications: required.map(scenarioId => ({ scenarioId, outcome: "passed" })),
    reviews: [{ decision: "changes_requested", authority: "completion_gate" }], openFindingCount: 1 };
  assert.equal(expectedOwnerAcceptedStatusV1(legal, changed), "changes_requested");
  assert.equal(checkOwnerAcceptedStateV1(legal, changed).ok, true);
});

test("a changes-requested decision never reads ready", () => {
  const page = { status: "changes_requested", missingVerificationScenarioIds: [...required],
    verifications: [], reviews: [{ decision: "changes_requested", authority: "completion_gate" }], openFindingCount: 1 };
  assert.equal(checkOwnerAcceptedStateV1(page, changed).ok, true);
  const slipped = checkOwnerAcceptedStateV1({ ...page, status: "ready" }, changed);
  assert.equal(slipped.ok, false, "a changes-requested target must never read ready");
  // The invariant check fires first here and names the more specific contradiction.
  assert.match(slipped.ok ? "" : slipped.problem, /observed|disagrees with missingVerificationScenarioIds/u);
});

test("an open finding outranks an accepted review", () => {
  const page = { ...sweepHasRun, openFindingCount: 1 };
  assert.equal(expectedOwnerAcceptedStatusV1(page, accepted), "changes_requested");
  assert.equal(checkOwnerAcceptedStateV1(page, accepted).ok, false);
});

test("the failure message names both states the accepted path allows", () => {
  assert.match(ownerAcceptedStateMessageV1("hermes", "accepted"),
    /pending until the automatic structure verification passes, then ready/u);
  assert.match(ownerAcceptedStateMessageV1("hermes", "changes_requested"),
    /must leave the target changes_requested/u);
});

// Wiring: a guard that no test proves the rehearsal actually calls is the exact
// failure mode two PRs shipped on 2026-09-28. The unit cases above prove the
// derivation; this proves the post-acceptance assertion in journey.ts is routed
// through it and can no longer silently revert to a bare scalar comparison.
test("the rehearsal's post-acceptance assertion is routed through this guard", async () => {
  const journey = await readFile(new URL("../scripts/mac-local/rehearsal/journey.ts", import.meta.url), "utf8");
  assert.match(journey, /import \{ checkOwnerAcceptedStateV1, ownerAcceptedStateMessageV1 \} from "\.\/owner-accepted-state";/u,
    "journey.ts must import the guard this test exercises");
  const call = journey.indexOf("checkOwnerAcceptedStateV1(acceptedPage");
  assert.notEqual(call, -1, "journey.ts must check the post-acceptance page with this guard");
  const window = journey.slice(call, call + 400);
  assert.match(window, /acceptedVerdict\.ok/u, "the guard's verdict must drive an assertion");
  assert.match(window, /ownerAcceptedStateMessageV1\(agent\.kind, decision\)/u,
    "the assertion message must name the states the accepted path allows");
  assert.doesNotMatch(window, /assert\.equal\(acceptedPage\.status/u,
    "the bare scalar comparison this replaced must not come back");
});
