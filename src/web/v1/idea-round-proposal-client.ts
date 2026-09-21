import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { ideaRoundProposalDraftSchema, ideaRoundProposalReceiptSchema } from "./idea-wire";
import { catalogProjectIdSchema } from "./project-wire";

/** One explicit preparation request. The durable task receipts own safe replay. */
export function createIdeaRoundProposalClient(transport: typeof fetch = fetch) {
  let busy = false;
  return { async propose(sessionId: string, value: unknown) {
    const input = ideaRoundProposalDraftSchema.safeParse(value);
    if (!input.success || !catalogProjectIdSchema.safeParse(sessionId).success) throw new BrowserRequestError("invalid_request");
    if (busy) throw new BrowserRequestError("uncertain");
    busy = true;
    try {
      const response = await transport(`/api/v1/ideas/${encodeURIComponent(sessionId)}/rounds/${input.data.round}/proposals`, {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/json" }, body: JSON.stringify(input.data),
      });
      if (!response.ok) {
        const code = ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied", 404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[response.status];
        throw new BrowserRequestError(code ?? "uncertain");
      }
      const receipt = ideaRoundProposalReceiptSchema.parse(await readBrowserJson(response));
      if (receipt.sessionId !== sessionId || receipt.sessionDigest !== input.data.sessionDigest
        || receipt.projectId !== input.data.projectId || receipt.round !== input.data.round || !receipt.receipts.length) throw new Error();
      return receipt;
    } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain"); }
    finally { busy = false; }
  } };
}
