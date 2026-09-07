import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import type { NativeResultReceipt } from "../../artifacts/v1/native-results";
import { hmacSha256Tag, sha256Digest } from "../../security";
import type { CompletionReviewTargetV1, CompletionRevisionV1 } from "./types";
import { nativeRevisionContextSchema } from "./native-revision-context";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
export const nativeReviewRequestSchema = z.object({ tenantId: id, runId: id, acceptanceProfileId: id,
  acceptanceProfileDigest: digest, plannedAt: instant }).strict();
const initial = nativeReviewRequestSchema.extend({ schema: z.literal("control-room.native-review-plan/v1"),
  projectId: id, jobId: id, attemptId: id, nodeId: id, inputDigest: digest, authorityDigest: digest,
  bindingDigest: digest, targetId: id }).strict();
export const nativeReviewPlanSchema = z.discriminatedUnion("schema", [initial,
  initial.extend({ schema: z.literal("control-room.native-review-plan/v2"), revision: nativeRevisionContextSchema })]);
export type NativeReviewPlan = z.infer<typeof nativeReviewPlanSchema>;
export type NativeReviewPlanRow = { tenant_id: string; project_id: string; job_id: string; run_id: string; plan: unknown; auth_tag: string };
export const nativeReviewPlanTag = (key: Uint8Array, plan: NativeReviewPlan) => hmacSha256Tag(key,
  { purpose: plan.schema === "control-room.native-review-plan/v1" ? "native-review-plan/v1" : "native-review-plan/v2", plan });
export function verifyNativeReviewPlan(key: Uint8Array, row: NativeReviewPlanRow) {
  const plan = nativeReviewPlanSchema.parse(row.plan), expected = Buffer.from(nativeReviewPlanTag(key, plan)), actual = Buffer.from(row.auth_tag);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || plan.tenantId !== row.tenant_id
    || plan.projectId !== row.project_id || plan.jobId !== row.job_id || plan.runId !== row.run_id)
    throw new Error("native_review_plan_unavailable");
  return plan;
}
/** Read-only authenticated producer-to-logical-subject relation; never an execution grant. */
export async function readNativeReviewPlan(tx: DatabaseSession, key: Uint8Array, tenantId: string, projectId: string, jobId: string) {
  const row = (await tx.query<NativeReviewPlanRow>(`SELECT * FROM control_native_review_plans
    WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3`, [tenantId, projectId, jobId])).rows[0];
  return row ? verifyNativeReviewPlan(key, row) : undefined;
}
export function nativeReviewTarget(plan: NativeReviewPlan, receipt: NativeResultReceipt): CompletionReviewTargetV1 {
  if (receipt.tenantId !== plan.tenantId || receipt.projectId !== plan.projectId || receipt.jobId !== plan.jobId
    || receipt.runId !== plan.runId || receipt.attemptId !== plan.attemptId || receipt.nodeId !== plan.nodeId
    || Date.parse(receipt.receivedAt) < Date.parse(plan.plannedAt)) throw new Error("native_review_result_unavailable");
  const revision = plan.schema === "control-room.native-review-plan/v2" ? plan.revision : undefined;
  return { schemaVersion: "control-room-completion-gate/v1", id: plan.targetId, tenantId: plan.tenantId,
    projectId: plan.projectId, kind: "document", subjectId: revision?.rootSubjectId ?? plan.jobId,
    subjectDigest: receipt.contentHash, acceptanceProfileId: plan.acceptanceProfileId,
    acceptanceProfileDigest: plan.acceptanceProfileDigest, producer: { actorId: plan.nodeId, actorType: "agent" },
    rootTargetId: revision?.rootTargetId ?? plan.targetId, revisionNumber: revision?.revisionNumber ?? 0,
    ...(revision ? { supersedesTargetId: revision.fromTargetId } : {}), submittedAt: receipt.receivedAt };
}
export function nativeReviewRevision(plan: Extract<NativeReviewPlan, { schema: "control-room.native-review-plan/v2" }>,
  target: CompletionReviewTargetV1): CompletionRevisionV1 {
  return { schemaVersion: "control-room-completion-gate/v1",
    id: `revision:native:${sha256Digest({ tenantId: plan.tenantId, runId: plan.runId }).slice(7)}`,
    tenantId: plan.tenantId, projectId: plan.projectId, rootTargetId: plan.revision.rootTargetId,
    fromTargetId: plan.revision.fromTargetId, fromTargetDigest: plan.revision.fromTargetDigest,
    toTargetId: target.id, toTargetDigest: sha256Digest(target), revisionNumber: plan.revision.revisionNumber,
    resolvedFindingIds: plan.revision.findingIds, revisedBy: target.producer, revisedAt: target.submittedAt,
    grantsApproval: false, grantsExecutionAuthority: false };
}
export function verifyNativeReviewTarget(plan: NativeReviewPlan | undefined, target: CompletionReviewTargetV1,
  receipt: NativeResultReceipt) {
  if (plan) {
    if (sha256Digest(nativeReviewTarget(plan, receipt)) !== sha256Digest(target)) throw new Error("native_review_target_unavailable");
  } else if (target.revisionNumber !== 0 || target.subjectId !== receipt.jobId) throw new Error("native_review_target_unavailable");
}
