import { BrowserRequestError } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { catalogProjectIdSchema } from "./project-wire";
import { sessionWatchPageSchemaV1 } from "./session-watch-wire";

/** Reads only retained cross-project run evidence. It cannot start, stop, retry, resume, approve or accept work. */
export async function readSessionWatchV1(after?: string, transport: typeof fetch = fetch, signal?: AbortSignal) {
  if (after !== undefined && !catalogProjectIdSchema.safeParse(after).success) throw new BrowserRequestError("invalid_request");
  const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
  try {
    const response = await transport(`/api/v1/session-watch${query}`, { method: "GET", credentials: "same-origin",
      cache: "no-store", redirect: "error", headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    if (response.status === 401) throw new BrowserRequestError("authentication_required");
    if (response.status === 403) throw new BrowserRequestError("access_denied");
    if (!response.ok) throw new BrowserRequestError("unavailable");
    return sessionWatchPageSchemaV1.parse(await readBrowserJson(response));
  } catch (error) {
    throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
  }
}
