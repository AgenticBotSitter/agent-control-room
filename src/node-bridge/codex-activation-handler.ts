import { signedNodeFrameSchema, type SignedNodeFrame } from '../node-protocol/v1';
import type { CodexActivationChannel } from './bridge';
import type { SqliteBridgeJournal } from './journal';
import { assertSynchronousFence } from '../security/synchronous-fence';

interface CodexActivationAuthorityV1 {
  currentAdmissionDigest(queueId: string): string;
  assertCurrent(queueId: string): void;
}

/** Effect-free semantic acknowledgement intake. This records that Control Room
 * durably received the exact node receipt. It deliberately owns no workspace,
 * App Server, start, retry, resume or read port. */
export class CodexActivationIntakeHandlerV1 {
  private closed = false;
  private busy = false;
  private readonly authority: CodexActivationAuthorityV1;
  private readonly journal: Pick<SqliteBridgeJournal, 'recordCodexActivation'>;

  constructor(journal: Pick<SqliteBridgeJournal, 'recordCodexActivation'>,
    authority: CodexActivationAuthorityV1, private readonly clock: () => number) {
    this.journal = Object.freeze({ recordCodexActivation: journal.recordCodexActivation.bind(journal) });
    this.authority = Object.freeze({
      currentAdmissionDigest: authority.currentAdmissionDigest.bind(authority),
      assertCurrent: authority.assertCurrent.bind(authority),
    });
  }

  close(): void { this.closed = true; }

  async accept(value: SignedNodeFrame<'harness.codex.dispatch.activation'>,
    channel: CodexActivationChannel) {
    if (this.closed || this.busy) throw new Error('codex_activation_intake_unavailable');
    const parsed = signedNodeFrameSchema.parse(value);
    if (parsed.type !== 'harness.codex.dispatch.activation') throw new Error('codex_activation_intake_invalid');
    this.busy = true;
    try {
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < Date.parse(parsed.sentAt) || now >= Date.parse(parsed.expiresAt)
        || parsed.tenantId !== channel.tenantId || parsed.body.nodeId !== channel.nodeId
        || parsed.connectionId !== channel.connectionId
        || Buffer.byteLength(JSON.stringify(parsed), 'utf8') > channel.maxFrameBytes) {
        throw new Error('codex_activation_intake_invalid');
      }
      const queueId = parsed.body.queueId;
      const assertCurrent = () => {
        channel.assertCurrent();
        const current = this.clock();
        if (this.closed || !Number.isSafeInteger(current) || current < now
          || current >= Date.parse(parsed.expiresAt)) throw new Error('codex_activation_intake_unavailable');
        assertSynchronousFence(() => this.authority.assertCurrent(queueId), () => {
          throw new Error('codex_activation_intake_unavailable');
        });
      };
      assertCurrent();
      const digest = this.authority.currentAdmissionDigest(queueId);
      assertCurrent();
      return this.journal.recordCodexActivation(parsed, new Date(now).toISOString(), digest, assertCurrent);
    } catch (error) {
      this.close();
      throw error;
    } finally { this.busy = false; }
  }
}
