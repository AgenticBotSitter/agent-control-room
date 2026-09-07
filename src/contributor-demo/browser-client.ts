import { z } from "zod";
import { BrowserRequestError, type BrowserFailureCode } from "../web/v1/browser-client";
import { readBrowserJson } from "../web/v1/browser-json";
import { catalogProjectIdSchema } from "../web/v1/project-wire";
import { contributorRevisionSchema, type ContributorRevision } from "./revision";

const receiptSchema = z.object({ simulationOnly: z.literal(true), grantsExecutionAuthority: z.literal(false),
  artifactId: catalogProjectIdSchema, jobId: catalogProjectIdSchema, projectId: catalogProjectIdSchema }).strict();
const historyEntry = z.object({ parentArtifactId: catalogProjectIdSchema.nullable(),
  feedback: z.string().min(1).max(500).nullable() });
const historySchema = z.object({ simulationOnly: z.literal(true), grantsExecutionAuthority: z.literal(false),
  projectId: catalogProjectIdSchema, jobId: catalogProjectIdSchema,
  entries: z.array(z.discriminatedUnion("state", [
    historyEntry.extend({ state: z.literal("succeeded"), artifactId: catalogProjectIdSchema }).strict(),
    historyEntry.extend({ state: z.literal("unavailable") }).strict(),
  ])).max(100) }).strict();

/** Explicit user action only. No polling/reconnect retries and no native fallback.
 * A lost reply can be reconciled by explicitly resubmitting the same project/job;
 * the demo server retains that simulation outcome for the current session.
 */
export function createContributorDemoBrowserClient(transport: typeof fetch = fetch) {
  return {
    async history(projectId: string, jobId: string) {
      if (!catalogProjectIdSchema.safeParse(projectId).success || !catalogProjectIdSchema.safeParse(jobId).success) {
        throw new BrowserRequestError("invalid_request");
      }
      try {
        const response = await transport(`/api/v1/contributor-demo/simulations?${new URLSearchParams({ projectId, jobId })}`, {
          method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store",
          signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" },
        });
        if (!response.ok) {
          const codes: Record<number, BrowserFailureCode> = { 400: "invalid_request", 401: "authentication_required",
            403: "access_denied", 404: "not_found" };
          throw new BrowserRequestError(codes[response.status] ?? "uncertain");
        }
        const history = historySchema.parse(await readBrowserJson(response));
        if (history.projectId !== projectId || history.jobId !== jobId) throw new Error("history_scope_mismatch");
        const artifacts = new Set<string>();
        let previous: string | null = null;
        for (const [index, entry] of history.entries.entries()) {
          if (entry.parentArtifactId !== previous || (index === 0 ? entry.feedback !== null : entry.feedback === null)) throw new Error("history_chain_invalid");
          if (entry.state === "unavailable") {
            if (index !== history.entries.length - 1) throw new Error("history_chain_invalid");
          } else {
            if (artifacts.has(entry.artifactId)) throw new Error("history_chain_invalid");
            artifacts.add(entry.artifactId); previous = entry.artifactId;
          }
        }
        return history;
      } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain"); }
    },
    async simulate(projectId: string, jobId: string, revision?: ContributorRevision) {
      if (!catalogProjectIdSchema.safeParse(projectId).success || !catalogProjectIdSchema.safeParse(jobId).success) {
        throw new BrowserRequestError("invalid_request");
      }
      const parsedRevision = revision === undefined ? undefined : contributorRevisionSchema.safeParse(revision);
      if (parsedRevision && !parsedRevision.success) throw new BrowserRequestError("invalid_request");
      try {
        const response = await transport("/api/v1/contributor-demo/simulations", {
          method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
          signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ operation: "simulate_task", simulationOnly: true, projectId, jobId,
            ...(parsedRevision?.success ? { revision: parsedRevision.data } : {}) }),
        });
        if (!response.ok) {
          const failures: Record<number, BrowserFailureCode> = {
            400: "invalid_request", 401: "authentication_required", 403: "access_denied", 404: "not_found",
          };
          const code = failures[response.status];
          throw new BrowserRequestError(code ?? "uncertain");
        }
        const receipt = receiptSchema.parse(await readBrowserJson(response));
        if (receipt.projectId !== projectId || receipt.jobId !== jobId) throw new Error("receipt_mismatch");
        if (revision && receipt.artifactId === revision.parentArtifactId) throw new Error("revision_receipt_mismatch");
        return receipt;
      } catch (error) {
        throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
      }
    },
  };
}
