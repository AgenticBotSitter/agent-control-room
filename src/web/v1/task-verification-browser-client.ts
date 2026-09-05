import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { taskVerificationCommandSchema, taskVerificationDraftSchema, taskVerificationOptionsSchema,
  type TaskVerificationBinding, type TaskVerificationDraft, type TaskVerificationReceipt } from "./task-verification-wire";

export const verificationErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Sign in again to read or record human verification.",
  access_denied: "Your current access does not permit this human verification.",
  invalid_request: "Choose a configured check and record a result with a nonempty observation note. Do not include credentials or secrets.",
  conflict: "This result, check or verification record changed. Refresh the recorded human verification.",
  not_found: "This result or human verification check is not available.",
  unavailable: "Human verification information is unavailable. No result has been invented.",
  uncertain: "This human verification may have saved. Check this exact save before recording another result.",
};

const failure = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required",
  403: "access_denied", 404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";

async function digestJsonString(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return `sha256:${[...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createTaskVerificationBrowserClient(transport: typeof fetch = fetch) {
  let pending: { projectId: string; jobId: string; draft: TaskVerificationDraft; body: string; uncertain: boolean } | undefined;
  let busy = false;
  const path = (projectId: string, jobId: string, bound: TaskVerificationBinding) =>
    `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/results/${encodeURIComponent(bound.artifactId)}/verifications/${encodeURIComponent(bound.targetId)}`;
  const ids = (...values: string[]) => {
    if (values.some(value => !catalogProjectIdSchema.safeParse(value).success)) throw new BrowserRequestError("invalid_request");
  };
  async function call(url: string, body?: string) {
    try {
      return await transport(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
        redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
          ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }) });
    } catch { throw new BrowserRequestError(body === undefined ? "unavailable" : "uncertain"); }
  }
  async function json(response: Response) {
    if (!response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
    const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 10_000);
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 1_048_576) throw new Error(); chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function commit(): Promise<TaskVerificationReceipt> {
    if (!pending || busy) throw new BrowserRequestError("uncertain");
    busy = true;
    try {
      const response = await call(path(pending.projectId, pending.jobId, pending.draft), pending.body);
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          if (!pending.uncertain) pending = undefined;
          throw new BrowserRequestError(failure(response.status));
        }
        throw new BrowserRequestError("uncertain");
      }
      const { receipt } = taskVerificationCommandSchema.parse(await json(response));
      const noteDigest = await digestJsonString(pending.draft.note);
      if (receipt.projectId !== pending.projectId || receipt.jobId !== pending.jobId
        || receipt.artifactId !== pending.draft.artifactId || receipt.targetId !== pending.draft.targetId
        || receipt.targetDigest !== pending.draft.targetDigest || receipt.contentHash !== pending.draft.contentHash
        || receipt.scenarioId !== pending.draft.scenarioId || receipt.instructionsDigest !== pending.draft.instructionsDigest
        || receipt.outcome !== pending.draft.outcome || receipt.noteDigest !== noteDigest) throw new Error();
      pending = undefined;
      return receipt;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    } finally { busy = false; }
  }
  return {
    hasPending: () => !!pending,
    async options(projectId: string, jobId: string, bound: TaskVerificationBinding) {
      ids(projectId, jobId, bound.artifactId, bound.targetId);
      try {
        const response = await call(path(projectId, jobId, bound));
        if (!response.ok) throw new BrowserRequestError(failure(response.status));
        const options = taskVerificationOptionsSchema.parse(await json(response));
        if (options.projectId !== projectId || options.jobId !== jobId || options.artifactId !== bound.artifactId
          || options.targetId !== bound.targetId || options.targetDigest !== bound.targetDigest || options.contentHash !== bound.contentHash
          || options.source === "not_configured" && options.scenarios.length !== 0
          || new Set(options.scenarios.map(scenario => scenario.scenarioId)).size !== options.scenarios.length) throw new Error();
        for (const scenario of options.scenarios) {
          const recorded = scenario.ownVerification;
          if (scenario.availability === "available" && recorded || scenario.availability === "already_recorded" && !recorded) throw new Error();
          if (recorded && (recorded.projectId !== projectId || recorded.jobId !== jobId || recorded.artifactId !== bound.artifactId
            || recorded.targetId !== bound.targetId || recorded.targetDigest !== bound.targetDigest || recorded.contentHash !== bound.contentHash
            || recorded.scenarioId !== scenario.scenarioId || recorded.instructionsDigest !== scenario.instructionsDigest)) throw new Error();
        }
        return options;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async record(projectId: string, jobId: string, input: unknown) {
      ids(projectId, jobId);
      const parsed = taskVerificationDraftSchema.safeParse(input);
      if (!parsed.success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.projectId !== projectId || pending.jobId !== jobId || pending.body !== body))
        throw new BrowserRequestError("uncertain");
      pending ??= { projectId, jobId, draft: parsed.data, body, uncertain: false };
      return commit();
    },
    // Explicit owner interaction only. Reads, focus and timers never call this or clear pending state.
    checkSave: commit,
  };
}
