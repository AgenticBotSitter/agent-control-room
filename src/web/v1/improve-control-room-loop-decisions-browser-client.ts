import { loopBridgeReceiptSchemaV1 } from "../../improve-control-room/v1/schemas";
import { readBrowserJson } from "./browser-json";
import { LoopReadError, type FrozenLoopAction } from "./improve-control-room-loop-browser-client";
import { documentMatchesStatus, loopApprovalDocumentSchemaV1, type LoopDecisionStatusV1 } from "./improve-control-room-loop-attention-wire";

const base = (project: string) => `/api/v1/projects/${encodeURIComponent(project)}/improvements/loop`;
async function exchange(url: string, action?: FrozenLoopAction, signal?: AbortSignal, limit = 65536) {
  const abort = new AbortController(), cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async () => {
      const response = await fetch(url, { method: action ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: abort.signal,
        headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest", ...(action ? { "content-type": "application/json", "idempotency-key": action.key } : {}) },
        ...(action ? { body: action.body } : {}) });
      if (!response.ok) throw new LoopReadError(response.status, [401, 403].includes(response.status));
      try { return await readBrowserJson(response, limit, 10000); } catch { throw new LoopReadError(0, true); }
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new LoopReadError(0)); }, 10000); })]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
export const loopDecisionsBrowserClient = {
  async command(projectId: string, requestId: string | null, operation: "intake" | "confirm" | "approve" | "answer", action: FrozenLoopAction) {
    const value = await exchange(`${base(projectId)}/${requestId ? `${encodeURIComponent(requestId)}/` : ""}${operation}`, action);
    const parsed = loopBridgeReceiptSchemaV1.safeParse(value);
    if (!parsed.success || requestId !== null && parsed.data.requestId !== requestId) throw new LoopReadError(0, true);
    return parsed.data;
  },
  async readApprovalDocument(status: LoopDecisionStatusV1, signal: AbortSignal) {
    const value = await exchange(`${base(status.request.projectId)}/${encodeURIComponent(status.request.requestId)}/approval-document`, undefined, signal, 1600000);
    const parsed = loopApprovalDocumentSchemaV1.safeParse(value);
    if (!parsed.success || !documentMatchesStatus(parsed.data, status)) throw new LoopReadError(0, true);
    return parsed.data;
  },
};
