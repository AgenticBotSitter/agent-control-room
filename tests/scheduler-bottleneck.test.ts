import assert from "node:assert/strict";
import test from "node:test";
import { findBottleneckV1, projectResourceReliefV1 } from "../src/scheduler/v1";

test("CR6C reports the most constrained declared resource with stable blocked-work evidence", () => {
  assert.deepEqual(findBottleneckV1([
    { resourceKey: "gpu:one", capacityUnits: 2, reservedUnits: 2, blockedWorkItemIds: ["work:z", "work:a", "work:a"] },
    { resourceKey: "slot:one", capacityUnits: 1, reservedUnits: 1, blockedWorkItemIds: ["work:slot"] },
  ]), {
    resourceKey: "gpu:one", utilizationPercent: 100, blockedWorkItemIds: ["work:a", "work:z"],
    explanation: "gpu:one is 100.00% reserved and is blocking 2 waiting work items.",
  });
  assert.equal(findBottleneckV1([{ resourceKey: "gpu:idle", capacityUnits: 1, reservedUnits: 0, blockedWorkItemIds: [] }]), undefined);
  assert.equal(findBottleneckV1([{ resourceKey: "unsafe key", capacityUnits: 1, reservedUnits: 1, blockedWorkItemIds: ["work:a"] }]), undefined);
});

test("CR6C projects conservative relief from declared reservation release without presenting it as an action", () => {
  assert.deepEqual(projectResourceReliefV1({
    resourceKey: "gpu:one", capacityUnits: 4, reservedUnits: 4, releasedUnits: 2,
    waiting: [
      { workItemId: "work:b", units: 1, queuePosition: 2, downstreamUnlockCount: 1 },
      { workItemId: "work:a", units: 2, queuePosition: 1, downstreamUnlockCount: 3 },
      { workItemId: "work:c", units: 1, queuePosition: 3, downstreamUnlockCount: 5 },
    ],
  }), {
    resourceKey: "gpu:one",
    availableUnitsAfterRelease: 2,
    newlyFeasibleWorkItemIds: ["work:a"],
    downstreamItemsUnlocked: 3,
    explanation: "If 2 declared reserved units are released at a safe boundary, 1 additional waiting work item becomes feasible under the declared queue order. This is a projection, not a release instruction.",
  });
  assert.equal(projectResourceReliefV1({ resourceKey: "gpu:one", capacityUnits: 1, reservedUnits: 1, releasedUnits: 2, waiting: [{ workItemId: "work:a", units: 1, queuePosition: 0, downstreamUnlockCount: 0 }] }), undefined);
});
