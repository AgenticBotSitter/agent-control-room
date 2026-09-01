import {
  getConnectionCenterProtectedRuntimeV1,
  type ConnectionCenterProtectedRuntimeV1,
} from "@/app/connection-center-protected-runtime";
import { ConnectionCenterReadServiceV1 } from "@/src/connection-center/v1";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store",
    "x-control-room-data-class": "protected-connection-inventory" } });
}

export function createConnectionCenterReadHandlerV1(runtime?: ConnectionCenterProtectedRuntimeV1) {
  return async function handler(request: Request): Promise<Response> {
    if (!runtime) return json({ error: "connection_center_unavailable" }, 503);
    const now = new Date().toISOString();
    let authentication;
    try { authentication = await runtime.ownerSession.verify(request, now); }
    catch { return json({ error: "authentication_required" }, 401); }
    try {
      const projection = await new ConnectionCenterReadServiceV1(runtime.rosterSource)
        .read({ tenantId: authentication.tenantId, now });
      return Response.json({ projection }, { status: 200, headers: { "cache-control": "no-store",
        "x-control-room-contract": projection.contractVersion,
        "x-control-room-data-class": "protected-connection-inventory" } });
    } catch {
      return json({ error: "connection_center_unavailable" }, 503);
    }
  };
}

export const GET = createConnectionCenterReadHandlerV1(getConnectionCenterProtectedRuntimeV1());
