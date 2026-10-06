export type BrowserFailureCode = "authentication_required" | "access_denied" | "invalid_request" | "conflict" | "not_found" | "unavailable" | "uncertain";

export class BrowserRequestError extends Error {
  /** An optional server-supplied refusal code (for example `module_signature_digest_mismatch`),
   * carried through for callers that can show a more specific message than `code` alone allows. */
  constructor(readonly code: BrowserFailureCode, readonly reason?: string) { super(code); }
}
