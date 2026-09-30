import { BrowserRequestError } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { taskHomeActivitySchema } from "./task-home-wire";
import type { OwnerSurfaceV1 } from "./task-home-wire";

/** Read-only home activity. It cannot submit, retry, resume or acknowledge work. */
export async function readTaskHomeActivity(transport: typeof fetch = fetch, signal?: AbortSignal,
  options: Readonly<{ surface?: OwnerSurfaceV1; recent?: boolean }> = {}) {
  try {
    const surface = options.surface ?? "home";
    const query = new URLSearchParams({ surface, ...(options.recent ? { recent: "true" } : {}) });
    const path = surface === "home" && !options.recent ? "/api/v1/home/tasks" : `/api/v1/home/tasks?${query}`;
    const response = await transport(path, { method: "GET", credentials: "same-origin",
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

/** Called only after the matching surface has painted the successful read. A
 * lost response is safe to retry because the server advances with GREATEST. */
export async function acknowledgeTaskHomeActivity(cursor: Readonly<{ surface: OwnerSurfaceV1;
  acknowledgeThrough: string }>, transport: typeof fetch = fetch, signal?: AbortSignal) {
  try {
    const response = await transport("/api/v1/home/tasks", { method: "POST", credentials: "same-origin",
      cache: "no-store", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
      body: JSON.stringify(cursor) });
    if (response.status === 401) throw new BrowserRequestError("authentication_required");
    if (response.status === 403) throw new BrowserRequestError("access_denied");
    if (!response.ok) throw new BrowserRequestError("unavailable");
    return response.json() as Promise<{ acknowledged: true; seenThrough: string }>;
  } catch (error) {
    throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
  }
}

/** Run `work` once the browser has painted, and hand back a cancel.
 *
 * The owner cursor may only advance after a read that actually reached the
 * screen. `requestAnimationFrame` is not guaranteed to exist (jsdom, older
 * engines, a prerender pass), and a missing scheduler must mean "no
 * acknowledgement" rather than a broken page: the owner sees the same items
 * again on the next visit, which is the safe direction. */
export function scheduleAfterPaint(work: () => void): () => void {
  if (typeof requestAnimationFrame !== "function" || typeof cancelAnimationFrame !== "function") {
    return () => undefined;
  }
  const request = requestAnimationFrame.bind(globalThis);
  const cancel = cancelAnimationFrame.bind(globalThis);
  const handle = request(() => { work(); });
  return () => cancel(handle);
}
