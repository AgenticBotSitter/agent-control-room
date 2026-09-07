import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { taskSubmissionDraftSchema, taskSubmissionReadSchema, taskSubmissionReceiptSchema } from "./task-submission-wire";

/** A lost write response is reconciled by reading its exact canonical identity, never auto-retried. */
export function createTaskSubmissionBrowserClient(transport: typeof fetch = fetch) {
  let busy = false;
  let pending: { projectId: string; jobId: string; inputDigest: string; packetDigest: string } | undefined;
  async function call(projectId: string, jobId: string, inputDigest: string, packetDigest: string, write: boolean) {
    if (![projectId, jobId].every(id => catalogProjectIdSchema.safeParse(id).success)
      || !taskSubmissionDraftSchema.safeParse({ expectedInputDigest: inputDigest, expectedPacketDigest: packetDigest }).success)
      throw new BrowserRequestError("invalid_request");
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/submission`;
    const response = await transport(path + (write ? "" : `?inputDigest=${encodeURIComponent(inputDigest)}`), {
      method: write ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
        ...(write ? { "content-type": "application/json" } : {}) },
      ...(write ? { body: JSON.stringify({ expectedInputDigest: inputDigest, expectedPacketDigest: packetDigest }) } : {}),
    });
    if (!response.ok) {
      const code = ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied", 404: "not_found",
        409: "conflict" } as Record<number, BrowserFailureCode>)[response.status];
      if (write && code) pending = undefined;
      throw new BrowserRequestError(code ?? (write ? "uncertain" : "unavailable"));
    }
    if (!response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async () => {
        for (;;) { const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 16_384) throw new Error(); chunks.push(value); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 10_000); })]);
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return {
    hasPending: () => !!pending,
    async read(projectId: string, jobId: string, inputDigest: string, packetDigest: string) {
      try {
        const result = taskSubmissionReadSchema.parse(await call(projectId, jobId, inputDigest, packetDigest, false));
        if (result.projectId !== projectId || result.jobId !== jobId || result.inputDigest !== inputDigest
          || result.receipt && (result.receipt.projectId !== projectId || result.receipt.jobId !== jobId || result.receipt.packetDigest !== packetDigest)) throw new Error();
        if (result.receipt && pending?.projectId === projectId && pending.jobId === jobId
          && pending.inputDigest === inputDigest && pending.packetDigest === packetDigest) pending = undefined;
        return result;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async submit(projectId: string, jobId: string, inputDigest: string, packetDigest: string) {
      if (busy || pending) throw new BrowserRequestError("uncertain");
      if (![projectId, jobId].every(id => catalogProjectIdSchema.safeParse(id).success)
        || !taskSubmissionDraftSchema.safeParse({ expectedInputDigest: inputDigest, expectedPacketDigest: packetDigest }).success)
        throw new BrowserRequestError("invalid_request");
      busy = true; pending = { projectId, jobId, inputDigest, packetDigest };
      try {
        const result = taskSubmissionReceiptSchema.parse(await call(projectId, jobId, inputDigest, packetDigest, true));
        if (result.projectId !== projectId || result.jobId !== jobId || result.packetDigest !== packetDigest) throw new Error();
        pending = undefined; return result;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain"); }
      finally { busy = false; }
    },
  };
}
