import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { taskCommandSchema, taskDetailSchema, taskDraftSchema, taskPageSchema, type TaskReceipt } from "./task-wire";

export const taskErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Your session has ended. Sign in again to see your tasks.",
  access_denied: "Your current access does not allow this task or action.",
  invalid_request: "Check the title and instructions. Do not include passwords, access tokens or other secrets.",
  conflict: "The project or save changed. Refresh saved work before making a new proposal.",
  not_found: "This task or project is not available.",
  unavailable: "Task information is unavailable. No sample progress has been substituted.",
  uncertain: "This save may have completed. Check this exact save again, or look in saved tasks before creating another.",
};

export function createTaskBrowserClient(transport: typeof fetch = fetch, makeKey: () => string = () => crypto.randomUUID()) {
  let pending: { projectId: string; body: string; key: string; uncertain: boolean } | undefined, busy = false;
  const checkId = (id: string) => { if (!catalogProjectIdSchema.safeParse(id).success) throw new BrowserRequestError("invalid_request"); };
  const path = (id: string) => `/api/v1/projects/${encodeURIComponent(id)}/tasks`;
  const failure = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied",
    404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
  async function call(url: string, command?: { body: string; key: string }) {
    try {
      return await transport(url, { method: command ? "POST" : "GET", credentials: "same-origin", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
          ...(command ? { "content-type": "application/json", "idempotency-key": command.key } : {}) },
        ...(command ? { body: command.body } : {}) });
    } catch { throw new BrowserRequestError(command ? "uncertain" : "unavailable"); }
  }
  async function json(response: Response) {
    if (!response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 10_000);
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 1_048_576) throw new Error(); chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function read(url: string) {
    const response = await call(url); if (!response.ok) throw new BrowserRequestError(failure(response.status));
    return json(response);
  }
  async function commit(): Promise<TaskReceipt> {
    if (!pending || busy) throw new BrowserRequestError("uncertain");
    busy = true;
    try {
      const response = await call(path(pending.projectId), pending);
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          // A denied check cannot settle whether an earlier attempt committed. Only a first-attempt
          // definitive rejection releases the hold; uncertain receipt identity survives later denials.
          if (!pending.uncertain) pending = undefined;
          throw new BrowserRequestError(failure(response.status));
        }
        throw new BrowserRequestError("uncertain");
      }
      const result = taskCommandSchema.parse(await json(response));
      if (result.receipt.projectId !== pending.projectId) throw new Error();
      pending = undefined; return result.receipt;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    }
    finally { busy = false; }
  }
  return {
    hasPending: () => !!pending,
    async list(projectId: string, after?: string) {
      try {
        checkId(projectId); if (after !== undefined) checkId(after);
        const page = taskPageSchema.parse(await read(`${path(projectId)}${after ? `?after=${encodeURIComponent(after)}` : ""}`));
        if (page.project.projectId !== projectId || page.tasks.some((task, index) => task.projectId !== projectId
          || after !== undefined && task.jobId <= after || index > 0 && task.jobId <= page.tasks[index - 1].jobId)
          || page.nextCursor !== null && (page.tasks.length !== 50 || page.nextCursor !== page.tasks.at(-1)?.jobId)) throw new Error();
        return page;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async detail(projectId: string, jobId: string) {
      try {
        checkId(projectId); checkId(jobId);
        const detail = taskDetailSchema.parse(await read(`${path(projectId)}/${encodeURIComponent(jobId)}`));
        if (detail.project.projectId !== projectId || detail.task.projectId !== projectId || detail.task.jobId !== jobId) throw new Error();
        return detail;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async propose(projectId: string, draft: unknown) {
      checkId(projectId);
      const parsed = taskDraftSchema.safeParse(draft); if (!parsed.success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.projectId !== projectId || pending.body !== body)) throw new BrowserRequestError("uncertain");
      pending ??= { projectId, body, key: makeKey(), uncertain: false };
      return commit();
    },
    // Explicit owner interaction only. Polling, reconnect and focus never invoke this method.
    retrySave: commit,
  };
}
