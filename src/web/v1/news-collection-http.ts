import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust } from "./access-verifier";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { WebNewsCollectionPlanning } from "./news-collection-planning";
import type { WebNewsCollectionAdmission } from "./news-collection-admission";

/** Explicit project-scoped composition; does not enable a collector or open a database. */
export function createNewsCollectionHttpHandler(options: { origin: string; trust: AccessTrust; projectId: string;
  planning: Pick<WebNewsCollectionPlanning, "propose">; admission: Pick<WebNewsCollectionAdmission, "approve">; clock?: () => number }) {
  const verify = createAccessVerifier(options.trust), clock = options.clock ?? Date.now;
  const propose = options.planning.propose.bind(options.planning), approve = options.admission.approve.bind(options.admission);
  const path = `/api/v1/projects/${encodeURIComponent(options.projectId)}/news/collection`;
  return async (request: Request): Promise<Response> => {
    try {
      requireSameOrigin(request, options.origin);
      const identity = verify(request, clock()), url = new URL(request.url);
      if (url.pathname !== `${path}/propose` && url.pathname !== `${path}/approve`)
        return Response.json({ error: "not_found" }, { status: 404, headers: privateResponseHeaders });
      if (request.method !== "POST" || url.search || request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body)
        throw new WebAccessError("invalid_request");
      const input = await readBoundedJson(request.body, 4096);
      const result = url.pathname.endsWith("/propose") ? await propose(identity, input) : await approve(identity, input);
      return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
    } catch (error) { return webFailure(error); }
  };
}
