import { nativeTaskApprovalPacketSchema } from "../../harness/v1/native-approval-packet";
import { sha256Digest } from "../../security";
import { taskApprovalSavedSchema } from "./task-approval-wire";
import type { NativeOwnerReviewTarget } from "../../harness/v1/native-owner-review-session";

export { createNativeOwnerReviewSession } from "../../harness/v1/native-owner-review-session";

/** Same canonical intake receipt contract as the existing protected application.
 * Parsing a supplied receipt is not transport authentication or proof of a DB write. */
export function verifyPrivateOwnerStoredReceipt(target: NativeOwnerReviewTarget, packet: unknown, receipt: unknown) {
  const value = nativeTaskApprovalPacketSchema.parse(packet);
  const saved = taskApprovalSavedSchema.parse({ ...target, receipt });
  if (saved.receipt.projectId !== target.projectId || saved.receipt.jobId !== target.jobId
    || saved.receipt.attemptId !== value.approval.body.attemptId
    || saved.receipt.operationDigest !== value.approval.body.operationDigest
    || saved.receipt.packetDigest !== sha256Digest(value)) throw new Error("private_owner_receipt_invalid");
  return Object.freeze(saved.receipt);
}
