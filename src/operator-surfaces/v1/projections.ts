import type { ActionInboxFilterV1, ActionInboxItemV1, OperatorSurfaceSnapshotV1, OwnerFocusPinV1, OwnerFocusSchedulerProjectionV1 } from "./types";
import { parseOperatorSurfaceSnapshotV1 } from "./validators";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
function instant(value: string): boolean { return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }

/** Applies only display filtering and stable ordering. It never removes an unresolved record because delivery failed. */
export function filterActionInboxV1(items: ActionInboxItemV1[], filter: ActionInboxFilterV1): ActionInboxItemV1[] | undefined {
  if (!instant(filter.now) || !Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 500
    || (filter.projectId !== undefined && !safeId.test(filter.projectId))
    || filter.kinds?.some((kind) => !["approval", "question", "review", "failure", "ambiguity", "incident", "authority_expiry", "native_session"].includes(kind))
    || filter.states?.some((state) => !["open", "resolved", "expired"].includes(state))) return undefined;
  const kindSet = filter.kinds ? new Set(filter.kinds) : undefined;
  const stateSet = filter.states ? new Set(filter.states) : undefined;
  return items.filter((item) => {
    if (filter.projectId && item.projectId !== filter.projectId) return false;
    if (kindSet && !kindSet.has(item.kind)) return false;
    if (stateSet && !stateSet.has(item.state)) return false;
    return filter.includeExpired || item.state !== "expired";
  }).sort((left, right) => {
    const leftExpiry = left.expiresAt ? Date.parse(left.expiresAt) : Number.POSITIVE_INFINITY;
    const rightExpiry = right.expiresAt ? Date.parse(right.expiresAt) : Number.POSITIVE_INFINITY;
    return leftExpiry - rightExpiry || Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id);
  }).slice(0, filter.limit);
}

/** Converts active owner intent into explicit non-authoritative scheduler metadata. */
export function projectOwnerFocusForSchedulerV1(pins: OwnerFocusPinV1[], now: string): OwnerFocusSchedulerProjectionV1[] | undefined {
  if (!instant(now) || pins.some((pin) => !safeId.test(pin.projectId) || !instant(pin.createdAt) || (pin.expiresAt !== undefined && !instant(pin.expiresAt)))) return undefined;
  const byProject = new Map<string, OwnerFocusPinV1>();
  for (const pin of pins) {
    if (pin.expiresAt && Date.parse(pin.expiresAt) <= Date.parse(now)) continue;
    const current = byProject.get(pin.projectId);
    if (!current || (pin.level === "p0" && current.level === "today") || Date.parse(pin.createdAt) > Date.parse(current.createdAt)) byProject.set(pin.projectId, pin);
  }
  return [...byProject.values()].sort((left, right) => left.level.localeCompare(right.level) || left.projectId.localeCompare(right.projectId)).map((pin) => ({
    projectId: pin.projectId,
    level: pin.level,
    reasonCode: "owner_focus",
    canOverrideFairness: false,
    canOverrideAuthority: false,
    canReserveCapacity: false,
  }));
}

/** Creates a validated, deterministic, redacted snapshot from already authorized read sources. */
export function buildOperatorSurfaceSnapshotV1(input: OperatorSurfaceSnapshotV1): OperatorSurfaceSnapshotV1 {
  const parsed = parseOperatorSurfaceSnapshotV1(input);
  return {
    ...parsed,
    fleet: [...parsed.fleet].sort((left, right) => left.workerId.localeCompare(right.workerId)),
    bottlenecks: [...parsed.bottlenecks].sort((left, right) => right.utilizationPercent - left.utilizationPercent || left.resourceKey.localeCompare(right.resourceKey)),
    activeWork: [...parsed.activeWork].sort((left, right) => right.priority - left.priority || Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.jobId.localeCompare(right.jobId)),
    portfolio: [...parsed.portfolio].sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) || left.projectId.localeCompare(right.projectId)),
    services: [...parsed.services].sort((left, right) => left.projectId.localeCompare(right.projectId) || left.serviceId.localeCompare(right.serviceId)),
    schedules: [...parsed.schedules].sort((left, right) => (left.nextRunAt ?? "\uffff").localeCompare(right.nextRunAt ?? "\uffff") || left.scheduleId.localeCompare(right.scheduleId)),
    serviceIncidents: [...parsed.serviceIncidents].sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt) || left.id.localeCompare(right.id)),
    actionInbox: [...parsed.actionInbox].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id)),
    ownerFocus: [...parsed.ownerFocus].sort((left, right) => left.level.localeCompare(right.level) || left.projectId.localeCompare(right.projectId)),
  };
}
