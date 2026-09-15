import { z } from "zod";
import { nativeTaskSnapshotBodySchema } from "../../harness/v1/native-observation";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import { sha256Digest } from "../../security";
import { checkedResultBytes, nativeResultId } from "./native-results";
import { createResultWriteReservationMachine, resultBytesVerificationDigestV1 } from "./result-write-reservation";

export const NATIVE_RESULT_RESERVATION_SCHEMA_V1 =
  "control-room.native-result-write-reservation/v1" as const;

const stateSchema = z.enum(["reserved", "bytes_verified", "metadata_committed", "storage_uncertain"]);
const lastCertainStateSchema = z.enum(["reserved", "bytes_verified"]);

const reservationIdentitySchemaV1 = z.object({
  schema: z.literal("control-room.native-result-write-reservation-identity/v1"),
  tenantId: localId,
  projectId: localId,
  jobId: localId,
  attemptId: localId,
  runId: localId,
  nodeId: localId,
  artifactId: localId,
  snapshotDigest: digestSchema,
  snapshotVersion: z.number().int().positive(),
  contentHash: digestSchema,
  sizeBytes: z.number().int().nonnegative().max(65_536),
  leaseId: localId,
  leaseEpoch: z.number().int().positive(),
  bindingDigest: digestSchema,
  sessionKeyDigest: digestSchema,
  nativeRunKeyDigest: digestSchema,
}).strict();

const reservationMaterialSchemaV1 = z.object({
  schema: z.literal(NATIVE_RESULT_RESERVATION_SCHEMA_V1),
  reservationId: localId,
  identity: reservationIdentitySchemaV1,
  identityDigest: digestSchema,
  state: stateSchema,
  bytesVerificationDigest: digestSchema.nullable(),
  manifestDigest: digestSchema.nullable(),
  receiptDigest: digestSchema.nullable(),
  uncertaintyDigest: digestSchema.nullable(),
  lastCertainState: lastCertainStateSchema.nullable(),
  canonicalPublicationAllowed: z.literal(false),
  completionVerified: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  grantsStorageWriteAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsCleanup: z.literal(false),
  deletesArtifact: z.literal(false),
}).strict();

function bytesVerificationDigestV1(_identity: z.infer<typeof reservationIdentitySchemaV1>): string {
  return resultBytesVerificationDigestV1(_identity);
}

export const nativeResultReservationSchemaV1 = reservationMaterialSchemaV1.extend({
  contractDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { contractDigest, ...material } = value;
  const identityDigest = sha256Digest(value.identity);
  if (value.identity.artifactId !== nativeResultId(value.identity.tenantId, value.identity.runId)
    || value.identityDigest !== identityDigest
    || value.reservationId !== `reservation:native:${identityDigest.slice(7)}`
    || (value.bytesVerificationDigest !== null
      && value.bytesVerificationDigest !== bytesVerificationDigestV1(value.identity))
    || value.contractDigest !== sha256Digest(material)) {
    context.addIssue({ code: "custom", message: "native result reservation identity mismatch" });
  }
  const reserved = value.state === "reserved" && value.bytesVerificationDigest === null
    && value.manifestDigest === null && value.receiptDigest === null
    && value.uncertaintyDigest === null && value.lastCertainState === null;
  const bytesVerified = value.state === "bytes_verified" && value.bytesVerificationDigest !== null
    && value.manifestDigest === null && value.receiptDigest === null
    && value.uncertaintyDigest === null && value.lastCertainState === null;
  const metadataCommitted = value.state === "metadata_committed" && value.bytesVerificationDigest !== null
    && value.manifestDigest !== null && value.receiptDigest !== null
    && value.uncertaintyDigest === null && value.lastCertainState === null;
  const uncertain = value.state === "storage_uncertain" && value.uncertaintyDigest !== null
    && value.lastCertainState !== null && value.manifestDigest === null && value.receiptDigest === null
    && (value.lastCertainState === "bytes_verified") === (value.bytesVerificationDigest !== null);
  if (!reserved && !bytesVerified && !metadataCommitted && !uncertain) {
    context.addIssue({ code: "custom", message: "native result reservation state evidence mismatch" });
  }
});

export type NativeResultReservationV1 = z.infer<typeof nativeResultReservationSchemaV1>;

function unavailable(): never { throw new Error("native_result_reservation_unavailable"); }
function conflict(): never { throw new Error("native_result_reservation_conflict"); }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** Shared lifecycle bound to the native identity shape; schemas, digests and errors are unchanged. */
const machine = createResultWriteReservationMachine({
  reservationSchema: nativeResultReservationSchemaV1,
  materialize: ({ reservationId, identity, identityDigest, state, ...fields }) => ({
    schema: NATIVE_RESULT_RESERVATION_SCHEMA_V1,
    reservationId,
    identity,
    identityDigest,
    state,
    ...fields,
    canonicalPublicationAllowed: false,
    completionVerified: false,
    grantsExecutionAuthority: false,
    grantsStorageWriteAuthority: false,
    permitsRetry: false,
    permitsCleanup: false,
    deletesArtifact: false,
  }),
  bytesVerificationDigest: resultBytesVerificationDigestV1,
  reservationId: identityDigest => `reservation:native:${identityDigest.slice(7)}`,
  unavailable,
  conflict,
  compareReplayDigests: true,
});

function reservationIdentity(input: { tenantId: string; nodeId: string; snapshot: unknown }) {
  const tenantId = localId.parse(input.tenantId), nodeId = localId.parse(input.nodeId);
  const snapshot = nativeTaskSnapshotBodySchema.parse(input.snapshot);
  if (snapshot.state !== "completed" || snapshot.result === null || snapshot.nativeRunKeyDigest === null) unavailable();
  return reservationIdentitySchemaV1.parse({
    schema: "control-room.native-result-write-reservation-identity/v1",
    tenantId,
    projectId: snapshot.projectId,
    jobId: snapshot.jobId,
    attemptId: snapshot.attemptId,
    runId: snapshot.runId,
    nodeId,
    artifactId: nativeResultId(tenantId, snapshot.runId),
    snapshotDigest: sha256Digest(snapshot),
    snapshotVersion: snapshot.snapshotVersion,
    contentHash: snapshot.result.contentHash,
    sizeBytes: snapshot.result.sizeBytes,
    leaseId: snapshot.leaseId,
    leaseEpoch: snapshot.leaseEpoch,
    bindingDigest: snapshot.bindingDigest,
    sessionKeyDigest: snapshot.sessionKeyDigest,
    nativeRunKeyDigest: snapshot.nativeRunKeyDigest,
  });
}

/** Pure pre-write reservation. Exact replay returns the current reservation; any changed binding refuses. */
export function reserveNativeResultWriteV1(input: {
  tenantId: string;
  nodeId: string;
  snapshot: unknown;
  existing?: unknown;
}): NativeResultReservationV1 {
  try {
    const parsedInput = z.object({ tenantId: localId, nodeId: localId,
      snapshot: nativeTaskSnapshotBodySchema, existing: z.unknown().optional() }).strict().parse(input);
    const identity = reservationIdentity(parsedInput);
    if (parsedInput.existing !== undefined) {
      const existing = nativeResultReservationSchemaV1.parse(parsedInput.existing);
      if (existing.identityDigest !== sha256Digest(identity)) conflict();
      return deepFreeze(existing);
    }
    return machine.buildReserved(identity) as NativeResultReservationV1;
  } catch (error) {
    if (error instanceof Error && error.message === "native_result_reservation_conflict") throw error;
    return unavailable();
  }
}

/** Verifies exact bytes without writing them. A replay cannot escape a later or uncertain state. */
export function verifyNativeResultReservationBytesV1(
  reservationValue: unknown,
  bytesValue: Uint8Array,
): NativeResultReservationV1 {
  return machine.verifyBytes(reservationValue, bytesValue, checkedResultBytes) as NativeResultReservationV1;
}

/** Records only proposed metadata evidence in the contract; it performs no metadata or byte write. */
export function commitNativeResultReservationMetadataV1(input: {
  reservation: unknown;
  manifestDigest: string;
  receiptDigest: string;
}): NativeResultReservationV1 {
  try {
    const parsedInput = z.object({ reservation: z.unknown(), manifestDigest: digestSchema,
      receiptDigest: digestSchema }).strict().parse(input);
    return machine.commitMetadata(parsedInput.reservation,
      parsedInput.manifestDigest, parsedInput.receiptDigest) as NativeResultReservationV1;
  } catch (error) {
    if (error instanceof Error && error.message === "native_result_reservation_conflict") throw error;
    return unavailable();
  }
}

/** Marks an unresolved storage boundary. It cannot be cleared, retried, or converted to committed. */
export function markNativeResultReservationStorageUncertainV1(input: {
  reservation: unknown;
  uncertaintyDigest: string;
}): NativeResultReservationV1 {
  try {
    const parsedInput = z.object({ reservation: z.unknown(), uncertaintyDigest: digestSchema }).strict().parse(input);
    return machine.markStorageUncertain(parsedInput.reservation,
      parsedInput.uncertaintyDigest) as NativeResultReservationV1;
  } catch (error) {
    if (error instanceof Error && error.message === "native_result_reservation_conflict") throw error;
    return unavailable();
  }
}

const reconciliationMaterialSchemaV1 = z.object({
  schema: z.literal("control-room.native-result-write-reconciliation/v1"),
  reservationId: localId,
  artifactId: localId,
  reservationContractDigest: digestSchema,
  observedState: stateSchema,
  disposition: z.enum(["metadata_already_committed", "manual_reconciliation_required"]),
  autoRetriesWrite: z.literal(false),
  autoDeletesBytes: z.literal(false),
  autoCommitsMetadata: z.literal(false),
  grantsStorageWriteAuthority: z.literal(false),
  canonicalPublicationAllowed: z.literal(false),
  completionVerified: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsCleanup: z.literal(false),
}).strict();

export const nativeResultReconciliationSchemaV1 = reconciliationMaterialSchemaV1.extend({
  reconciliationDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { reconciliationDigest, ...material } = value;
  if (reconciliationDigest !== sha256Digest(material)
    || (value.observedState === "metadata_committed") !== (value.disposition === "metadata_already_committed")) {
    context.addIssue({ code: "custom", message: "native result reconciliation mismatch" });
  }
});

/** Crash/readback decision only. It never retries, deletes, writes metadata, or grants cleanup. */
export function reconcileNativeResultReservationCrashV1(value: unknown) {
  try {
    const reservation = nativeResultReservationSchemaV1.parse(value);
    const material = reconciliationMaterialSchemaV1.parse({
      schema: "control-room.native-result-write-reconciliation/v1",
      reservationId: reservation.reservationId,
      artifactId: reservation.identity.artifactId,
      reservationContractDigest: reservation.contractDigest,
      observedState: reservation.state,
      disposition: reservation.state === "metadata_committed"
        ? "metadata_already_committed" : "manual_reconciliation_required",
      autoRetriesWrite: false,
      autoDeletesBytes: false,
      autoCommitsMetadata: false,
      grantsStorageWriteAuthority: false,
      canonicalPublicationAllowed: false,
      completionVerified: false,
      grantsExecutionAuthority: false,
      permitsRetry: false,
      permitsCleanup: false,
    });
    return deepFreeze(nativeResultReconciliationSchemaV1.parse({
      ...material, reconciliationDigest: sha256Digest(material),
    }));
  } catch { return unavailable(); }
}
