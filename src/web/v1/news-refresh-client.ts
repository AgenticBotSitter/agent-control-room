import { z } from "zod";
import { readBrowserJson } from "./browser-json";
import { BrowserAuthenticationRecoveryError, BrowserRequestError } from "./browser-client";
import { newsCollectionStatusSchema, newsCollectionHistorySchema } from "./news-collection-status-wire";
import { catalogProjectIdSchema as id } from "./project-wire";
import { effectIntentStates } from "../../domain/v1/types";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const base = z.object({ projectId: id, sourceId: id, configured: z.literal(false), canRefresh: z.literal(false), startsWork: z.literal(false) }).strict();
export const newsRefreshDescriptionSchema = z.union([base, base.extend({ configured: z.literal(true), canRefresh: z.boolean(),
  sourceDigest: digest, sourceLabel: z.string().min(1).max(180), endpointUrl: z.string().url().max(2000), mode: z.enum(["feed", "discovery"]),
  sourceCurrent: z.boolean(), allowedOrigins: z.array(z.string().url()).min(1).max(16),
  limits: z.object({ timeoutMs: z.number().int().min(1).max(30000), maxAttempts: z.number().int().min(1).max(1000),
    maxDocumentBytes: z.number().int().min(1).max(50 * 1024 * 1024), maxReservedBodyBytes: z.number().int().min(1).max(100 * 1024 * 1024),
    maxArticles: z.number().int().min(1).max(10).optional() }).strict(),
}).strict()]);
export type NewsRefreshDescription = z.infer<typeof newsRefreshDescriptionSchema>;
const proposalSchema = z.object({ jobId: id, inputDigest: digest, sourceDigest: digest, replayed: z.boolean(), startsWork: z.literal(false) }).strict();
const approvalSchema = z.object({ schema: z.literal("control-room.abs-feed-job/v1"), tenantId: id, projectId: id, jobId: id,
  attemptId: id, effectId: id, operationDigest: digest, replayed: z.boolean(), effectState: z.enum(effectIntentStates), networkContacted: z.literal(false) }).strict();

/** Fixed source client. Retains an exact uncertain request; never auto-approves or
 * auto-retries. A receipt records admission/history, not collection completion. */
export function createNewsRefreshClient(projectValue: string, sourceValue: string, fetcher: typeof fetch = fetch) {
  const projectId = id.parse(projectValue), sourceId = id.parse(sourceValue);
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/news/sources/${encodeURIComponent(sourceId)}/collection`;
  let proposal: z.infer<typeof proposalSchema> | undefined, approval: z.infer<typeof approvalSchema> | undefined, busy = false, approvalCurrent = false;
  let pending: { phase: "propose" | "approve"; input: Record<string, string>; uncertain: boolean } | undefined;
  async function transmit() {
    if (!pending || busy) throw new Error("Resolve the current refresh request first.");
    const exact = pending; busy = true;
    try {
      const response = await fetcher(`${path}/${exact.phase}`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10000), headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(exact.input) });
      if ([400, 401, 403, 409].includes(response.status)) {
        if (!exact.uncertain) pending = undefined;
        if (response.status === 401) throw new BrowserAuthenticationRecoveryError(exact.uncertain);
        throw new Error("Refresh request refused or unresolved. Check access and source settings.");
      }
      if (!response.ok) throw new Error("Refresh outcome unknown. Retry the exact request.");
      const body = await readBrowserJson(response);
      if (exact.phase === "propose") {
        const value = proposalSchema.parse(body);
        if (value.sourceDigest !== exact.input.sourceDigest) throw new Error("Refresh response mismatch.");
        proposal = value; approvalCurrent = true;
      } else {
        const value = approvalSchema.parse(body);
        if (value.projectId !== projectId || value.jobId !== exact.input.jobId) throw new Error("Refresh response mismatch.");
        approval = value;
      }
      pending = undefined;
    } catch (error) { if (pending) pending.uncertain = true; throw error; }
    finally { busy = false; }
  }
  return Object.freeze({ hasPending: () => !!pending,
    state: () => ({ proposed: !!proposal, submitted: !!approval, canApprove: approvalCurrent && !!proposal && !approval,
      jobId: proposal?.jobId, effectState: approval?.effectState }),
    async history(after?: string, signal?: AbortSignal) {
      if (after !== undefined && !id.safeParse(after).success) throw new BrowserRequestError("invalid_request");
      try {
        const response = await fetcher(`${path}/history${after === undefined ? "" : `?${new URLSearchParams({ after })}`}`, {
          credentials: "same-origin", cache: "no-store", redirect: "error",
          headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new BrowserRequestError(response.status === 401 ? "authentication_required"
          : response.status === 403 ? "access_denied" : response.status === 404 ? "not_found" : "unavailable");
        const value = newsCollectionHistorySchema.parse(await readBrowserJson(response));
        if (value.projectId !== projectId || value.sourceId !== sourceId || value.after !== (after ?? null)) throw new Error();
        return value;
      } catch (reason) { throw reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"); }
    },
    async status(jobId?: string, signal?: AbortSignal) {
      if (jobId !== undefined && !id.safeParse(jobId).success) throw new BrowserRequestError("invalid_request");
      try {
        const response = await fetcher(`${path}/status${jobId === undefined ? "" : `?${new URLSearchParams({ jobId })}`}`, {
          credentials: "same-origin", cache: "no-store", redirect: "error",
          headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new BrowserRequestError(response.status === 401 ? "authentication_required"
          : response.status === 403 ? "access_denied" : response.status === 404 ? "not_found" : "unavailable");
        const value = newsCollectionStatusSchema.parse(await readBrowserJson(response));
        if (value.projectId !== projectId || value.sourceId !== sourceId
          || jobId !== undefined && (value.configured && value.latest === null
            || value.latest !== null && value.latest.jobId !== jobId)) throw new Error();
        return value;
      } catch (reason) { throw reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"); }
    },
    async describe(signal?: AbortSignal) {
      if (proposal) approvalCurrent = false;
      const response = await fetcher(path, { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
      if (response.status === 401) throw new BrowserAuthenticationRecoveryError(!!pending);
      if (!response.ok) throw new Error("Refresh settings unavailable.");
      const value = newsRefreshDescriptionSchema.parse(await readBrowserJson(response));
      if (value.projectId !== projectId || value.sourceId !== sourceId) throw new Error("Refresh source mismatch.");
      if (proposal && value.configured && value.sourceDigest !== proposal.sourceDigest) throw new Error("Prepared refresh configuration changed.");
      if (proposal && value.configured && value.canRefresh && value.sourceCurrent) approvalCurrent = true;
      return value;
    },
    propose(description: NewsRefreshDescription, requestKey: string) {
      if (pending || busy || proposal || approval) return Promise.reject(new Error("A refresh request already exists."));
      const value = newsRefreshDescriptionSchema.parse(description);
      if (!value.configured || !value.canRefresh || !value.sourceCurrent || value.projectId !== projectId || value.sourceId !== sourceId)
        return Promise.reject(new Error("Refresh is unavailable."));
      pending = { phase: "propose", input: { sourceDigest: value.sourceDigest, idempotencyKey: id.min(12).parse(requestKey) }, uncertain: false };
      return transmit();
    },
    approve() {
      if (pending || busy || !proposal || approval || !approvalCurrent) return Promise.reject(new Error("Prepare a refresh first, or resolve the current request."));
      pending = { phase: "approve", input: { jobId: proposal.jobId, inputDigest: proposal.inputDigest }, uncertain: false };
      return transmit();
    }, retry: transmit,
  });
}
