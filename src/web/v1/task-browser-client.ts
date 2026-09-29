import { BrowserRequestError, observeBrowserAuthentication, type BrowserAuthenticationObserver,
  type BrowserFailureCode } from "./browser-client";
import type { NewsWorkOrderProposalV1 } from "../../project-adapters/news/v1/types";
import { newsResearchTaskDraft } from "./news-research-draft";
import { readBrowserJson as json } from "./browser-json";
import { catalogProjectIdSchema } from "./project-wire";
import { taskCommandSchema, taskDetailSchema, taskDraftSchema, taskPageSchema, type TaskReceipt } from "./task-wire";
import { taskResultsPageSchema, taskResultContentSchema, type TaskResultMetadata } from "./task-result-wire";
import { syntheticResultSchemaV1 } from "../../local-pilot/v1/synthetic-result-wire";

export const taskErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Your session has ended. Sign in again to see your tasks.",
  access_denied: "Your current access does not allow this task or action.",
  invalid_request: "Check the title and instructions. Do not include passwords, access tokens or other secrets.",
  conflict: "The project or save changed. Refresh saved work before making a new proposal.",
  not_found: "This task or project is not available.",
  unavailable: "Control Room could not read the saved task database or service. No task was started or changed, and no sample progress was substituted. Check saved tasks again when the service is ready.",
  uncertain: "This save may have completed. Check this exact save again, or look in saved tasks before creating another.",
};

export function createTaskBrowserClient(transport: typeof fetch = fetch, makeKey: () => string = () => crypto.randomUUID(),
  observeAuthentication?: BrowserAuthenticationObserver) {
  let pending: { projectId: string; body: string; key: string; uncertain: boolean; source?: "news" } | undefined, busy = false;
  const checkId = (id: string) => { if (!catalogProjectIdSchema.safeParse(id).success) throw new BrowserRequestError("invalid_request"); };
  const path = (id: string) => `/api/v1/projects/${encodeURIComponent(id)}/tasks`;
  const failure = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied",
    404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
  async function call(url: string, command?: { body: string; key: string }, signal?: AbortSignal,
    transportOverride: typeof fetch = transport) {
    try {
      signal?.throwIfAborted();
      const response = await transportOverride(url, { method: command ? "POST" : "GET", credentials: "same-origin", redirect: "error", cache: "no-store",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
          ...(command ? { "content-type": "application/json", "idempotency-key": command.key } : {}) },
        ...(command ? { body: command.body } : {}) });
      observeBrowserAuthentication(response, observeAuthentication); return response;
    } catch { throw new BrowserRequestError(command ? "uncertain" : "unavailable"); }
  }
  async function read(url: string, signal?: AbortSignal, readTransport?: typeof fetch) {
    const response = await call(url, undefined, signal, readTransport); signal?.throwIfAborted();
    if (!response.ok) throw new BrowserRequestError(failure(response.status));
    const result = await json(response); signal?.throwIfAborted(); return result;
  }
  async function commit(): Promise<TaskReceipt> {
    if (!pending || busy) throw new BrowserRequestError("uncertain");
    busy = true;
    try {
      const response = await call(path(pending.projectId) + (pending.source === "news" ? "/from-news" : ""), pending);
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
    async list(projectId: string, after?: string, signal?: AbortSignal, readTransport?: typeof fetch) {
      try {
        checkId(projectId); if (after !== undefined) checkId(after);
        const page = taskPageSchema.parse(await read(
          `${path(projectId)}${after ? `?after=${encodeURIComponent(after)}` : ""}`, signal, readTransport));
        if (page.project.projectId !== projectId || page.tasks.some((task, index) => task.projectId !== projectId
          || after !== undefined && task.jobId <= after || index > 0 && task.jobId <= page.tasks[index - 1].jobId)
          || page.nextCursor !== null && (page.tasks.length !== 50 || page.nextCursor !== page.tasks.at(-1)?.jobId)) throw new Error();
        return page;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async detail(projectId: string, jobId: string, signal?: AbortSignal, readTransport?: typeof fetch) {
      try {
        checkId(projectId); checkId(jobId);
        const detail = taskDetailSchema.parse(await read(
          `${path(projectId)}/${encodeURIComponent(jobId)}`, signal, readTransport));
        if (detail.project.projectId !== projectId || detail.task.projectId !== projectId || detail.task.jobId !== jobId) throw new Error();
        return detail;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async propose(projectId: string, draft: unknown) {
      checkId(projectId);
      const parsed = taskDraftSchema.safeParse(draft); if (!parsed.success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.source || pending.projectId !== projectId || pending.body !== body)) throw new BrowserRequestError("uncertain");
      pending ??= { projectId, body, key: makeKey(), uncertain: false };
      return commit();
    },
    async proposeNewsResearch(projectId: string, proposal: NewsWorkOrderProposalV1) {
      checkId(projectId);
      let body: string;
      try {
        if (proposal.projectId !== projectId) throw new Error();
        newsResearchTaskDraft(proposal);
        body = JSON.stringify(proposal);
        if (new TextEncoder().encode(body).length > 24_576) throw new Error();
      } catch { throw new BrowserRequestError("invalid_request"); }
      if (pending && (pending.source !== "news" || pending.projectId !== projectId || pending.body !== body))
        throw new BrowserRequestError("uncertain");
      pending ??= { projectId, body, key: makeKey(), uncertain: false, source: "news" };
      return commit();
    },
    // Explicit owner interaction only. Polling, reconnect and focus never invoke this method.
    retrySave: commit,
    async syntheticResult(projectId: string, jobId: string, artifactId: string) {
      try {
        checkId(projectId); checkId(jobId); checkId(artifactId);
        const value = syntheticResultSchemaV1.parse(await read(`${path(projectId)}/${encodeURIComponent(jobId)}/synthetic-results/${encodeURIComponent(artifactId)}`));
        if (value.projectId !== projectId || value.jobId !== jobId || value.artifactId !== artifactId) throw new Error();
        const bytes = new TextEncoder().encode(value.text);
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map(byte => byte.toString(16).padStart(2, "0")).join("");
        if (bytes.byteLength !== value.sizeBytes || `sha256:${hash}` !== value.contentHash) throw new Error();
        return value;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async results(projectId: string, jobId: string, signal?: AbortSignal) {
      try {
        checkId(projectId); checkId(jobId);
        const page = taskResultsPageSchema.parse(await read(`${path(projectId)}/${encodeURIComponent(jobId)}/results`, signal));
        if (page.projectId !== projectId || page.jobId !== jobId || new Set(page.items.map(item => item.artifactId)).size !== page.items.length
          || page.reviews.some(review => review.matchingArtifactIds.some(id => review.kind !== "document"
            || !page.items.some(item => item.artifactId === id && item.contentHash === review.contentHash)))) throw new Error();
        return page;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async resultContent(projectId: string, jobId: string, artifact: TaskResultMetadata | string, signal?: AbortSignal) {
      try {
        const artifactId = typeof artifact === "string" ? artifact : artifact.artifactId;
        checkId(projectId); checkId(jobId); checkId(artifactId);
        if (typeof artifact === "string" || !artifact.fileAccess) throw new Error();
        const preview = new URL(artifact.fileAccess.previewHref, "http://control-room.invalid");
        const expectedPath = `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/files/${encodeURIComponent(artifactId)}`;
        if (preview.origin !== "http://control-room.invalid" || preview.pathname !== expectedPath
          || preview.searchParams.get("disposition") !== "preview" || preview.searchParams.getAll("token").length !== 1
          || [...preview.searchParams.keys()].some(key => !["disposition", "token"].includes(key))) throw new Error();
        const response = await call(artifact.fileAccess.previewHref, undefined, signal); signal?.throwIfAborted();
        if (!response.ok) throw new BrowserRequestError(failure(response.status));
        if (response.headers.get("content-type")?.split(";")[0].trim() !== "text/plain" || !response.body) throw new Error();
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
          if (size > 65_536) throw new Error(); chunks.push(next.value); } } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
        const content = taskResultContentSchema.parse({ projectId, jobId, artifact, text,
          contentVerifiedAt: new Date().toISOString(), untrustedContent: true });
        if (content.projectId !== projectId || content.jobId !== jobId || content.artifact.artifactId !== artifactId) throw new Error();
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
        if (bytes.byteLength !== content.artifact.sizeBytes || `sha256:${hash}` !== content.artifact.contentHash) throw new Error();
        return content;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
  };
}
