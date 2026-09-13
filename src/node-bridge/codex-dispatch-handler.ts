import { createCodexApprovalIntakeV1 } from '../harness/codex-v1/approval-intake';
import { codexTaskDispatchReceiptBodySchemaV1 } from '../harness/codex-v1/delivery-contract';
import { signedNodeFrameSchema, type SignedNodeFrame } from '../node-protocol/v1';
import type { PinnedApprovalTrustStore } from '../node-policy/v1/pinned-approval-trust';
import type { SqliteNodeSecurityStateRepository } from '../node-policy/v1/persistent-security-state';
import type { CodexDeliveryChannel } from './bridge';
import type { SqliteBridgeJournal } from './journal';

interface CodexIntakeConfigV1 {
  enrollmentDigest: string;
  connectorProfileDigest: string;
  workspaceIntentDigest: string;
}
interface CodexIntakeTrustV1 {
  approvals: PinnedApprovalTrustStore;
  security: Pick<SqliteNodeSecurityStateRepository, 'currentServerTrustRevision'>;
}

/** Authenticated delivery intake only. It records the exact signed job and owner
 * permit, but deliberately has no App Server, workspace or execution port. */
export class CodexDispatchIntakeHandlerV1 {
  private busy = false;
  private closed = false;
  private highWater = -1;
  private readonly config: Readonly<CodexIntakeConfigV1>;
  private readonly trust: CodexIntakeTrustV1;

  constructor(config: CodexIntakeConfigV1,
    private readonly journal: Pick<SqliteBridgeJournal, 'recordCodexDelivery'>,
    trust: CodexIntakeTrustV1, private readonly clock: () => number) {
    this.config = Object.freeze({ ...config });
    this.journal = Object.freeze({ recordCodexDelivery: journal.recordCodexDelivery.bind(journal) });
    this.trust = { approvals: trust.approvals,
      security: { currentServerTrustRevision: trust.security.currentServerTrustRevision.bind(trust.security) } };
  }

  close() { this.closed = true; }

  async accept(frameValue: SignedNodeFrame<'harness.codex.dispatch'>, channel: CodexDeliveryChannel) {
    if (this.closed || this.busy) throw new Error('codex_intake_unavailable');
    const parsed = signedNodeFrameSchema.parse(frameValue);
    if (parsed.type !== 'harness.codex.dispatch') throw new Error('codex_intake_scope_invalid');
    const frame = parsed;
    this.busy = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { this.close(); controller.abort(); reject(new Error('codex_intake_uncertain')); }, 5000);
    });
    const now = () => {
      channel.assertCurrent(); const value = this.clock();
      if (this.closed || controller.signal.aborted || !Number.isSafeInteger(value) || value < this.highWater
        || value >= Date.parse(frame.expiresAt)) throw new Error('codex_intake_unavailable');
      this.highWater = value; return value;
    };
    try {
      now(); const start = frame.body.start;
      if (frame.tenantId !== channel.tenantId || start.nodeId !== channel.nodeId
        || frame.connectionId !== channel.connectionId
        || Buffer.byteLength(JSON.stringify(frame), 'utf8') > channel.maxFrameBytes) {
        throw new Error('codex_intake_scope_invalid');
      }
      const intake = createCodexApprovalIntakeV1({ body: frame.body,
        expectedEnrollmentDigest: this.config.enrollmentDigest,
        expectedConnectorProfileDigest: this.config.connectorProfileDigest,
        expectedWorkspaceIntentDigest: this.config.workspaceIntentDigest }, { ...this.trust, clock: now });
      const verified = await Promise.race([intake(controller.signal), timeout]);
      const assertFresh = () => { now(); verified.assertFresh(); };
      assertFresh();
      const receipt = codexTaskDispatchReceiptBodySchemaV1.parse({
        schema: 'control-room.codex-task-dispatch-receipt/v1', queueId: frame.body.queueId,
        dispatchMessageId: frame.messageId, dispatchBodyDigest: frame.bodyDigest,
        tenantId: start.tenantId, projectId: start.projectId, nodeId: start.nodeId,
        jobId: start.jobId, attemptId: start.attemptId, permitDigest: frame.body.permitDigest,
        enrollmentDigest: start.enrollmentDigest, recordedAt: new Date(now()).toISOString(),
        disposition: 'recorded', safeReason: 'none', startsWork: false, grantsExecutionAuthority: false,
      });
      return this.journal.recordCodexDelivery(frame, receipt, assertFresh);
    } catch (error) { this.close(); throw error; }
    finally { if (timer) clearTimeout(timer); this.busy = false; }
  }
}
