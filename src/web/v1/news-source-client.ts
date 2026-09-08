import { z } from "zod";
import { readBrowserJson } from "./browser-json";
import { BrowserAuthenticationRecoveryError } from "./browser-client";
import { catalogProjectIdSchema as id } from "./project-wire";

// Browser wire validation only. Server performs the stronger destination/authority checks.
const sourceSchema = z.object({ id, name: z.string().min(1).max(180), url: z.string().url().max(2000), enabled: z.boolean() }).strict();
const recordSchema = z.object({ source: sourceSchema, revision: z.number().int().min(1), updatedAt: z.string().datetime() }).strict();
const pageSchema = z.object({ projectId: id, configured: z.boolean(), canEdit: z.boolean(),
  sources: z.array(recordSchema).max(50), nextCursor: id.nullable() }).strict();
const inputSchema = z.object({ source: sourceSchema, expectedRevision: z.number().int().min(0).max(2_147_483_646) }).strict();
const receiptSchema = z.object({ projectId: id, record: recordSchema, replayed: z.boolean(), startsWork: z.literal(false) }).strict();
export type NewsSourcePage = z.infer<typeof pageSchema>;
export type NewsSourceInput = z.infer<typeof inputSchema>;

export function createNewsSourceClient(fetcher: typeof fetch = fetch) {
  let pending: { projectId: string; input: NewsSourceInput; uncertain: boolean } | undefined, busy = false;
  const path = (projectId: string) => `/api/v1/projects/${encodeURIComponent(id.parse(projectId))}/news/sources`;
  async function transmit() {
    if (!pending || busy) throw new Error("Finish the pending save first.");
    busy = true;
    const exact = pending;
    try {
      const response = await fetcher(path(exact.projectId), { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10_000), headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(exact.input) });
      if ([400, 401, 403, 409].includes(response.status)) {
        if (response.status === 401) { if (!exact.uncertain) pending = undefined;
          throw new BrowserAuthenticationRecoveryError(exact.uncertain); }
        if (exact.uncertain) throw new Error("Earlier save is still unresolved. Restore access and retry this exact save.");
        pending = undefined;
        throw new Error(response.status === 409 ? "This source changed. Reload settings before editing again." : "Source was not saved. Check your access and the public feed URL.");
      }
      if (!response.ok) throw new Error("Save outcome is unknown. Retry this exact save.");
      const receipt = receiptSchema.parse(await readBrowserJson(response));
      if (receipt.projectId !== exact.projectId || receipt.record.revision !== exact.input.expectedRevision + 1
        || JSON.stringify(receipt.record.source) !== JSON.stringify(exact.input.source)) throw new Error("Save response did not match. Retry this exact save.");
      pending = undefined; return receipt;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error;
    } finally { busy = false; }
  }
  return Object.freeze({ hasPending: () => pending !== undefined,
    async list(projectId: string, after?: string, signal?: AbortSignal) {
      const url = path(projectId) + (after ? `?${new URLSearchParams({ after: id.parse(after) })}` : "");
      const response = await fetcher(url, { credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" } });
      if (response.status === 401) throw new BrowserAuthenticationRecoveryError(!!pending);
      if (!response.ok) throw new Error("Source settings are unavailable. Check your access and reload.");
      const page = pageSchema.parse(await readBrowserJson(response));
      if (page.projectId !== projectId || page.sources.some((row, i) => after !== undefined && row.source.id <= after
        || i > 0 && row.source.id <= page.sources[i - 1].source.id)
        || page.nextCursor !== null && (page.sources.length !== 50 || page.nextCursor !== page.sources.at(-1)?.source.id)
        || !page.configured && (page.canEdit || page.sources.length || page.nextCursor !== null)) throw new Error("Invalid source settings response.");
      return page;
    },
    save(projectId: string, value: unknown) {
      if (pending || busy) return Promise.reject(new Error("Finish the pending save first."));
      pending = { projectId: id.parse(projectId), input: inputSchema.parse(value), uncertain: false };
      return transmit();
    }, retry: transmit,
  });
}
