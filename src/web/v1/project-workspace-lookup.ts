// The ONE workspace-fenced project row lookup.
//
// Every private-web surface that resolves a project a browser named in the URL
// must go through this function, not through its own `FROM projects` query. A
// per-caller query that forgets `workspace_id` is not a cosmetic difference:
// within one tenant, a project in a sibling workspace is private data, and a
// wildcard owner grant legitimately spans the whole tenant, so the grant check
// cannot supply the boundary. Only the workspace predicate does.
//
// The fence is three-part and all of it is mandatory here:
//   * `p.tenant_id`   — the configured deployment scope;
//   * `p.workspace_id`— the configured deployment workspace;
//   * `p.id`          — the project the caller named;
// plus the caller's own adapter predicate when it has one (ordinary projects
// are scoped to the manual adapter; Idea projects carry their own source).
// `FOR SHARE OF p,h` is part of the contract too: it is what makes the row that
// passed the fence stay put until the caller's transaction commits, so a
// workspace reassignment cannot slip between the check and the write.
//
// The returned row is deliberately narrow: identity, presentation and the
// columns the callers name. Nothing here returns `payload`, so a caller cannot
// widen its own read by reusing this helper.

import type { DatabaseSession, QueryResult } from "../../persistence/database";
import { WebAccessError } from "./access-verifier";

export interface WorkspaceProjectScope {
  tenantId: string;
  workspaceId: string;
}

/** The minimal query surface both a pool client and a transaction session satisfy. */
export interface ProjectWorkspaceQueryV1 {
  query<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface WorkspaceScopedProjectRowV1 {
  id: string;
  title: string;
  summary: string;
  lifecycle: string;
  version: string | number;
  createdAt: unknown;
  updatedAt: unknown;
}

const SELECT_COLUMNS = `p.id,p.title,coalesce(p.description,'') AS summary,
       h.lifecycle,h.version,h.created_at AS "createdAt",h.updated_at AS "updatedAt"`;

/**
 * Resolve one project inside the configured tenant AND workspace, or undefined.
 *
 * `adapterId` narrows the result to one project source. Omit it only where the
 * caller legitimately serves more than one source (the coordination surface
 * resolves the project behind any coordinator head, ordinary or otherwise).
 */
export async function readWorkspaceScopedProjectRowV1(
  db: ProjectWorkspaceQueryV1,
  scope: WorkspaceProjectScope,
  input: { projectId: string; adapterId?: string },
): Promise<WorkspaceScopedProjectRowV1 | undefined> {
  const adapterPredicate = input.adapterId === undefined ? "" : " AND p.adapter_id=$4";
  const params = input.adapterId === undefined
    ? [scope.tenantId, scope.workspaceId, input.projectId]
    : [scope.tenantId, scope.workspaceId, input.projectId, input.adapterId];
  const rows = await db.query<WorkspaceScopedProjectRowV1>(
    `SELECT ${SELECT_COLUMNS}
       FROM projects p
       JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
      WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3${adapterPredicate}
      FOR SHARE OF p,h`, params);
  return rows.rows[0];
}

/** Same lookup, taken from inside the caller's own authorization transaction. */
export function workspaceScopedProjectLookupV1(
  tx: DatabaseSession,
  scope: WorkspaceProjectScope,
  input: { projectId: string; adapterId?: string },
): Promise<WorkspaceScopedProjectRowV1 | undefined> {
  return readWorkspaceScopedProjectRowV1(tx, scope, input);
}

/**
 * Authorize a project the browser named, from inside the caller's own session
 * transaction, and throw `not_found` when it is outside the configured
 * workspace.
 *
 * `not_found` and not `access_denied` is deliberate and load-bearing: an absent
 * project and a project in a sibling workspace must be indistinguishable to the
 * caller, or this endpoint becomes a probe that confirms the existence of
 * another workspace's project. The grant check has already run by the time this
 * is called; this adds the boundary the grant cannot express.
 */
export async function assertWorkspaceProjectInSessionV1(
  tx: DatabaseSession,
  scope: WorkspaceProjectScope,
  projectId: string,
): Promise<WorkspaceScopedProjectRowV1> {
  const row = await workspaceScopedProjectLookupV1(tx, scope, { projectId });
  if (!row) throw new WebAccessError("not_found");
  return row;
}