import { z } from "zod";
import { sha256Digest } from "../../security";
import { computeArtifactBodyDigest } from "../../node-policy/v1/crypto";
import { normalizedLocalPolicyRequestSchema, ownerApprovalAttestationBodySchema } from "../../node-policy/v1/schemas";
import { enrollmentSchema, startSchema } from "./native-run-contracts";
import { verifyNativeTaskApprovalBinding } from "./native-task-approval-binding";
import { nativeRecoveryPermissionBodySchema } from "./native-approval-packet";
import { localId } from "./native-run-identifiers";

/** Unsigned material for a separately authorized owner signer. Caller must establish
 * canonical preparation provenance and owner consent; parsing proves neither.
 * No key access, signature, transport, persistence or execution occurs here.
 */
export function prepareNativeOwnerApprovalMaterial(input: {
  enrollment: unknown; request: unknown; start: unknown;
  approvalKeyId: string; issuedAt: number; recoveryExpiresAt: number;
  approvalNonce: string; recoveryNonce: string;
}) {
  try {
    const enrollment = enrollmentSchema.parse(input.enrollment);
    const request = normalizedLocalPolicyRequestSchema.parse(input.request), start = startSchema.parse(input.start);
    if (request.approval) throw new Error();
    const { binding } = verifyNativeTaskApprovalBinding(enrollment, request, start);
    const key = localId.parse(input.approvalKeyId);
    const instant = z.number().int().nonnegative().max(8_640_000_000_000_000);
    const now = instant.parse(input.issuedAt), recoveryExpiresAt = instant.parse(input.recoveryExpiresAt);
    if (now < Date.parse(request.occurredAt) || now >= start.deadline
      || start.deadline >= recoveryExpiresAt || recoveryExpiresAt > Math.min(enrollment.validUntil, start.deadline + 300_000)) throw new Error();
    const approval = { schema: "control-room.owner-approval-attestation/v1" as const,
      tenantId: request.tenantId, nodeId: request.nodeId, projectId: request.projectId,
      jobId: request.jobId, attemptId: request.attemptId, operationDigest: request.operationDigest,
      risk: request.risk, decision: "approved" as const, issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(start.deadline).toISOString(), nonce: input.approvalNonce, approvalKeyId: key };
    const recovery = { schema: "control-room.native-run-recovery-permission/v1" as const,
      bindingDigest: sha256Digest(binding), approvalKeyId: key, issuedAt: now, expiresAt: recoveryExpiresAt,
      operations: ["status", "stop"] as ["status", "stop"], nonce: input.recoveryNonce };
    return {
      approval: ownerApprovalAttestationBodySchema.parse({ ...approval, bodyDigest: computeArtifactBodyDigest(approval) }),
      recovery: nativeRecoveryPermissionBodySchema.parse({ ...recovery, bodyDigest: computeArtifactBodyDigest(recovery) }),
      signatureStatus: "unsigned" as const, startsWork: false as const, grantsExecutionAuthority: false as const,
    };
  } catch { throw new Error("native_owner_approval_material_invalid"); }
}
