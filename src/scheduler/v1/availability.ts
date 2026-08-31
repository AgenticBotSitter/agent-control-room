export interface ResourceAvailabilityWindowV1 {
  startsAt: string;
  endsAt: string;
  capacityUnits: number;
}

export interface ResourceAvailabilityRequestV1 {
  resourceKey: string;
  requestedFrom: string;
  requestedUntil: string;
  units: number;
  windows: ResourceAvailabilityWindowV1[];
}

export type AvailabilityRejectionV1 = "outside_availability_window" | "insufficient_window_capacity" | "invalid_candidate";

export interface ResourceAvailabilityDecisionV1 {
  eligible: boolean;
  reason?: AvailabilityRejectionV1;
  matchedWindow?: ResourceAvailabilityWindowV1;
  explanation: string;
}

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
function instant(value: string): boolean { const parsed = new Date(value); return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value; }

function normalizedWindows(windows: ResourceAvailabilityWindowV1[]): ResourceAvailabilityWindowV1[] | undefined {
  if (windows.length === 0 || windows.some((window) => !instant(window.startsAt) || !instant(window.endsAt)
    || Date.parse(window.endsAt) <= Date.parse(window.startsAt) || !Number.isSafeInteger(window.capacityUnits) || window.capacityUnits <= 0)) return undefined;
  const sorted = windows.map((window) => ({ ...window })).sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt) || Date.parse(left.endsAt) - Date.parse(right.endsAt));
  if (sorted.some((window, index) => index > 0 && Date.parse(window.startsAt) < Date.parse(sorted[index - 1].endsAt))) return undefined;
  return sorted;
}

/** Checks declared UTC windows only; it does not inspect, wake, or reserve a real resource. */
export function evaluateResourceAvailabilityV1(input: ResourceAvailabilityRequestV1): ResourceAvailabilityDecisionV1 {
  const windows = normalizedWindows(input.windows);
  if (!safeId.test(input.resourceKey) || !instant(input.requestedFrom) || !instant(input.requestedUntil)
    || Date.parse(input.requestedUntil) <= Date.parse(input.requestedFrom) || !Number.isSafeInteger(input.units) || input.units <= 0 || !windows) {
    return { eligible: false, reason: "invalid_candidate", explanation: "Resource availability facts are invalid or ambiguous." };
  }
  const containing = windows.find((window) => Date.parse(window.startsAt) <= Date.parse(input.requestedFrom) && Date.parse(window.endsAt) >= Date.parse(input.requestedUntil));
  if (!containing) return { eligible: false, reason: "outside_availability_window", explanation: `${input.resourceKey} is not declared available for the complete requested interval.` };
  if (input.units > containing.capacityUnits) return { eligible: false, reason: "insufficient_window_capacity", matchedWindow: containing, explanation: `${input.resourceKey} has ${containing.capacityUnits} declared units during the requested interval; ${input.units} are required.` };
  return { eligible: true, matchedWindow: containing, explanation: `${input.resourceKey} has ${containing.capacityUnits} declared units for the complete requested interval.` };
}
