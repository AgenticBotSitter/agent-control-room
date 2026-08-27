export const placementModesV1 = ["exclusive", "preferred", "shared", "opportunistic", "manual"] as const;
export type PlacementModeV1 = (typeof placementModesV1)[number];

export type PlacementRejectionV1 =
  | "resource_draining"
  | "exclusive_resource_owned"
  | "preferred_resource_reserved"
  | "opportunistic_work_deferred"
  | "manual_assignment_required"
  | "invalid_candidate";

export interface ManualPlacementAssignmentV1 {
  projectId: string;
  workItemId: string;
  routeId: string;
}

export interface PlacementConstraintV1 {
  resourceKey: string;
  mode: PlacementModeV1;
  draining?: boolean;
  exclusiveProjectId?: string;
  preferredProjectIds?: string[];
  projectsWithEligibleWaitingWork?: string[];
  normalEligibleWorkWaiting?: boolean;
  manualAssignment?: ManualPlacementAssignmentV1;
}

export interface PlacementSubjectV1 {
  projectId: string;
  workItemId: string;
  routeId: string;
}

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

function validIds(values: string[] | undefined): boolean {
  return values === undefined || (new Set(values).size === values.length && values.every((value) => safeId.test(value)));
}

function invalid(subject: PlacementSubjectV1, placement: PlacementConstraintV1): boolean {
  if (![subject.projectId, subject.workItemId, subject.routeId, placement.resourceKey].every((value) => safeId.test(value))) return true;
  if (!placementModesV1.includes(placement.mode)) return true;
  if (placement.draining !== undefined && typeof placement.draining !== "boolean") return true;
  if (!validIds(placement.preferredProjectIds) || !validIds(placement.projectsWithEligibleWaitingWork)) return true;
  if (placement.exclusiveProjectId !== undefined && !safeId.test(placement.exclusiveProjectId)) return true;
  if (placement.manualAssignment && ![placement.manualAssignment.projectId, placement.manualAssignment.workItemId, placement.manualAssignment.routeId].every((value) => safeId.test(value))) return true;
  if (placement.mode === "exclusive" && !placement.exclusiveProjectId) return true;
  if (placement.mode === "preferred" && !placement.preferredProjectIds?.length) return true;
  if (placement.mode === "opportunistic" && typeof placement.normalEligibleWorkWaiting !== "boolean") return true;
  return false;
}

/** Pure placement gate. It evaluates declared scheduling facts and never inspects or changes a host. */
export function placementRejectionV1(subject: PlacementSubjectV1, placement: PlacementConstraintV1): PlacementRejectionV1 | undefined {
  if (invalid(subject, placement)) return "invalid_candidate";
  if (placement.draining) return "resource_draining";

  switch (placement.mode) {
    case "exclusive":
      return subject.projectId === placement.exclusiveProjectId ? undefined : "exclusive_resource_owned";
    case "preferred": {
      if (placement.preferredProjectIds!.includes(subject.projectId)) return undefined;
      const waiting = new Set(placement.projectsWithEligibleWaitingWork ?? []);
      return placement.preferredProjectIds!.some((projectId) => waiting.has(projectId)) ? "preferred_resource_reserved" : undefined;
    }
    case "shared":
      return undefined;
    case "opportunistic":
      return placement.normalEligibleWorkWaiting ? "opportunistic_work_deferred" : undefined;
    case "manual": {
      const assignment = placement.manualAssignment;
      return assignment
        && assignment.projectId === subject.projectId
        && assignment.workItemId === subject.workItemId
        && assignment.routeId === subject.routeId
        ? undefined
        : "manual_assignment_required";
    }
  }
}
