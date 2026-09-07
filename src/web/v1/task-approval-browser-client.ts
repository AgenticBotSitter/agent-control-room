import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { approvalDigestSchema, taskApprovalReadSchema, taskApprovalReviewSchema, taskApprovalSavedSchema, type TaskApprovalRead } from "./task-approval-wire";

export const approvalErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Sign in again to see execution approval.", access_denied: "Only the current project owner can manage this approval.",
  invalid_request: "Choose a valid signed approval file for this task.", conflict: "The task or reservation changed. Refresh before continuing.",
  not_found: "Execution approval is available only for a prepared task you can access.",
  unavailable: "Execution approval is not connected or is temporarily unavailable.",
  uncertain: "The save could not be confirmed. Check the saved approval; do not submit another file yet.",
};
const failure = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied",
  404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
// Input comes only from bounded JSON.parse, never host objects. Mirrors canonical JSON ordering.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function createTaskApprovalBrowserClient(transport: typeof fetch = fetch) {
  let busy = false, pending: { projectId: string; jobId: string; inputDigest: string; packetDigest: string } | undefined;
  let confirmed: TaskApprovalRead | undefined;
  const scope = (projectId: string, jobId: string, inputDigest: string) => {
    if (![projectId, jobId].every(id => catalogProjectIdSchema.safeParse(id).success) || !approvalDigestSchema.safeParse(inputDigest).success)
      throw new BrowserRequestError("invalid_request");
    return { projectId, jobId, inputDigest };
  };
  async function call(projectId: string, jobId: string, inputDigest: string, body?: string, write = false) {
    let response: Response;
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/approval`;
    try { response = await transport(path + (body ? "" : `?inputDigest=${encodeURIComponent(inputDigest)}`), {
      method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
        ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}) }); }
    catch { throw new BrowserRequestError(write ? "uncertain" : "unavailable"); }
    if (!response.ok) {
      const code = failure(response.status);
      if (write && [400, 401, 403, 404, 409].includes(response.status)) pending = undefined;
      throw new BrowserRequestError(write && code === "unavailable" ? "uncertain" : code);
    }
    if (!response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
    const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async () => {
        for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65_536) throw new Error(); chunks.push(value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 10_000); })]);
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  const matching = (value: { projectId: string; jobId: string; inputDigest: string }, expected: typeof value) => {
    if (value.projectId !== expected.projectId || value.jobId !== expected.jobId || value.inputDigest !== expected.inputDigest) throw new Error();
  };
  return {
    hasPending: () => !!pending,
    async read(projectId: string, jobId: string, inputDigest: string) {
      const expected = scope(projectId, jobId, inputDigest);
      try {
        const value = taskApprovalReadSchema.parse(await call(projectId, jobId, inputDigest)); matching(value, expected);
        if (value.receipt && (value.receipt.projectId !== projectId || value.receipt.jobId !== jobId)) throw new Error();
        if (confirmed?.projectId === projectId && confirmed.jobId === jobId && confirmed.inputDigest === inputDigest) {
          if (value.receipt && confirmed.receipt && value.receipt.packetDigest !== confirmed.receipt.packetDigest) throw new Error();
          value.receipt ??= structuredClone(confirmed.receipt);
        }
        if (value.receipt) confirmed = structuredClone(value);
        if (pending && pending.projectId === projectId && pending.jobId === jobId && pending.inputDigest === inputDigest
          && value.receipt?.packetDigest === pending.packetDigest) pending = undefined;
        return value;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async prepare(projectId: string, jobId: string, inputDigest: string) {
      const expected = scope(projectId, jobId, inputDigest);
      try { const value = taskApprovalReviewSchema.parse(await call(projectId, jobId, inputDigest, JSON.stringify({ action: "prepare", expectedInputDigest: inputDigest })));
        matching(value, expected); return value;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
    },
    async store(projectId: string, jobId: string, inputDigest: string, fileText: string) {
      const expected = scope(projectId, jobId, inputDigest);
      if (busy || pending) throw new BrowserRequestError("uncertain"); busy = true;
      try {
        let packet: unknown, packetDigest: string;
        try {
          if (new TextEncoder().encode(fileText).byteLength > 24_576) throw new Error(); packet = JSON.parse(fileText);
          const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(packet)));
          packetDigest = "sha256:" + [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
        } catch { throw new BrowserRequestError("invalid_request"); }
        pending = { ...expected, packetDigest };
        const value = taskApprovalSavedSchema.parse(await call(projectId, jobId, inputDigest,
          JSON.stringify({ action: "store", expectedInputDigest: inputDigest, packet }), true)); matching(value, expected);
        if (value.receipt.projectId !== projectId || value.receipt.jobId !== jobId || value.receipt.packetDigest !== packetDigest) throw new Error();
        const { replayed: _replayed, ...receipt } = value.receipt; void _replayed;
        confirmed = { ...expected, receipt: { ...receipt, evidence: "stored_signatures_only" } };
        pending = undefined; return value;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError(pending ? "uncertain" : "invalid_request"); }
      finally { busy = false; }
    },
  };
}
