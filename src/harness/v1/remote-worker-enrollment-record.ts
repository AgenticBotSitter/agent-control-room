import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { remoteWorkerEnrollmentSchemaV1 } from "./remote-worker-delivery";

/** Canonical, database-owned authority for one accepted remote worker. */
export const REMOTE_WORKER_ENROLLMENT_RECORD_V1 =
  "control-room.remote-worker-enrollment-record/v1" as const;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const lifecycle = z.enum(["enrolled", "draining", "quarantined", "revoked"]);

export type RemoteWorkerEnrollmentLifecycleV1 = z.infer<typeof lifecycle>;

export type RemoteWorkerEnrollmentRecordV1 = Readonly<{
  schema: typeof REMOTE_WORKER_ENROLLMENT_RECORD_V1;
  tenantId: string;
  nodeId: string;
  nodeKeyId: string;
  workerId: string;
  adapterId: string;
  adapterRevision: string;
  capabilityDigest: string;
  enrollmentId: string;
  enrollmentDigest: string;
  releaseBindingDigest: string;
  revision: number;
  state: RemoteWorkerEnrollmentLifecycleV1;
  enrolledAt: string;
  updatedAt: string;
  evidenceDigest?: string;
  previousRecordDigest: string | null;
  recordDigest: string;
}>;

const recordSchema = z.object({
  schema: z.literal(REMOTE_WORKER_ENROLLMENT_RECORD_V1),
  tenantId: id,
  nodeId: id,
  nodeKeyId: id,
  workerId: id,
  adapterId: id,
  adapterRevision: z.string().min(7).max(180),
  capabilityDigest: digest,
  enrollmentId: id,
  enrollmentDigest: digest,
  releaseBindingDigest: digest,
  revision: z.number().int().min(0),
  state: lifecycle,
  enrolledAt: instant,
  updatedAt: instant,
  evidenceDigest: digest.optional(),
  previousRecordDigest: digest.nullable(),
  recordDigest: digest,
}).strict();

function freezeRecord(material: Omit<RemoteWorkerEnrollmentRecordV1, "recordDigest">): RemoteWorkerEnrollmentRecordV1 {
  return Object.freeze({ ...material, recordDigest: sha256Digest(material) });
}

/**
 * Creates revision zero from the existing safe delivery enrollment envelope.
 * This value alone starts no connection, delivery, transport, or worker.
 */
export function createRemoteWorkerEnrollmentRecordV1(input: Readonly<{
  tenantId: unknown;
  nodeId: unknown;
  nodeKeyId: unknown;
  enrollment: unknown;
  capabilityDigest: unknown;
  releaseBindingDigest: unknown;
  now: unknown;
}>): RemoteWorkerEnrollmentRecordV1 {
  const enrollment = remoteWorkerEnrollmentSchemaV1.parse(input.enrollment);
  const updatedAt = instant.parse(input.now);
  if (enrollment.state !== "enrolled" || Date.parse(updatedAt) < Date.parse(enrollment.enrolledAt)) {
    throw new Error("remote_worker_enrollment_record_invalid");
  }
  return freezeRecord({
    schema: REMOTE_WORKER_ENROLLMENT_RECORD_V1,
    tenantId: id.parse(input.tenantId),
    nodeId: id.parse(input.nodeId),
    nodeKeyId: id.parse(input.nodeKeyId),
    workerId: enrollment.workerId,
    adapterId: enrollment.adapterId,
    adapterRevision: enrollment.adapterRevision,
    capabilityDigest: digest.parse(input.capabilityDigest),
    enrollmentId: enrollment.enrollmentId,
    enrollmentDigest: enrollment.enrollmentDigest,
    releaseBindingDigest: digest.parse(input.releaseBindingDigest),
    revision: 0,
    state: "enrolled",
    enrolledAt: enrollment.enrolledAt,
    updatedAt,
    previousRecordDigest: null,
  });
}

export function verifyRemoteWorkerEnrollmentRecordV1(value: unknown): RemoteWorkerEnrollmentRecordV1 {
  const parsed = recordSchema.parse(value);
  const { recordDigest, ...material } = parsed;
  if (recordDigest !== sha256Digest(material)
    || Date.parse(parsed.updatedAt) < Date.parse(parsed.enrolledAt)
    || (parsed.revision === 0) !== (parsed.previousRecordDigest === null)
    || (parsed.revision === 0) !== (parsed.evidenceDigest === undefined)
    || (parsed.revision === 0 && parsed.state !== "enrolled")) {
    throw new Error("remote_worker_enrollment_record_invalid");
  }
  return Object.freeze(parsed);
}

/** Appends a monotonic lifecycle revision without changing any authority binding. */
export function advanceRemoteWorkerEnrollmentRecordV1(currentValue: unknown, input: Readonly<{
  expectedRevision: unknown;
  state: unknown;
  evidenceDigest: unknown;
  now: unknown;
}>): RemoteWorkerEnrollmentRecordV1 {
  const current = verifyRemoteWorkerEnrollmentRecordV1(currentValue);
  const expectedRevision = z.number().int().min(0).parse(input.expectedRevision);
  const nextState = lifecycle.parse(input.state);
  const updatedAt = instant.parse(input.now);
  if (expectedRevision !== current.revision || Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error("remote_worker_enrollment_conflict");
  }
  const allowed: Readonly<Record<RemoteWorkerEnrollmentLifecycleV1, readonly RemoteWorkerEnrollmentLifecycleV1[]>> = {
    enrolled: ["draining", "quarantined", "revoked"],
    draining: ["quarantined", "revoked"],
    quarantined: ["revoked"],
    revoked: [],
  };
  if (!allowed[current.state].includes(nextState)) throw new Error("remote_worker_enrollment_lifecycle_invalid");
  const { recordDigest: _recordDigest, evidenceDigest: _evidenceDigest, ...fixed } = current;
  return freezeRecord({
    ...fixed,
    revision: current.revision + 1,
    state: nextState,
    updatedAt,
    evidenceDigest: digest.parse(input.evidenceDigest),
    previousRecordDigest: current.recordDigest,
  });
}
