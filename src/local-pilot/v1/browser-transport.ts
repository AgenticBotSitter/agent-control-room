import { catalogProjectIdSchema, projectCreateSchema, projectTransitionSchema } from "../../web/v1/project-wire";
import { taskDraftSchema } from "../../web/v1/task-wire";

/** Reuse the canonical browser clients, including their exact-save retry handling.
 * Unsupported operational routes never fall through to another API. Server-side
 * owner authentication and authorization remain required on every request.
 */
export function createLocalPilotBrowserTransportV1(transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const invalid = () => new TypeError("Unsupported local pilot request");
    if (typeof input !== "string" || !input.startsWith("/api/v1/projects") || input.includes("#")
      || input.includes("\\")) throw invalid();
    const [pathname, query = "", extra] = input.split("?");
    if (extra !== undefined) throw invalid();
    const match = /^\/api\/v1\/projects(?:\/([^/]+)(?:\/(lifecycle|tasks)(?:\/([^/]+)(?:\/(results|synthetic-results)(?:\/([^/]+))?)?)?)?)?$/.exec(pathname);
    if (!match) throw invalid();
    const decodeId = (value: string | undefined) => value === undefined ? undefined
      : catalogProjectIdSchema.parse(decodeURIComponent(value));
    const projectId = decodeId(match[1]);
    const jobId = decodeId(match[3]);
    const action = match[2];
    const results = match[4] !== undefined;
    const artifactId = decodeId(match[5]);
    if (results && action !== "tasks") throw invalid();
    const synthetic = match[4] === "synthetic-results";
    if (synthetic && !artifactId) throw invalid();
    const method = init?.method ?? "GET";
    const params = new URLSearchParams(query);
    let body: string | undefined;
    let target = "/api/v1/local-pilot/workspace";
    if (method === "GET") {
      if (init?.body != null || action === "lifecycle" || (action !== "tasks" && jobId)) throw invalid();
      const list = projectId === undefined || action === "tasks" && jobId === undefined;
      if ([...params.keys()].some(key => key !== "after") || params.getAll("after").length > 1
        || !list && params.has("after")) throw invalid();
      const after = params.has("after") ? catalogProjectIdSchema.parse(params.get("after")) : undefined;
      const mapped = new URLSearchParams({ resource: projectId === undefined ? "projects"
        : synthetic ? "synthetic_result" : results ? "results" : action === "tasks" ? jobId === undefined ? "tasks" : "task" : "project" });
      if (projectId !== undefined) mapped.set("projectId", projectId);
      if (jobId !== undefined) mapped.set("jobId", jobId);
      if (artifactId !== undefined) mapped.set("artifactId", artifactId);
      if (after !== undefined) mapped.set("after", after);
      target += `?${mapped}`;
    } else if (method === "POST") {
      if (query || jobId !== undefined || typeof init?.body !== "string" || init.body.length > 24_576) throw invalid();
      const draft: unknown = JSON.parse(init.body);
      if (projectId === undefined) body = JSON.stringify({ operation: "create_project", draft: projectCreateSchema.parse(draft) });
      else if (action === "lifecycle") body = JSON.stringify({ operation: "transition_project", projectId,
        draft: projectTransitionSchema.parse(draft) });
      else if (action === "tasks") body = JSON.stringify({ operation: "propose_task", projectId, draft: taskDraftSchema.parse(draft) });
      else throw invalid();
    } else throw invalid();
    return transport(target, { ...init, method, ...(body === undefined ? {} : { body }) });
  };
}
