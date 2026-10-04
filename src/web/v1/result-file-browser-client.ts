import { BrowserRequestError } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { catalogProjectIdSchema } from "./project-wire";
import { resultFileCatalogSchema, type ResultFileCatalog } from "./result-file-wire";

/**
 * The browser side of "Save to my Mac".
 *
 * Two calls, both same-origin and both credentialed: read the catalog, and ask
 * for a download link. The link is then handed to the browser as an ordinary
 * navigation, because a download is a navigation — the bytes are fetched by the
 * browser, not assembled in JavaScript, so a 256 MiB file never passes through
 * this tab's heap.
 */
export async function readResultFileCatalog(projectId: string, jobId: string | undefined,
  transport: typeof fetch = fetch, signal?: AbortSignal): Promise<ResultFileCatalog> {
  try {
    if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
    if (jobId !== undefined && !catalogProjectIdSchema.safeParse(jobId).success)
      throw new BrowserRequestError("invalid_request");
    signal?.throwIfAborted();
    const query = jobId === undefined ? "" : `?job=${encodeURIComponent(jobId)}`;
    const response = await transport(`/api/v1/projects/${encodeURIComponent(projectId)}/result-files${query}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
    });
    if (response.status === 401) throw new BrowserRequestError("authentication_required");
    if (response.status === 403) throw new BrowserRequestError("access_denied");
    if (response.status === 404) throw new BrowserRequestError("not_found");
    if (!response.ok) throw new BrowserRequestError("unavailable");
    const value = resultFileCatalogSchema.parse(await readBrowserJson(response));
    if (value.projectId !== projectId) throw new Error();
    if (jobId !== undefined && value.jobId !== jobId) throw new Error();
    return value;
  } catch (error) {
    throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
  }
}

/** Asks the server for one fresh link. The server is the only thing that mints
 * a token, so a page cannot invent one and the link it receives is the only
 * link that can ever be spent. */
export async function requestResultFileDownload(projectId: string, setId: string, fileId: string,
  transport: typeof fetch = fetch, signal?: AbortSignal): Promise<{ href: string; expiresAt: string }> {
  try {
    if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
    if (!/^result-set:[a-f0-9]{32}$/u.test(setId) || !/^result-file:[a-f0-9]{32}$/u.test(fileId))
      throw new BrowserRequestError("invalid_request");
    signal?.throwIfAborted();
    const response = await transport(`/api/v1/projects/${encodeURIComponent(projectId)}/result-files/`
      + `${encodeURIComponent(setId)}/${encodeURIComponent(fileId)}/download`, {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
    });
    if (response.status === 401) throw new BrowserRequestError("authentication_required");
    if (response.status === 403) throw new BrowserRequestError("access_denied");
    if (response.status === 404) throw new BrowserRequestError("not_found");
    if (!response.ok) throw new BrowserRequestError("unavailable");
    const value = await readBrowserJson(response) as { href?: unknown; expiresAt?: unknown };
    // A link is only usable if it is a link to THIS project's route. Anything
    // else — a storage path, an object-store URL, another origin — is refused
    // here rather than navigated to.
    if (typeof value.href !== "string" || !value.href.startsWith("/api/v1/") || value.href.length > 4096
      || typeof value.expiresAt !== "string") throw new Error();
    return { href: value.href, expiresAt: value.expiresAt };
  } catch (error) {
    throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
  }
}
