import { canonicalJson, sha256Digest } from "../../security";
import { verifyArtifactSignature } from "../../node-policy/v1/crypto";
import { prepareNativeOwnerApprovalMaterial } from "./native-owner-approval-material";
import { nativeTaskApprovalPacketSchema } from "./native-approval-packet";
import { describeNativeOwnerReview } from "./native-owner-review";

/** Trusted local composition only. Supplied consent guard is not implemented here;
 * it must bind actual owner consent/current pins to reviewDigest, not a request flag.
 * No native custody, channel acquisition, persistence or dispatch is supplied.
 */
export function createNativeOwnerApprovalIssuer(
  input: Parameters<typeof prepareNativeOwnerApprovalMaterial>[0],
  dependencies: {
    publicKeySpki: string; timeoutMs: number; clock: () => number;
    assertOwnerConsentCurrent: (reviewDigest: string) => void;
    sign: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  },
) {
  const material = prepareNativeOwnerApprovalMaterial(input), review = describeNativeOwnerReview(input);
  const reviewDigest = sha256Digest({ review, material });
  const authorization = Object.freeze({ approvalKeyId: material.approval.approvalKeyId,
    approvalExpiresAt: material.approval.expiresAt,
    recoveryExpiresAt: new Date(material.recovery.expiresAt).toISOString(),
    recoveryOperations: Object.freeze([...material.recovery.operations]) });
  const key = dependencies.publicKeySpki, clock = dependencies.clock;
  const consent = dependencies.assertOwnerConsentCurrent, sign = dependencies.sign;
  const timeoutMs = dependencies.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("owner_approval_issuer_invalid");
  let attempted = false, highWater = material.recovery.issuedAt;
  return Object.freeze({ review, authorization, reviewDigest, async issue(signal: AbortSignal) {
    const unavailable = () => new Error("owner_approval_issuance_uncertain");
    if (attempted) throw unavailable(); attempted = true;
    const controller = new AbortController(), stop = () => controller.abort();
    const end = performance.now() + timeoutMs;
    function observe() {
      const now = clock();
      if (controller.signal.aborted || signal.aborted || performance.now() >= end
        || !Number.isSafeInteger(now) || now < highWater || now >= Date.parse(material.approval.expiresAt)) throw unavailable();
      highWater = now;
    }
    function current() {
      observe();
      const result: unknown = consent(reviewDigest);
      if (result !== undefined) {
        // A mistakenly supplied async guard must not authorize signing before it settles.
        if (result instanceof Promise) void result.catch(() => {});
        throw unavailable();
      }
      observe();
    }
    signal.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    try {
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(unavailable());
        controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(stop, timeoutMs);
      });
      const work = (async () => {
        current();
        const first = await sign(Buffer.from(canonicalJson(material.approval)), controller.signal);
        current();
        if (!(first instanceof Uint8Array) || first.byteLength !== 64) throw unavailable();
        const approval = { body: material.approval, signatureAlgorithm: "Ed25519" as const, signature: Buffer.from(first).toString("base64url") };
        if (!verifyArtifactSignature(approval, key)) throw unavailable();
        const second = await sign(Buffer.from(canonicalJson(material.recovery)), controller.signal);
        current();
        if (!(second instanceof Uint8Array) || second.byteLength !== 64) throw unavailable();
        const recovery = { body: material.recovery, signatureAlgorithm: "Ed25519" as const, signature: Buffer.from(second).toString("base64url") };
        if (!verifyArtifactSignature(recovery, key)) throw unavailable();
        const packet = nativeTaskApprovalPacketSchema.parse({ schema: "control-room.native-task-approval-packet/v1", approval, recovery });
        current(); return packet;
      })();
      return await Promise.race([work, stopped]);
    } catch { throw unavailable(); }
    finally { controller.abort(); clearTimeout(timer); signal.removeEventListener("abort", stop);
      controller.signal.removeEventListener("abort", onAbort); }
  } });
}
