import { executorCapabilitySchema, keyAvailabilitySchema, normalizedLocalPolicyRequestSchema, signedNodeAuthorityCeilingSchema } from "../../node-policy/v1/schemas";
import type { SqliteNodeSecurityStateRepository } from "../../node-policy/v1/persistent-security-state";
import { resolvePinnedApprovalKey, type PinnedApprovalTrustStore } from "../../node-policy/v1/pinned-approval-trust";
import type { NodePrivateKeyStore } from "../../node-policy/v1/stores";
import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import type { SqliteEffectClaimStore } from "../../node-policy/v1/effect-claim-store";
import type { VerifiedLeaseAuthorityV1 } from "../../node-policy/v1/types";
import { createNativeLeaseEvidence } from "./lease-evidence";
import type { NativeCurrentPolicy } from "./start-authority";
import { sha256Digest } from "../../security";

/** Compose already-open verified stores for one exact task. No native key unlock/sign, setup,
 * listener or default pause/profile evidence. The enclosing start controller owns time/concurrency.
 */
export function createNativeCurrentPolicy(config: { request: unknown; executor: unknown; nodeClass: string;
  leaseMessageId: string; serverActorId: string; nodeSigningKeyReferenceId: string;
  parentAuthorities: VerifiedLeaseAuthorityV1["parentAuthorities"] }, deps: {
  security: Pick<SqliteNodeSecurityStateRepository, "loadCeiling" | "resolveServerKey" | "currentPolicyRevision">;
  approvals: PinnedApprovalTrustStore;
  journal: Pick<SqliteBridgeJournal, "acceptedCommand" | "attemptSummary" | "nodeControlState">;
  effects: Pick<SqliteEffectClaimStore, "countActive">;
  keys: Pick<NodePrivateKeyStore, "availability">;
  /** Trusted local emergency-pause source, never a request field or default false. */
  localPaused: () => boolean;
  clock?: () => number;
}): (signal: AbortSignal) => Promise<NativeCurrentPolicy> {
  const request = normalizedLocalPolicyRequestSchema.parse(config.request), executor = executorCapabilitySchema.parse(config.executor);
  const scope = { tenantId: request.tenantId, nodeId: request.nodeId, nodeClass: config.nodeClass };
  const signingReference = config.nodeSigningKeyReferenceId, keyId = request.approval?.body.approvalKeyId;
  if (!keyId || !scope.nodeClass || !signingReference || executor.executorId !== request.executorId) throw new Error("native_current_policy_invalid");
  const approvalBinding = deps.approvals.binding();
  if (approvalBinding.tenantId !== scope.tenantId || approvalBinding.nodeId !== scope.nodeId || approvalBinding.nodeClass !== scope.nodeClass) throw new Error("native_current_policy_invalid");
  const readLease = createNativeLeaseEvidence({ request, messageId: config.leaseMessageId, serverActorId: config.serverActorId,
    parentAuthorities: config.parentAuthorities }, { journal: deps.journal, trust: deps.security, clock: deps.clock });
  const ceiling = deps.security.loadCeiling.bind(deps.security), keys = deps.keys.availability.bind(deps.keys),
    node = deps.journal.nodeControlState.bind(deps.journal), count = deps.effects.countActive.bind(deps.effects), paused = deps.localPaused.bind(deps);
  const approvals = deps.approvals;
  const revision = deps.security.currentPolicyRevision.bind(deps.security);
  const receipt = deps.journal.acceptedCommand.bind(deps.journal), attempt = deps.journal.attemptSummary.bind(deps.journal);
  const messageId = config.leaseMessageId;
  const stamp = () => sha256Digest({ revision: revision(), receipt: receipt(messageId), attempt: attempt(request.attemptId),
    control: node(scope.nodeId) ?? null, active: count(scope.tenantId, scope.nodeId), paused: paused() });
  return async signal => {
    const check = () => { if (signal.aborted) throw new Error("native_current_policy_unavailable"); };
    try {
      check(); const before = stamp();
      const owner = signedNodeAuthorityCeilingSchema.parse(await ceiling()).body; check();
      if (owner.tenantId !== scope.tenantId || owner.nodeId !== scope.nodeId) throw new Error();
      const lease = await readLease(signal); check();
      const keyAvailability = keyAvailabilitySchema.parse(await keys()); check();
      if (keyAvailability.keyReferenceId !== signingReference) throw new Error();
      const approvalKey = await resolvePinnedApprovalKey(approvals, scope, keyId); check();
      if (!approvalKey) throw new Error();
      const localPaused = paused(); if (typeof localPaused !== "boolean") throw new Error();
      const control = node(scope.nodeId), activeExternalEffects = count(scope.tenantId, scope.nodeId); check();
      const assertFresh = () => { approvals.assertAvailable(); if (stamp() !== before) throw new Error("native_current_policy_unavailable"); };
      assertFresh();
      return { assertFresh, ceiling: owner, lease, executor: structuredClone(executor), keyAvailability, approvalKey,
        activeExternalEffects, paused: localPaused || !control || control.nodeId !== scope.nodeId || control.state !== "active" };
    } catch { throw new Error("native_current_policy_unavailable"); }
  };
}
