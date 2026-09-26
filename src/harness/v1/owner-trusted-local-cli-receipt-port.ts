import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1, CONTROLLER_WORKER_DELIVERY_RECEIPT_V1,
  type ControllerWorkerDeliveryPortV1 } from "./controller-worker-delivery";
import { sha256Digest } from "../../security/canonical-digest";

const unavailable = (): never => { throw new Error("owner_trusted_local_cli_receipt_port_unavailable"); };

/**
 * Same-process receiving station for the owner-trusted local CLI bridge.
 * There is no separate transport that can fail: the delivery already reached
 * this process, so the port's only job is to mint the standard,
 * tamper-evident receipt. It grants no execution authority and makes no
 * retry decision; the caller's own `assertCurrent` fences are what may still
 * refuse the task before or after this receipt.
 */
export function createOwnerTrustedLocalCliReceiptPortV1(clock: () => number = Date.now): ControllerWorkerDeliveryPortV1 {
  if (typeof clock !== "function") unavailable();
  return Object.freeze({ async receive(deliveryValue: unknown, routeValue: unknown, signal?: AbortSignal) {
    if (signal?.aborted) unavailable();
    const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
    const route = controllerWorkerRouteSchemaV1.parse(routeValue);
    if (route.kind !== "local" || route.workerId !== delivery.worker.workerId) unavailable();
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) unavailable();
    const receivedAt = new Date(now).toISOString();
    if (Date.parse(receivedAt) < Date.parse(delivery.issuedAt) || Date.parse(receivedAt) >= Date.parse(delivery.expiresAt)) unavailable();
    const material = { schema: CONTROLLER_WORKER_DELIVERY_RECEIPT_V1, deliveryId: delivery.deliveryId,
      deliveryDigest: delivery.deliveryDigest, workerId: delivery.worker.workerId, route, receivedAt,
      disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
    return Object.freeze({ ...material, receiptDigest: sha256Digest(material) });
  } });
}
