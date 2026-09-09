import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { ideaCreateDraftSchema, ideaCreateReceiptSchema, ideaCreationOptionsSchema } from "./idea-wire";

/** Explicit exact-request retry only. Never autosubmit a second session after uncertainty. */
export function createIdeaCreationClient(transport: typeof fetch = fetch, makeKey = () => crypto.randomUUID()) {
  let pending: { body: string; key: string; uncertain: boolean } | undefined, busy = false;
  async function commit() {
    if (!pending || busy) throw new BrowserRequestError("uncertain");
    busy = true;
    try {
      const response = await transport("/api/v1/ideas", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10_000), headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/json", "idempotency-key": pending.key }, body: pending.body });
      if (!response.ok) {
        const code = ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied", 404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[response.status];
        if (code) { if (!pending.uncertain) pending = undefined; throw new BrowserRequestError(code); }
        throw new BrowserRequestError("uncertain");
      }
      const receipt = ideaCreateReceiptSchema.parse(await readBrowserJson(response));
      if (receipt.idempotencyKey !== pending.key) throw new Error();
      pending = undefined; return receipt;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    } finally { busy = false; }
  }
  return { hasPending: () => !!pending, retry: commit,
    async options(signal?: AbortSignal) {
      try {
        const response = await transport("/api/v1/ideas/options", { credentials: "same-origin", cache: "no-store", redirect: "error",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
          headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" } });
        if (!response.ok) throw new BrowserRequestError(response.status === 401 ? "authentication_required"
          : response.status === 403 ? "access_denied" : "unavailable");
        return ideaCreationOptionsSchema.parse(await readBrowserJson(response));
      } catch (reason) { throw reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"); }
    },
    async create(value: unknown) {
      const parsed = ideaCreateDraftSchema.safeParse(value); if (!parsed.success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && pending.body !== body) throw new BrowserRequestError("uncertain");
      pending ??= { body, key: makeKey(), uncertain: false }; return commit();
    },
  };
}
