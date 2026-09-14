import { failProjectCoordinationV1 } from "./errors";
import type { ProjectWorkResourceScopeV1 } from "../../contracts/v1/project-coordination-boundaries";

/**
 * Pure overlap rules for the one canonical resource-conflict operation.
 *
 * Every path reaching this module has already been folded to lowercase and
 * validated as complete segments by the shared boundary module (and again by the
 * database CHECK on `control_attempt_resource_scopes`), so `..`, `\`, absolute
 * paths, empty segments and mixed-case aliases cannot reach here. The functions
 * below still re-validate, because a conflict check that trusts its input is not
 * a conflict check.
 */

const SEGMENTED_PATH = /^[a-z0-9_][a-z0-9._-]{0,127}(\/[a-z0-9_][a-z0-9._-]{0,127})*$/;

export interface HeldScopeV1 {
  admissionId: string;
  resourceId: string;
  accessMode: "read" | "write";
  scopeKind: "file" | "tree" | "logical";
  path: string;
}

export function assertComparablePathV1(scope: { scopeKind: string; path: string }): void {
  if (scope.scopeKind === "logical") {
    if (scope.path !== "") failProjectCoordinationV1("resource_declaration_invalid");
    return;
  }
  if (scope.scopeKind === "tree" && scope.path === "") return;
  if (!SEGMENTED_PATH.test(scope.path)) failProjectCoordinationV1("resource_declaration_invalid");
}

function withinTree(tree: string, candidate: string): boolean {
  return tree === "" || candidate === tree || candidate.startsWith(`${tree}/`);
}

/** Overlap on one resource. Tree scopes cover their descendants; a root tree covers the repository. */
export function scopesOverlapV1(
  left: { scopeKind: string; path: string },
  right: { scopeKind: string; path: string },
): boolean {
  assertComparablePathV1(left);
  assertComparablePathV1(right);
  if (left.scopeKind === "logical" || right.scopeKind === "logical") {
    // A logical resource is whole; two scopes on the same logical resource always meet.
    return left.scopeKind === "logical" && right.scopeKind === "logical";
  }
  if (left.scopeKind === "tree" && right.scopeKind === "tree") {
    return withinTree(left.path, right.path) || withinTree(right.path, left.path);
  }
  if (left.scopeKind === "tree") return withinTree(left.path, right.path);
  if (right.scopeKind === "tree") return withinTree(right.path, left.path);
  return left.path === right.path;
}

export interface ResourceConflictV1 {
  resourceId: string;
  heldAdmissionId: string;
  heldAccessMode: "read" | "write";
  requestedAccessMode: "read" | "write";
}

/**
 * Two readers share a resource. A writer conflicts with any overlapping reader
 * or writer. Every conflict found is returned so the caller can decide whether an
 * owner policy plus a distinct enforced workspace makes a disjoint writer legal.
 */
export function findResourceConflictsV1(
  requested: readonly ProjectWorkResourceScopeV1[],
  held: readonly HeldScopeV1[],
): ResourceConflictV1[] {
  const conflicts: ResourceConflictV1[] = [];
  for (const scope of requested) {
    assertComparablePathV1(scope);
    for (const other of held) {
      if (other.resourceId !== scope.resourceId) continue;
      if (scope.accessMode === "read" && other.accessMode === "read") continue;
      if (!scopesOverlapV1(scope, other)) continue;
      conflicts.push({
        resourceId: scope.resourceId,
        heldAdmissionId: other.admissionId,
        heldAccessMode: other.accessMode,
        requestedAccessMode: scope.accessMode,
      });
    }
  }
  return conflicts;
}

/**
 * Repository resources this declaration writes with anything narrower than the
 * whole repository. Those are the only writers that need an owner policy
 * permitting exact disjoint scopes plus a separately enforced workspace; every
 * other repository writer must take one root-tree write scope and serialize.
 */
export function narrowWriteResourcesV1(scopes: readonly ProjectWorkResourceScopeV1[]): string[] {
  const writes = new Map<string, ProjectWorkResourceScopeV1[]>();
  for (const scope of scopes) {
    if (scope.resourceKind !== "repository" || scope.accessMode !== "write") continue;
    const list = writes.get(scope.resourceId) ?? [];
    list.push(scope);
    writes.set(scope.resourceId, list);
  }
  const narrow: string[] = [];
  for (const [resourceId, list] of writes) {
    const wholeRepository = list.some((scope) => scope.scopeKind === "tree" && scope.path === "");
    if (!wholeRepository) narrow.push(resourceId);
  }
  return narrow.sort();
}
