import type { SignedNodeFrame } from "../../node-protocol/v1";
import { assertAuthorityDigest } from "../../security";

/** Binding only. Current signing trust, canonical provenance and transport intent
 * remain the responsibility of the enclosing checked staging/transmission path. */
export function assertNativeLeaseDispatchPair(dispatch: SignedNodeFrame<"harness.native.dispatch">, lease: SignedNodeFrame) {
  if (lease.type !== "job.lease.grant") throw new Error("native_lease_pair_mismatch");
  const r = dispatch.body.request, g = lease.body;
  if (lease.direction !== "server_to_node" || lease.senderKind !== "control_room"
    || lease.tenantId !== dispatch.tenantId || lease.actorId !== dispatch.actorId || lease.keyId !== dispatch.keyId
    || lease.connectionId !== dispatch.connectionId || lease.sequence !== dispatch.sequence + 1
    || lease.messageId === dispatch.messageId || lease.causationId !== dispatch.messageId
    || Date.parse(lease.sentAt) < Date.parse(dispatch.sentAt) || Date.parse(lease.expiresAt) > Date.parse(dispatch.expiresAt)
    || Date.parse(lease.expiresAt) > Date.parse(g.expiresAt) || Date.parse(lease.expiresAt) > Date.parse(g.authority.expiresAt)
    || g.nodeId !== r.nodeId || g.jobId !== r.jobId || g.attemptId !== r.attemptId
    || g.leaseId !== r.leaseId || g.leaseEpoch !== r.leaseEpoch || g.authorityDigest !== r.authorityDigest
    || g.authority.digest !== r.authorityDigest || g.authority.projectId !== r.projectId)
    throw new Error("native_lease_pair_mismatch");
  assertAuthorityDigest(g.authority);
  return lease;
}
