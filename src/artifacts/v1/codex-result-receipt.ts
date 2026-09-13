import { z } from "zod";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

/** Canonical Codex artifact metadata. This is deliberately presentation-neutral: accepting
 * this receipt never accepts quality, completes work, or releases capacity. */
export const codexResultReceiptSchemaV1 = z.object({
  schema: z.literal("control-room.codex-result-receipt/v1"), artifactId: localId,
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId, nodeId: localId,
  publicationId: localId, publicationContractDigest: digestSchema, terminalEvidenceDigest: digestSchema,
  qualificationReceiptBodyDigest: digestSchema, qualificationSignerKeyId: localId,
  threadId: localId, turnId: localId, itemId: localId, projectionDigest: digestSchema,
  rawResultDigest: digestSchema, rawTurnDigest: digestSchema, contentHash: digestSchema,
  sizeBytes: z.number().int().min(1).max(65_536), manifestDigest: digestSchema, receivedAt: instant,
  byteCheck: z.literal("matched_recorded_claim"), qualityAccepted: z.literal(false),
  canonicalPublicationAllowed: z.literal(false), completionVerified: z.literal(false),
  releasesCapacity: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
export type CodexResultReceiptV1 = z.infer<typeof codexResultReceiptSchemaV1>;
