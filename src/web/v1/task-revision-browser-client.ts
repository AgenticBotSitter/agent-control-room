import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { taskRevisionRequestSchema, taskRevisionCommandSchema, type TaskRevisionRequest, type TaskRevisionReceipt } from "./task-revision-wire";
import type { TaskReviewOptions } from "./task-review-wire";

export const revisionErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Sign in again before preparing a revised task.", access_denied: "Your current access does not permit revision preparation.",
  invalid_request: "Refresh the recorded request for changes before preparing a revision.",
  conflict: "The result, saved review or revision limit no longer permits this preparation. Refresh the recorded review.",
  not_found: "This result or source task is not available.", unavailable: "Revision preparation is unavailable. No agent has been started.",
  uncertain: "The revised task may have saved. Check this exact preparation before preparing another revision. No agent has been started.",
};

/** Only the exact saved owner note can populate a new command. Configuration is not authority. */
export function revisionRequestFromReview(runId: string | undefined, options: TaskReviewOptions): TaskRevisionRequest | undefined {
  const note = options.ownReview;
  if (!runId || !note || note.decision !== "changes_requested" || !note.findingId
    || note.artifactId !== options.artifactId || note.targetId !== options.targetId
    || note.targetDigest !== options.targetDigest || note.contentHash !== options.contentHash) return undefined;
  const parsed = taskRevisionRequestSchema.safeParse({ runId, targetId: note.targetId, targetDigest: note.targetDigest,
    contentHash: note.contentHash, reviewId: note.reviewId, feedback: note.feedback });
  return parsed.success ? parsed.data : undefined;
}

export function createTaskRevisionBrowserClient(transport: typeof fetch = fetch) {
  type Pending = { projectId: string; jobId: string; draft: TaskRevisionRequest; body: string; uncertain: boolean };
  let pending: Pending | undefined, busy = false;
  let confirmed: { projectId: string; jobId: string; body: string; receipt: TaskRevisionReceipt } | undefined;
  const failure = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied",
    404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
  async function json(response: Response) {
    if (!response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0, expired = false;
    const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 10_000);
    try {
      for (;;) { const { value, done } = await reader.read(); if (expired) throw new Error(); if (done) break;
        size += value.byteLength; if (size > 16_384) throw new Error(); chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function commit() {
    if (!pending || busy) throw new BrowserRequestError("uncertain"); busy = true;
    try {
      const response = await transport(`/api/v1/projects/${encodeURIComponent(pending.projectId)}/tasks/${encodeURIComponent(pending.jobId)}/revisions`, {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest", "content-type": "application/json" }, body: pending.body });
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          if (!pending.uncertain) pending = undefined;
          throw new BrowserRequestError(failure(response.status));
        }
        throw new BrowserRequestError("uncertain");
      }
      const { receipt } = taskRevisionCommandSchema.parse(await json(response)), draft = pending.draft;
      const bytes = new TextEncoder().encode(JSON.stringify(draft.feedback));
      const feedbackDigest = `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("")}`;
      if (receipt.projectId !== pending.projectId || receipt.sourceJobId !== pending.jobId || receipt.jobId === pending.jobId
        || receipt.fromRunId !== draft.runId || receipt.fromTargetId !== draft.targetId || receipt.fromTargetDigest !== draft.targetDigest
        || receipt.fromContentHash !== draft.contentHash || receipt.reviewId !== draft.reviewId || receipt.feedbackDigest !== feedbackDigest) throw new Error();
      confirmed = { projectId: pending.projectId, jobId: pending.jobId, body: pending.body, receipt: { ...receipt } };
      pending = undefined; return receipt;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    } finally { busy = false; }
  }
  return {
    hasPending: () => !!pending,
    savedReceipt(projectId: string, jobId: string, draft: TaskRevisionRequest) {
      const parsed = taskRevisionRequestSchema.safeParse(draft);
      return parsed.success && confirmed?.projectId === projectId && confirmed.jobId === jobId && confirmed.body === JSON.stringify(parsed.data)
        ? { ...confirmed.receipt } : undefined;
    },
    async prepare(projectId: string, jobId: string, value: TaskRevisionRequest) {
      const parsed = taskRevisionRequestSchema.safeParse(value);
      if (!catalogProjectIdSchema.safeParse(projectId).success || !catalogProjectIdSchema.safeParse(jobId).success || !parsed.success)
        throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.projectId !== projectId || pending.jobId !== jobId || pending.body !== body)) throw new BrowserRequestError("uncertain");
      pending ??= { projectId, jobId, draft: parsed.data, body, uncertain: false };
      return commit();
    },
    // Only an explicit owner action retries a captured write; protected reads never call this.
    retrySave: commit,
  };
}
