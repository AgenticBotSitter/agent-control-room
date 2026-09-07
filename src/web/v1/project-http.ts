import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust } from "./access-verifier";
import type { WebProjectService } from "./project-service";
import { privateResponseHeaders as responseHeaders, readBoundedJson, webFailure } from "./http-common";

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body)
    throw new WebAccessError("invalid_request");
  return readBoundedJson(request.body, 8192);
}

/** Full Web Request -> transaction -> response seam. Composition is explicit; never opens a database. */
export function createProjectHttpHandler(options: {
  origin: string; trust: AccessTrust; service: WebProjectService; clock?: () => number;
}) {
  const verifyIdentity = createAccessVerifier(options.trust);
  const clock = options.clock ?? Date.now;
  return async (request: Request): Promise<Response> => {
    try {
      requireSameOrigin(request, options.origin);
      const identity = verifyIdentity(request, clock());
      const url = new URL(request.url), path = url.pathname;
      if (path === "/api/v1/projects" && request.method === "GET") {
        if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1)
          throw new WebAccessError("invalid_request");
        return Response.json(await options.service.listPage(identity, url.searchParams.get("after") ?? undefined), { headers: responseHeaders });
      }
      if (url.search) throw new WebAccessError("invalid_request");
      if (path === "/api/v1/projects") {
        if (request.method === "POST") {
          const result = await options.service.create(identity, await readBody(request), request.headers.get("idempotency-key") ?? "");
          return Response.json(result, { status: result.replayed ? 200 : 201, headers: responseHeaders });
        }
      }
      const lifecycle = /^\/api\/v1\/projects\/([^/]+)\/lifecycle$/.exec(path);
      if (lifecycle && request.method === "POST") {
        let projectId: string;
        try { projectId = decodeURIComponent(lifecycle[1]); } catch { throw new WebAccessError("invalid_request"); }
        return Response.json(await options.service.transition(identity, projectId, await readBody(request), request.headers.get("idempotency-key") ?? ""),
          { headers: responseHeaders });
      }
      const detail = /^\/api\/v1\/projects\/([^/]+)$/.exec(path);
      if (detail && request.method === "GET") {
        let projectId: string;
        try { projectId = decodeURIComponent(detail[1]); } catch { throw new WebAccessError("invalid_request"); }
        return Response.json({ project: await options.service.getView(identity, projectId) }, { headers: responseHeaders });
      }
      if (path === "/api/v1/session/logout" && request.method === "POST") {
        await options.service.logout(identity);
        // Revoke this token durably first. Browser integration also performs the Access logout navigation.
        return new Response(null, { status: 204, headers: responseHeaders });
      }
      return Response.json({ error: "not_found" }, { status: 404, headers: responseHeaders });
    } catch (error) {
      return webFailure(error);
    }
  };
}
