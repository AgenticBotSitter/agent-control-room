import { z } from "zod";
import { BrowserRequestError, type BrowserFailureCode } from "../web/v1/browser-client";
import { readBrowserJson } from "../web/v1/browser-json";
import { catalogProjectIdSchema } from "../web/v1/project-wire";

const receiptSchema = z.object({ simulationOnly: z.literal(true), grantsExecutionAuthority: z.literal(false),
  artifactId: catalogProjectIdSchema, jobId: catalogProjectIdSchema, projectId: catalogProjectIdSchema }).strict();

/** Explicit user action only. No polling/reconnect retries and no native fallback.
 * A lost reply can be reconciled by explicitly resubmitting the same project/job;
 * the demo server retains that simulation outcome for the current session.
 */
export function createContributorDemoBrowserClient(transport: typeof fetch = fetch) {
  return {
    async simulate(projectId: string, jobId: string) {
      if (!catalogProjectIdSchema.safeParse(projectId).success || !catalogProjectIdSchema.safeParse(jobId).success) {
        throw new BrowserRequestError("invalid_request");
      }
      try {
        const response = await transport("/api/v1/contributor-demo/simulations", {
          method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
          signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ operation: "simulate_task", simulationOnly: true, projectId, jobId }),
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
        return receipt;
      } catch (error) {
        throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
      }
    },
  };
}
