import { loopCandidatePageSchemaV1, loopCandidateDetailSchemaV1, loopCandidateDecisionBodySchemaV1,
  loopCandidateDecisionReceiptSchemaV1 } from "../../improve-control-room/v1/loop-candidate-wire";
import { readBrowserJson } from "./browser-json";

export class LoopCandidateReadErrorV1 extends Error {
  constructor(readonly status: number, readonly protectedFailure = false) { super("loop_candidate_request_failed"); }
}
export type FrozenLoopCandidateDecisionV1 = Readonly<{ body: string; key: string }>;
async function exchange(path: string, signal?: AbortSignal, action?: FrozenLoopCandidateDecisionV1) {
  const abort = new AbortController(), cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async () => {
      const response = await fetch(path, { method: action ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: abort.signal, headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
          ...(action ? { "content-type": "application/json", "idempotency-key": action.key } : {}) }, ...(action ? { body: action.body } : {}) });
      if (!response.ok) throw new LoopCandidateReadErrorV1(response.status, [401,403].includes(response.status));
      try { return await readBrowserJson(response); } catch { throw new LoopCandidateReadErrorV1(0, true); }
    })(), new Promise<never>((_,reject) => { timer = setTimeout(() => { abort.abort(); reject(new LoopCandidateReadErrorV1(0)); },10_000); })]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort",cancel); }
}
function decode<T>(parse: () => T): T { try { return parse(); } catch { throw new LoopCandidateReadErrorV1(0,true); } }
export const loopCandidateBrowserClientV1 = {
  async read(signal: AbortSignal, projectId?: string, requestId?: string) {
    if (projectId && requestId) {
      const raw = await exchange(`/api/v1/projects/${encodeURIComponent(projectId)}/improvements/loop/${encodeURIComponent(requestId)}/candidate`,signal);
      const detail = decode(() => loopCandidateDetailSchemaV1.parse(raw));
      if (detail.candidate && (detail.candidate.projectId !== projectId || detail.candidate.requestId !== requestId)) throw new LoopCandidateReadErrorV1(0,true);
      return { candidates: detail.candidate ? [detail.candidate] : [], truncated: false, observedAt: detail.observedAt };
    }
    const rawRead = await exchange("/api/v1/loop-update-candidates",signal);
    return decode(() => loopCandidatePageSchemaV1.parse(rawRead));
  },
  async decide(action: FrozenLoopCandidateDecisionV1) {
    const expected = decode(() => loopCandidateDecisionBodySchemaV1.parse(JSON.parse(action.body)));
    const raw = await exchange(`/api/v1/loop-update-candidates/${encodeURIComponent(expected.candidateId)}/decision`,undefined,action);
    const receipt = decode(() => loopCandidateDecisionReceiptSchemaV1.parse(raw));
    if (receipt.candidateId !== expected.candidateId || receipt.candidateRecordDigest !== expected.candidateRecordDigest
      || receipt.candidateRevision !== expected.candidateRevision || receipt.decision !== expected.decision) throw new LoopCandidateReadErrorV1(0,true);
    return receipt;
  },
};
