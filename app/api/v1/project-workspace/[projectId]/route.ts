import { projects } from "@/src/fixtures/data";
import { createPostgresClient } from "@/src/persistence/database";
import {
  OperatorSurfaceProjectWorkspaceReadSourceV1,
  ProjectWorkspaceContractErrorV1,
  ProjectWorkspaceReadServiceV1,
} from "@/src/project-workspace/v1";
import { DatabaseOperatorFleetReadSourceV1, OperatorSurfaceReadServiceV1, OperatorSurfaceStoreV1 } from "@/src/operator-surfaces/v1";
import { ServiceIncidentStore } from "@/src/services/v1";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-control-room-data-class": "protected-project-projection" } });
}

/** Protected project read. Tenant and workspace scope are resolved on the server and never accepted from query input. */
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const actorId = request.headers.get("oai-authenticated-user-id");
  if (!actorId || !safeId.test(actorId)) return json({ error: "authentication_required" }, 401);
  const { projectId } = await context.params;
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return json({ error: "project_not_found" }, 404);
  const tenantId = process.env.CONTROL_ROOM_TENANT_ID;
  const databaseUrl = process.env.DATABASE_URL;
  if (!tenantId || !safeId.test(tenantId) || !databaseUrl) return json({ error: "protected_source_unavailable" }, 503);
  const now = new Date().toISOString();
  let close: (() => Promise<void>) | undefined;
  try {
    const database = createPostgresClient(databaseUrl);
    close = database.close;
    const operatorService = new OperatorSurfaceReadServiceV1(
      new OperatorSurfaceStoreV1(database.client),
      new ServiceIncidentStore(database.client),
      new DatabaseOperatorFleetReadSourceV1(database.client),
    );
    const service = new ProjectWorkspaceReadServiceV1(
      new OperatorSurfaceProjectWorkspaceReadSourceV1(operatorService),
      [{ tenantId, workspaceId: project.source.workspaceId, projectId }],
    );
    const result = await service.read({
      scope: { tenantId, workspaceId: project.source.workspaceId, projectId, actorId, grantedAt: now },
      now,
    });
    if (result.state === "unavailable") return json({ error: result.code }, result.code === "project_not_found" ? 404 : 503);
    return Response.json({ model: result.model }, {
      headers: {
        "cache-control": "no-store",
        "x-control-room-contract": result.model.contractVersion,
        "x-control-room-data-class": "protected-project-projection",
      },
    });
  } catch (error) {
    const code = error instanceof ProjectWorkspaceContractErrorV1 ? error.safeCode : "protected_source_unavailable";
    return json({ error: code === "scope_mismatch" || code === "invalid_read_scope" ? code : "protected_source_unavailable" }, 503);
  } finally {
    if (close) await close().catch(() => undefined);
  }
}
