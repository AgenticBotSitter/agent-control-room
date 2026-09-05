import { z } from "zod";
import { projectCreateSchema, projectTransitionSchema, webProjectSchema, type WebProject } from "./project-wire";

export type BrowserFailureCode = "authentication_required" | "access_denied" | "invalid_request" | "conflict" | "not_found" | "unavailable" | "uncertain";
export class BrowserRequestError extends Error {
  constructor(readonly code: BrowserFailureCode) { super(code); }
}
export const browserErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Your session has ended. Sign in again to continue.",
  access_denied: "You do not have access to this project or action.",
  invalid_request: "Check the project title and summary, then try again.",
  conflict: "This project changed in another tab. Refresh it before saving again.",
  not_found: "This project is not available.",
  unavailable: "Control Room is unavailable. Your saved projects have not been replaced with sample data.",
  uncertain: "The save could not be confirmed. Retry the same save or check your projects before starting another.",
};

export function createProjectBrowserClient(transport: typeof fetch = fetch, makeKey: () => string = () => crypto.randomUUID()) {
  let pending: { path: string; body: string; key: string } | undefined;
  let busy = false;
  async function call(path: string, method = "GET", body?: string, key?: string): Promise<Response> {
    try {
      return await transport(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10_000), headers: { accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "idempotency-key": key } : {}) },
        ...(body === undefined ? {} : { body }) });
    } catch { throw new BrowserRequestError(method === "GET" ? "unavailable" : "uncertain"); }
  }
  const errorFor = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required",
    403: "access_denied", 404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
  async function read(response: Response): Promise<unknown> {
    if (!response.ok) throw new BrowserRequestError(errorFor(response.status));
    try { return await response.json(); } catch { throw new BrowserRequestError("unavailable"); }
  }
  async function command(path: string, value: unknown): Promise<WebProject> {
    if (busy) throw new BrowserRequestError("uncertain");
    const body = JSON.stringify(value);
    if (pending && (pending.path !== path || pending.body !== body)) throw new BrowserRequestError("uncertain");
    pending ??= { path, body, key: makeKey() };
    busy = true;
    try {
      const response = await call(path, "POST", body, pending.key);
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) { pending = undefined; throw new BrowserRequestError(errorFor(response.status)); }
        throw new BrowserRequestError("uncertain");
      }
      const result = z.object({ project: webProjectSchema, replayed: z.boolean() }).strict().parse(await response.json());
      pending = undefined;
      return result.project;
    } catch (error) {
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    } finally { busy = false; }
  }
  return {
    async list(): Promise<WebProject[]> {
      try { return z.object({ projects: z.array(webProjectSchema).max(200) }).strict().parse(await read(await call("/api/v1/projects"))).projects; }
      catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async get(id: string): Promise<WebProject> {
      try {
        const result = z.object({ project: webProjectSchema }).strict().parse(await read(await call(`/api/v1/projects/${encodeURIComponent(id)}`)));
        if (result.project.projectId !== id) throw new Error();
        return result.project;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    create(draft: unknown) {
      const parsed = projectCreateSchema.safeParse(draft);
      if (!parsed.success) return Promise.reject(new BrowserRequestError("invalid_request"));
      return command("/api/v1/projects", parsed.data);
    },
    transition(project: WebProject, lifecycle: WebProject["lifecycle"]) {
      const input = projectTransitionSchema.parse({ lifecycle, expectedVersion: project.version });
      return command(`/api/v1/projects/${encodeURIComponent(project.projectId)}/lifecycle`, input);
    },
    async logout() {
      const response = await call("/api/v1/session/logout", "POST");
      if (response.status !== 204) throw new BrowserRequestError(errorFor(response.status));
      // This path is handled by the configured Access edge, not by a custom password/session endpoint.
      return "/cdn-cgi/access/logout" as const;
    },
  };
}
