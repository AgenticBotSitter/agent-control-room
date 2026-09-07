import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { taskPlanningDraftSchema, taskPlanningOptionsSchema, taskPlanningCommandSchema, type TaskPlanningReceipt } from "./task-planning-wire";

export const planningErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Sign in again before preparing this task.", access_denied: "Your current access does not permit preparing this task.",
  invalid_request: "Refresh the saved task before preparing it.", conflict: "The saved task or planning template changed. Refresh before continuing.",
  not_found: "This task is not available.", unavailable: "Task preparation is unavailable. No agent has been started.",
  uncertain: "The plan may have saved. Check this exact preparation again before preparing another task. This does not start an agent.",
};

export function createTaskPlanningBrowserClient(transport: typeof fetch = fetch) {
  let pending: { projectId: string; jobId: string; digest: string; body: string; uncertain: boolean } | undefined, busy = false;
  let confirmed: TaskPlanningReceipt | undefined;
  const path = (projectId: string, jobId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/plan`;
  const ids = (...values: string[]) => { if (values.some(value => !catalogProjectIdSchema.safeParse(value).success)) throw new BrowserRequestError("invalid_request"); };
  const failure = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied",
    404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
  async function call(projectId: string, jobId: string, body?: string) {
    try { return await transport(path(projectId, jobId), { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
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
        size += value.byteLength; if (size > 16_384) throw new Error(); chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function commit() {
    if (!pending || busy) throw new BrowserRequestError("uncertain"); busy = true;
    try {
      const response = await call(pending.projectId, pending.jobId, pending.body);
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          if (!pending.uncertain) pending = undefined;
          throw new BrowserRequestError(failure(response.status));
        }
        throw new BrowserRequestError("uncertain");
      }
      const { receipt } = taskPlanningCommandSchema.parse(await json(response));
      if (receipt.projectId !== pending.projectId || receipt.sourceJobId !== pending.jobId
        || receipt.sourceInputDigest !== pending.digest || receipt.jobId === pending.jobId) throw new Error();
      confirmed = { ...receipt }; pending = undefined; return receipt;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    } finally { busy = false; }
  }
  return {
    hasPending: () => !!pending,
    // Page-local acknowledgement only, not authorization. Display only after a current protected
    // read of this exact source/input; a refresh must not destroy an acknowledged plan's link.
    savedReceipt(projectId: string, jobId: string, inputDigest: string) {
      return confirmed?.projectId === projectId && confirmed.sourceJobId === jobId && confirmed.sourceInputDigest === inputDigest
        ? { ...confirmed } : undefined;
    },
    async options(projectId: string, jobId: string, inputDigest: string) {
      ids(projectId, jobId);
      try {
        const response = await call(projectId, jobId);
        if (!response.ok) throw new BrowserRequestError(failure(response.status));
        const value = taskPlanningOptionsSchema.parse(await json(response));
        if (value.projectId !== projectId || value.sourceJobId !== jobId || value.inputDigest !== inputDigest) throw new Error();
        if (value.savedPlan) {
          confirmed = { ...value.savedPlan };
          if (!busy && pending?.projectId === projectId && pending.jobId === jobId && pending.digest === inputDigest) pending = undefined;
        }
        return value;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async prepare(projectId: string, jobId: string, expectedInputDigest: string) {
      ids(projectId, jobId);
      const parsed = taskPlanningDraftSchema.safeParse({ expectedInputDigest });
      if (!parsed.success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.projectId !== projectId || pending.jobId !== jobId || pending.body !== body)) throw new BrowserRequestError("uncertain");
      pending ??= { projectId, jobId, digest: expectedInputDigest, body, uncertain: false };
      return commit();
    },
    // Explicit owner action only; availability reads, focus and reconnect cannot invoke a write.
    retrySave: commit,
  };
}
