import { sha256Digest } from '../../security/canonical-digest';
import { verifyArtifactSignature } from '../../node-policy/v1/crypto';
import { resolvePinnedApprovalKey, type PinnedApprovalTrustStore } from '../../node-policy/v1/pinned-approval-trust';
import type { SqliteNodeSecurityStateRepository } from '../../node-policy/v1/persistent-security-state';
import { codexTaskDispatchBodySchemaV1 } from './delivery-contract';

/** Verifies one signed owner permit from an authenticated Codex delivery.
 * It never signs, dispatches, launches App Server or grants execution authority.
 */
export function createCodexApprovalIntakeV1(config: { body: unknown; expectedEnrollmentDigest: string;
  expectedConnectorProfileDigest: string; expectedWorkspaceIntentDigest: string }, dependencies: {
  approvals: PinnedApprovalTrustStore;
  security: Pick<SqliteNodeSecurityStateRepository, 'currentServerTrustRevision'>;
  clock?: () => number;
}) {
  const body = codexTaskDispatchBodySchemaV1.parse(config.body), start = body.start, request = body.request;
  if (start.enrollmentDigest !== config.expectedEnrollmentDigest
    || start.connectorProfileDigest !== config.expectedConnectorProfileDigest
    || start.workspaceIntentDigest !== config.expectedWorkspaceIntentDigest) throw new Error('codex_approval_intake_invalid');
  const scope = { tenantId: request.tenantId, nodeId: request.nodeId, nodeClass: request.nodeClass };
  if (sha256Digest(scope) !== sha256Digest(dependencies.approvals.binding())) throw new Error('codex_approval_intake_invalid');
  const revision = dependencies.security.currentServerTrustRevision.bind(dependencies.security);
  const clock = dependencies.clock ?? Date.now;
  let highWater = -1;
  const currentTime = () => {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < highWater || now >= start.deadline) {
      throw new Error('codex_approval_intake_unavailable');
    }
    highWater = now; return now;
  };
  return async (signal: AbortSignal) => {
    const unavailable = (): never => { throw new Error('codex_approval_intake_unavailable'); };
    try {
      if (!(signal instanceof AbortSignal) || signal.aborted) return unavailable();
      const now = currentTime(), permit = body.permit, approval = permit.body;
      if (Date.parse(approval.issuedAt) > now || Date.parse(approval.expiresAt) < start.deadline) return unavailable();
      const before = revision();
      const key = await resolvePinnedApprovalKey(dependencies.approvals, scope, approval.approvalKeyId);
      if (signal.aborted || !key || !verifyArtifactSignature(permit, key.publicKeySpki)) return unavailable();
      const assertFresh = () => {
        try {
          currentTime(); dependencies.approvals.assertAvailable();
          if (revision() !== before) return unavailable();
        } catch { return unavailable(); }
      };
      assertFresh();
      return Object.freeze({ body: structuredClone(body),
        request: Object.freeze({ ...structuredClone(request), approval: structuredClone(body.permit) }),
        deliveryBodyDigest: sha256Digest(body),
        permitDigest: body.permitDigest, enrollmentDigest: start.enrollmentDigest,
        connectorProfileDigest: start.connectorProfileDigest, workspaceIntentDigest: start.workspaceIntentDigest,
        assertFresh, startsWork: false as const, grantsExecutionAuthority: false as const,
        permitsRetry: false as const, permitsResume: false as const });
    } catch { return unavailable(); }
  };
}
