import { sha256Digest, assertAuthorityDigest } from "../../security";
import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import type { ServerTrustStore } from "../../node-policy/v1/stores";
import { normalizedLocalPolicyRequestSchema } from "../../node-policy/v1/schemas";
import type { VerifiedLeaseAuthorityV1 } from "../../node-policy/v1/types";
import { verifyNodeFrameSignature } from "../../node-protocol/v1";

/** Read an exact previously accepted initial lease, rechecking current server signing trust.
 * Caller supplies already-open stores; this opens nothing and cannot receive/renew a lease.
 * Parent material is still checked against the signed authority digest by the local evaluator.
 */
export function createNativeLeaseEvidence(config: { request: unknown; messageId: string; serverActorId: string;
  parentAuthorities: VerifiedLeaseAuthorityV1["parentAuthorities"] }, deps: {
  journal: Pick<SqliteBridgeJournal, "acceptedCommand" | "attemptSummary">;
  trust: Pick<ServerTrustStore, "resolveServerKey">; clock?: () => number;
}) {
  const request = normalizedLocalPolicyRequestSchema.parse(config.request);
  const messageId = config.messageId, actor = config.serverActorId, parents = structuredClone(config.parentAuthorities);
  if (!messageId || !actor || request.operationId !== "harness.hermes.native.start") throw new Error("native_lease_evidence_invalid");
  const load = deps.journal.acceptedCommand.bind(deps.journal), attempt = deps.journal.attemptSummary.bind(deps.journal),
    key = deps.trust.resolveServerKey.bind(deps.trust), clock = deps.clock ?? Date.now;
  return async (signal: AbortSignal): Promise<VerifiedLeaseAuthorityV1> => {
    try {
      if (signal.aborted) throw new Error();
      const accepted = load(messageId); if (!accepted) throw new Error();
      const frame = accepted.frame;
      if (frame.type !== "job.lease.grant" || frame.tenantId !== request.tenantId || frame.actorId !== actor
        || frame.direction !== "server_to_node" || frame.senderKind !== "control_room" || sha256Digest(frame.body) !== frame.bodyDigest) throw new Error();
      const publicKey = await key(frame.keyId);
      if (signal.aborted || !publicKey || !verifyNodeFrameSignature(frame, Buffer.from(publicKey).toString("base64url"))) throw new Error();
      const now = clock(), received = Date.parse(accepted.receivedAt), grant = frame.body, current = attempt(request.attemptId);
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(received)
        || received < Date.parse(frame.sentAt) || received >= Date.parse(frame.expiresAt) || received > now
        || grant.nodeId !== request.nodeId || grant.jobId !== request.jobId || grant.attemptId !== request.attemptId
        || grant.leaseId !== request.leaseId || grant.leaseEpoch !== request.leaseEpoch || grant.authorityDigest !== request.authorityDigest
        || grant.authority.digest !== grant.authorityDigest
        || grant.authority.projectId !== request.projectId || Date.parse(grant.acquiredAt) > now
        || Date.parse(grant.expiresAt) <= now || Date.parse(grant.authority.expiresAt) <= now
        || !current || current.jobId !== grant.jobId || current.leaseId !== grant.leaseId || current.leaseEpoch !== grant.leaseEpoch
        || !["leased", "running", "waiting"].includes(current.state)) throw new Error();
      assertAuthorityDigest(grant.authority);
      // Re-read the immutable receipt after awaiting trust; replaced/corrupt records cannot be used.
      if (sha256Digest(load(messageId)) !== sha256Digest(accepted)) throw new Error();
      return { tenantId: frame.tenantId, nodeId: grant.nodeId, jobId: grant.jobId, attemptId: grant.attemptId,
        leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch, validFrom: grant.acquiredAt, expiresAt: grant.expiresAt,
        authorityDigest: grant.authorityDigest, authority: structuredClone(grant.authority), parentAuthorities: structuredClone(parents) };
    } catch { throw new Error("native_lease_evidence_unavailable"); }
  };
}
