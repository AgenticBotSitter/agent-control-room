import { z } from "zod";
import { sha256Digest } from "../../security";
import type { SqliteNodeSecurityStateRepository } from "../../node-policy/v1/persistent-security-state";
import { resolvePinnedApprovalKey, type PinnedApprovalTrustStore } from "../../node-policy/v1/pinned-approval-trust";
import { enrollmentSchema, localId, type NativeEnrollment } from "./contracts";
import type { NativeRecoveryCurrent } from "./recovery-authority";

const localStateSchema = z.object({ credentialRef: localId, credentialAvailable: z.boolean(),
  recoveryAllowed: z.boolean(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export type NativeLocalRecoveryState = z.infer<typeof localStateSchema>;

/** Resolve public owner trust without requiring a still-live work lease or ceiling. Opens nothing.
 * Local state is a trusted synchronous node service, never browser/worker-reported permission.
 */
export function createNativeCurrentRecoveryPolicy(config: { enrollment: unknown; nodeClass: string; approvalKeyId: string }, deps: {
  security: Pick<SqliteNodeSecurityStateRepository, "currentServerTrustRevision">;
  approvals: PinnedApprovalTrustStore;
  readLocalState: (enrollment: Readonly<NativeEnrollment>) => NativeLocalRecoveryState;
}): (signal: AbortSignal) => Promise<NativeRecoveryCurrent> {
  const enrollment = Object.freeze(enrollmentSchema.parse(config.enrollment)), keyId = localId.parse(config.approvalKeyId);
  const scope = { tenantId: enrollment.tenantId, nodeId: enrollment.nodeId, nodeClass: config.nodeClass };
  const binding = deps.approvals.binding();
  if (!scope.nodeClass || sha256Digest(binding) !== sha256Digest(scope)) throw new Error("native_current_recovery_invalid");
  const approvals = deps.approvals, revision = deps.security.currentServerTrustRevision.bind(deps.security), read = deps.readLocalState.bind(deps);
  let highWater = -1, lastLocalDigest: string | undefined;
  const snapshot = () => {
    const local = localStateSchema.parse(read(enrollment));
    const digest = sha256Digest(local);
    if (local.credentialRef !== enrollment.credentialRef || local.revision < highWater
      || (local.revision === highWater && digest !== lastLocalDigest)) throw new Error();
    highWater = local.revision; lastLocalDigest = digest;
    return { local, trustRevision: revision() };
  };
  return async signal => {
    const unavailable = () => { throw new Error("native_current_recovery_unavailable"); };
    try {
      if (signal.aborted) return unavailable();
      const before = snapshot(), stamp = sha256Digest(before);
      const approvalKey = await resolvePinnedApprovalKey(approvals, scope, keyId);
      if (signal.aborted || !approvalKey) return unavailable();
      const assertFresh = () => {
        try { approvals.assertAvailable(); if (sha256Digest(snapshot()) !== stamp) return unavailable(); }
        catch { return unavailable(); }
      };
      assertFresh();
      return { approvalKey, credentialAvailable: before.local.credentialAvailable,
        recoveryAllowed: before.local.recoveryAllowed, assertFresh };
    } catch { return unavailable(); }
  };
}
