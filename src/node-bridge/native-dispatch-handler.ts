import { createNativeApprovalIntake } from "../harness/v1/native-approval-intake";
import { prepareNativeTaskDispatchIntake, nativeTaskDispatchReceiptBodySchema } from "../harness/v1/native-delivery";
import { enrollmentSchema } from "../harness/v1/native-run-contracts";
import { signedNodeFrameSchema, type SignedNodeFrame } from "../node-protocol/v1";
import type { NativeDeliveryChannel } from "./bridge";
import type { SqliteBridgeJournal } from "./journal";

type Trust = Omit<Parameters<typeof createNativeApprovalIntake>[1], "clock">;
/** Trusted node configuration and already-authenticated channel only. No provider or native adapter. */
export class NativeDispatchIntakeHandler {
  private readonly enrollment: ReturnType<typeof enrollmentSchema.parse>;
  private readonly trust: Trust;
  private busy = false;
  private closed = false;
  private highWater = -1;
  constructor(enrollment: unknown, private readonly journal: Pick<SqliteBridgeJournal, "recordNativeDelivery">, trust: Trust, private readonly clock: () => number) {
    this.enrollment = enrollmentSchema.parse(enrollment);
    this.journal = Object.freeze({ recordNativeDelivery: journal.recordNativeDelivery.bind(journal) });
    this.trust = { approvals: trust.approvals, security: { currentServerTrustRevision: trust.security.currentServerTrustRevision.bind(trust.security) } };
  }
  close() { this.closed = true; }
  async accept(frame: SignedNodeFrame<"harness.native.dispatch">, channel: NativeDeliveryChannel) {
    if (this.closed || this.busy) throw new Error("native_intake_unavailable");
    const snapshot = signedNodeFrameSchema.parse(frame);
    if (snapshot.type !== "harness.native.dispatch") throw new Error("native_intake_scope_invalid");
    frame = snapshot;
    this.busy = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { this.close(); controller.abort(); reject(new Error("native_intake_uncertain")); }, 5000);
    });
    const now = () => {
      channel.assertCurrent(); const value = this.clock();
      if (this.closed || controller.signal.aborted || !Number.isSafeInteger(value) || value < this.highWater
        || value >= Date.parse(frame.expiresAt)) throw new Error("native_intake_unavailable");
      this.highWater = value; return value;
    };
    try {
      now();
      const prepared = prepareNativeTaskDispatchIntake(frame.body, this.enrollment);
      if (frame.tenantId !== channel.tenantId || prepared.request.nodeId !== channel.nodeId || frame.connectionId !== channel.connectionId
        || Buffer.byteLength(JSON.stringify(frame)) > channel.maxFrameBytes) throw new Error("native_intake_scope_invalid");
      const verified = await Promise.race([createNativeApprovalIntake(prepared, { ...this.trust, clock: now })(prepared.packet, controller.signal), timeout]);
      const assertFresh = () => { now(); verified.assertFresh(); };
      assertFresh();
      const q = prepared.request;
      const receipt = nativeTaskDispatchReceiptBodySchema.parse({ schema: "control-room.native-task-dispatch-receipt/v1",
        queueId: frame.body.queueId, dispatchMessageId: frame.messageId, dispatchBodyDigest: frame.bodyDigest,
        tenantId: q.tenantId, projectId: q.projectId, nodeId: q.nodeId, jobId: q.jobId, attemptId: q.attemptId,
        packetDigest: frame.body.packetDigest, bindingDigest: frame.body.bindingDigest, recordedAt: new Date(now()).toISOString(),
        disposition: "recorded", safeReason: "none", startsWork: false, grantsExecutionAuthority: false });
      return this.journal.recordNativeDelivery(frame, receipt, assertFresh);
    } catch (error) { this.close(); throw error; }
    finally { if (timer) clearTimeout(timer); this.busy = false; }
  }
}
