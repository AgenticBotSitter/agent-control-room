import { LoopCandidateStaleCompletionV1 } from "../../improve-control-room/v1/loop-candidate-publisher";
import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import type { ImproveControlRoomDeskServiceV1 } from "../../improve-control-room/v1/service";
import { loopCandidateDecisionBodySchemaV1, loopCandidateIdV1 } from "../../improve-control-room/v1/loop-candidate-wire";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import { privateRequestBudgets } from "./private-request-budgets";

export const isLoopCandidateRouteV1 = (path: string) => path === "/api/v1/loop-update-candidates"
  || /^\/api\/v1\/loop-update-candidates\/[^/]+\/decision$/.test(path)
  || /^\/api\/v1\/projects\/[^/]+\/improvements\/loop\/[^/]+\/candidate$/.test(path);
const decodeId = (value: string) => {
  try { return loopCandidateIdV1.parse(decodeURIComponent(value)); } catch { throw new WebAccessError("invalid_request"); }
};
export function createLoopCandidateHttpHandlerV1(options: { origin: string; service: ImproveControlRoomDeskServiceV1;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("loop_candidate_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    let exceeded = false;
    try {
      if (local) local.assertLocalRequest(request, request.method === "POST"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)()) : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const detail = /^\/api\/v1\/projects\/([^/]+)\/improvements\/loop\/([^/]+)\/candidate$/.exec(url.pathname);
      if (url.pathname === "/api/v1/loop-update-candidates" || detail) {
        if (request.method !== "GET" || request.body) throw new WebAccessError("invalid_request");
        const value = detail ? await options.service.readLoopCandidate(identity, decodeId(detail[1]!), decodeId(detail[2]!))
          : await options.service.readLoopCandidates(identity);
        return Response.json(value, { headers: privateResponseHeaders });
      }
      const decision = /^\/api\/v1\/loop-update-candidates\/([^/]+)\/decision$/.exec(url.pathname);
      if (!decision) throw new WebAccessError("not_found");
      if (request.method !== "POST" || !request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      const candidateId = decodeId(decision[1]!);
      // The Node transport and this direct handler both enforce the default 8192-byte ceiling.
      let bytes = 0;
      const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > privateRequestBudgets.default) { exceeded = true; throw new Error("body_too_large"); }
        controller.enqueue(chunk);
      } }));
      const body = loopCandidateDecisionBodySchemaV1.safeParse(await readBoundedJson(bounded, privateRequestBudgets.default));
      if (!body.success || body.data.candidateId !== candidateId) throw new WebAccessError("invalid_request");
      const value = await options.service.decideLoopCandidate(identity, body.data, request.headers.get("idempotency-key") ?? "");
      return Response.json(value, { status: value.replayed ? 200 : 201, headers: privateResponseHeaders });
    } catch (error) {
      if (exceeded) return Response.json({ error: "request_too_large" }, { status: 413, headers: privateResponseHeaders });
      if (error instanceof LoopCandidateStaleCompletionV1) return webFailure(new WebAccessError("conflict"));
      return webFailure(error);
    }
  };
}
