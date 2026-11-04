import { LoopPolicyRefusedV1 } from "./loop-policy-service";
import { privateRequestBudgets } from "./private-request-budgets";
import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { ImproveControlRoomDeskServiceV1 } from "../../improve-control-room/v1";

import type { ImproveControlRoomLoopServiceV1 } from "./improve-control-room-loop-service";

export function createImproveControlRoomHttpHandlerV1(options: { origin: string; service?: ImproveControlRoomDeskServiceV1;
  loopBridge?: Pick<ImproveControlRoomLoopServiceV1, "mutate" | "status" | "viewDesk" | "readApprovalDocument">;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  if (!options.service && !options.loopBridge) throw new Error("improvement_service_required");
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("improvement_desk_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method === "POST"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)()) : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const loop = /^\/api\/v1\/projects\/([^/]+)\/improvements\/loop\/(desk|intake|([^/]+)\/(status|approval-document|confirm|start|stop|approve|answer))$/.exec(url.pathname);
      if (loop && options.loopBridge) {
        const decodeId = (encoded: string) => {
          let value: string; try { value = decodeURIComponent(encoded); } catch { throw new WebAccessError("invalid_request"); }
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/.test(value)) throw new WebAccessError("invalid_request");
          return value;
        };
        const projectId = decodeId(loop[1]!), requestId = loop[3] ? decodeId(loop[3]) : null;
        if (loop[2] === "desk") {
          if (request.method !== "GET" || request.body) throw new WebAccessError("invalid_request");
          return Response.json(await options.loopBridge.viewDesk(identity, projectId), { headers: privateResponseHeaders });
        }
        if (loop[4] === "approval-document") {
          if (request.method !== "GET" || request.body) throw new WebAccessError("invalid_request");
          return Response.json(await options.loopBridge.readApprovalDocument(identity, projectId, requestId!), { headers: privateResponseHeaders });
        }
        if (loop[4] === "status") {
          if (request.method !== "GET" || request.body) throw new WebAccessError("invalid_request");
          return Response.json(await options.loopBridge.status(identity, projectId, requestId!), { headers: privateResponseHeaders });
        }
        if (request.method !== "POST" || !request.body
          || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
          throw new WebAccessError("invalid_request");
        const result = await options.loopBridge.mutate(identity, projectId, requestId,
          (loop[4] ?? "intake") as "intake" | "confirm" | "start" | "stop" | "approve" | "answer",
          await readBoundedJson(request.body, privateRequestBudgets.improvement), request.headers.get("idempotency-key") ?? "");
        return Response.json(result, { status: result.replayed && result.state !== "uncertain" ? 200 : 202, headers: privateResponseHeaders });
      }
      if (!options.service) throw new WebAccessError("not_found");
      if (url.pathname === "/api/v1/update-candidates") {
        if (request.method !== "GET") throw new WebAccessError("invalid_request");
        return Response.json(await options.service.ready(identity), { headers: privateResponseHeaders });
      }
      const decision = /^\/api\/v1\/update-candidates\/([^/]+)\/decision$/.exec(url.pathname);
      if (decision) {
        if (request.method !== "POST" || !request.body
          || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
          throw new WebAccessError("invalid_request");
        let candidateId: string;
        try { candidateId = decodeURIComponent(decision[1]!); } catch { throw new WebAccessError("invalid_request"); }
        const value = await readBoundedJson(request.body, privateRequestBudgets.improvement);
        if (!value || typeof value !== "object" || (value as { candidateId?: unknown }).candidateId !== candidateId)
          throw new WebAccessError("invalid_request");
        const result = await options.service.decide(identity, value, request.headers.get("idempotency-key") ?? "");
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
      }
      const improvements = /^\/api\/v1\/projects\/([^/]+)\/improvements$/.exec(url.pathname);
      if (!improvements) throw new WebAccessError("not_found");
      let projectId: string;
      try { projectId = decodeURIComponent(improvements[1]!); } catch { throw new WebAccessError("invalid_request"); }
      if (request.method === "GET") return Response.json(await options.service.view(identity, projectId),
        { headers: privateResponseHeaders });
      if (request.method !== "POST" || !request.body
        || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      const result = await options.service.create(identity, projectId, await readBoundedJson(request.body, privateRequestBudgets.improvement),
        request.headers.get("idempotency-key") ?? "");
      return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
    } catch (error) {
      if (error instanceof LoopPolicyRefusedV1) return Response.json({ error: "policy_refused", reasons: error.reasons },
        { status: 422, headers: privateResponseHeaders });
      return webFailure(error);
    }
  };
}
