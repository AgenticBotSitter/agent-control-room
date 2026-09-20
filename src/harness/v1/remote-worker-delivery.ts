import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  controllerWorkerDeliveryReceiptSchemaV1,
  type ControllerWorkerDeliveryReceiptV1, type ControllerWorkerDeliveryV1 } from "./controller-worker-delivery";

export const REMOTE_WORKER_ENROLLMENT_V1 = "control-room.remote-worker-enrollment/v1" as const;

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
