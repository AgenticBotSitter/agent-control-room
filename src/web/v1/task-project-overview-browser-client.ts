import { BrowserRequestError } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { catalogProjectIdSchema } from "./project-wire";
import { taskProjectOverviewSchema } from "./task-project-overview-wire";

export async function readTaskProjectOverview(projectId: string, transport: typeof fetch = fetch, signal?: AbortSignal) {
  try {
    if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
    signal?.throwIfAborted();
    const response = await transport(`/api/v1/projects/${encodeURIComponent(projectId)}/overview`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
    });
    if (response.status === 401) throw new BrowserRequestError("authentication_required");
    if (response.status === 403) throw new BrowserRequestError("access_denied");
    if (response.status === 404) throw new BrowserRequestError("not_found");
    if (!response.ok) throw new BrowserRequestError("unavailable");
    const value = taskProjectOverviewSchema.parse(await readBrowserJson(response));
    if (value.projectId !== projectId) throw new Error();
    return value;
  } catch (error) {
    throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
  }
}
