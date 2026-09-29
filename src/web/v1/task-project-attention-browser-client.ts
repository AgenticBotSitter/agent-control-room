import { BrowserRequestError } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { catalogProjectIdSchema } from "./project-wire";
import { taskProjectAttentionPageSchema } from "./task-project-attention-wire";

export async function readTaskProjectAttention(projectId: string, mode: "inbox" | "reviews", after?: string,
  transport: typeof fetch = fetch, signal?: AbortSignal) {
  try {
    if (!catalogProjectIdSchema.safeParse(projectId).success || after !== undefined && !catalogProjectIdSchema.safeParse(after).success)
      throw new BrowserRequestError("invalid_request");
    signal?.throwIfAborted();
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    const response = await transport(`/api/v1/projects/${encodeURIComponent(projectId)}/${mode}${query}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
    });
    if (response.status === 401) throw new BrowserRequestError("authentication_required");
    if (response.status === 403) throw new BrowserRequestError("access_denied");
    if (response.status === 404) throw new BrowserRequestError("not_found");
    if (!response.ok) throw new BrowserRequestError("unavailable");
    const value = taskProjectAttentionPageSchema.parse(await readBrowserJson(response));
    if (value.projectId !== projectId || value.mode !== mode
      || after !== undefined && value.items.some(item => item.task.jobId <= after)
      || value.nextCursor !== null && (value.examined !== 20 || after !== undefined && value.nextCursor <= after
        || value.items.some(item => item.task.jobId > value.nextCursor!))) throw new Error();
    return value;
  } catch (error) {
    throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
  }
}
