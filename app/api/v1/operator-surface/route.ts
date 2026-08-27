import { createPostgresClient } from "@/src/persistence/database";
import { ServiceIncidentStore } from "@/src/services/v1";
import { DatabaseOperatorFleetReadSourceV1, OperatorSurfaceReadServiceV1, OperatorSurfaceStoreV1 } from "@/src/operator-surfaces/v1";

const states = new Set(["open", "resolved", "expired"]);

function unavailable(error: unknown): Response {
  const code = error instanceof Error && (error.message === "invalid_filter" || error.message === "invalid_read_scope") ? error.message : "operator_surface_unavailable";
  return Response.json({ error: code }, { status: code === "invalid_filter" ? 400 : 503, headers: { "cache-control": "no-store" } });
}

/** Protected read endpoint. Tenant scope comes from deployment configuration, never from the URL or request body. */
export async function GET(request: Request): Promise<Response> {
  const actorId = request.headers.get("oai-authenticated-user-id");
  if (!actorId) return Response.json({ error: "authentication_required" }, { status: 401, headers: { "cache-control": "no-store" } });
  const tenantId = process.env.CONTROL_ROOM_TENANT_ID;
  const databaseUrl = process.env.DATABASE_URL;
  if (!tenantId || !databaseUrl) return Response.json({ error: "operator_surface_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  const url = new URL(request.url);
  const projectId = url.searchParams.get("project_id") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;
  if (state && !states.has(state)) return Response.json({ error: "invalid_filter" }, { status: 400, headers: { "cache-control": "no-store" } });
  const includeExpired = url.searchParams.get("include_expired") === "true";
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit ? Number(rawLimit) : 100;
  const { client, close } = createPostgresClient(databaseUrl);
  try {
    const result = await new OperatorSurfaceReadServiceV1(
      new OperatorSurfaceStoreV1(client),
      new ServiceIncidentStore(client),
      new DatabaseOperatorFleetReadSourceV1(client),
    ).read({
      scope: { tenantId, actorId, grantedAt: new Date().toISOString() },
      now: new Date().toISOString(),
      inboxFilter: { ...(projectId ? { projectId } : {}), ...(state ? { states: [state as "open" | "resolved" | "expired"] } : {}), includeExpired, limit },
    });
    return Response.json({ snapshot: result.snapshot }, { headers: { "cache-control": "no-store", "x-control-room-contract": result.snapshot.contractVersion, "x-control-room-data-class": "operator-projection" } });
  } catch (error) {
    return unavailable(error);
  } finally {
    await close();
  }
}
