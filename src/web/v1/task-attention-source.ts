import { BrowserRequestError } from "./browser-client";
import { readTaskAttention } from "./queue-attention-browser-client";
import type { TaskAttentionPage } from "./task-attention-wire";

export type TaskAttentionSourceState =
  | { state: "loading" }
  | { state: "available"; pages: TaskAttentionPage[]; truncated: boolean }
  | { state: "unavailable"; code: "authentication_required" | "access_denied" | "unavailable"; pages: TaskAttentionPage[] };

/** Candidate pages can be empty without being the end of the source. */
export async function readAllTaskAttention(transport: typeof fetch = fetch, signal?: AbortSignal): Promise<TaskAttentionSourceState> {
  const pages: TaskAttentionPage[] = [];
  let cursor: string | undefined;
  try {
    for (let pageNumber = 0; pageNumber < 40; pageNumber += 1) {
      signal?.throwIfAborted();
      const page = await readTaskAttention(cursor, transport);
      pages.push(page);
      if (!page.nextCursor) return { state: "available", pages, truncated: false };
      cursor = page.nextCursor;
    }
    return { state: "available", pages, truncated: true };
  } catch (error) {
    const code = error instanceof BrowserRequestError && (error.code === "authentication_required" || error.code === "access_denied")
      ? error.code : "unavailable";
    return { state: "unavailable", code, pages: code === "unavailable" ? pages : [] };
  }
}

/** Fresh rows replace cached rows; an incomplete read cannot resolve unseen work. */
export function retainTaskAttentionPages(previous: readonly TaskAttentionPage[], fresh: readonly TaskAttentionPage[]): TaskAttentionPage[] {
  const seen = new Set(fresh.flatMap(page => page.items).map(item => item.task.jobId));
  return [...fresh, ...previous.map(page => ({ ...page, items: page.items.filter(item => !seen.has(item.task.jobId)) })).filter(page => page.items.length)];
}
