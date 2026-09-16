import type { DatabaseSession } from "../../persistence/database";
import type { TaskResultReceipt } from "../../artifacts/v1/native-results";
import type { DurableResultReceiptV1 } from "../../artifacts/v1/durable-result-receipt";
import { nativeReviewPlanSchema, nativeReviewTarget, verifyNativeReviewPlan,
  type NativeReviewPlan, type NativeReviewPlanRow } from "./native-review-plan";
import { codexReviewPlanSchemaV1, codexReviewTargetV1, verifyCodexReviewPlanV1,
  type CodexReviewPlanRowV1, type CodexReviewPlanV1 } from "./codex-review-plan";
import { durableResultReviewPlanSchemaV1, durableReviewTargetV1, verifyDurableResultReviewPlanV1,
  type DurableResultReviewPlanRowV1, type DurableResultReviewPlanV1 } from "./durable-result-review-plan";
import { sha256Digest } from "../../security";
import type { CompletionReviewTargetV1 } from "./types";

export type TaskReviewPlanV1 = NativeReviewPlan | CodexReviewPlanV1 | DurableResultReviewPlanV1;
export type TaskResultReceiptV1 = TaskResultReceipt | DurableResultReceiptV1;
type Row = NativeReviewPlanRow & CodexReviewPlanRowV1 & DurableResultReviewPlanRowV1;

/** One authenticated reader for the shared review-plan table. The schema decides the harness;
 * callers never select a weaker verifier. */
export async function readTaskReviewPlanV1(tx: DatabaseSession, key: Uint8Array,
  tenantId: string, projectId: string, jobId: string): Promise<TaskReviewPlanV1 | undefined> {
  const row = (await tx.query<Row>(`SELECT * FROM control_native_review_plans
    WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3`, [tenantId, projectId, jobId])).rows[0];
  if (!row) return undefined;
  if (nativeReviewPlanSchema.safeParse(row.plan).success) return verifyNativeReviewPlan(key, row);
  if (codexReviewPlanSchemaV1.safeParse(row.plan).success) return verifyCodexReviewPlanV1(key, row);
  if (durableResultReviewPlanSchemaV1.safeParse(row.plan).success) return verifyDurableResultReviewPlanV1(key, row);
  throw new Error("task_review_plan_unavailable");
}

export function taskReviewTargetV1(plan: TaskReviewPlanV1, receipt: TaskResultReceiptV1): CompletionReviewTargetV1 {
  if (plan.schema === "control-room.durable-result-review-plan/v1") {
    if (receipt.schema !== "control-room.durable-result-receipt/v1") throw new Error("task_review_target_unavailable");
    return durableReviewTargetV1(plan, receipt);
  }
  if (plan.schema.startsWith("control-room.native-review-plan/")) {
    if (receipt.schema !== "control-room.native-result-receipt/v1") throw new Error("task_review_target_unavailable");
    return nativeReviewTarget(plan as NativeReviewPlan, receipt);
  }
  if (receipt.schema !== "control-room.codex-result-receipt/v1") throw new Error("task_review_target_unavailable");
  return codexReviewTargetV1(plan as CodexReviewPlanV1, receipt as Extract<TaskResultReceipt, { schema: "control-room.codex-result-receipt/v1" }>);
}

export function verifyTaskReviewTargetV1(plan: TaskReviewPlanV1 | undefined,
  target: CompletionReviewTargetV1, receipt: TaskResultReceipt) {
  if (!plan) {
    if (target.revisionNumber !== 0 || target.subjectId !== receipt.jobId) throw new Error("task_review_target_unavailable");
    return;
  }
  if (sha256Digest(taskReviewTargetV1(plan, receipt)) !== sha256Digest(target)) throw new Error("task_review_target_unavailable");
}

export function taskReviewRootSubjectIdV1(plan: TaskReviewPlanV1 | undefined, jobId: string) {
  if (!plan) return jobId;
  return plan.schema === "control-room.native-review-plan/v2" || plan.schema === "control-room.codex-review-plan/v2"
    ? plan.revision.rootSubjectId : jobId;
}
