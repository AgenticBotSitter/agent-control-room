import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { taskReviewDraftSchema, taskReviewCommandSchema, taskReviewOptionsSchema,
  type TaskReviewDraft, type TaskReviewReceipt } from "./task-review-wire";

export const reviewErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Sign in again to read or record this review.", access_denied: "Your current access does not permit this review.",
  invalid_request: "Check your review and changes requested. Do not include credentials or other secrets.",
  conflict: "This result or review changed, or your decision is already recorded. Refresh its saved review.",
  not_found: "This result or review is not available.", unavailable: "Review information is unavailable. No decision has been invented.",
  uncertain: "This review may have saved. Check this exact save before making another decision.",
};
type Binding = Pick<TaskReviewDraft, "artifactId" | "targetId" | "targetDigest" | "contentHash">;
export function createTaskReviewBrowserClient(transport: typeof fetch = fetch, makeKey: () => string = () => crypto.randomUUID()) {
  let pending: { projectId: string; jobId: string; draft: TaskReviewDraft; body: string; key: string; uncertain: boolean } | undefined, busy = false;
  const path = (projectId: string, jobId: string, bound: Binding) => `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/results/${encodeURIComponent(bound.artifactId)}/reviews/${encodeURIComponent(bound.targetId)}`;
  const ids = (...values: string[]) => { if (values.some(value => !catalogProjectIdSchema.safeParse(value).success)) throw new BrowserRequestError("invalid_request"); };
  const failure = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied",
    404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
  async function call(url: string, command?: { body: string; key: string }) {
    try { return await transport(url, { method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
        ...(command ? { "content-type": "application/json", "idempotency-key": command.key } : {}) }, ...(command ? { body: command.body } : {}) }); }
    catch { throw new BrowserRequestError(command ? "uncertain" : "unavailable"); }
  }
  async function json(response: Response) {
    if (!response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
    const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 10_000);
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 32_768) throw new Error(); chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function commit(): Promise<TaskReviewReceipt> {
    if (!pending || busy) throw new BrowserRequestError("uncertain"); busy = true;
    try {
      const response = await call(path(pending.projectId, pending.jobId, pending.draft), pending);
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          if (!pending.uncertain) pending = undefined;
          throw new BrowserRequestError(failure(response.status));
        }
        throw new BrowserRequestError("uncertain");
      }
      const { receipt } = taskReviewCommandSchema.parse(await json(response));
      const bytes = new TextEncoder().encode(JSON.stringify(pending.draft.feedback));
      const feedbackDigest = `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("")}`;
      if (receipt.projectId !== pending.projectId || receipt.jobId !== pending.jobId || receipt.artifactId !== pending.draft.artifactId
        || receipt.targetId !== pending.draft.targetId || receipt.targetDigest !== pending.draft.targetDigest
        || receipt.contentHash !== pending.draft.contentHash || receipt.decision !== pending.draft.decision
        || receipt.feedbackDigest !== feedbackDigest || (receipt.findingId !== null) !== (receipt.decision === "changes_requested")) throw new Error();
      pending = undefined; return receipt;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    } finally { busy = false; }
  }
  return {
    hasPending: () => !!pending,
    async options(projectId: string, jobId: string, bound: Binding) {
      ids(projectId, jobId, bound.artifactId, bound.targetId);
      try {
        const response = await call(path(projectId, jobId, bound));
        if (!response.ok) throw new BrowserRequestError(failure(response.status));
        const options = taskReviewOptionsSchema.parse(await json(response));
        if (options.projectId !== projectId || options.jobId !== jobId || options.artifactId !== bound.artifactId
          || options.targetId !== bound.targetId || options.targetDigest !== bound.targetDigest || options.contentHash !== bound.contentHash
          || options.canReview !== (options.availability === "available") || options.ownReview &&
            (options.ownReview.targetId !== bound.targetId || options.ownReview.targetDigest !== bound.targetDigest
              || options.ownReview.contentHash !== bound.contentHash)) throw new Error();
        return options;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async record(projectId: string, jobId: string, input: unknown) {
      ids(projectId, jobId); const parsed = taskReviewDraftSchema.safeParse(input);
      if (!parsed.success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.projectId !== projectId || pending.jobId !== jobId || pending.body !== body)) throw new BrowserRequestError("uncertain");
      pending ??= { projectId, jobId, draft: parsed.data, body, key: makeKey(), uncertain: false };
      return commit();
    },
    // Explicit owner interaction only. No timer, focus handler or read calls this.
    retrySave: commit,
  };
}
