import { BrowserRequestError } from "../../web/v1/browser-client";
import { readBrowserJson } from "../../web/v1/browser-json";
import { catalogProjectIdSchema } from "../../web/v1/project-wire";
import { taskHomeActivitySchema } from "../../web/v1/task-home-wire";
import { taskProjectOverviewSchema } from "../../web/v1/task-project-overview-wire";
import { taskProjectAgentOptionsSchema } from "../../web/v1/task-project-agents-wire";
import { taskProjectAttentionPageSchema } from "../../web/v1/task-project-attention-wire";

/** Browser reads for the local workboard. Every request is a bounded GET to the
 * local pilot adapter and each response is parsed by the existing product wire.
 */
export function createLocalPilotControlRoomClientV1(transport: typeof fetch = fetch) {
  async function read(params: Record<string, string>) {
    try {
      const response = await transport(`/api/v1/local-pilot/workspace?${new URLSearchParams(params)}`, {
        method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
      });
      if (response.status === 401) throw new BrowserRequestError("authentication_required");
      if (response.status === 403) throw new BrowserRequestError("access_denied");
      if (response.status === 404) throw new BrowserRequestError("not_found");
      if (!response.ok) throw new BrowserRequestError("unavailable");
      return readBrowserJson(response);
    } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
  }
  const project = (projectId: string) => {
    if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
    return projectId;
  };
  return Object.freeze({
    async home() { return taskHomeActivitySchema.parse(await read({ resource: "home" })); },
    async overview(projectId: string) { const id = project(projectId); const value = taskProjectOverviewSchema.parse(await read({ resource: "overview", projectId: id }));
      if (value.projectId !== id) throw new BrowserRequestError("unavailable"); return value; },
    async agents(projectId: string) { const id = project(projectId); const value = taskProjectAgentOptionsSchema.parse(await read({ resource: "agents", projectId: id }));
      if (value.projectId !== id) throw new BrowserRequestError("unavailable"); return value; },
    async attention(projectId: string, mode: "inbox" | "reviews", after?: string) { const id = project(projectId);
      if (after !== undefined) project(after); const value = taskProjectAttentionPageSchema.parse(await read({ resource: "attention", projectId: id, mode, ...(after ? { after } : {}) }));
      if (value.projectId !== id || value.mode !== mode) throw new BrowserRequestError("unavailable"); return value; },
  });
}
