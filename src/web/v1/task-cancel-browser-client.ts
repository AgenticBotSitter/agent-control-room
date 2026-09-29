import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { taskCancelDraftSchema, taskCancelCommandSchema } from "./task-cancel-wire";
import type { TaskCancelReceipt } from "./task-cancel-wire";

export const cancelErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Sign in again to cancel this task.", access_denied: "Your current access does not allow cancelling this task.",
  invalid_request: "Refresh the task before cancelling.", conflict: "This task is not in a state that can be cancelled right now. Refresh before trying again.",
  not_found: "Cancel is available only for a task you can access.",
  unavailable: "Cancel is not connected or is unavailable. No task was changed.",
  uncertain: "This cancel request may have saved. Check this exact task before trying again.",
};
export function createTaskCancelBrowserClient(transport: typeof fetch = fetch) {
  let pending: { projectId: string; jobId: string; body: string; uncertain: boolean } | undefined, busy = false;
  const path = (projectId: string, jobId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/cancel`;
  const ids = (...values: string[]) => { if (values.some(value => !catalogProjectIdSchema.safeParse(value).success)) throw new BrowserRequestError("invalid_request"); };
  const failure = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied",
    404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
  async function call(projectId: string, jobId: string, body: string) {
    try { return await transport(path(projectId, jobId), { method: "POST", credentials: "same-origin", cache: "no-store",
      redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
        "content-type": "application/json" }, body }); }
    catch { throw new BrowserRequestError("uncertain"); }
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
  async function commit(): Promise<TaskCancelReceipt> {
    if (!pending || busy) throw new BrowserRequestError("uncertain"); busy = true;
    try {
      const draft = taskCancelDraftSchema.parse(JSON.parse(pending.body));
      const response = await call(pending.projectId, pending.jobId, pending.body);
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          if (!pending.uncertain) pending = undefined;
          throw new BrowserRequestError(failure(response.status));
        }
        throw new BrowserRequestError("uncertain");
      }
      const { receipt } = taskCancelCommandSchema.parse(await json(response));
      if (receipt.projectId !== pending.projectId || receipt.jobId !== pending.jobId || receipt.inputDigest !== draft.expectedInputDigest) throw new Error();
      pending = undefined; return receipt;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    } finally { busy = false; }
  }
  return {
    hasPending: () => !!pending,
    async cancel(projectId: string, jobId: string, expectedInputDigest: string) {
      ids(projectId, jobId); const parsed = taskCancelDraftSchema.safeParse({ expectedInputDigest });
      if (!parsed.success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.projectId !== projectId || pending.jobId !== jobId || pending.body !== body)) throw new BrowserRequestError("uncertain");
      pending ??= { projectId, jobId, body, uncertain: false }; return commit();
    },
    // Owner click only. Reads/reconnect/focus cannot retry a cancel command.
    retrySave: commit,
  };
}
