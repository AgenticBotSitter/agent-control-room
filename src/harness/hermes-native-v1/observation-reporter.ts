import { z } from "zod";
import { sha256Digest } from "../../security";
import { signedNodeFrameSchema, verifyNodeFrameSignature } from "../../node-protocol/v1";
import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import type { PortableNodeBridge } from "../../node-bridge/bridge";
import { matchNativeTaskDispatchReceipt, prepareNativeTaskDispatchIntake } from "../v1/native-delivery";
import { verifyNativeTaskApprovalBinding } from "../v1/native-task-approval-binding";
import { nativeTaskRegistration } from "../v1/native-task-registration";
import { assertNativeSnapshotProgress, nativeTaskSnapshotBodySchema, type NativeTaskSnapshotBody } from "../v1/native-observation";
import { enrollmentSchema, localId, snapshotSchema, type NativeRunJournal } from "./contracts";
import { nativeTaskObservation } from "./task-observation";

const configuration = z.object({ queueId: localId, enrollment: enrollmentSchema,
  serverId: localId, serverKeyId: localId, serverPublicKeySpki: z.string().min(16).max(4096) }).strict();
type Dependencies = {
  deliveries: Pick<SqliteBridgeJournal, "acceptedNativeDelivery">;
  runs: Pick<NativeRunJournal, "load">;
  bridge: Pick<PortableNodeBridge, "publishNativeSnapshot">;
  clock: () => number;
  assertAvailable: () => void;
};
const fail = (): never => { throw new Error("native_observation_reporter_unavailable"); };

/** Node-private reporting owner. No adapter, execution authority, native transport,
 * reservation, polling, observation request or stop capability is accepted here. */
export class NativeObservationReporter {
  private readonly config: z.infer<typeof configuration>;
  private readonly loadDelivery: Dependencies["deliveries"]["acceptedNativeDelivery"];
  private readonly loadRun: Dependencies["runs"]["load"];
  private readonly publish: Dependencies["bridge"]["publishNativeSnapshot"];
  private readonly clock: () => number;
  private readonly available: () => void;
  private highWater = -1;
  private closed = false;
  private busy = false;
  private deliveryDigest?: string;
  private last?: NativeTaskSnapshotBody;
  constructor(config: z.input<typeof configuration>, dependencies: Dependencies) {
    this.config = configuration.parse(config);
    this.loadDelivery = dependencies.deliveries.acceptedNativeDelivery.bind(dependencies.deliveries);
    this.loadRun = dependencies.runs.load.bind(dependencies.runs);
    this.publish = dependencies.bridge.publishNativeSnapshot.bind(dependencies.bridge);
    this.clock = dependencies.clock.bind(dependencies);
    this.available = dependencies.assertAvailable.bind(dependencies);
  }
  private current(signal: AbortSignal) {
    if (!(signal instanceof AbortSignal) || signal.aborted || this.closed) return fail();
    this.available(); const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < this.highWater) return fail();
    this.highWater = now; return now;
  }
  private read(signal: AbortSignal) {
    const now = this.current(signal), saved = this.loadDelivery(this.config.queueId);
    if (!saved) return fail();
    const frame = signedNodeFrameSchema.parse(saved.frame);
    if (frame.type !== "harness.native.dispatch" || frame.direction !== "server_to_node"
      || frame.actorId !== this.config.serverId || frame.keyId !== this.config.serverKeyId
      || frame.tenantId !== this.config.enrollment.tenantId || frame.body.queueId !== this.config.queueId
      || frame.bodyDigest !== sha256Digest(frame.body)
      || !verifyNodeFrameSignature(frame, this.config.serverPublicKeySpki)) return fail();
    const receipt = matchNativeTaskDispatchReceipt(saved.receipt, frame);
    if (receipt.disposition !== "recorded" || Date.parse(receipt.recordedAt) > now
      || Date.parse(receipt.recordedAt) < Date.parse(frame.sentAt)
      || Date.parse(receipt.recordedAt) >= Date.parse(frame.expiresAt)) return fail();
    const digest = sha256Digest({ frame, receipt });
    if (this.deliveryDigest !== undefined && digest !== this.deliveryDigest) return fail();
    const material = prepareNativeTaskDispatchIntake(frame.body, this.config.enrollment);
    const { binding } = verifyNativeTaskApprovalBinding(material.enrollment, material.request, material.start);
    const registration = nativeTaskRegistration(binding, frame.body.inputDigest,
      material.request.leaseId, material.request.leaseEpoch, receipt.recordedAt);
    const snapshot = snapshotSchema.parse(this.loadRun(binding.runId));
    if (sha256Digest(snapshot.binding) !== sha256Digest(binding) || snapshot.observedAt > now
      || snapshot.observedAt < Date.parse(receipt.recordedAt)) return fail();
    const body = nativeTaskObservation(snapshot, registration.nativeTask!);
    if (this.last && (body.snapshotVersion < this.last.snapshotVersion
      || body.snapshotVersion === this.last.snapshotVersion && sha256Digest(body) !== sha256Digest(this.last))) return fail();
    if (this.last && body.snapshotVersion > this.last.snapshotVersion) assertNativeSnapshotProgress(this.last, body);
    this.current(signal); this.deliveryDigest = digest;
    return { body, snapshot, now };
  }
  async report(signal: AbortSignal) {
    if (this.busy) return fail();
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { body, now } = this.read(signal);
      // Capture into the existing durable bridge outbox; publication is not a server ACK.
      const disposition = await Promise.race([this.publish(structuredClone(body), new Date(now).toISOString()),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          this.closed = true; reject(new Error("native_observation_reporter_uncertain"));
        }, 5000); })]);
      this.current(signal);
      if (disposition !== "recorded" && disposition !== "duplicate") return fail();
      this.last = body;
      return { runId: body.runId, snapshotVersion: body.snapshotVersion, disposition,
        serverAccepted: false as const, grantsExecutionAuthority: false as const };
    } catch { this.closed = true; return fail(); }
    finally { clearTimeout(timer); this.busy = false; }
  }
  /** Exact latest saved result only, for the trusted artifact sender, never protocol/log output. */
  readResult(input: NativeTaskSnapshotBody, signal: AbortSignal): Uint8Array {
    try {
      const expected = nativeTaskSnapshotBodySchema.parse(input), { body, snapshot } = this.read(signal);
      if (body.state !== "completed" || snapshot.resultText === null || sha256Digest(body) !== sha256Digest(expected)) return fail();
      return new TextEncoder().encode(snapshot.resultText);
    } catch { this.closed = true; return fail(); }
  }
  /** Stops new reports. Already journaled evidence is not erased or retracted. The bridge
   * owner separately disconnects replaced transports and fences its signing/send generation. */
  close() { this.closed = true; }
}
