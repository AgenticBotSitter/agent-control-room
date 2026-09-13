import { z } from "zod";
import { codexResultPublicationContractSchemaV1 } from "../../harness/codex-v1/result-publication-contract";
import { terminalResultEvidenceSchemaV1 } from "../../harness/v1/terminal-result-evidence";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import { sha256Digest } from "../../security";
import { checkedResultBytes, nativeResultId } from "./native-results";

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
  return sha256Digest({ artifactId: identity.artifactId, contentHash: identity.contentHash,
    sizeBytes: identity.sizeBytes, verifiedBytesHash: identity.contentHash, verifiedSizeBytes: identity.sizeBytes });
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

function build(identity: z.infer<typeof identitySchema>, state: z.infer<typeof stateSchema>, fields: {
  bytesVerificationDigest: string | null; manifestDigest: string | null; receiptDigest: string | null;
  uncertaintyDigest: string | null; lastCertainState: z.infer<typeof lastCertainStateSchema> | null;
}) {
  const identityDigest = sha256Digest(identity);
  const material = materialSchema.parse({ schema: "control-room.native-result-write-reservation/v1",
    reservationId: `reservation:codex:${identityDigest.slice(7)}`, identity, identityDigest, state, ...fields,
    canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
    grantsStorageWriteAuthority: false, permitsRetry: false, permitsCleanup: false, deletesArtifact: false });
  return frozen(codexResultReservationSchemaV1.parse({ ...material, contractDigest: sha256Digest(material) }));
}

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
    return build(identity, "reserved", { bytesVerificationDigest: null, manifestDigest: null,
      receiptDigest: null, uncertaintyDigest: null, lastCertainState: null });
  } catch (error) { if (error instanceof Error && error.message === "codex_result_reservation_conflict") throw error; return unavailable(); }
}

export function verifyCodexResultReservationBytesV1(reservationValue: unknown, bytes: Uint8Array) {
  try {
    const reservation = codexResultReservationSchemaV1.parse(reservationValue);
    checkedResultBytes(bytes, reservation.identity);
    if (reservation.state === "storage_uncertain") unavailable();
    if (reservation.bytesVerificationDigest !== null) return frozen(reservation);
    if (reservation.state !== "reserved") unavailable();
    return build(reservation.identity, "bytes_verified", { bytesVerificationDigest: bytesDigest(reservation.identity),
      manifestDigest: null, receiptDigest: null, uncertaintyDigest: null, lastCertainState: null });
  } catch { return unavailable(); }
}

export function commitCodexResultReservationMetadataV1(input: { reservation: unknown; manifestDigest: string; receiptDigest: string }) {
  try {
    const reservation = codexResultReservationSchemaV1.parse(input.reservation);
    digestSchema.parse(input.manifestDigest); digestSchema.parse(input.receiptDigest);
    if (reservation.state === "metadata_committed") {
      if (reservation.manifestDigest !== input.manifestDigest || reservation.receiptDigest !== input.receiptDigest) conflict();
      return frozen(reservation);
    }
    if (reservation.state !== "bytes_verified") unavailable();
    return build(reservation.identity, "metadata_committed", { bytesVerificationDigest: reservation.bytesVerificationDigest,
      manifestDigest: input.manifestDigest, receiptDigest: input.receiptDigest, uncertaintyDigest: null, lastCertainState: null });
  } catch (error) { if (error instanceof Error && error.message === "codex_result_reservation_conflict") throw error; return unavailable(); }
}

export function markCodexResultReservationStorageUncertainV1(input: { reservation: unknown; uncertaintyDigest: string }) {
  try {
    const reservation = codexResultReservationSchemaV1.parse(input.reservation);
    digestSchema.parse(input.uncertaintyDigest);
    if (reservation.state === "storage_uncertain") return frozen(reservation);
    if (reservation.state !== "reserved" && reservation.state !== "bytes_verified") unavailable();
    const lastCertainState = reservation.state === "reserved" ? "reserved" as const : "bytes_verified" as const;
    return build(reservation.identity, "storage_uncertain", { bytesVerificationDigest: reservation.bytesVerificationDigest,
      manifestDigest: null, receiptDigest: null, uncertaintyDigest: input.uncertaintyDigest, lastCertainState });
  } catch { return unavailable(); }
}
