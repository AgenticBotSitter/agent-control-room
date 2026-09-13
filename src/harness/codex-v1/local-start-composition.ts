import type { SqliteBridgeJournal } from '../../node-bridge/journal';
import { sha256Digest } from '../../security/canonical-digest';
import { createCodexStartAdmissionV1 } from './admission-contract';
import { journaledWorkspacePort } from './journaled-workspace-port';
import { createCodexLocalStartRuntimeV1, type CodexLocalStartAuthorityV1,
  type CodexLocalStartBindingV1 } from './local-start-runtime';
import type { CodexOwnedStartV1 } from './owned-start';
import type { SqliteCodexStartJournalV1 } from './start-journal';
import type { ObservableGitWorkspacePort } from './git-workspace-port';
import { CodexWorkspaceManagerV1 } from './workspace';
import { parseWorkspaceIntent } from '../../node-bridge/workspace-intent';

type BridgeStartJournal = Pick<SqliteBridgeJournal,
  'acceptedCodexActivation' | 'reserveWorkspaceIntent' | 'recordWorkspaceRoots' | 'recordWorkspaceCreation'
  | 'reserveWorkspaceRemoval' | 'recordWorkspaceRemoved'>;
type StartJournal = Pick<SqliteCodexStartJournalV1, 'reserveStart' | 'recordThread' | 'recordTurn'>;

const unavailable = (): never => { throw new Error('codex_local_start_composition_unavailable'); };

function assertWorkspaceBinding(binding: CodexLocalStartBindingV1,
  intent: ReturnType<typeof parseWorkspaceIntent>): void {
  const activation = binding.activation;
  if (activation.workspaceIntentDigest !== sha256Digest(intent)
    || activation.workspacePath !== intent.checkoutPath
    || activation.tenantId !== intent.tenantId
    || activation.nodeId !== intent.nodeId
    || activation.projectId !== intent.projectId
    || activation.jobId !== intent.jobId
    || activation.attemptId !== intent.attemptId
    || activation.runId !== intent.runId
    || activation.leaseId !== intent.leaseId
    || activation.leaseEpoch !== intent.leaseEpoch) unavailable();
}

/**
 * Trusted, inert host composition for one already-delivered Codex task. It
 * connects the protected activation record, no-replay start journal, exact
 * workspace intent and owned App Server start. Construction performs no I/O;
 * start remains an explicit one-shot call and no native implementation is
 * supplied by default.
 */
export function createCodexLocalStartCompositionV1(input: {
  queueId: string;
  connectionAttemptId: string;
  initializedConnectionDigest: string;
  threadStartRequestId: number;
  turnStartRequestId: number;
  workspaceIntent: unknown;
  bridgeJournal: BridgeStartJournal;
  startJournal: StartJournal;
  workspacePort: ObservableGitWorkspacePort;
  authority: CodexLocalStartAuthorityV1;
  ownedStart: CodexOwnedStartV1;
  clock: () => number;
}) {
  const intent = parseWorkspaceIntent(structuredClone(input.workspaceIntent));
  const bridge = {
    acceptedCodexActivation: input.bridgeJournal.acceptedCodexActivation.bind(input.bridgeJournal),
    reserveWorkspaceIntent: input.bridgeJournal.reserveWorkspaceIntent.bind(input.bridgeJournal),
    recordWorkspaceRoots: input.bridgeJournal.recordWorkspaceRoots.bind(input.bridgeJournal),
    recordWorkspaceCreation: input.bridgeJournal.recordWorkspaceCreation.bind(input.bridgeJournal),
    reserveWorkspaceRemoval: input.bridgeJournal.reserveWorkspaceRemoval.bind(input.bridgeJournal),
    recordWorkspaceRemoved: input.bridgeJournal.recordWorkspaceRemoved.bind(input.bridgeJournal),
  };
  const starts = {
    reserveStart: input.startJournal.reserveStart.bind(input.startJournal),
    recordThread: input.startJournal.recordThread.bind(input.startJournal),
    recordTurn: input.startJournal.recordTurn.bind(input.startJournal),
  };
  const workspacePort: ObservableGitWorkspacePort = Object.freeze({
    inspectRootIdentities: input.workspacePort.inspectRootIdentities.bind(input.workspacePort),
    observeCheckout: input.workspacePort.observeCheckout.bind(input.workspacePort),
    inspectExisting: input.workspacePort.inspectExisting.bind(input.workspacePort),
    createDetachedWorktree: input.workspacePort.createDetachedWorktree.bind(input.workspacePort),
    removeWorktree: input.workspacePort.removeWorktree.bind(input.workspacePort),
  });
  const ownedStart: CodexOwnedStartV1 = Object.freeze({
    startThread: input.ownedStart.startThread.bind(input.ownedStart),
    startTurn: input.ownedStart.startTurn.bind(input.ownedStart),
    close: input.ownedStart.close.bind(input.ownedStart),
  });
  const authority = Object.freeze({
    currentAdmissionDigest: input.authority.currentAdmissionDigest.bind(input.authority),
    assertCurrent: input.authority.assertCurrent.bind(input.authority),
  });

  return createCodexLocalStartRuntimeV1({
    queueId: input.queueId,
    connectionAttemptId: input.connectionAttemptId,
    initializedConnectionDigest: input.initializedConnectionDigest,
    threadStartRequestId: input.threadStartRequestId,
    turnStartRequestId: input.turnStartRequestId,
    activationEvidence: bridge,
    authority,
    reservation: { reserveExactStart: starts.reserveStart },
    receipts: { recordThread: starts.recordThread, recordTurn: starts.recordTurn },
    workspace: { async prepare(binding, assertCurrent) {
      assertWorkspaceBinding(binding, intent);
      const port = journaledWorkspacePort({ port: workspacePort, journal: bridge, intent, assertCurrent });
      const manager = new CodexWorkspaceManagerV1(port);
      const lease = await manager.prepare({ runId: intent.runId, repositoryRoot: intent.repositoryRoot,
        workspaceRoot: intent.workspaceRoot, revision: intent.revision });
      assertCurrent();
      if (lease.checkoutPath !== binding.activation.workspacePath || lease.runId !== binding.activation.runId
        || lease.revision !== intent.revision) unavailable();
    } },
    ownedStart,
    admissionFactory: { create: binding => {
      assertWorkspaceBinding(binding, intent);
      return createCodexStartAdmissionV1({
        schema: 'control-room.codex-start-admission/v1',
        scope: { tenantId: binding.activation.tenantId, nodeId: binding.activation.nodeId,
          projectId: binding.activation.projectId, jobId: binding.activation.jobId,
          attemptId: binding.activation.attemptId, runId: binding.activation.runId,
          leaseId: binding.activation.leaseId, leaseEpoch: binding.activation.leaseEpoch,
          operationDigest: binding.activation.operationDigest },
        queueId: binding.queueId, requestMessageId: binding.activationMessageId,
        activationMessageId: binding.activationMessageId, activationId: binding.activationId,
        activationDigest: binding.activationDigest, activationFrameDigest: binding.activationFrameDigest,
        dispatchMessageId: binding.dispatchMessageId, dispatchFrameDigest: binding.dispatchFrameDigest,
        receiptMessageId: binding.receiptMessageId, receiptFrameDigest: binding.receiptFrameDigest,
        workspacePath: binding.activation.workspacePath, deliveryDigest: binding.dispatchFrameDigest,
        enrollmentDigest: binding.activation.enrollmentDigest, permitDigest: binding.activation.permitDigest,
        currentAdmissionDigest: binding.currentAdmissionDigest, inputDigest: binding.activation.inputDigest,
        method: 'thread/start', connectionAttemptId: binding.connectionAttemptId,
        initializedConnectionDigest: binding.initializedConnectionDigest,
        threadStartRequestId: binding.threadStartRequestId, requestedAt: binding.requestedAt,
        deadline: binding.deadline,
      });
    } },
    clock: input.clock.bind(input),
  });
}
