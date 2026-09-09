import { z } from "zod";
import { readBrowserJson } from "./browser-json";
import { browserAuthenticationRecovery } from "./browser-client";
import { catalogProjectIdSchema as id } from "./project-wire";

const inputSchema = z.object({ storyId: id, archived: z.boolean(),
  expectedRevision: z.number().int().min(0).max(2_147_483_646) }).strict();
const receiptSchema = z.object({ projectId: id, record: z.object({ storyId: id, archived: z.boolean(),
  revision: z.number().int().min(1).max(2_147_483_647), updatedAt: z.string().datetime({ offset: true }) }).strict(),
  replayed: z.boolean(), startsWork: z.literal(false) }).strict();
export type NewsArchiveReceipt = z.infer<typeof receiptSchema>;

/** Same exact-save convention as source settings: never toggle or automatically retry. */
export function createNewsArchiveClient(projectId: string, fetcher: typeof fetch = fetch) {
  const path = `/api/v1/projects/${encodeURIComponent(id.parse(projectId))}/news/archive`;
  let pending: { input: z.infer<typeof inputSchema>; uncertain: boolean } | undefined, busy = false;
  async function transmit() {
    if (!pending || busy) throw new Error("Finish the pending archive change first.");
    const exact = pending; busy = true;
    try {
      const response = await fetcher(path, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10_000), headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(exact.input) });
      if ([400, 401, 403, 404, 409].includes(response.status)) {
        if (response.status === 401) { if (!exact.uncertain) pending = undefined;
          throw new Error(browserAuthenticationRecovery(exact.uncertain)); }
        if (exact.uncertain) throw new Error("Earlier change is still unresolved. Restore access and retry this exact change.");
        pending = undefined;
        throw new Error("Article was not changed. Check access and reload the library before trying again.");
      }
      if (!response.ok) throw new Error("Change outcome is unknown. Retry this exact change.");
      const receipt = receiptSchema.parse(await readBrowserJson(response));
      if (receipt.projectId !== projectId || receipt.record.storyId !== exact.input.storyId
        || receipt.record.archived !== exact.input.archived || receipt.record.revision !== exact.input.expectedRevision + 1)
        throw new Error("Change response did not match. Retry this exact change.");
      pending = undefined; return receipt;
    } catch (error) {
      if (pending) pending.uncertain = true;
      throw error;
    } finally { busy = false; }
  }
  return Object.freeze({ hasPending: () => pending !== undefined,
    save(value: unknown) {
      if (pending || busy) return Promise.reject(new Error("Finish the pending archive change first."));
      pending = { input: inputSchema.parse(value), uncertain: false };
      return transmit();
    }, retry: transmit });
}
