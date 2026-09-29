import { sha256Digest } from '../../security/canonical-digest';
import { parseWorkspaceIntent, type WorkspaceIntent } from '../../node-bridge/workspace-intent';
import type { SqliteBridgeJournal } from '../../node-bridge/journal';
import { CodingWorkspaceLifecycleHolderV1 } from '../v1/coding-workspace-lifecycle-holder';
import { controllerWorkerDeliverySchemaV1, type ControllerWorkerDeliveryV1 }
  from '../v1/controller-worker-delivery';
import type { CodexWorkspacePreparationV1, CodexLocalStartBindingV1 } from './local-start-runtime';
import type { ObservableGitWorkspacePort } from './git-workspace-port';
import { journaledWorkspacePort } from './journaled-workspace-port';

type WorkspaceJournal = Pick<SqliteBridgeJournal,
  'reserveWorkspaceIntent' | 'recordWorkspaceRoots' | 'recordWorkspaceCreation'
  | 'reserveWorkspaceRemoval' | 'recordWorkspaceRemoved'>;

export type CodexDeliveryBoundWorkspacePolicyV1 = Readonly<{
  allowedPaths: readonly string[];
  maximumChangedFiles: number;
  maximumChangedBytes: number;
}>;

export type CodexDeliveryBoundWorkspacePreparationV1 = CodexWorkspacePreparationV1 & Readonly<{
  bindDelivery(delivery: unknown): void;
}>;

const unavailable = (): never => { throw new Error('codex_delivery_bound_workspace_unavailable'); };

function sameIdentity(delivery: ControllerWorkerDeliveryV1, intent: WorkspaceIntent): boolean {
  const identity = delivery.identity;
  return identity.tenantId === intent.tenantId && identity.nodeId === intent.nodeId
    && identity.projectId === intent.projectId && identity.jobId === intent.jobId
    && identity.attemptId === intent.attemptId && identity.runId === intent.runId;
}

function assertBinding(delivery: ControllerWorkerDeliveryV1, intent: WorkspaceIntent,
  binding: CodexLocalStartBindingV1): void {
  const activation = binding.activation;
  if (!sameIdentity(delivery, intent)
    || activation.workspaceIntentDigest !== sha256Digest(intent)
    || activation.workspacePath !== intent.checkoutPath
    || activation.tenantId !== intent.tenantId || activation.nodeId !== intent.nodeId
    || activation.projectId !== intent.projectId || activation.jobId !== intent.jobId
    || activation.attemptId !== intent.attemptId || activation.runId !== intent.runId
    || activation.leaseId !== intent.leaseId || activation.leaseEpoch !== intent.leaseEpoch
    || activation.prompt !== delivery.input.prompt || activation.instructions !== delivery.input.instructions
    || activation.inputDigest !== delivery.inputDigest
    || activation.connectorProfileDigest !== delivery.connectorProfileDigest) unavailable();
}

function containsScope(container: string, candidate: string): boolean {
  if (!container.endsWith('/**')) return container === candidate;
  const root = container.slice(0, -3);
  const candidateRoot = candidate.endsWith('/**') ? candidate.slice(0, -3) : candidate;
  return candidateRoot === root || candidateRoot.startsWith(`${root}/`);
}

/** Intersects the host's configured ceiling with the signed durable lease
 * scopes. Neither side can widen the other. */
export function effectiveOwnershipLeaseAllowedPathsV1(delivery: ControllerWorkerDeliveryV1,
  configured: readonly string[]): readonly string[] {
  const leased = delivery.writeScopes.map(scope => scope.scopeKind === 'file' ? scope.path
    : scope.path === '' ? undefined : `${scope.path}/**`);
  if (leased.some(scope => scope === undefined)) return configured;
  const result = new Set<string>();
  for (const host of configured) for (const lease of leased) {
    if (!lease) continue;
    if (containsScope(host, lease)) result.add(lease);
    else if (containsScope(lease, host)) result.add(host);
  }
  if (!result.size) unavailable();
  return Object.freeze([...result].sort());
}

/**
 * Binds one shared controller delivery to the existing journaled Codex
 * workspace port and retains the lifecycle holder in this closure. It exposes
 * neither the physical lease nor a cleanup operation: process-session cleanup
 * is not terminal task cleanup and cannot release workspace/task capacity.
 */
export function createCodexDeliveryBoundWorkspacePreparationV1(input: Readonly<{
  workspaceIntent: unknown;
  workspacePort: ObservableGitWorkspacePort;
  journal: WorkspaceJournal;
  policy: CodexDeliveryBoundWorkspacePolicyV1;
}>): CodexDeliveryBoundWorkspacePreparationV1 {
  const intent = parseWorkspaceIntent(structuredClone(input.workspaceIntent));
  const workspacePort: ObservableGitWorkspacePort = Object.freeze({
    inspectRootIdentities: input.workspacePort.inspectRootIdentities.bind(input.workspacePort),
    observeCheckout: input.workspacePort.observeCheckout.bind(input.workspacePort),
    inspectExisting: input.workspacePort.inspectExisting.bind(input.workspacePort),
    createDetachedWorktree: input.workspacePort.createDetachedWorktree.bind(input.workspacePort),
    removeWorktree: input.workspacePort.removeWorktree.bind(input.workspacePort),
  });
  const policy = Object.freeze({ allowedPaths: Object.freeze([...input.policy.allowedPaths]),
    maximumChangedFiles: input.policy.maximumChangedFiles, maximumChangedBytes: input.policy.maximumChangedBytes });
  let delivery: ControllerWorkerDeliveryV1 | undefined;
  let holder: CodingWorkspaceLifecycleHolderV1 | undefined;

  return Object.freeze({
    bindDelivery(value: unknown) {
      if (delivery) unavailable();
      const parsed = controllerWorkerDeliverySchemaV1.parse(value);
      if (!sameIdentity(parsed, intent)) unavailable();
      delivery = parsed;
    },
    async prepare(binding: CodexLocalStartBindingV1, assertCurrent: () => void) {
      if (typeof assertCurrent !== 'function') unavailable();
      const selected = delivery;
      if (selected === undefined) return unavailable();
      const bound: ControllerWorkerDeliveryV1 = selected;
      assertBinding(bound, intent, binding);
      assertCurrent();
      const leaseAllowedPaths = effectiveOwnershipLeaseAllowedPathsV1(bound, policy.allowedPaths);
      holder ??= new CodingWorkspaceLifecycleHolderV1({
        maximumConcurrentWorkspaces: 1,
        allowedPaths: leaseAllowedPaths,
        maximumChangedFiles: policy.maximumChangedFiles,
        maximumChangedBytes: policy.maximumChangedBytes,
        workspacePort: journaledWorkspacePort({ port: workspacePort, journal: input.journal,
          intent, assertCurrent }),
      });
      const observation = await holder.acquire({ delivery: bound, repositoryRoot: intent.repositoryRoot,
        workspaceRoot: intent.workspaceRoot, revision: intent.revision });
      const auditPlan = observation.auditPlan;
      // Authority may have changed while the physical workspace was acquired.
      // Recheck before accepting it and before the start runtime can open its
      // separately owned process session.
      assertCurrent();
      if (observation.disposition !== 'workspace_held' || observation.reconciliationRequired
        || !observation.workspaceCapacityHeld || observation.runId !== intent.runId
        || observation.deliveryDigest !== bound.deliveryDigest
        || !auditPlan || auditPlan.deliveryDigest !== bound.deliveryDigest
        || auditPlan.baseRevision !== intent.revision
        || auditPlan.allowedPaths.length !== leaseAllowedPaths.length
        || auditPlan.allowedPaths.some((path, index) => path !== leaseAllowedPaths[index])
        || observation.startsAdapter || observation.releasesCapacity) unavailable();
    },
  });
}
