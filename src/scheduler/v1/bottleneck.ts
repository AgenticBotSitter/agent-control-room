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

/** Reports only declared scheduler resource pressure; it never inspects a host or proposes an action. */
export function findBottleneckV1(resources: ResourcePressureV1[]): BottleneckV1 | undefined {
  const candidates = resources.filter((resource) => Number.isSafeInteger(resource.capacityUnits) && resource.capacityUnits > 0
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
