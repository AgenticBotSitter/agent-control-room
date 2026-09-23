import { BrowserRequestError } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { readPrivateConnections, ConnectionBrowserError, type PrivateConnectionSnapshot } from "./connection-browser-client";
import { readOperatorCapacityViewV1, type OperatorCapacityViewV1 } from "./operator-capacity-browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { createTaskBrowserClient } from "./task-browser-client";
import { readTaskProjectOverview } from "./task-project-overview-browser-client";
import type { TaskProjectOverview } from "./task-project-overview-wire";
import type { TaskDetail } from "./task-wire";
import { taskProjectAgentOptionsSchema, type TaskProjectAgentOptions } from "./task-project-agents-wire";

export type ProjectAgentTaskEvidence = Readonly<{
  jobId: string;
  detail: { state: "ready"; value: TaskDetail }
    | { state: "unavailable"; code: BrowserRequestError["code"] };
}>;

export type ProjectAgentVisibilityRead = Readonly<{
  eligibility: { state: "ready"; value: TaskProjectAgentOptions }
    | { state: "unavailable"; code: BrowserRequestError["code"] };
  connections: { state: "ready"; value: PrivateConnectionSnapshot }
    | { state: "unavailable"; code: ConnectionBrowserError["code"] };
  capacity: { state: "ready"; value: OperatorCapacityViewV1 }
    | { state: "unavailable"; code: "authentication_required" | "operator_surface_unavailable" | "invalid_response" | "request_failed" };
  currentWork: { state: "ready"; value: TaskProjectOverview }
    | { state: "unavailable"; code: BrowserRequestError["code"] };
  agentWork: { state: "ready"; value: readonly ProjectAgentTaskEvidence[] }
    | { state: "unavailable"; code: BrowserRequestError["code"] };
}>;

function failure(status: number): BrowserRequestError["code"] {
  const codes: Record<number, BrowserRequestError["code"]> = {
    400: "invalid_request",
    401: "authentication_required",
    403: "access_denied",
    404: "not_found",
  };
  return codes[status] ?? "unavailable";
}

export async function readTaskProjectAgentOptions(projectId: string, transport: typeof fetch = fetch,
  signal?: AbortSignal): Promise<TaskProjectAgentOptions> {
  try {
    if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
    signal?.throwIfAborted();
    const response = await transport(`/api/v1/projects/${encodeURIComponent(projectId)}/agents`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
    });
    if (!response.ok) throw new BrowserRequestError(failure(response.status));
    const value = taskProjectAgentOptionsSchema.parse(await readBrowserJson(response));
    if (value.projectId !== projectId) throw new Error();
    return value;
  } catch (error) {
    throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
  }
}

/**
 * Reads four independent existing evidence sources. A failed source remains
 * unavailable on its own; it never empties or reclassifies another source.
 */
export async function readProjectAgentVisibility(projectId: string, transport: typeof fetch = fetch,
  signal?: AbortSignal): Promise<ProjectAgentVisibilityRead> {
  const [eligibility, connections, capacity, currentWork] = await Promise.all([
    readTaskProjectAgentOptions(projectId, transport, signal).then(value => ({ state: "ready" as const, value }), error => ({
      state: "unavailable" as const, code: error instanceof BrowserRequestError ? error.code : "unavailable" as const })),
    readPrivateConnections(transport, signal).then(value => ({ state: "ready" as const, value }), error => ({ state: "unavailable" as const,
      code: error instanceof ConnectionBrowserError ? error.code : "unavailable" as const })),
    readOperatorCapacityViewV1({ fetcher: transport, signal }).then(value => value.state === "available"
      ? { state: "ready" as const, value: value.view }
      : { state: "unavailable" as const, code: value.code }),
    readTaskProjectOverview(projectId, transport, signal).then(value => ({ state: "ready" as const, value }), error => ({
      state: "unavailable" as const, code: error instanceof BrowserRequestError ? error.code : "unavailable" as const })),
  ]);
  const agentWork = currentWork.state === "unavailable"
    ? { state: "unavailable" as const, code: currentWork.code }
    : { state: "ready" as const, value: Object.freeze(await Promise.all(currentWork.value.current.map(async task => {
      try {
        const value = await createTaskBrowserClient(transport).detail(projectId, task.jobId, signal);
        return Object.freeze({ jobId: task.jobId, detail: { state: "ready" as const, value } });
      } catch (error) {
        return Object.freeze({ jobId: task.jobId, detail: { state: "unavailable" as const,
          code: error instanceof BrowserRequestError ? error.code : "unavailable" as const } });
      }
    }))) };
  return Object.freeze({ eligibility, connections, capacity, currentWork, agentWork });
}
