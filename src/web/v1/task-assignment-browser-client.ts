import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { taskAssignmentDraftSchema, taskAssignmentCommandSchema, taskAssignmentOptionsSchema } from "./task-assignment-wire";
import type { TaskAssignmentReceipt } from "./task-assignment-wire";

/** One immutable reservation per task: delayed replies cannot undo its known expiry. Not authorization. */
export function reconcileAssignmentReceipt(previous: TaskAssignmentReceipt | undefined, incoming: TaskAssignmentReceipt | null): TaskAssignmentReceipt | undefined {
  if (!incoming) return previous;
  if (!previous || previous.projectId !== incoming.projectId || previous.jobId !== incoming.jobId
    || previous.inputDigest !== incoming.inputDigest || previous.leaseId !== incoming.leaseId) return incoming;
  if (previous.leaseState !== "active" && incoming.leaseState === "active") return previous;
  return { ...incoming, leaseCurrent: previous.leaseCurrent && incoming.leaseCurrent };
}

export const assignmentErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Sign in again to see this assignment.", access_denied: "Your current access does not allow assignment changes.",
  invalid_request: "Refresh the prepared task and check your selection.", conflict: "The machine, task or reservation is not available for this change. Refresh before continuing.",
  not_found: "Assignment is available only for a prepared task you can access.",
  unavailable: "Task assignment is not connected or is unavailable. No agent has been started.",
  uncertain: "This assignment change may have saved. Check this exact change before making another. This does not start an agent.",
};
export function createTaskAssignmentBrowserClient(transport: typeof fetch = fetch) {
  let pending: { projectId: string; jobId: string; body: string; uncertain: boolean } | undefined, busy = false;
  const path = (projectId: string, jobId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/assignment`;
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
        size += value.byteLength; if (size > 65_536) throw new Error(); chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function commit() {
    if (!pending || busy) throw new BrowserRequestError("uncertain"); busy = true;
    try {
      const draft = taskAssignmentDraftSchema.parse(JSON.parse(pending.body));
      const response = await call(pending.projectId, pending.jobId, pending.body);
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          if (!pending.uncertain) pending = undefined;
          throw new BrowserRequestError(failure(response.status));
        }
        throw new BrowserRequestError("uncertain");
      }
      const { receipt } = taskAssignmentCommandSchema.parse(await json(response));
      if (receipt.projectId !== pending.projectId || receipt.jobId !== pending.jobId || receipt.inputDigest !== draft.expectedInputDigest
        || draft.action === "assign" && receipt.nodeId !== draft.nodeId || draft.action === "expire" && receipt.leaseState !== "expired") throw new Error();
      pending = undefined; return receipt;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    } finally { busy = false; }
  }
  return {
    hasPending: () => !!pending,
    async options(projectId: string, jobId: string, inputDigest: string) {
      ids(projectId, jobId);
      try {
        const response = await call(projectId, jobId);
        if (!response.ok) throw new BrowserRequestError(failure(response.status));
        const value = taskAssignmentOptionsSchema.parse(await json(response));
        if (value.projectId !== projectId || value.jobId !== jobId || value.inputDigest !== inputDigest
          || new Set(value.candidates.map(candidate => candidate.nodeId)).size !== value.candidates.length
          || value.receipt && (value.receipt.projectId !== projectId || value.receipt.jobId !== jobId || value.receipt.inputDigest !== inputDigest)) throw new Error();
        return value;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async change(projectId: string, jobId: string, input: unknown) {
      ids(projectId, jobId); const parsed = taskAssignmentDraftSchema.safeParse(input);
      if (!parsed.success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.projectId !== projectId || pending.jobId !== jobId || pending.body !== body)) throw new BrowserRequestError("uncertain");
      pending ??= { projectId, jobId, body, uncertain: false }; return commit();
    },
    // Owner click only. Reads/reconnect/focus cannot allocate, expire or retry a command.
    retrySave: commit,
  };
}
