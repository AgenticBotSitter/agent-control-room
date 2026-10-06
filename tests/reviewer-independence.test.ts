import assert from "node:assert/strict";
import test from "node:test";
import { assertReviewerIndependentV1, reviewerSeparationForPolicyV1 }
  from "../src/completion-gate/v1/reviewer-independence";
import type { CompletionPrincipalV1 } from "../src/completion-gate/v1";

const producer: CompletionPrincipalV1 = { actorId: "agent:writer", actorType: "agent", workerId: "worker:one",
  agentProfileId: "profile:writer", harness: "harness:alpha", adapterId: "adapter:alpha", modelFamily: "family:alpha" };
const reviewer = (overrides: Partial<CompletionPrincipalV1> = {}): CompletionPrincipalV1 => ({ actorId: "agent:reviewer",
  actorType: "agent", workerId: "worker:two", agentProfileId: "profile:reviewer", harness: "harness:beta",
  adapterId: "adapter:beta", modelFamily: "family:beta", ...overrides });

test("agent self-review is refused", () => {
  assert.throws(() => assertReviewerIndependentV1(producer, { ...producer },
    reviewerSeparationForPolicyV1("different_worker")), /reviewer_not_independent/);
});

test("same-family review is refused by the preferred project policy", () => {
  assert.throws(() => assertReviewerIndependentV1(producer, reviewer({ modelFamily: producer.modelFamily }),
    reviewerSeparationForPolicyV1("different_model_family")), /reviewer_not_independent/);
});

test("a review with different worker, profile, harness and model family is accepted", () => {
  assert.doesNotThrow(() => assertReviewerIndependentV1(producer, reviewer(),
    reviewerSeparationForPolicyV1("different_model_family")));
});

test("owner review remains allowed without agent provenance", () => {
  assert.doesNotThrow(() => assertReviewerIndependentV1(producer,
    { actorId: "identity:owner", actorType: "human" }, reviewerSeparationForPolicyV1("different_model_family")));
});

test("missing provenance is distinguishable from a same-value reviewer", () => {
  const separation = reviewerSeparationForPolicyV1("different_model_family");
  assert.throws(() => assertReviewerIndependentV1(producer, reviewer({ modelFamily: undefined }), separation),
    (error: unknown) => (error as { safeCode?: string }).safeCode === "reviewer_provenance_missing");
  assert.throws(() => assertReviewerIndependentV1(producer, reviewer({ modelFamily: producer.modelFamily }), separation),
    (error: unknown) => (error as { safeCode?: string }).safeCode === "reviewer_not_independent");
});

for (const field of ["workerId", "agentProfileId", "harness"] as const) test(`missing ${field} fails closed distinctly`, () => {
  assert.throws(() => assertReviewerIndependentV1(producer, reviewer({ [field]: undefined }),
    reviewerSeparationForPolicyV1("different_worker")),
  (error: unknown) => (error as { safeCode?: string }).safeCode === "reviewer_provenance_missing");
});
