import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";

/**
 * One topology-neutral handoff from the authoritative controller to one
 * enrolled worker. `route` deliberately lives outside this packet: the same
 * signed work identity can be carried over a local Mac bridge or a remote
 * enrolled connection without creating a second task, queue, or authority.
 */
export const CONTROLLER_WORKER_DELIVERY_V1 = "control-room.controller-worker-delivery/v1" as const;
export const CONTROLLER_WORKER_DELIVERY_RECEIPT_V1 = "control-room.controller-worker-delivery-receipt/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
/** A harness adapter is an identifier, not a path.  The slash-separated form
 * is already used by the existing Codex App Server planning contract. */
export const controllerWorkerAdapterIdSchemaV1 = z.string().min(3).max(180)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const taskText = z.string().min(1).max(32_768).refine(value => Buffer.byteLength(value, "utf8") <= 32_768);

const identitySchema = z.object({ tenantId: id, projectId: id, jobId: id, attemptId: id, runId: id, nodeId: id }).strict();
const workerSchema = z.object({ workerId: id, adapterId: controllerWorkerAdapterIdSchemaV1,
  adapterRevision: z.string().min(7).max(180) }).strict();
const inputSchema = z.object({ prompt: taskText, instructions: z.string().max(8192).refine(value => Buffer.byteLength(value, "utf8") <= 8192) }).strict();

const materialSchema = z.object({
  schema: z.literal(CONTROLLER_WORKER_DELIVERY_V1), identity: identitySchema, worker: workerSchema,
  input: inputSchema, inputDigest: digest, authorityDigest: digest, connectorProfileDigest: digest,
  acceptanceProfileId: id, acceptanceProfileDigest: digest, issuedAt: instant, expiresAt: instant,
  deliveryId: id,
}).strict();

export const controllerWorkerDeliverySchemaV1 = materialSchema.extend({ deliveryDigest: digest }).strict().superRefine((value, context) => {
  const { deliveryDigest, ...material } = value;
  const expectedInput = sha256Digest(value.input);
  const expectedId = `delivery:${sha256Digest({ identity: value.identity, worker: value.worker, inputDigest: expectedInput,
    authorityDigest: value.authorityDigest, connectorProfileDigest: value.connectorProfileDigest,
    acceptanceProfileId: value.acceptanceProfileId, acceptanceProfileDigest: value.acceptanceProfileDigest,
    issuedAt: value.issuedAt, expiresAt: value.expiresAt }).slice(7)}`;
  if (value.inputDigest !== expectedInput || value.deliveryId !== expectedId || value.deliveryDigest !== sha256Digest(material)
    || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    context.addIssue({ code: "custom", message: "controller worker delivery binding mismatch" });
  }
});
export type ControllerWorkerDeliveryV1 = z.infer<typeof controllerWorkerDeliverySchemaV1>;

/** The route changes physical placement only. It has no task or authority data. */
export const controllerWorkerRouteSchemaV1 = z.object({ kind: z.enum(["local", "remote"]), workerId: id }).strict();
export type ControllerWorkerRouteV1 = z.infer<typeof controllerWorkerRouteSchemaV1>;

export const controllerWorkerDeliveryReceiptSchemaV1 = z.object({
  schema: z.literal(CONTROLLER_WORKER_DELIVERY_RECEIPT_V1), deliveryId: id, deliveryDigest: digest,
  workerId: id, route: controllerWorkerRouteSchemaV1, receivedAt: instant,
  disposition: z.enum(["accepted", "duplicate", "rejected"]),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false), receiptDigest: digest,
}).strict().superRefine((value, context) => {
  const { receiptDigest, ...material } = value;
  if (value.receiptDigest !== sha256Digest(material)) context.addIssue({ code: "custom", message: "controller worker receipt mismatch" });
});
export type ControllerWorkerDeliveryReceiptV1 = z.infer<typeof controllerWorkerDeliveryReceiptSchemaV1>;

export function createControllerWorkerDeliveryV1(value: Omit<ControllerWorkerDeliveryV1, "schema" | "inputDigest" | "deliveryId" | "deliveryDigest">): ControllerWorkerDeliveryV1 {
  const base = z.object({ identity: identitySchema, worker: workerSchema, input: inputSchema, authorityDigest: digest,
    connectorProfileDigest: digest, acceptanceProfileId: id, acceptanceProfileDigest: digest, issuedAt: instant, expiresAt: instant }).strict().parse(value);
  const inputDigest = sha256Digest(base.input);
  const deliveryId = `delivery:${sha256Digest({ identity: base.identity, worker: base.worker, inputDigest,
    authorityDigest: base.authorityDigest, connectorProfileDigest: base.connectorProfileDigest,
    acceptanceProfileId: base.acceptanceProfileId, acceptanceProfileDigest: base.acceptanceProfileDigest,
    issuedAt: base.issuedAt, expiresAt: base.expiresAt }).slice(7)}`;
  const material = { schema: CONTROLLER_WORKER_DELIVERY_V1, ...base, inputDigest, deliveryId };
  return Object.freeze(controllerWorkerDeliverySchemaV1.parse({ ...material, deliveryDigest: sha256Digest(material) }));
}

export interface ControllerWorkerDeliveryPortV1 {
  receive(delivery: ControllerWorkerDeliveryV1, route: ControllerWorkerRouteV1, signal?: AbortSignal): Promise<unknown>;
}

/**
 * Delivers one immutable controller packet over either physical route. The
 * receiving bridge must return the standard non-executing receipt. A route
 * failure is intentionally returned as uncertainty by the caller; this helper
 * makes no retry decision and does not start work.
 */
export async function deliverControllerWorkerPacketV1(port: ControllerWorkerDeliveryPortV1, deliveryValue: unknown,
  routeValue: unknown, signal?: AbortSignal): Promise<ControllerWorkerDeliveryReceiptV1> {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const route = controllerWorkerRouteSchemaV1.parse(routeValue);
  if (!port || typeof port.receive !== "function" || signal?.aborted || route.workerId !== delivery.worker.workerId) {
    throw new Error("controller_worker_delivery_unavailable");
  }
  const result = controllerWorkerDeliveryReceiptSchemaV1.parse(await port.receive(delivery, route, signal));
  if (result.deliveryId !== delivery.deliveryId || result.deliveryDigest !== delivery.deliveryDigest
    || result.workerId !== delivery.worker.workerId || canonicalJson(result.route) !== canonicalJson(route)) {
    throw new Error("controller_worker_delivery_receipt_mismatch");
  }
  return result;
}
