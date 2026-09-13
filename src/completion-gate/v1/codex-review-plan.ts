import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CodexResultReceiptV1 } from "../../artifacts/v1/codex-result-receipt";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import type { DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import type { CompletionReviewTargetV1, CompletionRevisionV1 } from "./types";
import { nativeRevisionContextSchema } from "./native-revision-context";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const material = z.object({ tenantId: localId, projectId: localId, jobId: localId, attemptId: localId,
  runId: localId, nodeId: localId, publicationId: localId, publicationContractDigest: digestSchema,
  terminalEvidenceDigest: digestSchema, taskPlanDigest: digestSchema, activationIntentRecordDigest: digestSchema,
  acceptanceProfileId: localId, acceptanceProfileDigest: digestSchema, plannedAt: instant, targetId: localId,
  qualityAccepted: z.literal(false), completionVerified: z.literal(false), releasesCapacity: z.literal(false),
  grantsExecutionAuthority: z.literal(false) }).strict();
const initial = material.extend({ schema: z.literal("control-room.codex-review-plan/v1") }).strict();
const revision = material.extend({ schema: z.literal("control-room.codex-review-plan/v2"),
  revision: nativeRevisionContextSchema }).strict();
export const codexReviewPlanSchemaV1 = z.discriminatedUnion("schema", [initial, revision]);
export type CodexReviewPlanV1 = z.infer<typeof codexReviewPlanSchemaV1>;
export type CodexReviewPlanRowV1 = { tenant_id: string; project_id: string; job_id: string; run_id: string;
  plan: unknown; auth_tag: string };

export const codexReviewPlanTagV1 = (key: Uint8Array, plan: CodexReviewPlanV1) => hmacSha256Tag(key,
  { purpose: plan.schema === "control-room.codex-review-plan/v1" ? "codex-review-plan/v1" : "codex-review-plan/v2", plan });

export function verifyCodexReviewPlanV1(key: Uint8Array, row: CodexReviewPlanRowV1) {
  const plan = codexReviewPlanSchemaV1.parse(row.plan);
  const expected = Buffer.from(codexReviewPlanTagV1(key, plan)), actual = Buffer.from(row.auth_tag);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || row.tenant_id !== plan.tenantId
    || row.project_id !== plan.projectId || row.job_id !== plan.jobId || row.run_id !== plan.runId)
    throw new Error("codex_review_plan_unavailable");
  return plan;
}

export async function readCodexReviewPlanV1(tx: DatabaseSession, key: Uint8Array,
  tenantId: string, projectId: string, jobId: string) {
  const row = (await tx.query<CodexReviewPlanRowV1>(`SELECT * FROM control_native_review_plans
    WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3`, [tenantId, projectId, jobId])).rows[0];
  if (!row) return undefined;
  return verifyCodexReviewPlanV1(key, row);
}

export function codexReviewTargetV1(plan: CodexReviewPlanV1, receipt: CodexResultReceiptV1): CompletionReviewTargetV1 {
  if (receipt.tenantId !== plan.tenantId || receipt.projectId !== plan.projectId || receipt.jobId !== plan.jobId
    || receipt.runId !== plan.runId || receipt.attemptId !== plan.attemptId || receipt.nodeId !== plan.nodeId
    || receipt.publicationId !== plan.publicationId || receipt.publicationContractDigest !== plan.publicationContractDigest
    || receipt.terminalEvidenceDigest !== plan.terminalEvidenceDigest
    || Date.parse(receipt.receivedAt) < Date.parse(plan.plannedAt)) throw new Error("codex_review_result_unavailable");
  const prior = plan.schema === "control-room.codex-review-plan/v2" ? plan.revision : undefined;
  return { schemaVersion: "control-room-completion-gate/v1", id: plan.targetId, tenantId: plan.tenantId,
    projectId: plan.projectId, kind: "document", subjectId: prior?.rootSubjectId ?? plan.jobId,
    subjectDigest: receipt.contentHash, acceptanceProfileId: plan.acceptanceProfileId,
    acceptanceProfileDigest: plan.acceptanceProfileDigest, producer: { actorId: plan.nodeId, actorType: "agent" },
    rootTargetId: prior?.rootTargetId ?? plan.targetId, revisionNumber: prior?.revisionNumber ?? 0,
    ...(prior ? { supersedesTargetId: prior.fromTargetId } : {}), submittedAt: receipt.receivedAt };
}

export function codexReviewRevisionV1(plan: Extract<CodexReviewPlanV1, { schema: "control-room.codex-review-plan/v2" }>,
  target: CompletionReviewTargetV1): CompletionRevisionV1 {
  return { schemaVersion: "control-room-completion-gate/v1",
    id: `revision:codex:${sha256Digest({ tenantId: plan.tenantId, runId: plan.runId }).slice(7)}`,
    tenantId: plan.tenantId, projectId: plan.projectId, rootTargetId: plan.revision.rootTargetId,
    fromTargetId: plan.revision.fromTargetId, fromTargetDigest: plan.revision.fromTargetDigest,
    toTargetId: target.id, toTargetDigest: sha256Digest(target), revisionNumber: plan.revision.revisionNumber,
    resolvedFindingIds: plan.revision.findingIds, revisedBy: target.producer, revisedAt: target.submittedAt,
    grantsApproval: false, grantsExecutionAuthority: false };
}
