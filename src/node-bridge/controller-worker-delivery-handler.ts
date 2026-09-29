import { sha256Digest } from "../security/canonical-digest";
import {
  controllerWorkerNodeDispatchBodySchemaV1,
  controllerWorkerNodeDispatchReceiptBodySchemaV1,
  type ControllerWorkerNodeDispatchReceiptBodyV1,
} from "../harness/v1/controller-worker-node-delivery";
import { controllerWorkerDeliveryReceiptSchemaV1 } from "../harness/v1/controller-worker-delivery";
import { signedNodeFrameSchema, type SignedNodeFrame } from "../node-protocol/v1";
import type { ControllerWorkerDeliveryChannel } from "./bridge";
import type { SqliteBridgeJournal } from "./journal";

export interface ControllerWorkerDeliveryIntakeConfigV1 {
  workerId: string;
  adapterId: string;
  adapterRevision: string;
  enrollmentDigest: string;
}

/**
 * Receives exactly one authenticated generic packet and durably records it.
 * This class has no provider, harness, process, workspace, or execution port.
 */
export class ControllerWorkerDeliveryIntakeHandlerV1 {
  private busy = false;
  private closed = false;
  private highWater = -1;
  private readonly config: Readonly<ControllerWorkerDeliveryIntakeConfigV1>;

  constructor(config: ControllerWorkerDeliveryIntakeConfigV1,
    private readonly journal: Pick<SqliteBridgeJournal, "recordControllerWorkerDelivery">,
    private readonly clock: () => number) {
    if (!config || typeof config !== "object" || Object.keys(config).length !== 4
      || typeof config.workerId !== "string" || typeof config.adapterId !== "string"
      || typeof config.adapterRevision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(config.enrollmentDigest)) {
      throw new Error("controller_worker_intake_configuration_invalid");
    }
    this.config = Object.freeze({ ...config });
    this.journal = Object.freeze({ recordControllerWorkerDelivery: journal.recordControllerWorkerDelivery.bind(journal) });
  }

  close(): void { this.closed = true; }

  async accept(frameValue: SignedNodeFrame<"controller.worker.delivery">,
    channel: ControllerWorkerDeliveryChannel): Promise<ControllerWorkerNodeDispatchReceiptBodyV1> {
    if (this.closed || this.busy) throw new Error("controller_worker_intake_unavailable");
    const parsed = signedNodeFrameSchema.parse(frameValue);
    if (parsed.type !== "controller.worker.delivery") throw new Error("controller_worker_intake_scope_invalid");
    const frame = parsed;
    this.busy = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { this.close(); controller.abort(); reject(new Error("controller_worker_intake_uncertain")); }, 5_000);
    });
    const now = () => {
      channel.assertCurrent(); const value = this.clock();
      if (this.closed || controller.signal.aborted || !Number.isSafeInteger(value) || value < this.highWater
        || value >= Date.parse(frame.expiresAt)) throw new Error("controller_worker_intake_unavailable");
      this.highWater = value; return value;
    };
    try {
      now(); const body = controllerWorkerNodeDispatchBodySchemaV1.parse(frame.body), delivery = body.delivery;
      if (frame.tenantId !== channel.tenantId || delivery.identity.nodeId !== channel.nodeId
        || frame.connectionId !== channel.connectionId || Buffer.byteLength(JSON.stringify(frame), "utf8") > channel.maxFrameBytes
        || body.enrollmentDigest !== this.config.enrollmentDigest || delivery.worker.workerId !== this.config.workerId
        || delivery.worker.adapterId !== this.config.adapterId || delivery.worker.adapterRevision !== this.config.adapterRevision) {
        throw new Error("controller_worker_intake_scope_invalid");
      }
      const receivedAt = new Date(now()).toISOString();
      const standardMaterial = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
        deliveryId: delivery.deliveryId, deliveryDigest: delivery.deliveryDigest, workerId: delivery.worker.workerId,
        route: { kind: "remote" as const, workerId: delivery.worker.workerId }, receivedAt,
        disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
      const standard = controllerWorkerDeliveryReceiptSchemaV1.parse({ ...standardMaterial,
        receiptDigest: sha256Digest(standardMaterial) });
      const receipt = controllerWorkerNodeDispatchReceiptBodySchemaV1.parse({
        schema: "control-room.controller-worker-node-dispatch-receipt/v1", queueId: body.queueId,
        dispatchMessageId: frame.messageId, dispatchBodyDigest: frame.bodyDigest,
        enrollmentDigest: body.enrollmentDigest, receipt: standard,
      });
      await Promise.race([Promise.resolve(this.journal.recordControllerWorkerDelivery(frame, receipt, () => { now(); })), timeout]);
      now(); return receipt;
    } catch (error) { this.close(); throw error; }
    finally { if (timer) clearTimeout(timer); this.busy = false; }
  }
}
