import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { sha256Digest } from "../../security/canonical-digest";
import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  controllerWorkerDeliveryReceiptSchemaV1,
  deliverControllerWorkerPacketV1, type ControllerWorkerDeliveryPortV1,
  type ControllerWorkerDeliveryReceiptV1, type ControllerWorkerDeliveryV1 } from "./controller-worker-delivery";
import { persistControllerWorkerDeliveryReceiptV1 } from "./controller-worker-delivery-receipt-store";

export const REMOTE_WORKER_ENROLLMENT_V1 = "control-room.remote-worker-enrollment/v1" as const;

/** Planning identifiers only. This class saves a bounded text-review proposal;
 * it does not enroll a worker, queue a packet, or start remote work. */
export const CONTROLLER_WORKER_REMOTE_ADAPTER_V1 = "connector:controller-worker-remote-v1" as const;
export const CONTROLLER_WORKER_REMOTE_CAPABILITY_V1 = "harness.controller-worker.remote.text-review.v1" as const;
export const CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1 = "harness.controller-worker.remote.task" as const;
export const CONTROLLER_WORKER_REMOTE_START_OPERATION_V1 = "harness.controller-worker.remote.start" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

/** Public enrollment record. It deliberately contains no hostname, address, key, or tunnel detail. */
const enrollmentMaterialSchema = z.object({
  schema: z.literal(REMOTE_WORKER_ENROLLMENT_V1),
  workerId: id,
  adapterId: id,
  adapterRevision: z.string().min(7).max(180),
  enrollmentId: id,
  state: z.enum(["enrolled", "revoked"]),
  enrolledAt: instant,
  revokedAt: instant.nullable(),
}).strict();

export const remoteWorkerEnrollmentSchemaV1 = enrollmentMaterialSchema.extend({ enrollmentDigest: digest }).strict()
  .superRefine((value, context) => {
    const { enrollmentDigest, ...material } = value;
    if (enrollmentDigest !== sha256Digest(material)
      || (value.state === "enrolled") !== (value.revokedAt === null)
      || (value.revokedAt !== null && Date.parse(value.revokedAt) < Date.parse(value.enrolledAt))) {
      context.addIssue({ code: "custom", message: "remote worker enrollment mismatch" });
    }
  });
export type RemoteWorkerEnrollmentV1 = z.infer<typeof remoteWorkerEnrollmentSchemaV1>;

export function createRemoteWorkerEnrollmentV1(value: Omit<RemoteWorkerEnrollmentV1, "schema" | "enrollmentDigest">): RemoteWorkerEnrollmentV1 {
  const material = enrollmentMaterialSchema.parse({ schema: REMOTE_WORKER_ENROLLMENT_V1, ...value });
  return Object.freeze(remoteWorkerEnrollmentSchemaV1.parse({ ...material, enrollmentDigest: sha256Digest(material) }));
}

export type RemoteDeliveryAdmissionV1 =
  | Readonly<{ accepted: true; delivery: ControllerWorkerDeliveryV1; enrollment: RemoteWorkerEnrollmentV1;
      route: Readonly<{ kind: "remote"; workerId: string }>; startsWork: false; grantsExecutionAuthority: false }>
  | Readonly<{ accepted: false; reason: "worker_revoked" | "worker_binding_mismatch" | "adapter_version_incompatible";
      startsWork: false; grantsExecutionAuthority: false }>;

/**
 * Validates remote placement before the shared delivery port is called. A
 * reconnect may replace private transport details without changing this record;
 * a revoked worker or adapter-version mismatch cannot receive new work.
 */
export function admitRemoteWorkerDeliveryV1(input: {
  delivery: unknown; route: unknown; enrollment: unknown; supportedAdapterRevisions: readonly string[];
}): RemoteDeliveryAdmissionV1 {
  const delivery = controllerWorkerDeliverySchemaV1.parse(input.delivery);
  const route = controllerWorkerRouteSchemaV1.parse(input.route);
  const enrollment = remoteWorkerEnrollmentSchemaV1.parse(input.enrollment);
  if (route.kind !== "remote" || route.workerId !== delivery.worker.workerId
    || enrollment.workerId !== delivery.worker.workerId || enrollment.adapterId !== delivery.worker.adapterId) {
    return Object.freeze({ accepted: false, reason: "worker_binding_mismatch", startsWork: false, grantsExecutionAuthority: false });
  }
  if (enrollment.state === "revoked") {
    return Object.freeze({ accepted: false, reason: "worker_revoked", startsWork: false, grantsExecutionAuthority: false });
  }
  if (enrollment.adapterRevision !== delivery.worker.adapterRevision
    || !input.supportedAdapterRevisions.includes(enrollment.adapterRevision)) {
    return Object.freeze({ accepted: false, reason: "adapter_version_incompatible", startsWork: false, grantsExecutionAuthority: false });
  }
  return Object.freeze({ accepted: true, delivery, enrollment, route: Object.freeze({ kind: "remote", workerId: route.workerId }),
    startsWork: false, grantsExecutionAuthority: false });
}

/**
 * Sends an already-admitted remote packet through the one shared delivery
 * helper. This is intentionally not a remote queue, retry loop, or transport;
 * an installation injects its enrolled connection behind the same port used
 * by the local route.
 */
export async function deliverAdmittedRemoteWorkerPacketV1(port: ControllerWorkerDeliveryPortV1,
  admission: RemoteDeliveryAdmissionV1, signal?: AbortSignal): Promise<ControllerWorkerDeliveryReceiptV1> {
  if (!admission.accepted) throw new Error("remote_worker_delivery_not_admitted");
  return deliverControllerWorkerPacketV1(port, admission.delivery, admission.route, signal);
}

/**
 * The remote counterpart of the local receipt composition. It sends one
 * already-admitted packet, then retains that exact acknowledgement in the
 * installation's existing PostgreSQL authority. It is not a broker, retry
 * loop, or remote task runner; if the send outcome is uncertain, nothing is
 * persisted and reconnect reconciliation remains read-only.
 */
export async function deliverAndRecordAdmittedRemoteWorkerPacketV1(config: {
  db: DatabaseClient; integrityKey: Uint8Array; port: ControllerWorkerDeliveryPortV1;
}, admission: RemoteDeliveryAdmissionV1, recordedAt: unknown, signal?: AbortSignal) {
  if (!config || !config.db || typeof config.db.transaction !== "function"
    || !(config.integrityKey instanceof Uint8Array) || config.integrityKey.length !== 32 || !config.port) {
    throw new Error("remote_worker_delivery_unavailable");
  }
  const receipt = await deliverAdmittedRemoteWorkerPacketV1(config.port, admission, signal);
  if (!admission.accepted) throw new Error("remote_worker_delivery_not_admitted");
  const persisted = await config.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, config.integrityKey,
    admission.delivery, receipt, recordedAt));
  return Object.freeze({ receipt: persisted.receipt, replayed: persisted.replayed,
    startsWork: false as const, grantsExecutionAuthority: false as const });
}

export type RemoteDeliveryObservationV1 =
  | Readonly<{ kind: "receipt"; receipt: ControllerWorkerDeliveryReceiptV1; permitsRetry: false }>
  | Readonly<{ kind: "uncertain"; reason: "remote_disconnect" | "remote_timeout"; permitsRetry: false }>;

/** A lost remote reply is uncertainty, even if the worker may have received the packet. */
export function observeRemoteWorkerDeliveryV1(value: { result: unknown; failure?: "disconnect" | "timeout" }): RemoteDeliveryObservationV1 {
  if (value.failure === "disconnect") return Object.freeze({ kind: "uncertain", reason: "remote_disconnect", permitsRetry: false });
  if (value.failure === "timeout") return Object.freeze({ kind: "uncertain", reason: "remote_timeout", permitsRetry: false });
  // Parsing is intentionally delegated to the shared receipt contract; this
  // layer does not invent another result envelope.
  const receipt = controllerWorkerDeliveryReceiptSchemaV1.parse(value.result);
  return Object.freeze({ kind: "receipt", receipt, permitsRetry: false });
}

export type RemoteReconnectReconciliationV1 =
  | Readonly<{ kind: "receipt"; receipt: ControllerWorkerDeliveryReceiptV1; reconciled: true;
      startsWork: false; grantsExecutionAuthority: false; permitsRetry: false }>
  | Readonly<{ kind: "uncertain"; reason: "remote_reconnect_no_receipt" | "remote_reconnect_receipt_invalid";
      reconciled: false; startsWork: false; grantsExecutionAuthority: false; permitsRetry: false }>;

/**
 * Reconciles a lost remote-delivery reply after the already-enrolled worker
 * reconnects. It never resends the packet. The only acceptable recovery
 * evidence is a receipt for the exact original delivery and route, inside its
 * original delivery window. A connection without that evidence remains
 * uncertain for the normal task/review records to resolve.
 */
export function reconcileRemoteWorkerDeliveryAfterReconnectV1(input: {
  prior: RemoteDeliveryObservationV1; delivery: unknown; route: unknown; enrollment: unknown;
  supportedAdapterRevisions: readonly string[]; receipt?: unknown;
}): RemoteReconnectReconciliationV1 {
  if (input.prior.kind !== "uncertain") return Object.freeze({ kind: "uncertain", reason: "remote_reconnect_receipt_invalid",
    reconciled: false, startsWork: false, grantsExecutionAuthority: false, permitsRetry: false });
  const admission = admitRemoteWorkerDeliveryV1({ delivery: input.delivery, route: input.route,
    enrollment: input.enrollment, supportedAdapterRevisions: input.supportedAdapterRevisions });
  if (!admission.accepted || input.receipt === undefined) return Object.freeze({ kind: "uncertain", reason: "remote_reconnect_no_receipt",
    reconciled: false, startsWork: false, grantsExecutionAuthority: false, permitsRetry: false });
  try {
    const receipt = controllerWorkerDeliveryReceiptSchemaV1.parse(input.receipt);
    if (receipt.deliveryId !== admission.delivery.deliveryId || receipt.deliveryDigest !== admission.delivery.deliveryDigest
      || receipt.workerId !== admission.delivery.worker.workerId || receipt.route.kind !== "remote"
      || receipt.route.workerId !== admission.route.workerId
      || Date.parse(receipt.receivedAt) < Date.parse(admission.delivery.issuedAt)
      || Date.parse(receipt.receivedAt) > Date.parse(admission.delivery.expiresAt)) throw new Error("invalid");
    return Object.freeze({ kind: "receipt", receipt, reconciled: true, startsWork: false,
      grantsExecutionAuthority: false, permitsRetry: false });
  } catch {
    return Object.freeze({ kind: "uncertain", reason: "remote_reconnect_receipt_invalid",
      reconciled: false, startsWork: false, grantsExecutionAuthority: false, permitsRetry: false });
  }
}

/**
 * Records a receipt recovered from an enrolled worker after a lost reply.
 * It first applies the exact no-resend reconciliation rules above; only an
 * accepted, original receipt is retained. A missing or foreign receipt stays
 * uncertain and performs no database write.
 */
export async function reconcileAndRecordRemoteWorkerDeliveryAfterReconnectV1(config: {
  db: DatabaseClient; integrityKey: Uint8Array;
}, input: Parameters<typeof reconcileRemoteWorkerDeliveryAfterReconnectV1>[0], recordedAt: unknown) {
  if (!config || !config.db || typeof config.db.transaction !== "function"
    || !(config.integrityKey instanceof Uint8Array) || config.integrityKey.length !== 32) {
    throw new Error("remote_worker_delivery_unavailable");
  }
  const reconciled = reconcileRemoteWorkerDeliveryAfterReconnectV1(input);
  if (reconciled.kind !== "receipt") return reconciled;
  const delivery = controllerWorkerDeliverySchemaV1.parse(input.delivery);
  const persisted = await config.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, config.integrityKey,
    delivery, reconciled.receipt, recordedAt));
  return Object.freeze({ ...reconciled, receipt: persisted.receipt, replayed: persisted.replayed,
    startsWork: false as const, grantsExecutionAuthority: false as const, permitsRetry: false as const });
}
