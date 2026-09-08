import { BrowserRequestError } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { ideaPageSchema, ideaDetailSchema } from "./idea-wire";
import { catalogProjectIdSchema } from "./project-wire";

export function createIdeaBrowserClient(transport: typeof fetch = fetch) {
  const id = (value: string) => { if (!catalogProjectIdSchema.safeParse(value).success) throw new BrowserRequestError("invalid_request"); };
  async function read(path: string, signal?: AbortSignal) {
    try {
      const response = await transport(path, { credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" } });
      if (!response.ok) throw new BrowserRequestError(response.status === 401 ? "authentication_required"
        : response.status === 403 ? "access_denied" : response.status === 404 ? "not_found" : "unavailable");
      return await readBrowserJson(response);
    } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
  }
  return {
    async list(after?: string, signal?: AbortSignal) {
      if (after !== undefined) id(after);
      try {
        const page = ideaPageSchema.parse(await read(`/api/v1/ideas${after ? `?after=${encodeURIComponent(after)}` : ""}`, signal));
        if (page.sessions.some((s, i) => after !== undefined && s.sessionId <= after || i > 0 && s.sessionId <= page.sessions[i - 1].sessionId)
          || page.nextCursor !== null && (page.sessions.length !== 50 || page.nextCursor !== page.sessions.at(-1)?.sessionId)) throw new Error();
        return page;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async detail(sessionId: string, signal?: AbortSignal) {
      id(sessionId);
      try {
        const detail = ideaDetailSchema.parse(await read(`/api/v1/ideas/${encodeURIComponent(sessionId)}`, signal));
        if (detail.session.sessionId !== sessionId) throw new Error();
        return detail;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
  };
}
