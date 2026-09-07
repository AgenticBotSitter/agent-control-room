import { sha256Digest } from "../../security";
import { enrollmentSchema, startSchema } from "./native-run-contracts";
import { normalizedLocalPolicyRequestSchema } from "../../node-policy/v1/schemas";
import { verifyNativeTaskApprovalBinding } from "./native-task-approval-binding";

/** Shared human review of bound task material, not proof of provenance or consent.
 * Deliberately excludes enrollment internals and credential/destination references.
 */
export function describeNativeOwnerReview(input: { enrollment: unknown; request: unknown; start: unknown }) {
  const enrollment = enrollmentSchema.parse(input.enrollment);
  const request = normalizedLocalPolicyRequestSchema.parse(input.request), start = startSchema.parse(input.start);
  if (request.approval) throw new Error("owner_review_already_signed");
  verifyNativeTaskApprovalBinding(enrollment, request, start);
  return Object.freeze({ projectId: start.projectId, jobId: start.jobId,
    inputDigest: sha256Digest({ prompt: start.prompt, instructions: start.instructions }),
    attemptId: start.attemptId, nodeId: start.nodeId, prompt: start.prompt, instructions: start.instructions,
    model: enrollment.model, provider: enrollment.provider, durationSeconds: request.estimatedDurationSeconds,
    deadline: new Date(start.deadline).toISOString(), operationDigest: request.operationDigest,
    signatureStatus: "unsigned" as const, startsWork: false as const, grantsExecutionAuthority: false as const });
}
