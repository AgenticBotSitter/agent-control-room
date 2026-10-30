import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { LoopRosterRefusedV1, type LoopRosterServiceV1 } from "./loop-roster-service";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import { privateRequestBudgets } from "./private-request-budgets";

/** `{name}` is one percent-encoded path segment: four shipped names contain a slash. */
export const isLoopRosterRouteV1 = (path: string) => path === "/api/v1/loop-roster"
  || /^\/api\/v1\/loop-roster\/models\/[^/]+(?:\/on)?$/.test(path);
const decodeName = (value: string) => {
  try { return decodeURIComponent(value); } catch { throw new WebAccessError("invalid_request"); }
};

export function createLoopRosterHttpHandlerV1(options: { origin: string; service: LoopRosterServiceV1;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("loop_roster_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    let exceeded = false;
    try {
      const write = request.method === "PUT" || request.method === "POST";
      if (local) local.assertLocalRequest(request, write); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)()) : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      if (url.pathname === "/api/v1/loop-roster") {
        if (request.method !== "GET" || request.body) throw new WebAccessError("invalid_request");
        return Response.json(await options.service.view(identity), { headers: privateResponseHeaders });
      }
      const route = /^\/api\/v1\/loop-roster\/models\/([^/]+)(\/on)?$/.exec(url.pathname);
      if (!route) throw new WebAccessError("not_found");
      if (request.method !== (route[2] ? "POST" : "PUT") || !request.body
        || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      const name = decodeName(route[1]!);
      let bytes = 0;
      const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > privateRequestBudgets.default) { exceeded = true; throw new Error("body_too_large"); }
        controller.enqueue(chunk);
      } }));
      const body = await readBoundedJson(bounded, privateRequestBudgets.default);
      const key = request.headers.get("idempotency-key") ?? "";
      const value = route[2] ? await options.service.setOn(identity, name, body, key)
        : await options.service.upsert(identity, name, body, key);
      return Response.json(value, { status: value.replayed ? 200 : 201, headers: privateResponseHeaders });
    } catch (error) {
      if (exceeded) return Response.json({ error: "request_too_large" }, { status: 413, headers: privateResponseHeaders });
      // cr's own problem lines; nothing was committed.
      if (error instanceof LoopRosterRefusedV1) return Response.json({ error: "roster_refused", reason: error.reason,
        message: error.message, problems: error.problems }, { status: 422, headers: privateResponseHeaders });
      return webFailure(error);
    }
  };
}
