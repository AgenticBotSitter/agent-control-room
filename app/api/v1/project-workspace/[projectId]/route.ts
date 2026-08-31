import {
  ProjectWorkspaceContractErrorV1,
  ProjectWorkspaceReadServiceV1,
} from "@/src/project-workspace/v1";
import {
  getProjectWorkspaceProtectedRuntimeV1,
  type ProjectWorkspaceProtectedRuntimeV1,
} from "@/app/project-workspace-protected-runtime";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-control-room-data-class": "protected-project-projection" } });
}

function safeFailure(error: unknown): Response {
  if (!(error instanceof ProjectWorkspaceContractErrorV1)) return json({ error: "protected_source_unavailable" }, 503);
  if (error.safeCode === "authentication_required") return json({ error: "authentication_required" }, 401);
  if (error.safeCode === "policy_denied") return json({ error: "project_read_forbidden" }, 403);
  if (error.safeCode === "not_found" || error.safeCode === "catalog_revoked") return json({ error: "project_not_found" }, 404);
  return json({ error: "protected_source_unavailable" }, 503);
}

/** Protected project read. HTTP input supplies only the selected project and opaque session credential. */
export function createProjectWorkspaceProtectedReadHandlerV1(runtime?: ProjectWorkspaceProtectedRuntimeV1) {
  return async function protectedProjectRead(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
    if (!runtime) return json({ error: "protected_identity_boundary_unavailable" }, 503);
    const { projectId } = await context.params;
    if (!safeId.test(projectId)) return json({ error: "project_not_found" }, 404);
    const now = new Date().toISOString();
    try {
      const scope = await runtime.scopeAuthority.authorize({ credential: request, projectId, now });
      const result = await new ProjectWorkspaceReadServiceV1(runtime.readSource, [{
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
      }]).read({ scope, now });
      if (result.state === "unavailable") return json({ error: result.code }, result.code === "project_not_found" ? 404 : 503);
      return Response.json({ model: result.model }, {
        headers: {
          "cache-control": "no-store",
          "x-control-room-contract": result.model.contractVersion,
          "x-control-room-data-class": "protected-project-projection",
        },
      });
    } catch (error) { return safeFailure(error); }
  };
}

export const GET = createProjectWorkspaceProtectedReadHandlerV1(getProjectWorkspaceProtectedRuntimeV1());
