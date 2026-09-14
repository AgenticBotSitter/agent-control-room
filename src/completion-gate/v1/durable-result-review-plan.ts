import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import type { DurableResultReceiptV1 } from "../../artifacts/v1/durable-result-receipt";
import type { CompletionReviewTargetV1 } from "./types";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

/**
 * Harness-neutral review plan. The `harness` discriminator routes every
 * later read to the matching harness evidence rule: a plan recorded for
 * native evidence can never authorize a Codex-discriminated receipt, and
 * planning never accepts quality, verifies completion, or releases capacity.
 */
export const durableResultReviewPlanSchemaV1 = z.object({
  schema: z.literal("control-room.durable-result-review-plan/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId, nodeId: localId,
  harness: z.enum(["native", "codex"]),
  receiptDigest: digestSchema,
  snapshotDigest: digestSchema.nullable(),
  publicationContractDigest: digestSchema.nullable(),
  terminalEvidenceDigest: digestSchema.nullable(),
  acceptanceProfileId: localId, acceptanceProfileDigest: digestSchema, plannedAt: instant,
  targetId: localId,
  qualityAccepted: z.literal(false), completionVerified: z.literal(false),
  releasesCapacity: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  const nativeEvidence = value.snapshotDigest !== null
    && value.publicationContractDigest === null && value.terminalEvidenceDigest === null;
  const codexEvidence = value.publicationContractDigest !== null && value.terminalEvidenceDigest !== null
    && value.snapshotDigest === null;
  if ((value.harness === "native") !== nativeEvidence || (value.harness === "codex") !== codexEvidence) {
    context.addIssue({ code: "custom", message: "durable review plan harness evidence mismatch" });
  }
});

export type DurableResultReviewPlanV1 = z.infer<typeof durableResultReviewPlanSchemaV1>;
export type DurableResultReviewPlanRowV1 = { tenant_id: string; project_id: string; job_id: string; run_id: string;
  plan: unknown; auth_tag: string };

function unavailable(): never { throw new Error("durable_result_review_plan_unavailable"); }

export const durableResultReviewPlanTagV1 = (key: Uint8Array, plan: DurableResultReviewPlanV1): string =>
  hmacSha256Tag(key, { purpose: "durable-result-review-plan/v1", plan });

export function verifyDurableResultReviewPlanV1(key: Uint8Array, row: DurableResultReviewPlanRowV1): DurableResultReviewPlanV1 {
  const plan = durableResultReviewPlanSchemaV1.parse(row.plan);
  const expected = Buffer.from(durableResultReviewPlanTagV1(key, plan)), actual = Buffer.from(row.auth_tag);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || row.tenant_id !== plan.tenantId
    || row.project_id !== plan.projectId || row.job_id !== plan.jobId || row.run_id !== plan.runId) unavailable();
  return plan;
}

export async function readDurableResultReviewPlanV1(tx: DatabaseSession, key: Uint8Array,
  tenantId: string, projectId: string, jobId: string): Promise<DurableResultReviewPlanV1 | undefined> {
  const row = (await tx.query<DurableResultReviewPlanRowV1>(`SELECT * FROM control_native_review_plans
    WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3`, [tenantId, projectId, jobId])).rows[0];
  if (!row) return undefined;
  if (!durableResultReviewPlanSchemaV1.safeParse(row.plan).success) return undefined;
  return verifyDurableResultReviewPlanV1(key, row);
}

/** Derives the single pending owner-review target. It records no decision of any kind. */
export function durableReviewTargetV1(plan: DurableResultReviewPlanV1, receipt: DurableResultReceiptV1): CompletionReviewTargetV1 {
  if (receipt.schema !== "control-room.durable-result-receipt/v1" || receipt.harness !== plan.harness
    || receipt.tenantId !== plan.tenantId || receipt.projectId !== plan.projectId || receipt.jobId !== plan.jobId
    || receipt.attemptId !== plan.attemptId || receipt.runId !== plan.runId || receipt.nodeId !== plan.nodeId
    || sha256Digest(receipt) !== plan.receiptDigest
    || (plan.harness === "native"
      ? receipt.snapshotDigest !== plan.snapshotDigest
      : receipt.publicationContractDigest !== plan.publicationContractDigest
        || receipt.terminalEvidenceDigest !== plan.terminalEvidenceDigest)
    || Date.parse(receipt.receivedAt) < Date.parse(plan.plannedAt)) unavailable();
  return { schemaVersion: "control-room-completion-gate/v1", id: plan.targetId, tenantId: plan.tenantId,
    projectId: plan.projectId, kind: "document", subjectId: plan.jobId,
    subjectDigest: receipt.contentHash, acceptanceProfileId: plan.acceptanceProfileId,
    acceptanceProfileDigest: plan.acceptanceProfileDigest, producer: { actorId: plan.nodeId, actorType: "agent" },
    rootTargetId: plan.targetId, revisionNumber: 0, submittedAt: receipt.receivedAt };
}
