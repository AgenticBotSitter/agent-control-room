import { jobRecordSchema, leaseRecordSchema } from "../../domain/v1";
import { leaseGrantSchema } from "../../node-protocol/v1";
import { sha256Digest } from "../../security";
import { prepareNativeTaskApproval } from "./native-task-approval-binding";

/** Pure unsigned grant material from the same checked reservation as approval.
 * The coordinator must read these records under its existing locks and retain its
 * commit fence. Plain objects are not provenance. No signing, staging or delivery. */
export function prepareNativeTaskApprovalWithLease(input: Parameters<typeof prepareNativeTaskApproval>[0]) {
  // Capture records once so getters or caller mutation cannot split the two outputs.
  const captured = structuredClone(input);
  const prepared = prepareNativeTaskApproval(captured);
  const job = jobRecordSchema.parse(captured.job), lease = leaseRecordSchema.parse(captured.lease);
  const r = prepared.request;
  const leaseGrant = leaseGrantSchema.parse({
    // Correlation for native direct delivery, not evidence of a separate job offer.
    offerId: `offer:native-task:${sha256Digest({ tenantId: r.tenantId, jobId: r.jobId, attemptId: r.attemptId,
      leaseId: r.leaseId, leaseEpoch: r.leaseEpoch }).slice(7)}`,
    nodeId: r.nodeId, jobId: r.jobId, attemptId: r.attemptId, leaseId: r.leaseId, leaseEpoch: r.leaseEpoch,
    acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt, authorityDigest: r.authorityDigest, authority: job.authority,
  });
  return { ...prepared, leaseGrant };
}
