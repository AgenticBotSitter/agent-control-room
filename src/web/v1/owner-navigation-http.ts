// Stage 0 + 0b routes (Navigation + Home §9).
//
// FIVE ROUTES, and the split between GET and POST is the same one every other
// owner-facing read in this app makes: a GET never writes, so a browser prefetch,
// a reload or a crawler's link check cannot mark a chore done or count a visit.
//
//   GET  /api/v1/home/chores              the "Due this week" line
//   POST /api/v1/home/chores              declare one of the owner's own chores
//   POST /api/v1/home/chores/action       Done, or Snooze until a named instant
//   GET  /api/v1/home/shortcuts           pins and recently opened pages
//   POST /api/v1/home/page-visit          record one page open (fire-and-forget)
//   POST /api/v1/home/page-pin            pin or unpin one page
//
// NOTHING HERE IS CACHED AND NOTHING IS A REDIRECT. Every response carries
// privateResponseHeaders like every other private route, so a chore receipt can
// never be cached by the browser and replayed after the owner has moved on.

import { WebAccessError, createAccessVerifier, requireSameOrigin, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { OwnerNavigationServiceV1 } from "./owner-navigation-service";

/** Bounded bodies. A chore title is at most 180 characters; everything else is a
 * key and a boolean. 2KB is generous for the largest legal body and small enough
 * that a hostile client cannot make the process buffer a large payload for a
 * fire-and-forget navigation write. */
const BODY_LIMIT = 2_048;

export function createOwnerNavigationHttpHandlerV1(options: { origin: string;
  service: OwnerNavigationServiceV1; trust?: AccessTrust;
  gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  // Same one-of-the-two rule the recurring-rule handler uses: a handler is either
  // local-session authenticated or trust-assertion authenticated, never both and
  // never neither, so there is no path on which `identity` is unverified.
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("owner_navigation_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    try {
      // Second argument is "is a write": the local owner session only requires a
      // same-origin check for those, exactly as every other handler here does.
      if (local) local.assertLocalRequest(request, request.method !== "GET");
      else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)())
        : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      // A query string on any of these is refused rather than ignored. An unknown
      // parameter on a write is a client that believes it is asking for something
      // this route does not do, and answering anyway would be the wrong kind of
      // helpful.
      if (url.search) throw new WebAccessError("invalid_request");
      const json = async () => {
        if (!request.body || request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
          !== "application/json") throw new WebAccessError("invalid_request");
        return readBoundedJson(request.body, BODY_LIMIT);
      };
      const declared = (path: string) => request.method === "GET" ? undefined : json();

      if (url.pathname === "/api/v1/home/chores") {
        if (request.method === "GET") return Response.json(await options.service.dueChores(identity),
          { headers: privateResponseHeaders });
        if (request.method !== "POST") throw new WebAccessError("invalid_request");
        return Response.json(await options.service.declareChore(identity, await declared(url.pathname)),
          { status: 201, headers: privateResponseHeaders });
      }

      if (url.pathname === "/api/v1/home/chores/action") {
        if (request.method !== "POST") throw new WebAccessError("invalid_request");
        return Response.json(await options.service.actOnChore(identity, await declared(url.pathname)),
          { headers: privateResponseHeaders });
      }

      if (url.pathname === "/api/v1/home/shortcuts") {
        if (request.method !== "GET") throw new WebAccessError("invalid_request");
        return Response.json(await options.service.shortcuts(identity), { headers: privateResponseHeaders });
      }

      if (url.pathname === "/api/v1/home/page-visit") {
        if (request.method !== "POST") throw new WebAccessError("invalid_request");
        return Response.json(await options.service.recordVisit(identity, await declared(url.pathname)),
          { headers: privateResponseHeaders });
      }

      if (url.pathname === "/api/v1/home/page-pin") {
        if (request.method !== "POST") throw new WebAccessError("invalid_request");
        return Response.json(await options.service.setPin(identity, await declared(url.pathname)),
          { headers: privateResponseHeaders });
      }

      throw new WebAccessError("not_found");
    } catch (error) { return webFailure(error); }
  };
}