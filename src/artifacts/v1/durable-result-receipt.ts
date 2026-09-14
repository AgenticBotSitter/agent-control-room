import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import { hmacSha256Tag } from "../../security";
import type { NativeResultReceipt } from "./native-results";
import type { CodexResultReceiptV1 } from "./codex-result-receipt";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

/**
 * Harness-neutral durable result receipt. The `harness` discriminator states
 * which adapter authenticated the terminal evidence, and the schema requires
 * exactly that harness's evidence facts: snapshot facts for native,
 * thread/turn qualification facts for Codex. A native receipt can never be
 * relabelled Codex (or the reverse) because the required facts differ.
 */
export const durableResultReceiptSchemaV1 = z.object({
  schema: z.literal("control-room.durable-result-receipt/v1"),
  artifactId: z.string().regex(/^artifact:result:[a-f0-9]{64}$/),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId, nodeId: localId,
  harness: z.enum(["native", "codex"]),
  snapshotDigest: digestSchema.nullable(),
  snapshotVersion: z.number().int().positive().nullable(),
  publicationContractDigest: digestSchema.nullable(),
  terminalEvidenceDigest: digestSchema.nullable(),
  threadId: localId.nullable(), turnId: localId.nullable(), itemId: localId.nullable(),
  contentHash: digestSchema, sizeBytes: z.number().int().min(0).max(65_536),
  manifestDigest: digestSchema, receivedAt: instant,
  byteCheck: z.literal("matched_recorded_claim"), qualityAccepted: z.literal(false),
  canonicalPublicationAllowed: z.literal(false), completionVerified: z.literal(false),
  releasesCapacity: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  const nativeEvidence = value.snapshotDigest !== null && value.snapshotVersion !== null
    && value.publicationContractDigest === null && value.terminalEvidenceDigest === null
    && value.threadId === null && value.turnId === null && value.itemId === null;
  const codexEvidence = value.publicationContractDigest !== null && value.terminalEvidenceDigest !== null
    && value.threadId !== null && value.turnId !== null && value.itemId !== null
    && value.snapshotDigest === null && value.snapshotVersion === null;
  if ((value.harness === "native") !== nativeEvidence || (value.harness === "codex") !== codexEvidence) {
    context.addIssue({ code: "custom", message: "durable result receipt harness evidence mismatch" });
  }
});

export type DurableResultReceiptV1 = z.infer<typeof durableResultReceiptSchemaV1>;

function unavailable(): never { throw new Error("durable_result_receipt_unavailable"); }

/** Content-derived neutral artifact identity for the shared path. Legacy harness identifiers are retained, never renamed. */
export const durableResultArtifactIdV1 = (contentHash: string): string => {
  const parsed = digestSchema.parse(contentHash);
  return `artifact:result:${parsed.slice("sha256:".length)}`;
};

export const durableResultReceiptTagV1 = (key: Uint8Array, receipt: DurableResultReceiptV1): string =>
  hmacSha256Tag(key, { purpose: "durable-result-receipt/v1", receipt });

function verifyDurableResultReceiptAuthTagV1(receipt: DurableResultReceiptV1, key: Uint8Array, authTag: string): void {
  const expected = Buffer.from(durableResultReceiptTagV1(key, receipt)), actual = Buffer.from(authTag);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) unavailable();
}

export function verifyDurableResultReceiptV1(receiptValue: unknown, key: Uint8Array, authTag: string): DurableResultReceiptV1 {
  try {
    const receipt = durableResultReceiptSchemaV1.parse(receiptValue);
    verifyDurableResultReceiptAuthTagV1(receipt, key, authTag);
    return receipt;
  } catch { return unavailable(); }
}

/** One-way labeled conversion: a native receipt becomes a native-discriminated neutral receipt. */
export function durableReceiptFromNativeV1(receipt: NativeResultReceipt): DurableResultReceiptV1 {
  try {
    if (receipt.schema !== "control-room.native-result-receipt/v1") return unavailable();
    return durableResultReceiptSchemaV1.parse({ schema: "control-room.durable-result-receipt/v1",
      artifactId: durableResultArtifactIdV1(receipt.contentHash),
      tenantId: receipt.tenantId, projectId: receipt.projectId, jobId: receipt.jobId,
      attemptId: receipt.attemptId, runId: receipt.runId, nodeId: receipt.nodeId, harness: "native",
      snapshotDigest: receipt.snapshotDigest, snapshotVersion: receipt.snapshotVersion,
      publicationContractDigest: null, terminalEvidenceDigest: null, threadId: null, turnId: null, itemId: null,
      contentHash: receipt.contentHash, sizeBytes: receipt.sizeBytes, manifestDigest: receipt.manifestDigest,
      receivedAt: receipt.receivedAt, byteCheck: "matched_recorded_claim", qualityAccepted: false,
      canonicalPublicationAllowed: false, completionVerified: false, releasesCapacity: false,
      grantsExecutionAuthority: false });
  } catch { return unavailable(); }
}

/** One-way labeled conversion: a Codex receipt becomes a codex-discriminated neutral receipt. */
export function durableReceiptFromCodexV1(receipt: CodexResultReceiptV1): DurableResultReceiptV1 {
  try {
    if (receipt.schema !== "control-room.codex-result-receipt/v1") return unavailable();
    return durableResultReceiptSchemaV1.parse({ schema: "control-room.durable-result-receipt/v1",
      artifactId: durableResultArtifactIdV1(receipt.contentHash),
      tenantId: receipt.tenantId, projectId: receipt.projectId, jobId: receipt.jobId,
      attemptId: receipt.attemptId, runId: receipt.runId, nodeId: receipt.nodeId, harness: "codex",
      snapshotDigest: null, snapshotVersion: null,
      publicationContractDigest: receipt.publicationContractDigest,
      terminalEvidenceDigest: receipt.terminalEvidenceDigest,
      threadId: receipt.threadId, turnId: receipt.turnId, itemId: receipt.itemId,
      contentHash: receipt.contentHash, sizeBytes: receipt.sizeBytes, manifestDigest: receipt.manifestDigest,
      receivedAt: receipt.receivedAt, byteCheck: "matched_recorded_claim", qualityAccepted: false,
      canonicalPublicationAllowed: false, completionVerified: false, releasesCapacity: false,
      grantsExecutionAuthority: false });
  } catch { return unavailable(); }
}
