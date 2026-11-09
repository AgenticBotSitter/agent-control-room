import type { LoopSelectionPreviewBodyV1, LoopSelectionPreviewV1 } from "./loop-selection-wire";
import { readBrowserJson } from "./browser-json";

export class LoopSelectionReadErrorV1 extends Error {
  constructor(readonly status: number, readonly protectedFailure = false) { super("loop_selection_request_failed"); }
}
/** The pure preview has no idempotency key or acceptance action. UI wiring belongs to U81-C. */
export const loopSelectionBrowserClientV1 = {
  async preview(projectId: string, body: LoopSelectionPreviewBodyV1, signal?: AbortSignal): Promise<LoopSelectionPreviewV1> {
    const abort = new AbortController(), cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async () => {
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/loop-selection/preview`, {
          method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: abort.signal,
          headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "XMLHttpRequest" }, body: JSON.stringify(body),
        });
        if (!response.ok) throw new LoopSelectionReadErrorV1(response.status, [401, 403].includes(response.status));
        // The server validates the projection. Keep server/P71 Node imports out of this browser boundary.
        const value = await readBrowserJson(response);
        if (!value || typeof value !== "object" || !("available" in value) || typeof value.available !== "boolean")
          throw new LoopSelectionReadErrorV1(0, true);
        return value as LoopSelectionPreviewV1;
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => {
        abort.abort(); reject(new LoopSelectionReadErrorV1(0));
      }, 35_000); })]);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  },
};
