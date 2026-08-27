import assert from "node:assert/strict";
import test from "node:test";
import { chooseAllocationV1, placementRejectionV1, STARVATION_BOUND_MINUTES_V1 } from "../src/scheduler/v1";

test("CR6C chooses a deprived eligible project but never scores through a hard exclusion", () => {
  const result = chooseAllocationV1([
    { projectId: "project.a", workItemId: "work.a", routeId: "route.a", targetShare: 60, recentShareUsed: 10, priority: 20, queueAgeMinutes: 5, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0, exclusions: ["resource_unavailable"] },
    { projectId: "project.b", workItemId: "work.b", routeId: "route.b", targetShare: 25, recentShareUsed: 0, priority: 10, queueAgeMinutes: 5, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 },
  ]);
  assert.deepEqual(result.selected, { projectId: "project.b", workItemId: "work.b", routeId: "route.b" });
  assert.deepEqual(result.rejected, [{ projectId: "project.a", workItemId: "work.a", routeId: "route.a", reasons: ["resource_unavailable"] }]);
});

test("CR6C produces a stable order and an honest no-eligible explanation", () => {
  const tied = [{ projectId: "project.b", workItemId: "work.b", routeId: "route.b", targetShare: 0, recentShareUsed: 0, priority: 1, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 }, { projectId: "project.a", workItemId: "work.a", routeId: "route.a", targetShare: 0, recentShareUsed: 0, priority: 1, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 }];
  assert.equal(chooseAllocationV1(tied).selected?.projectId, "project.a");
  assert.deepEqual(chooseAllocationV1([{ ...tied[0], exclusions: ["maintenance"] }]).explanation, ["No candidate satisfies the hard scheduling rules."]);
});

test("CR6C rejects malformed numeric inputs before they can distort scoring", () => {
  const candidate = { projectId: "project.a", workItemId: "work.a", routeId: "route.a", targetShare: 10, recentShareUsed: 0, priority: 1, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 };
  assert.deepEqual(chooseAllocationV1([{ ...candidate, estimatedCostUsd: Number.NaN }]).rejected[0]?.reasons, ["invalid_candidate"]);
  assert.deepEqual(chooseAllocationV1([{ ...candidate, queueAgeMinutes: -1 }]).rejected[0]?.reasons, ["invalid_candidate"]);
});

test("CR6C gives the oldest eligible work a hard starvation bound without bypassing exclusions", () => {
  const base = { targetShare: 0, recentShareUsed: 0, downstreamUnlockCount: 0, deadlineRisk: 0, estimatedCostUsd: 0 };
  const result = chooseAllocationV1([
    { ...base, projectId: "project:new", workItemId: "work:new", routeId: "route:new", priority: 100, queueAgeMinutes: 1 },
    { ...base, projectId: "project:old", workItemId: "work:old", routeId: "route:old", priority: 0, queueAgeMinutes: STARVATION_BOUND_MINUTES_V1 },
    { ...base, projectId: "project:blocked", workItemId: "work:blocked", routeId: "route:blocked", priority: 0, queueAgeMinutes: STARVATION_BOUND_MINUTES_V1 * 2, exclusions: ["maintenance"] as const },
  ]);
  assert.equal(result.selected?.workItemId, "work:old");
  assert.match(result.explanation.join(" "), /starvation bound/i);
});

test("CR6C placement modes enforce ownership, preference, sharing, and draining before scoring", () => {
  const subject = { projectId: "project.borrower", workItemId: "work.1", routeId: "route.gpu" };
  assert.equal(placementRejectionV1(subject, { resourceKey: "gpu.1", mode: "exclusive", exclusiveProjectId: "project.owner" }), "exclusive_resource_owned");
  assert.equal(placementRejectionV1({ ...subject, projectId: "project.owner" }, { resourceKey: "gpu.1", mode: "exclusive", exclusiveProjectId: "project.owner" }), undefined);
  assert.equal(placementRejectionV1(subject, { resourceKey: "gpu.1", mode: "preferred", preferredProjectIds: ["project.owner"], projectsWithEligibleWaitingWork: ["project.owner"] }), "preferred_resource_reserved");
  assert.equal(placementRejectionV1(subject, { resourceKey: "gpu.1", mode: "preferred", preferredProjectIds: ["project.owner"], projectsWithEligibleWaitingWork: [] }), undefined);
  assert.equal(placementRejectionV1(subject, { resourceKey: "gpu.1", mode: "shared" }), undefined);
  assert.equal(placementRejectionV1(subject, { resourceKey: "gpu.1", mode: "shared", draining: true }), "resource_draining");
});

test("CR6C opportunistic and manual placement require explicit safe scheduling facts", () => {
  const subject = { projectId: "project.a", workItemId: "work.a", routeId: "route.a" };
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "opportunistic", normalEligibleWorkWaiting: true }), "opportunistic_work_deferred");
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "opportunistic", normalEligibleWorkWaiting: false }), undefined);
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "opportunistic" }), "invalid_candidate");
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "manual" }), "manual_assignment_required");
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "manual", manualAssignment: subject }), undefined);
  assert.equal(placementRejectionV1(subject, { resourceKey: "worker.a", mode: "manual", manualAssignment: { ...subject, workItemId: "work.other" } }), "manual_assignment_required");
});

test("CR6C allocation cannot score through a placement rejection", () => {
  const base = { targetShare: 100, recentShareUsed: 0, priority: 100, queueAgeMinutes: 10_000, downstreamUnlockCount: 10, deadlineRisk: 1, estimatedCostUsd: 0 };
  const result = chooseAllocationV1([
    { ...base, projectId: "project.borrower", workItemId: "work.blocked", routeId: "route.gpu", placement: { resourceKey: "gpu.1", mode: "exclusive", exclusiveProjectId: "project.owner" } },
    { ...base, targetShare: 0, priority: 0, queueAgeMinutes: 0, downstreamUnlockCount: 0, deadlineRisk: 0, projectId: "project.owner", workItemId: "work.allowed", routeId: "route.gpu", placement: { resourceKey: "gpu.1", mode: "exclusive", exclusiveProjectId: "project.owner" } },
  ]);
  assert.equal(result.selected?.workItemId, "work.allowed");
  assert.deepEqual(result.rejected, [{ projectId: "project.borrower", workItemId: "work.blocked", routeId: "route.gpu", reasons: ["exclusive_resource_owned"] }]);
});
