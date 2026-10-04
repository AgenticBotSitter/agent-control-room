import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";

/**
 * Browser-side calls for the module upload flow (preview and approve).
 * Download needs no client: a plain same-origin link to
 * `/api/v1/modules/:id/bundle` or `/api/v1/projects/:id/pack` carries the
 * session the same way every other GET in this app does.
 *
 * Every call here only previews or records an owner approval through the
 * server's existing bundle verifier and approval ledger; nothing here
 * installs, executes, or stages a module.
 */

export const moduleTransferErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Sign in again to continue.",
  access_denied: "Your current access does not allow installing modules.",
  invalid_request: "This file is not a bundle Control Room recognizes.",
  conflict: "This changed elsewhere. Re-check the bundle and try approving again.",
  not_found: "This module or project is not available.",
  unavailable: "The approval service is unavailable right now.",
  uncertain: "The approval may have gone through. Check the module's current approval before trying again.",
};

const MAX_RESPONSE_BYTES = 2_097_152;

function failureFor(status: number): BrowserFailureCode {
  return ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied",
    404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
}

async function readBoundedResponseJson(response: Response): Promise<unknown> {
  if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 10_000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function call(path: string, body: unknown, headers: Record<string, string>, transport: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await transport(path, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "XMLHttpRequest", ...headers },
      body: JSON.stringify(body) });
  } catch { throw new BrowserRequestError("uncertain"); }
  if (!response.ok) {
    const code = failureFor(response.status);
    // Only a 400 from this handler ever carries a `reason` (the verifier's exact refusal code);
    // a failed or absent read just leaves it undefined, same as before this reason existed.
    let reason: string | undefined;
    if (code === "invalid_request") {
      try {
        const body = await readBoundedResponseJson(response);
        if (body !== null && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string") {
          reason = (body as { reason: string }).reason;
        }
      } catch { /* no reason available */ }
    }
    throw new BrowserRequestError(code, reason);
  }
  try { return await readBoundedResponseJson(response); }
  catch { throw new BrowserRequestError("unavailable"); }
}

export function createModuleTransferBrowserClient(transport: typeof fetch = fetch) {
  return {
    /** Verifies a bundle the owner picked and returns the plain-language preview: name, publisher,
     * class, trust source, CODE warning, and the permission diff against the current approval. */
    async preview(submission: { bundle: unknown; signature?: unknown }): Promise<unknown> {
      return call("/api/v1/modules/preview", submission, {}, transport);
    },
    /** Records the owner's approval of exactly the bundle and diff they were shown. Never installs. */
    async approve(submission: { bundle: unknown; signature?: unknown }, draft: unknown, idempotencyKey: string): Promise<unknown> {
      return call("/api/v1/modules/approvals", { submission, draft }, { "idempotency-key": idempotencyKey }, transport);
    },
  };
}
