export interface ResourcePressureV1 {
  resourceKey: string;
  capacityUnits: number;
  reservedUnits: number;
  blockedWorkItemIds: string[];
}

export interface BottleneckV1 {
  resourceKey: string;
  utilizationPercent: number;
  blockedWorkItemIds: string[];
  explanation: string;
}

export interface WaitingResourceDemandV1 {
  workItemId: string;
  units: number;
  queuePosition: number;
  downstreamUnlockCount: number;
}

export interface ResourceReliefScenarioV1 {
  resourceKey: string;
  capacityUnits: number;
  reservedUnits: number;
  releasedUnits: number;
  waiting: WaitingResourceDemandV1[];
}

export interface ResourceReliefProjectionV1 {
  resourceKey: string;
  availableUnitsAfterRelease: number;
  newlyFeasibleWorkItemIds: string[];
  downstreamItemsUnlocked: number;
  explanation: string;
}

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

/** Reports only declared scheduler resource pressure; it never inspects a host or proposes an action. */
export function findBottleneckV1(resources: ResourcePressureV1[]): BottleneckV1 | undefined {
  const candidates = resources.filter((resource) => safeId.test(resource.resourceKey) && resource.blockedWorkItemIds.every((id) => safeId.test(id))
    && Number.isSafeInteger(resource.capacityUnits) && resource.capacityUnits > 0
    && Number.isSafeInteger(resource.reservedUnits) && resource.reservedUnits >= 0 && resource.reservedUnits <= resource.capacityUnits
    && resource.blockedWorkItemIds.length > 0).map((resource) => ({
      ...resource,
      utilizationPercent: Math.round((resource.reservedUnits / resource.capacityUnits) * 10_000) / 100,
      blockedWorkItemIds: [...new Set(resource.blockedWorkItemIds)].sort(),
    })).sort((left, right) => right.utilizationPercent - left.utilizationPercent || right.blockedWorkItemIds.length - left.blockedWorkItemIds.length || left.resourceKey.localeCompare(right.resourceKey));
  const bottleneck = candidates[0];
  if (!bottleneck) return undefined;
  return {
    resourceKey: bottleneck.resourceKey,
    utilizationPercent: bottleneck.utilizationPercent,
    blockedWorkItemIds: bottleneck.blockedWorkItemIds,
    explanation: `${bottleneck.resourceKey} is ${bottleneck.utilizationPercent.toFixed(2)}% reserved and is blocking ${bottleneck.blockedWorkItemIds.length} waiting work item${bottleneck.blockedWorkItemIds.length === 1 ? "" : "s"}.`,
  };
}

function feasibleWork(waiting: WaitingResourceDemandV1[], availableUnits: number): Set<string> {
  const feasible = new Set<string>();
  let remaining = availableUnits;
  for (const demand of waiting) {
    if (demand.units <= remaining) {
      feasible.add(demand.workItemId);
      remaining -= demand.units;
    }
  }
  return feasible;
}

/** Projects one declared reservation-release scenario; it never releases capacity or recommends an effect. */
export function projectResourceReliefV1(input: ResourceReliefScenarioV1): ResourceReliefProjectionV1 | undefined {
  if (!safeId.test(input.resourceKey) || ![input.capacityUnits,input.reservedUnits,input.releasedUnits].every(Number.isSafeInteger)
    || input.capacityUnits <= 0 || input.reservedUnits < 0 || input.reservedUnits > input.capacityUnits
    || input.releasedUnits <= 0 || input.releasedUnits > input.reservedUnits || input.waiting.length === 0
    || new Set(input.waiting.map((value) => value.workItemId)).size !== input.waiting.length
    || input.waiting.some((value) => !safeId.test(value.workItemId) || !Number.isSafeInteger(value.units) || value.units <= 0
      || !Number.isSafeInteger(value.queuePosition) || value.queuePosition < 0
      || !Number.isSafeInteger(value.downstreamUnlockCount) || value.downstreamUnlockCount < 0)) return undefined;
  const waiting = [...input.waiting].sort((left, right) => left.queuePosition - right.queuePosition || left.workItemId.localeCompare(right.workItemId));
  const before = feasibleWork(waiting, input.capacityUnits - input.reservedUnits);
  const availableUnitsAfterRelease = input.capacityUnits - input.reservedUnits + input.releasedUnits;
  const after = feasibleWork(waiting, availableUnitsAfterRelease);
  const newlyFeasible = waiting.filter((value) => after.has(value.workItemId) && !before.has(value.workItemId));
  return {
    resourceKey: input.resourceKey,
    availableUnitsAfterRelease,
    newlyFeasibleWorkItemIds: newlyFeasible.map((value) => value.workItemId),
    downstreamItemsUnlocked: newlyFeasible.reduce((total, value) => total + value.downstreamUnlockCount, 0),
    explanation: `If ${input.releasedUnits} declared reserved unit${input.releasedUnits === 1 ? " is" : "s are"} released at a safe boundary, ${newlyFeasible.length} additional waiting work item${newlyFeasible.length === 1 ? " becomes" : "s become"} feasible under the declared queue order. This is a projection, not a release instruction.`,
  };
}
