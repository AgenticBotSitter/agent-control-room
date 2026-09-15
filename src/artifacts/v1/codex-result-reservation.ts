import { z } from "zod";
import { codexResultPublicationContractSchemaV1 } from "../../harness/codex-v1/result-publication-contract";
import { terminalResultEvidenceSchemaV1 } from "../../harness/v1/terminal-result-evidence";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import { sha256Digest } from "../../security";
import { checkedResultBytes, nativeResultId } from "./native-results";
import { createResultWriteReservationMachine, resultBytesVerificationDigestV1 } from "./result-write-reservation";

const stateSchema = z.enum(["reserved", "bytes_verified", "metadata_committed", "storage_uncertain"]);
const lastCertainStateSchema = z.enum(["reserved", "bytes_verified"]);

const identitySchema = z.object({
  schema: z.literal("control-room.codex-result-write-reservation-identity/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId,
  nodeId: localId, artifactId: localId, publicationId: localId, publicationContractDigest: digestSchema,
  terminalEvidenceDigest: digestSchema, qualificationReceiptBodyDigest: digestSchema,
  contentHash: digestSchema, sizeBytes: z.number().int().min(1).max(65_536),
  leaseId: localId, leaseEpoch: z.number().int().positive(), threadId: localId, turnId: localId,
  itemId: localId, projectionDigest: digestSchema, rawResultDigest: digestSchema, rawTurnDigest: digestSchema,
}).strict();

const materialSchema = z.object({
  schema: z.literal("control-room.native-result-write-reservation/v1"),
  reservationId: localId, identity: identitySchema, identityDigest: digestSchema, state: stateSchema,
  bytesVerificationDigest: digestSchema.nullable(), manifestDigest: digestSchema.nullable(),
  receiptDigest: digestSchema.nullable(), uncertaintyDigest: digestSchema.nullable(),
  lastCertainState: lastCertainStateSchema.nullable(), canonicalPublicationAllowed: z.literal(false),
  completionVerified: z.literal(false), grantsExecutionAuthority: z.literal(false),
  grantsStorageWriteAuthority: z.literal(false), permitsRetry: z.literal(false),
  permitsCleanup: z.literal(false), deletesArtifact: z.literal(false),
}).strict();

function bytesDigest(identity: z.infer<typeof identitySchema>) {
  return resultBytesVerificationDigestV1(identity);
}

export const codexResultReservationSchemaV1 = materialSchema.extend({ contractDigest: digestSchema }).strict()
  .superRefine((value, context) => {
    const { contractDigest, ...material } = value;
    const identityDigest = sha256Digest(value.identity);
    const stateMatches = value.state === "reserved"
      ? value.bytesVerificationDigest === null && value.manifestDigest === null && value.receiptDigest === null
        && value.uncertaintyDigest === null && value.lastCertainState === null
      : value.state === "bytes_verified"
        ? value.bytesVerificationDigest === bytesDigest(value.identity) && value.manifestDigest === null
          && value.receiptDigest === null && value.uncertaintyDigest === null && value.lastCertainState === null
        : value.state === "metadata_committed"
          ? value.bytesVerificationDigest === bytesDigest(value.identity) && value.manifestDigest !== null
            && value.receiptDigest !== null && value.uncertaintyDigest === null && value.lastCertainState === null
          : value.uncertaintyDigest !== null && value.lastCertainState !== null && value.manifestDigest === null
            && value.receiptDigest === null && (value.lastCertainState === "bytes_verified")
              === (value.bytesVerificationDigest === bytesDigest(value.identity));
    if (value.identity.artifactId !== nativeResultId(value.identity.tenantId, value.identity.runId)
      || value.identityDigest !== identityDigest || value.reservationId !== `reservation:codex:${identityDigest.slice(7)}`
      || value.contractDigest !== sha256Digest(material) || !stateMatches) {
      context.addIssue({ code: "custom", message: "Codex result reservation mismatch" });
    }
  });
export type CodexResultReservationV1 = z.infer<typeof codexResultReservationSchemaV1>;

const unavailable = (): never => { throw new Error("codex_result_reservation_unavailable"); };
const conflict = (): never => { throw new Error("codex_result_reservation_conflict"); };
function frozen<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) {
  for (const key of Reflect.ownKeys(value)) frozen((value as Record<PropertyKey, unknown>)[key]); Object.freeze(value);
} return value; }

/**
 * Shared lifecycle bound to the Codex identity shape. The Codex replay
 * leniency (schema self-consistency instead of explicit digest comparison)
 * is preserved exactly; schemas, digests and errors are unchanged.
 * NOTE: the material schema literal stays
 * "control-room.native-result-write-reservation/v1" byte-for-byte: existing
 * committed rows carry it, and no migration is authorized to rename it.
 */
const machine = createResultWriteReservationMachine({
  reservationSchema: codexResultReservationSchemaV1,
  materialize: ({ reservationId, identity, identityDigest, state, ...fields }) => ({
    schema: "control-room.native-result-write-reservation/v1",
    reservationId,
    identity,
    identityDigest,
    state,
    ...fields,
    canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
    grantsStorageWriteAuthority: false, permitsRetry: false, permitsCleanup: false, deletesArtifact: false,
  }),
  bytesVerificationDigest: resultBytesVerificationDigestV1,
  reservationId: identityDigest => `reservation:codex:${identityDigest.slice(7)}`,
  unavailable,
  conflict,
  compareReplayDigests: false,
});

export function reserveCodexResultWriteV1(input: { publication: unknown; evidence: unknown; existing?: unknown }) {
  try {
    const publication = codexResultPublicationContractSchemaV1.parse(input.publication);
    const evidence = terminalResultEvidenceSchemaV1.parse(input.evidence);
    if (evidence.kind !== "codex_exact_completed_turn" || evidence.lineage.tenantId !== publication.identity.tenantId
      || evidence.lineage.projectId !== publication.identity.projectId || evidence.lineage.jobId !== publication.identity.jobId
      || evidence.lineage.attemptId !== publication.identity.attemptId || evidence.lineage.runId !== publication.identity.runId
      || evidence.lineage.nodeId !== publication.identity.nodeId || evidence.content.contentHash !== publication.result.contentHash
      || evidence.content.sizeBytes !== publication.result.contentSizeBytes || evidence.source.threadId !== publication.result.threadId
      || evidence.source.turnId !== publication.result.turnId || evidence.source.itemId !== publication.result.itemId
      || evidence.source.projectionDigest !== publication.result.projectionDigest
      || evidence.source.rawResultDigest !== publication.result.rawResultDigest
      || evidence.source.matchedTurnDigest !== publication.result.rawTurnDigest
      || evidence.source.qualificationDigest !== publication.physicalQualification.receiptBodyDigest) unavailable();
    const identity = identitySchema.parse({ schema: "control-room.codex-result-write-reservation-identity/v1",
      ...publication.identity, artifactId: nativeResultId(publication.identity.tenantId, publication.identity.runId),
      publicationId: publication.publicationId, publicationContractDigest: publication.contractDigest,
      terminalEvidenceDigest: evidence.evidenceDigest,
      qualificationReceiptBodyDigest: publication.physicalQualification.receiptBodyDigest,
      contentHash: publication.result.contentHash, sizeBytes: publication.result.contentSizeBytes,
      threadId: publication.result.threadId, turnId: publication.result.turnId, itemId: publication.result.itemId,
      projectionDigest: publication.result.projectionDigest, rawResultDigest: publication.result.rawResultDigest,
      rawTurnDigest: publication.result.rawTurnDigest });
    if (input.existing !== undefined) {
      const existing = codexResultReservationSchemaV1.parse(input.existing);
      if (existing.identityDigest !== sha256Digest(identity)) conflict();
      return frozen(existing);
    }
    return machine.buildReserved(identity) as CodexResultReservationV1;
  } catch (error) { if (error instanceof Error && error.message === "codex_result_reservation_conflict") throw error; return unavailable(); }
}

export function verifyCodexResultReservationBytesV1(reservationValue: unknown, bytes: Uint8Array) {
  try {
    return machine.verifyBytes(reservationValue, bytes, checkedResultBytes) as CodexResultReservationV1;
  } catch { return unavailable(); }
}

export function commitCodexResultReservationMetadataV1(input: { reservation: unknown; manifestDigest: string; receiptDigest: string }) {
  try {
    const reservation = codexResultReservationSchemaV1.parse(input.reservation);
    digestSchema.parse(input.manifestDigest); digestSchema.parse(input.receiptDigest);
    return machine.commitMetadata(reservation, input.manifestDigest, input.receiptDigest) as CodexResultReservationV1;
  } catch (error) { if (error instanceof Error && error.message === "codex_result_reservation_conflict") throw error; return unavailable(); }
}

export function markCodexResultReservationStorageUncertainV1(input: { reservation: unknown; uncertaintyDigest: string }) {
  try {
    const reservation = codexResultReservationSchemaV1.parse(input.reservation);
    digestSchema.parse(input.uncertaintyDigest);
    return machine.markStorageUncertain(reservation, input.uncertaintyDigest) as CodexResultReservationV1;
  } catch { return unavailable(); }
}
