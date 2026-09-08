import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { ideaDecisionDraftSchema, ideaDecisionReceiptSchema } from "./idea-wire";
import { catalogProjectIdSchema } from "./project-wire";

/** One immutable owner choice per discussion. Hold its exact request after uncertainty. */
export function createIdeaDecisionClient(transport: typeof fetch = fetch) {
  let pending: { sessionId: string; body: string; uncertain: boolean } | undefined, busy = false;
  async function commit() {
    if (!pending || busy) throw new BrowserRequestError("uncertain"); busy = true;
    try {
      const response = await transport(`/api/v1/ideas/${encodeURIComponent(pending.sessionId)}/decision`, {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/json" }, body: pending.body });
      if (!response.ok) {
        const code = ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied", 404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[response.status];
        if (code) { if (!pending.uncertain) pending = undefined; throw new BrowserRequestError(code); }
        throw new BrowserRequestError("uncertain");
      }
      const result = ideaDecisionReceiptSchema.parse(await readBrowserJson(response));
      const sent = ideaDecisionDraftSchema.parse(JSON.parse(pending.body));
      if (result.sessionId !== pending.sessionId || result.sessionDigest !== sent.sessionDigest || result.synthesisDigest !== sent.synthesisDigest
        || result.decision !== sent.intent.decision || result.projectId !== (sent.intent.project?.projectId ?? null)) throw new Error();
      pending = undefined; return result;
    } catch (error) { if (pending) pending.uncertain = true;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
    } finally { busy = false; }
  }
  return { hasPending: () => !!pending, retry: commit,
    async decide(sessionId: string, value: unknown) {
      const parsed = ideaDecisionDraftSchema.safeParse(value);
      if (!parsed.success || !catalogProjectIdSchema.safeParse(sessionId).success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.sessionId !== sessionId || pending.body !== body)) throw new BrowserRequestError("uncertain");
      pending ??= { sessionId, body, uncertain: false }; return commit();
    },
  };
}
