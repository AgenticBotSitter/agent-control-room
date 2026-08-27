import { randomUUID } from "node:crypto";
import { createPostgresClient } from "@/src/persistence/database";
import { AuthorizedOwnerFocusCommandServiceV1, OPERATOR_SURFACES_CONTRACT_V1, OwnerFocusCommandError, ownerFocusCommandSchemaV1 } from "@/src/operator-surfaces/v1";

function safeError(error: unknown): { code: string; status: number } {
  if (!(error instanceof OwnerFocusCommandError)) return { code: "owner_focus_unavailable", status: 503 };
  if (error.safeCode === "invalid_owner_focus_command") return { code: error.safeCode, status: 400 };
  if (error.safeCode === "owner_focus_forbidden") return { code: error.safeCode, status: 403 };
  return { code: error.safeCode, status: 503 };
}

/**
 * Authenticated, policy-gated Owner Focus intent endpoint. It accepts neither
 * a tenant id nor scheduler/dispatch fields and creates no external effect.
 */
export async function POST(request: Request): Promise<Response> {
  const actorId = request.headers.get("oai-authenticated-user-id");
  if (!actorId) return Response.json({ error: "authentication_required" }, { status: 401, headers: { "cache-control": "no-store" } });
  const tenantId = process.env.CONTROL_ROOM_TENANT_ID;
  const databaseUrl = process.env.DATABASE_URL;
  if (!tenantId || !databaseUrl) return Response.json({ error: "owner_focus_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) return Response.json({ error: "idempotency_key_required" }, { status: 400, headers: { "cache-control": "no-store" } });
  const body = await request.json().catch(() => undefined) as { commandId?: unknown; operation?: unknown; projectId?: unknown; level?: unknown; reason?: unknown } | undefined;
  if (!body || typeof body !== "object" || Object.keys(body).some((key) => !["commandId", "operation", "projectId", "level", "reason"].includes(key))) {
    return Response.json({ error: "invalid_owner_focus_command" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const now = new Date().toISOString();
  const command = ownerFocusCommandSchemaV1.safeParse({
    contractVersion: OPERATOR_SURFACES_CONTRACT_V1,
    commandId: body?.commandId,
    tenantId,
    operation: body?.operation,
    projectId: body?.projectId,
    idempotencyKey,
    requestedAt: now,
    ...(body?.level === undefined ? {} : { level: body.level }),
    ...(body?.reason === undefined ? {} : { reason: body.reason }),
  });
  if (!command.success) return Response.json({ error: "invalid_owner_focus_command" }, { status: 400, headers: { "cache-control": "no-store" } });
  const { client, close } = createPostgresClient(databaseUrl);
  try {
    const result = await new AuthorizedOwnerFocusCommandServiceV1(client).apply({
      command: command.data,
      authentication: { tenantId, provider: "chatgpt", subject: actorId, verifiedAt: now, expiresAt: new Date(Date.parse(now) + 60_000).toISOString() },
      decisionId: `decision:owner-focus:${randomUUID()}`,
    });
    return Response.json({ state: result.replayed ? "replayed" : "recorded", operation: command.data.operation, projectId: command.data.projectId }, { status: result.replayed ? 200 : 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const safe = safeError(error);
    return Response.json({ error: safe.code }, { status: safe.status, headers: { "cache-control": "no-store" } });
  } finally {
    await close();
  }
}
