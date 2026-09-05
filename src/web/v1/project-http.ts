import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust } from "./access-verifier";
import type { WebProjectService } from "./project-service";

const responseHeaders = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff" };
async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body)
    throw new WebAccessError("invalid_request");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new WebAccessError("invalid_request"); }
      parts.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  } catch { throw new WebAccessError("invalid_request"); }
  finally { reader.releaseLock(); }
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
      const path = new URL(request.url).pathname;
      if (new URL(request.url).search) throw new WebAccessError("invalid_request");
      if (path === "/api/v1/projects") {
        if (request.method === "GET") return Response.json({ projects: await options.service.list(identity) }, { headers: responseHeaders });
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
        return Response.json({ project: await options.service.get(identity, projectId) }, { headers: responseHeaders });
      }
      if (path === "/api/v1/session/logout" && request.method === "POST") {
        await options.service.logout(identity);
        // Revoke this token durably first. Browser integration also performs the Access logout navigation.
        return new Response(null, { status: 204, headers: responseHeaders });
      }
      return Response.json({ error: "not_found" }, { status: 404, headers: responseHeaders });
    } catch (error) {
      const code = error instanceof WebAccessError ? error.code : "service_unavailable";
      const status = { authentication_required: 401, access_denied: 403, invalid_request: 400, conflict: 409, not_found: 404, service_unavailable: 503 }[code];
      return Response.json({ error: code }, { status, headers: responseHeaders });
    }
  };
}
