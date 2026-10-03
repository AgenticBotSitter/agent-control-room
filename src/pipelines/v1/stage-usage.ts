import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import type { TaskDetail } from "../../web/v1/task-wire";
import { pipelineStageUsageSchemaV1 } from "./schemas";

export type PipelineTaskUsageReaderV1 = Readonly<{ detail(identity: VerifiedWebIdentity, projectId: string, jobId: string):
  Promise<Pick<TaskDetail, "attempts" | "usageRollup" | "earlierAttemptsOmitted">> }>;

/** Reuses authenticated harness evidence and pricing. Missing reads fail the page; they never become invented usage. */
export function pipelineStageUsageV1(detail: Pick<TaskDetail, "attempts" | "usageRollup" | "earlierAttemptsOmitted">) {
  const reports = detail.attempts.flatMap(attempt => attempt.runs.map(run => ({ runId:run.runId,
    usage:run.usage ? { ...run.usage, cachedInputTokens:run.usage.cachedInputTokens ?? 0 } : null, cost:run.cost })));
  const totals = detail.usageRollup;
  if (totals.runs === 0) return "unknown" as const;
  if (!reports.some(report => report.usage !== null) && totals.inputTokens === null && totals.outputTokens === null
    && totals.totalTokens === null && totals.wallTimeMs === null && !totals.knownCostRuns && !totals.subscriptionRuns) return "unknown" as const;
  return pipelineStageUsageSchemaV1.parse({ totals, reports,
    earlierReportsOmitted:detail.earlierAttemptsOmitted || detail.attempts.some(attempt => attempt.additionalRunsOmitted) });
}
