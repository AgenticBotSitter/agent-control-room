import type { ControlRoomLocalPilotRuntimeV1 } from "../local-pilot/v1/runtime";
import { createLocalPilotSessionHandlerV1, createLocalPilotSessionStatusHandlerV1 } from "../local-pilot/v1/session-http";
import { createLocalPilotProjectTaskHandlerV1 } from "../local-pilot/v1/project-task-http";
import { LocalPilotErrorV1 } from "../local-pilot/v1/runtime";
import { privateResponseHeaders, readBoundedJson, webFailure } from "../web/v1/http-common";
import { catalogProjectIdSchema } from "../web/v1/project-wire";
import { z } from "zod";
import type { createContributorDemoRuntime } from "./runtime";
import { contributorRevisionSchema } from "./revision";

const simulationRequest = z.object({ operation: z.literal("simulate_task"), simulationOnly: z.literal(true),
  projectId: catalogProjectIdSchema, jobId: catalogProjectIdSchema, revision: contributorRevisionSchema.optional() }).strict();

/** Request-only composition. Does not bind a socket, mount production routes or
 * discover runtime configuration. Existing handlers enforce authentication/scope.
 */
export function createContributorDemoHttp(runtime: ControlRoomLocalPilotRuntimeV1,
  simulate?: Awaited<ReturnType<typeof createContributorDemoRuntime>>["simulate"],
  history?: Awaited<ReturnType<typeof createContributorDemoRuntime>>["simulationHistory"]) {
  const issue = createLocalPilotSessionHandlerV1(runtime.ownerSession);
  const status = createLocalPilotSessionStatusHandlerV1(runtime.ownerSession);
  const workspace = createLocalPilotProjectTaskHandlerV1(runtime.projectTasks);
  const failure = (error: string, code: number) => Response.json({ error }, { status: code,
    headers: { "cache-control": "no-store", "x-control-room-pilot": "repository-fake" } });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== "http://127.0.0.1:3000") return failure("local_request_required", 403);
    if (url.pathname === "/api/v1/local-pilot/session") {
      if (url.search) return failure("invalid_request", 400);
      if (request.method === "POST") return issue(request);
      if (request.method === "GET") return status(request);
      return failure("method_not_allowed", 405);
    }
    if (url.pathname === "/api/v1/local-pilot/workspace") return workspace(request);
    if (url.pathname === "/api/v1/contributor-demo/simulations") {
      if (request.method === "GET") {
        if (!history) return failure("demo_simulation_unavailable", 503);
        const params = [...url.searchParams.keys()];
        const projectId = url.searchParams.get("projectId"), jobId = url.searchParams.get("jobId");
        if (params.length !== 2 || new Set(params).size !== 2 || !params.includes("projectId") || !params.includes("jobId")
          || !catalogProjectIdSchema.safeParse(projectId).success || !catalogProjectIdSchema.safeParse(jobId).success) {
          return failure("invalid_request", 400);
        }
        try { return Response.json(await history(request, projectId!, jobId!), { headers: privateResponseHeaders }); }
        catch (error) {
          if (error instanceof LocalPilotErrorV1 && error.safeCode === "authentication_required") return failure(error.safeCode, 401);
          if (error instanceof LocalPilotErrorV1 && error.safeCode === "local_request_required") return failure(error.safeCode, 403);
          return webFailure(error);
        }
      }
      if (!simulate) return failure("demo_simulation_unavailable", 503);
      if (request.method !== "POST") return failure("method_not_allowed", 405);
      if (request.headers.get("origin") !== url.origin) return failure("local_request_required", 403);
      if (url.search || !request.body || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return failure("invalid_request", 400);
      }
      try {
        const parsed = simulationRequest.safeParse(await readBoundedJson(request.body, 4096));
        if (!parsed.success || request.signal.aborted) return failure("invalid_request", 400);
        const result = await simulate(request, parsed.data.projectId, parsed.data.jobId, parsed.data.revision);
        return Response.json(result, { headers: { ...privateResponseHeaders, "x-control-room-pilot": "repository-fake" } });
      } catch (error) {
        if (error instanceof LocalPilotErrorV1) {
          if (error.safeCode === "authentication_required") return failure(error.safeCode, 401);
          if (error.safeCode === "local_request_required") return failure(error.safeCode, 403);
        }
        const response = webFailure(error);
        response.headers.set("x-control-room-pilot", "repository-fake");
        return response;
      }
    }
    return failure("not_found", 404);
  };
}
