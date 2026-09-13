import { sha256Digest } from '../../security/canonical-digest';
import { assertSynchronousFence } from '../../security/synchronous-fence';
import { digestSchema, localId } from '../v1/native-run-identifiers';
import { createCodexStartResponseDispatcherV1, createCodexTurnStartIntentV1,
  verifyCodexStartAdmissionV1,
  type CodexStartAdmissionV1, type CodexThreadStartReceiptV1,
  type CodexTurnStartReceiptV1 } from './admission-contract';
import { parseCodexTaskActivationV1, type CodexActivationFrameV1,
  type CodexTaskActivationBodyV1 } from './activation-contract';
import type { CodexOwnedStartV1 } from './owned-start';

export interface CodexLocalStartAuthorityV1 {
  currentAdmissionDigest(queueId: string): string;
  assertCurrent(queueId: string): void;
}

/** A node-private lookup of already-verified activation evidence. It is not an
 * upstream read, resume, retry or execution interface. */
export interface CodexActivationEvidenceSourceV1 {
  acceptedCodexActivation(queueId: string): Readonly<{ frame: CodexActivationFrameV1; receivedAt: string }> | undefined;
}

/** Durable implementations consume this exact identity before an effect. The
 * runtime will never call it a second time after any error or close. */
export interface CodexOneShotStartReservationV1 {
  reserveExactStart(admission: CodexStartAdmissionV1, reservedAt: string,
    assertCurrent: () => void): 'recorded' | 'duplicate' | Promise<'recorded' | 'duplicate'>;
}

export interface CodexStartReceiptJournalV1 {
  recordThread(value: unknown, assertCurrent: () => void): 'recorded' | 'duplicate' | Promise<'recorded' | 'duplicate'>;
  recordTurn(threadValue: unknown, turnValue: unknown, assertCurrent: () => void): 'recorded' | 'duplicate' | Promise<'recorded' | 'duplicate'>;
}

/** The workspace boundary owns physical paths. It receives binding evidence,
 * never an arbitrary path or prompt, and must check just before its own effect. */
export interface CodexWorkspacePreparationV1 {
  prepare(binding: CodexLocalStartBindingV1, assertCurrent: () => void): Promise<void>;
}

/** This makes every field that a durable start reservation and the updated
 * admission contract must bind explicit. The contract implementation lives
 * separately so it can evolve without giving this runtime a general request API. */
export interface CodexLocalStartBindingV1 {
  queueId: string;
  activation: CodexTaskActivationBodyV1;
  activationFrame: CodexActivationFrameV1;
  activationFrameDigest: string;
  activationMessageId: string;
  activationId: string;
  activationDigest: string;
  dispatchMessageId: string;
  dispatchFrameDigest: string;
  dispatchBodyDigest: string;
  receiptMessageId: string;
  receiptFrameDigest: string;
  receiptBodyDigest: string;
  currentAdmissionDigest: string;
  connectionAttemptId: string;
  initializedConnectionDigest: string;
  threadStartRequestId: number;
  turnStartRequestId: number;
  requestedAt: string;
  deadline: string;
}

/** Root owns the corresponding versioned admission schema. This factory is
 * passed all activation facts so a caller cannot silently substitute a looser
 * old admission while retaining the new start runtime. */
export interface CodexBoundAdmissionFactoryV1 {
  create(binding: CodexLocalStartBindingV1): CodexStartAdmissionV1;
}

export interface CodexLocalStartRuntimeV1 {
  start(): Promise<Readonly<{
    activation: CodexTaskActivationBodyV1;
    admission: CodexStartAdmissionV1;
    thread: CodexThreadStartReceiptV1;
    turn: CodexTurnStartReceiptV1;
    grantsExecutionAuthority: false;
    permitsRetry: false;
    permitsResume: false;
    permitsThreadRead: false;
  }>>;
  close(): Promise<void>;
}

const unavailable = (): never => { throw new Error('codex_local_start_unavailable'); };
const assertSynchronous = (check: () => unknown) => assertSynchronousFence(check, unavailable);

/**
 * Fixed, asynchronous start sequence: durable reservation, workspace
 * preparation, thread/start receipt, then turn/start receipt. The owned start
 * transport is closed on every exit. There is no retry, resume or read method.
 */
export function createCodexLocalStartRuntimeV1(input: {
  queueId: string;
  connectionAttemptId: string;
  initializedConnectionDigest: string;
  threadStartRequestId: number;
  turnStartRequestId: number;
  activationEvidence: CodexActivationEvidenceSourceV1;
  authority: CodexLocalStartAuthorityV1;
  reservation: CodexOneShotStartReservationV1;
  workspace: CodexWorkspacePreparationV1;
  ownedStart: CodexOwnedStartV1;
  receipts: CodexStartReceiptJournalV1;
  admissionFactory: CodexBoundAdmissionFactoryV1;
  clock: () => number;
}): CodexLocalStartRuntimeV1 {
  const queueId = localId.parse(input.queueId);
  const connectionAttemptId = localId.parse(input.connectionAttemptId);
  const initializedConnectionDigest = digestSchema.parse(input.initializedConnectionDigest);
  if (!Number.isSafeInteger(input.threadStartRequestId) || input.threadStartRequestId < 1
    || !Number.isSafeInteger(input.turnStartRequestId) || input.turnStartRequestId < 1
    || input.threadStartRequestId === input.turnStartRequestId) unavailable();
  let state: 'ready' | 'starting' | 'complete' | 'closed' = 'ready';
  let highWater = -1;
  const now = () => {
    const value = input.clock();
    if (!Number.isSafeInteger(value) || value < highWater) unavailable();
    highWater = value; return value;
  };
  const assertCurrent = (activation: CodexTaskActivationBodyV1, deadline: string) => {
    const at = now();
    if (at < Date.parse(activation.activatedAt) || at >= Date.parse(deadline)) unavailable();
    assertSynchronous(() => input.authority.assertCurrent(queueId));
    if (digestSchema.parse(input.authority.currentAdmissionDigest(queueId)) !== activation.currentAdmissionDigest) unavailable();
  };
  const close = async () => {
    if (state !== 'closed') state = 'closed';
    try { await input.ownedStart.close(); } catch { unavailable(); }
  };

  return Object.freeze({
    close,
    async start() {
      if (state !== 'ready') unavailable();
      state = 'starting';
      try {
        const saved = input.activationEvidence.acceptedCodexActivation(queueId);
        if (!saved) unavailable();
        const frame = saved.frame, activation = parseCodexTaskActivationV1(frame.body);
        if (frame.type !== 'harness.codex.dispatch.activation' || frame.direction !== 'server_to_node'
          || frame.senderKind !== 'control_room' || frame.connectionId !== activation.connectionId
          || activation.queueId !== queueId || Date.parse(saved.receivedAt) < Date.parse(activation.activatedAt)
          || activation.startsWork || !activation.authorizesExactStart || activation.grantsExecutionAuthority
          || activation.permitsRetry || activation.permitsResume || activation.permitsThreadRead) unavailable();
        const binding: CodexLocalStartBindingV1 = Object.freeze({
          queueId, activation, activationFrame: frame, activationFrameDigest: sha256Digest(frame),
          activationMessageId: frame.messageId, activationId: activation.activationId,
          activationDigest: activation.activationDigest, dispatchMessageId: activation.dispatchMessageId,
          dispatchFrameDigest: activation.dispatchFrameDigest, dispatchBodyDigest: activation.dispatchBodyDigest,
          receiptMessageId: activation.receiptMessageId, receiptFrameDigest: activation.receiptFrameDigest,
          receiptBodyDigest: activation.receiptBodyDigest, currentAdmissionDigest: activation.currentAdmissionDigest,
          connectionAttemptId, initializedConnectionDigest, threadStartRequestId: input.threadStartRequestId,
          turnStartRequestId: input.turnStartRequestId, requestedAt: new Date(now()).toISOString(), deadline: frame.expiresAt,
        });
        assertCurrent(activation, binding.deadline);
        const admission = verifyCodexStartAdmissionV1(input.admissionFactory.create(binding));
        const scope = admission.scope;
        if (admission.queueId !== binding.queueId || admission.requestMessageId !== binding.activationMessageId
          || admission.activationMessageId !== binding.activationMessageId
          || admission.activationId !== binding.activationId || admission.activationDigest !== binding.activationDigest
          || admission.activationFrameDigest !== binding.activationFrameDigest
          || admission.dispatchMessageId !== binding.dispatchMessageId
          || admission.dispatchFrameDigest !== binding.dispatchFrameDigest
          || admission.receiptMessageId !== binding.receiptMessageId
          || admission.receiptFrameDigest !== binding.receiptFrameDigest
          || admission.workspacePath !== activation.workspacePath
          || admission.deliveryDigest !== binding.dispatchFrameDigest
          || admission.enrollmentDigest !== activation.enrollmentDigest
          || admission.permitDigest !== activation.permitDigest
          || admission.currentAdmissionDigest !== activation.currentAdmissionDigest
          || admission.inputDigest !== activation.inputDigest
          || admission.connectionAttemptId !== binding.connectionAttemptId
          || admission.initializedConnectionDigest !== binding.initializedConnectionDigest
          || admission.threadStartRequestId !== binding.threadStartRequestId
          || admission.requestedAt !== binding.requestedAt || admission.deadline !== binding.deadline
          || scope.tenantId !== activation.tenantId || scope.nodeId !== activation.nodeId
          || scope.projectId !== activation.projectId || scope.jobId !== activation.jobId
          || scope.attemptId !== activation.attemptId || scope.runId !== activation.runId
          || scope.leaseId !== activation.leaseId || scope.leaseEpoch !== activation.leaseEpoch
          || scope.operationDigest !== activation.operationDigest) unavailable();
        const reservation = await input.reservation.reserveExactStart(admission, binding.requestedAt,
          () => assertCurrent(activation, binding.deadline));
        if (reservation !== 'recorded') unavailable();
        assertCurrent(activation, binding.deadline);
        await input.workspace.prepare(binding, () => assertCurrent(activation, binding.deadline));
        assertCurrent(activation, binding.deadline);
        const dispatcher = createCodexStartResponseDispatcherV1({ connectionAttemptId, initializedConnectionDigest });
        try {
          dispatcher.reserveThread(admission);
          assertCurrent(activation, binding.deadline);
          const threadRaw = await input.ownedStart.startThread({ activation, admission, assertCurrent: () => assertCurrent(activation, binding.deadline) });
          assertCurrent(activation, binding.deadline);
          const thread = dispatcher.receiveThread(admission, threadRaw, new Date(now()).toISOString());
          await input.receipts.recordThread(thread, () => assertCurrent(activation, binding.deadline));
          assertCurrent(activation, binding.deadline);
          const intent = createCodexTurnStartIntentV1(thread, { turnStartRequestId: binding.turnStartRequestId,
            inputDigest: activation.inputDigest, requestedAt: new Date(now()).toISOString(), deadline: binding.deadline });
          dispatcher.reserveTurn(thread, intent);
          assertCurrent(activation, binding.deadline);
          const turnRaw = await input.ownedStart.startTurn({ activation, thread, intent, assertCurrent: () => assertCurrent(activation, binding.deadline) });
          assertCurrent(activation, binding.deadline);
          const turn = dispatcher.receiveTurn(thread, intent, turnRaw, new Date(now()).toISOString());
          await input.receipts.recordTurn(thread, turn, () => assertCurrent(activation, binding.deadline));
          assertCurrent(activation, binding.deadline);
          state = 'complete';
          return Object.freeze({ activation, admission, thread, turn, grantsExecutionAuthority: false as const,
            permitsRetry: false as const, permitsResume: false as const, permitsThreadRead: false as const });
        } finally { dispatcher.close(); }
      } catch { state = 'closed'; await close().catch(() => {}); return unavailable(); }
      finally { if (state === 'complete') await close(); }
    },
  });
}
