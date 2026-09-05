import { sha256Digest } from "../../security";
import { normalizedLocalPolicyRequestSchema } from "../../node-policy/v1/schemas";
import { verifyArtifactSignature } from "../../node-policy/v1/crypto";
import { resolvePinnedApprovalKey, type PinnedApprovalTrustStore } from "../../node-policy/v1/pinned-approval-trust";
import type { SqliteNodeSecurityStateRepository } from "../../node-policy/v1/persistent-security-state";
import { enrollmentSchema, startSchema } from "./native-run-contracts";
import { verifyNativeTaskApprovalBinding } from "./native-task-approval-binding";
import { nativeTaskApprovalPacketSchema as packetSchema } from "./native-approval-packet";
export { type NativeTaskApprovalPacket } from "./native-approval-packet";

/** Intake for one trusted prepared reservation. Verifies owner signatures, never signs or dispatches.
 * Canonical reservation provenance/currentness and execution policy remain controller responsibilities.
 */
export function createNativeApprovalIntake(config: { enrollment: unknown; request: unknown; start: unknown }, deps: {
  approvals: PinnedApprovalTrustStore;
  security: Pick<SqliteNodeSecurityStateRepository, "currentServerTrustRevision">;
  clock?: () => number;
}) {
  const enrollment = enrollmentSchema.parse(config.enrollment), request = normalizedLocalPolicyRequestSchema.parse(config.request), start = startSchema.parse(config.start);
  if (request.approval) throw new Error("native_approval_intake_invalid");
  const { binding } = verifyNativeTaskApprovalBinding(enrollment, request, start);
  const scope = { tenantId: request.tenantId, nodeId: request.nodeId, nodeClass: request.nodeClass };
  if (sha256Digest(scope) !== sha256Digest(deps.approvals.binding())) throw new Error("native_approval_intake_invalid");
  const approvals = deps.approvals, revision = deps.security.currentServerTrustRevision.bind(deps.security), clock = deps.clock ?? Date.now;
  let highWater = -1;
  const time = () => {
    const now = clock(); if (!Number.isSafeInteger(now) || now < 0 || now < highWater) throw new Error();
    highWater = now; if (now >= Math.min(start.deadline, enrollment.validUntil)) throw new Error(); return now;
  };
  return async (value: unknown, signal: AbortSignal) => {
    const unavailable = () => { throw new Error("native_approval_intake_unavailable"); };
    try {
      if (signal.aborted) return unavailable();
      const packet = packetSchema.parse(value), a = packet.approval.body, r = packet.recovery.body, now = time();
      if (a.tenantId !== request.tenantId || a.nodeId !== request.nodeId || a.projectId !== request.projectId
        || a.jobId !== request.jobId || a.attemptId !== request.attemptId || a.operationDigest !== request.operationDigest
        || a.decision !== "approved" || a.risk !== request.risk || Date.parse(a.issuedAt) > now
        || Date.parse(a.issuedAt) >= Date.parse(a.expiresAt) || Date.parse(a.expiresAt) < start.deadline
        || r.bindingDigest !== sha256Digest(binding) || r.issuedAt > now || r.issuedAt >= start.deadline
        || r.expiresAt <= start.deadline || r.expiresAt > Math.min(enrollment.validUntil, start.deadline + 300_000)) return unavailable();
      const before = revision();
      const [startKey, recoveryKey] = await Promise.all([
        resolvePinnedApprovalKey(approvals, scope, a.approvalKeyId), resolvePinnedApprovalKey(approvals, scope, r.approvalKeyId),
      ]);
      if (signal.aborted || !startKey || !recoveryKey || !verifyArtifactSignature(packet.approval, startKey.publicKeySpki)
        || !verifyArtifactSignature(packet.recovery, recoveryKey.publicKeySpki)) return unavailable();
      const assertFresh = () => {
        try { time(); approvals.assertAvailable(); if (revision() !== before) return unavailable(); } catch { return unavailable(); }
      };
      assertFresh();
      return { enrollment: structuredClone(enrollment), request: { ...structuredClone(request), approval: packet.approval },
        start: structuredClone(start), binding: structuredClone(binding), recoveryPermission: packet.recovery,
        packetDigest: sha256Digest(packet), assertFresh, startsWork: false as const, grantsExecutionAuthority: false as const };
    } catch { return unavailable(); }
  };
}
