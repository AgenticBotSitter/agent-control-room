import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { projectSettingsSchema, projectSettingsDraftSchema } from "./project-settings-wire";
import type { ProjectSettings, ProjectSettingsDraft } from "./project-settings-wire";

export const projectSettingsErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Sign in again to see this project's settings.", access_denied: "Your current access does not allow editing this project's settings.",
  invalid_request: "Check the values and try saving again.", conflict: "These settings changed elsewhere. Refresh before saving again.",
  not_found: "Settings are available only for a project you can access.",
  unavailable: "Project settings are not connected or are unavailable.",
  uncertain: "This save may have gone through. Refresh before trying again.",
};
export function createProjectSettingsBrowserClient(transport: typeof fetch = fetch) {
  let pending: { projectId: string; body: string; uncertain: boolean } | undefined, busy = false;
  const path = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/settings`;
  const failure = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied",
    404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
  async function call(projectId: string, body?: string) {
    try { return await transport(path(projectId), { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
        ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}) }); }
    catch { throw new BrowserRequestError(body ? "uncertain" : "unavailable"); }
  }
  async function json(response: Response) {
    if (!response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 10_000);
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 65_536) throw new Error(); chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function commit(): Promise<ProjectSettings> {
    if (!pending || busy) throw new BrowserRequestError("uncertain"); busy = true;
    try {
      const draft = projectSettingsDraftSchema.parse(JSON.parse(pending.body));
      const response = await call(pending.projectId, pending.body);
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          if (!pending.uncertain) pending = undefined;
          throw new BrowserRequestError(failure(response.status));
        }
        throw new BrowserRequestError("uncertain");
      }
      const value = projectSettingsSchema.parse(await json(response));
      if (value.projectId !== pending.projectId || value.version !== draft.expectedVersion + 1) throw new Error();
      pending = undefined; return value;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    } finally { busy = false; }
  }
  return {
    hasPending: () => !!pending,
    async read(projectId: string): Promise<ProjectSettings> {
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
      try {
        const response = await call(projectId);
        if (!response.ok) throw new BrowserRequestError(failure(response.status));
        const value = projectSettingsSchema.parse(await json(response));
        if (value.projectId !== projectId) throw new Error();
        return value;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async save(projectId: string, draft: ProjectSettingsDraft) {
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
      const parsed = projectSettingsDraftSchema.safeParse(draft);
      if (!parsed.success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.projectId !== projectId || pending.body !== body)) throw new BrowserRequestError("uncertain");
      pending ??= { projectId, body, uncertain: false }; return commit();
    },
    retrySave: commit,
  };
}
