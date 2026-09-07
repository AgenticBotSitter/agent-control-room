import type { ControlRoomLocalPilotRuntimeV1 } from "../local-pilot/v1/runtime";
import { createLocalPilotSessionHandlerV1, createLocalPilotSessionStatusHandlerV1 } from "../local-pilot/v1/session-http";
import { createLocalPilotProjectTaskHandlerV1 } from "../local-pilot/v1/project-task-http";

/** Request-only composition. Does not bind a socket, mount production routes or
 * discover runtime configuration. Existing handlers enforce authentication/scope.
 */
export function createContributorDemoHttp(runtime: ControlRoomLocalPilotRuntimeV1) {
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
    return failure("not_found", 404);
  };
}
