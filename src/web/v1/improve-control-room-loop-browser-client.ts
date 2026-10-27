import { improvementDeskViewSchemaV1, loopImprovementDeskViewSchemaV1, loopImprovementStatusSchemaV1,
  loopBridgeReceiptSchemaV1 } from "../../improve-control-room/v1/schemas";
import { readBrowserJson } from "./browser-json";

export type FrozenLoopAction = Readonly<{ body: string; key: string }>;
export class LoopReadError extends Error {
  constructor(readonly status: number, readonly protectedFailure = false) { super("loop_request_failed"); }
}
export const clearsLoopAuthority = (error: unknown) => error instanceof LoopReadError && error.protectedFailure;
const path = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/improvements`;
const headers = { accept: "application/json", "x-requested-with": "XMLHttpRequest" };
async function exchange(url: string, signal?: AbortSignal, action?: FrozenLoopAction) {
  const abort = new AbortController();
  const cancel = () => abort.abort(); signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async () => {
      const response = await fetch(url, { method: action ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
        redirect: "error", signal: abort.signal, headers: action ? { ...headers, "content-type": "application/json", "idempotency-key": action.key } : headers,
        ...(action ? { body: action.body } : {}) });
      if (!response.ok) throw new LoopReadError(response.status, [401, 403].includes(response.status));
      try { return await readBrowserJson(response); } catch { throw new LoopReadError(0, true); }
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new LoopReadError(0)); }, 10_000); })]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
function decode<T>(parse: () => T): T {
  try { return parse(); } catch { throw new LoopReadError(0, true); }
}
export const loopImprovementBrowserClient = {
  async readDesk(projectId: string, signal: AbortSignal) {
    let value: unknown;
    try { value = await exchange(`${path(projectId)}/loop/desk`, signal); }
    catch (error) {
      if (!(error instanceof LoopReadError) || error.status !== 404) throw error;
      value = await exchange(path(projectId), signal);
      const legacy = decode(() => improvementDeskViewSchemaV1.parse(value));
      if (legacy.projectId !== projectId) throw new LoopReadError(0, true);
      return { kind: "legacy" as const, legacy };
    }
    const desk = decode(() => loopImprovementDeskViewSchemaV1.parse(value));
    if (desk.legacy.projectId !== projectId || desk.loopRequests.some(row => row.projectId !== projectId)) throw new LoopReadError(0, true);
    return { kind: "loop" as const, desk };
  },
  async readStatus(projectId: string, requestId: string, signal: AbortSignal) {
    const result = await exchange(`${path(projectId)}/loop/${encodeURIComponent(requestId)}/status`, signal);
    const display = decode(() => loopImprovementStatusSchemaV1.parse((result as { display?: unknown } | null)?.display));
    if (display.projectId !== projectId || display.requestId !== requestId) throw new LoopReadError(0, true);
    return display;
  },
  async start(projectId: string, requestId: string, action: FrozenLoopAction) {
    return command(projectId, requestId, "start", action);
  },
  async stop(projectId: string, requestId: string, action: FrozenLoopAction) {
    return command(projectId, requestId, "stop", action);
  },
};
async function command(projectId: string, requestId: string, operation: "start" | "stop", action: FrozenLoopAction) {
  const value = await exchange(`${path(projectId)}/loop/${encodeURIComponent(requestId)}/${operation}`, undefined, action);
  const receipt = decode(() => loopBridgeReceiptSchemaV1.parse(value));
  if (receipt.requestId !== requestId) throw new LoopReadError(0, true);
  return receipt;
}
