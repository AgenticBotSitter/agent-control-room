export type BrowserFailureCode = "authentication_required" | "access_denied" | "invalid_request" | "conflict" | "not_found" | "unavailable" | "uncertain";

export class BrowserRequestError extends Error {
  constructor(readonly code: BrowserFailureCode) { super(code); }
}
