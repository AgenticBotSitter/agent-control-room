import assert from "node:assert/strict";
import test from "node:test";
import { chooseAllocationV1 } from "../src/scheduler/v1";

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
