import assert from "node:assert/strict";
import test from "node:test";
import { findBottleneckV1 } from "../src/scheduler/v1";

test("CR6C reports the most constrained declared resource with stable blocked-work evidence", () => {
  assert.deepEqual(findBottleneckV1([
    { resourceKey: "gpu:one", capacityUnits: 2, reservedUnits: 2, blockedWorkItemIds: ["work:z", "work:a", "work:a"] },
    { resourceKey: "slot:one", capacityUnits: 1, reservedUnits: 1, blockedWorkItemIds: ["work:slot"] },
  ]), {
    resourceKey: "gpu:one", utilizationPercent: 100, blockedWorkItemIds: ["work:a", "work:z"],
    explanation: "gpu:one is 100.00% reserved and is blocking 2 waiting work items.",
  });
  assert.equal(findBottleneckV1([{ resourceKey: "gpu:idle", capacityUnits: 1, reservedUnits: 0, blockedWorkItemIds: [] }]), undefined);
});
