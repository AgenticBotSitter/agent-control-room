import { z } from "zod";
import { LocalPilotErrorV1 } from "./runtime";
import type { LocalPilotProjectTasksV1 } from "./project-tasks";
import { catalogProjectIdSchema, projectCreateSchema, projectTransitionSchema } from "../../web/v1/project-wire";
import { taskDraftSchema } from "../../web/v1/task-wire";
import { WebAccessError } from "../../web/v1/access-verifier";
import { privateResponseHeaders, readBoundedJson, webFailure } from "../../web/v1/http-common";

const reads = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("synthetic_result"), projectId: catalogProjectIdSchema,
    jobId: catalogProjectIdSchema, artifactId: catalogProjectIdSchema }).strict(),
  z.object({ resource: z.literal("projects"), after: catalogProjectIdSchema.optional() }).strict(),
  z.object({ resource: z.literal("project"), projectId: catalogProjectIdSchema }).strict(),
  z.object({ resource: z.literal("tasks"), projectId: catalogProjectIdSchema, after: catalogProjectIdSchema.optional() }).strict(),
  z.object({ resource: z.literal("task"), projectId: catalogProjectIdSchema, jobId: catalogProjectIdSchema }).strict(),
  z.object({ resource: z.literal("results"), projectId: catalogProjectIdSchema, jobId: catalogProjectIdSchema,
    artifactId: catalogProjectIdSchema.optional() }).strict(),
]);
const writes = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create_project"), draft: projectCreateSchema }).strict(),
  z.object({ operation: z.literal("transition_project"), projectId: catalogProjectIdSchema, draft: projectTransitionSchema }).strict(),
  z.object({ operation: z.literal("propose_task"), projectId: catalogProjectIdSchema, draft: taskDraftSchema }).strict(),
]);
const headers = { ...privateResponseHeaders, "x-control-room-pilot": "repository-fake" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

/** Development-only mounting adapter. No execution/assignment/result-write route.
 * The runtime verifies the existing local owner cookie and canonical grants per call.
 */
export function createLocalPilotProjectTaskHandlerV1(runtime: LocalPilotProjectTasksV1 | undefined) {
  return async (request: Request): Promise<Response> => {
    if (!runtime) return json({ error: "local_pilot_disabled" }, 503);
    try {
      const url = new URL(request.url);
      if (request.signal.aborted) throw new WebAccessError("invalid_request");
      if (request.method === "GET") {
        if (request.headers.has("idempotency-key")) throw new WebAccessError("invalid_request");
        const keys = [...url.searchParams.keys()];
        if (new Set(keys).size !== keys.length) throw new WebAccessError("invalid_request");
        const parsed = reads.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) throw new WebAccessError("invalid_request");
        const query = parsed.data;
        switch (query.resource) {
          case "synthetic_result": return json(await runtime.getSyntheticResult(request, query.projectId, query.jobId, query.artifactId));
          case "projects": return json(await runtime.listProjects(request, query.after));
          case "project": return json({ project: await runtime.getProject(request, query.projectId) });
          case "tasks": return json(await runtime.listTasks(request, query.projectId, query.after));
          case "task": return json(await runtime.getTask(request, query.projectId, query.jobId));
          case "results": return json(await runtime.getResults(request, query.projectId, query.jobId, query.artifactId));
        }
      }
      if (request.method !== "POST") throw new WebAccessError("not_found");
      if (url.search || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
        || !request.body) throw new WebAccessError("invalid_request");
      const key = request.headers.get("idempotency-key");
      if (!key) throw new WebAccessError("invalid_request");
      const parsed = writes.safeParse(await readBoundedJson(request.body, 24_576));
      if (!parsed.success || request.signal.aborted) throw new WebAccessError("invalid_request");
      const command = parsed.data;
      const result = command.operation === "create_project" ? await runtime.createProject(request, command.draft, key)
        : command.operation === "transition_project" ? await runtime.transitionProject(request, command.projectId, command.draft, key)
          : await runtime.proposeTask(request, command.projectId, command.draft, key);
      return json(result, result.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof LocalPilotErrorV1) {
        const status = error.safeCode === "authentication_required" ? 401 : error.safeCode === "local_request_required" ? 403 : 503;
        return json({ error: status === 503 ? "local_pilot_unavailable" : error.safeCode }, status);
      }
      const failure = webFailure(error);
      failure.headers.set("x-control-room-pilot", "repository-fake");
      return failure;
    }
  };
}
