import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import {
  controllerWorkerDeliveryReceiptSchemaV1,
  controllerWorkerDeliverySchemaV1,
  type ControllerWorkerDeliveryReceiptV1,
  type ControllerWorkerDeliveryV1,
} from "./controller-worker-delivery";
import { digestSchema, localId } from "./native-run-identifiers";

/** Optional negotiated feature. Older enrolled workers cannot receive this pair. */
export const CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1 = "controller.worker.delivery.v1" as const;
export const CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1 = "controller.worker.delivery.recovery.v1" as const;

const timestamp = z.string().datetime();
const queueFor = (delivery: ControllerWorkerDeliveryV1) => `native-queue:${sha256Digest({
  tenantId: delivery.identity.tenantId, jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId,
}).slice(7)}`;

/**
 * Signed-node transport wrapper for the topology-neutral packet. It adds only
 * the existing deterministic queue correlation and the current enrollment
 * digest; it deliberately does not translate the packet into a new task,
 * scheduler item, authority or execution request.
 */
export const controllerWorkerNodeDispatchBodySchemaV1 = z.object({
  schema: z.literal("control-room.controller-worker-node-dispatch/v1"),
  queueId: localId,
  enrollmentDigest: digestSchema,
  delivery: controllerWorkerDeliverySchemaV1,
}).strict().superRefine((value, context) => {
  if (value.queueId !== queueFor(value.delivery) || Buffer.byteLength(JSON.stringify(value), "utf8") > 65_536) {
    context.addIssue({ code: "custom", message: "controller worker node dispatch binding mismatch" });
  }
});
export type ControllerWorkerNodeDispatchBodyV1 = z.infer<typeof controllerWorkerNodeDispatchBodySchemaV1>;

/** Receipt wrapper binds the standard non-executing receipt to this one signed
 * dispatch frame. It contains no output, execution, approval, or retry grant. */
export const controllerWorkerNodeDispatchReceiptBodySchemaV1 = z.object({
  schema: z.literal("control-room.controller-worker-node-dispatch-receipt/v1"),
  queueId: localId,
  dispatchMessageId: localId,
  dispatchBodyDigest: digestSchema,
  enrollmentDigest: digestSchema,
  receipt: controllerWorkerDeliveryReceiptSchemaV1,
}).strict().superRefine((value, context) => {
  if (value.receipt.route.kind !== "remote" || value.receipt.route.workerId !== value.receipt.workerId
    || value.receipt.startsWork || value.receipt.grantsExecutionAuthority) {
    context.addIssue({ code: "custom", message: "controller worker node receipt binding mismatch" });
  }
});
export type ControllerWorkerNodeDispatchReceiptBodyV1 = z.infer<typeof controllerWorkerNodeDispatchReceiptBodySchemaV1>;

/** A fresh authenticated connection may report only an existing receipt. It
 * carries no prompt, authority grant or instruction to repeat delivery. */
export const controllerWorkerNodeReceiptRecoverySchemaV1 = z.object({
  schema: z.literal("control-room.controller-worker-node-receipt-recovery/v1"),
  scope: z.object({ projectId: localId, jobId: localId, attemptId: localId }).strict(),
  dispatchFrameDigest: digestSchema,
  receipt: controllerWorkerNodeDispatchReceiptBodySchemaV1,
}).strict();
export type ControllerWorkerNodeReceiptRecoveryV1 = z.infer<typeof controllerWorkerNodeReceiptRecoverySchemaV1>;

/**
 * Match only after the outer receipt frame has been authenticated as the
 * selected node. A matching rejected receipt is durable negative evidence;
 * neither it nor an accepted receipt grants execution or a resend.
 */
export function matchControllerWorkerNodeDispatchReceiptV1(receiptValue: unknown, expected: {
  messageId: string;
  body: ControllerWorkerNodeDispatchBodyV1;
}): ControllerWorkerDeliveryReceiptV1 {
  const receipt = controllerWorkerNodeDispatchReceiptBodySchemaV1.parse(receiptValue);
  const dispatch = controllerWorkerNodeDispatchBodySchemaV1.parse(expected.body);
  const standard = controllerWorkerDeliveryReceiptSchemaV1.parse(receipt.receipt);
  if (receipt.queueId !== dispatch.queueId || receipt.dispatchMessageId !== expected.messageId
    || receipt.dispatchBodyDigest !== sha256Digest(dispatch) || receipt.enrollmentDigest !== dispatch.enrollmentDigest
    || standard.deliveryId !== dispatch.delivery.deliveryId || standard.deliveryDigest !== dispatch.delivery.deliveryDigest
    || standard.workerId !== dispatch.delivery.worker.workerId || standard.route.kind !== "remote"
    || standard.route.workerId !== dispatch.delivery.worker.workerId) {
    throw new Error("controller_worker_node_delivery_receipt_mismatch");
  }
  return standard;
}

/** Frame-level checks that need outer signed timestamps and identity. */
export function assertControllerWorkerNodeDispatchFrameV1(input: Readonly<{
  tenantId: string;
  sentAt: string;
  expiresAt: string;
  body: ControllerWorkerNodeDispatchBodyV1;
}>): void {
  const body = controllerWorkerNodeDispatchBodySchemaV1.parse(input.body);
  if (input.tenantId !== body.delivery.identity.tenantId || Date.parse(input.sentAt) < Date.parse(body.delivery.issuedAt)
    || Date.parse(input.expiresAt) > Date.parse(body.delivery.expiresAt)) {
    throw new Error("controller_worker_node_delivery_frame_mismatch");
  }
}

export function assertControllerWorkerNodeReceiptFrameV1(input: Readonly<{
  tenantId: string;
  sentAt: string;
  body: ControllerWorkerNodeDispatchReceiptBodyV1;
}>): void {
  const body = controllerWorkerNodeDispatchReceiptBodySchemaV1.parse(input.body);
  if (Date.parse(body.receipt.receivedAt) > Date.parse(input.sentAt) || !timestamp.safeParse(input.sentAt).success
    || !timestamp.safeParse(body.receipt.receivedAt).success || input.tenantId.length < 3) {
    throw new Error("controller_worker_node_receipt_frame_mismatch");
  }
}
