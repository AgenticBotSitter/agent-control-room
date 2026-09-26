import { BrowserRequestError } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { taskHomeActivitySchema } from "./task-home-wire";

/** Read-only home activity. It cannot submit, retry, resume or acknowledge work. */
export async function readTaskHomeActivity(transport: typeof fetch = fetch, signal?: AbortSignal) {
  try {
    const response = await transport("/api/v1/home/tasks", { method: "GET", credentials: "same-origin",
      cache: "no-store", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
    if (response.status === 401) throw new BrowserRequestError("authentication_required");
    if (response.status === 403) throw new BrowserRequestError("access_denied");
    if (!response.ok) throw new BrowserRequestError("unavailable");
    return taskHomeActivitySchema.parse(await readBrowserJson(response));
  } catch (error) {
    throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
  }
}
