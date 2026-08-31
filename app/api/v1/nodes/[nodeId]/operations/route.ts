import { NodeControlError, NodeControlService, type NodeControlOperationV1 } from "@/src/node-control";
import { createPostgresClient } from "@/src/persistence/database";

const operations = new Set<NodeControlOperationV1>(["request_drain", "request_resume", "request_quarantine"]);

function safeError(error: unknown): { code: string; status: number } {
  if (error instanceof NodeControlError) {
    if (error.safeCode === "node_not_found") return { code: error.safeCode, status: 404 };
    if (error.safeCode === "stale_node_version" || error.safeCode === "idempotency_conflict") return { code: error.safeCode, status: 409 };
    return { code: error.safeCode, status: 400 };
  }
  return { code: "operation_request_unavailable", status: 503 };
}

export async function POST(request: Request, context: { params: Promise<{ nodeId: string }> }) {
  const actorId = request.headers.get("oai-authenticated-user-id");
  if (!actorId) return Response.json({ error: "authentication_required" }, { status: 401 });
  const tenantId = process.env.CONTROL_ROOM_TENANT_ID;
  const databaseUrl = process.env.DATABASE_URL;
  if (!tenantId || !databaseUrl) return Response.json({ error: "operation_request_unavailable" }, { status: 503 });
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) return Response.json({ error: "idempotency_key_required" }, { status: 400 });
  const body = await request.json().catch(() => undefined) as {
    operation?: NodeControlOperationV1;
    expectedNodeVersion?: number;
    safeReasonCode?: string;
  } | undefined;
  if (!body?.operation || !operations.has(body.operation) || body.expectedNodeVersion === undefined) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const { nodeId } = await context.params;
  const { client, close } = createPostgresClient(databaseUrl);
  try {
    const result = await new NodeControlService(client).request({
      tenantId,
      nodeId,
      operation: body.operation,
      expectedNodeVersion: body.expectedNodeVersion,
      actorId,
      idempotencyKey,
      requestedAt: new Date().toISOString(),
      ...(body.safeReasonCode === undefined ? {} : { safeReasonCode: body.safeReasonCode }),
    });
    return Response.json({
      requestId: result.requestId,
      nodeId: result.nodeId,
      operation: result.operation,
      state: result.state,
      replayed: result.replayed,
      applied: result.state === "applied",
      ...(result.safeResultCode ? { safeResultCode: result.safeResultCode } : {}),
      ...(result.resultingNodeVersion === undefined ? {} : { resultingNodeVersion: result.resultingNodeVersion }),
    }, { status: result.replayed ? 200 : 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const safe = safeError(error);
    return Response.json({ error: safe.code }, { status: safe.status, headers: { "cache-control": "no-store" } });
  } finally {
    await close();
  }
}

export async function GET(request: Request, context: { params: Promise<{ nodeId: string }> }) {
  const actorId = request.headers.get("oai-authenticated-user-id");
  if (!actorId) return Response.json({ error: "authentication_required" }, { status: 401 });
  const tenantId = process.env.CONTROL_ROOM_TENANT_ID;
  const databaseUrl = process.env.DATABASE_URL;
  if (!tenantId || !databaseUrl) return Response.json({ error: "operation_request_unavailable" }, { status: 503 });
  const requestId = new URL(request.url).searchParams.get("request_id");
  if (!requestId) return Response.json({ error: "invalid_request" }, { status: 400 });
  const { nodeId } = await context.params;
  const { client, close } = createPostgresClient(databaseUrl);
  try {
    const result = await new NodeControlService(client).status({ tenantId, nodeId, requestId, actorId });
    return Response.json({
      requestId: result.requestId,
      nodeId: result.nodeId,
      operation: result.operation,
      state: result.state,
      applied: result.state === "applied",
      ...(result.safeResultCode ? { safeResultCode: result.safeResultCode } : {}),
      ...(result.resultingNodeVersion === undefined ? {} : { resultingNodeVersion: result.resultingNodeVersion }),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const safe = safeError(error);
    return Response.json({ error: safe.code }, { status: safe.status, headers: { "cache-control": "no-store" } });
  } finally {
    await close();
  }
}
