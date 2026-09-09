import { z } from "zod";
import { createNativeOwnerApprovalIssuer } from "./native-owner-approval-issuer";
import { describeNativeOwnerReview } from "./native-owner-review";
import { localId } from "./native-run-identifiers";
import { digestSchema } from "./native-run-contracts";

type Issuer = ReturnType<typeof createNativeOwnerApprovalIssuer>;
type MaterialInput = Parameters<typeof createNativeOwnerApprovalIssuer>[0];
type Signer = Parameters<typeof createNativeOwnerApprovalIssuer>[1];
const targetSchema = z.object({ projectId: localId, jobId: localId, inputDigest: digestSchema }).strict();
export type NativeOwnerReviewTarget = z.infer<typeof targetSchema>;
export type NativeOwnerReviewPhase = "new" | "loading" | "review" | "issuing" | "issued" | "unavailable" | "closed";
export interface NativeOwnerReviewSessionPorts {
  /** Authenticated canonical preparation plus owner-side signing parameters.
   * Never a browser upload/summary or an agent's claim of canonical authority.
   * The returned synchronous fence must track the current trusted source/pins;
   * a constant no-op is only appropriate to labelled synthetic tests. */
  load(target: Readonly<NativeOwnerReviewTarget>, signal: AbortSignal): Promise<{
    input: MaterialInput; assertCurrent(): void;
  }>;
  signer: Signer;
}
const unavailable = () => new Error("native_owner_review_session_unavailable");
function synchronous(work: () => unknown) {
  const result = work();
  if (result !== undefined) {
    if (result instanceof Promise) void result.catch(() => {});
    throw unavailable();
  }
}

/** Owner-controlled application session, not a web endpoint or implemented key
 * custody. Reuses canonical human review and the existing paired issuer. One
 * preparation and one issue attempt; no storage, retry, dispatch or partial packet.
 * The echoed digest selects a displayed review; it is NOT owner consent. */
export function createNativeOwnerReviewSession(value: NativeOwnerReviewTarget,
  ports: NativeOwnerReviewSessionPorts, preparationTimeoutMs = 5000) {
  const target = Object.freeze(targetSchema.parse(value));
  if (!Number.isSafeInteger(preparationTimeoutMs) || preparationTimeoutMs < 1 || preparationTimeoutMs > 30_000) throw unavailable();
  const load = ports.load.bind(ports), sourceSigner = ports.signer;
  const signer = { publicKeySpki: sourceSigner.publicKeySpki, timeoutMs: sourceSigner.timeoutMs,
    clock: sourceSigner.clock.bind(sourceSigner), sign: sourceSigner.sign.bind(sourceSigner),
    consent: sourceSigner.assertOwnerConsentCurrent.bind(sourceSigner) };
  const lifetime = new AbortController();
  let phase: NativeOwnerReviewPhase = "new", issuer: Issuer | undefined;
  const status = (): NativeOwnerReviewPhase => phase;
  let preparationLifetime: AbortController | undefined;
  let reviewCurrent: ((digest: string) => void) | undefined;
  const active = (signal?: AbortSignal) => {
    if (lifetime.signal.aborted || signal?.aborted || phase === "closed" || phase === "unavailable") throw unavailable();
  };
  function close() { phase = "closed"; lifetime.abort(); preparationLifetime?.abort(); issuer = undefined; reviewCurrent = undefined; }
  return Object.freeze({ close,
    snapshot() {
      return Object.freeze({ phase, target, startsWork: false as const,
        ...(phase === "review" && issuer ? { review: issuer.review, authorization: issuer.authorization, reviewDigest: issuer.reviewDigest } : {}) });
    },
    async prepare(signal: AbortSignal) {
      if (phase !== "new" || !(signal instanceof AbortSignal)) throw unavailable();
      phase = "loading";
      const controller = new AbortController(), abort = () => controller.abort();
      const deadline = performance.now() + preparationTimeoutMs;
      const loadingCurrent = () => { active(controller.signal); if (performance.now() >= deadline) throw unavailable(); };
      signal.addEventListener("abort", abort, { once: true }); lifetime.signal.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined, rejectStopped: () => void = () => {};
      const stop = () => rejectStopped(); controller.signal.addEventListener("abort", stop, { once: true });
      try {
        active(signal);
        const stopped = new Promise<never>((_, reject) => { rejectStopped = () => reject(unavailable()); });
        timer = setTimeout(abort, preparationTimeoutMs);
        const work = Promise.resolve().then(() => {
          loadingCurrent(); return load(target, controller.signal);
        }).then(prepared => {
          loadingCurrent();
          const input = structuredClone(prepared.input), current = prepared.assertCurrent.bind(prepared);
          synchronous(current); loadingCurrent();
          const review = describeNativeOwnerReview(input);
          if (review.projectId !== target.projectId || review.jobId !== target.jobId || review.inputDigest !== target.inputDigest) throw unavailable();
          const checkReview = (digest: string) => {
            active(); synchronous(current); synchronous(() => signer.consent(digest)); active(); synchronous(current);
          };
          const candidate = createNativeOwnerApprovalIssuer(input, { ...signer, assertOwnerConsentCurrent: checkReview });
          synchronous(current); loadingCurrent(); issuer = candidate; reviewCurrent = checkReview; phase = "review";
          return Object.freeze({ review: candidate.review, authorization: candidate.authorization,
            reviewDigest: candidate.reviewDigest, startsWork: false as const });
        });
        return await Promise.race([work, stopped]);
      } catch { if (status() !== "closed") phase = "unavailable"; lifetime.abort(); issuer = undefined; throw unavailable(); }
      finally { clearTimeout(timer); if (status() === "review") preparationLifetime = controller; else controller.abort();
        signal.removeEventListener("abort", abort);
        lifetime.signal.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", stop); }
    },
    async issue(expectedReviewDigest: string, signal: AbortSignal) {
      if (phase !== "review" || !issuer || !reviewCurrent || !(signal instanceof AbortSignal)) throw unavailable();
      const prepared = issuer, checkReview = reviewCurrent; phase = "issuing"; issuer = undefined;
      const controller = new AbortController(), abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true }); lifetime.signal.addEventListener("abort", abort, { once: true });
      try {
        active(signal);
        if (expectedReviewDigest !== prepared.reviewDigest) throw unavailable();
        const packet = await prepared.issue(controller.signal);
        active(signal); checkReview(prepared.reviewDigest); active(signal); phase = "issued"; return packet;
      } catch { if (status() !== "closed") phase = "unavailable"; lifetime.abort(); throw unavailable(); }
      finally { controller.abort(); preparationLifetime?.abort(); preparationLifetime = undefined; reviewCurrent = undefined;
        signal.removeEventListener("abort", abort); lifetime.signal.removeEventListener("abort", abort); }
    },
  });
}
