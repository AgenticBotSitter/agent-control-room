import { pipelineBuildWritePolicySchemaV1 } from "./schemas";

export type PipelineStageRowV1 = { project_id: string; pipeline_run_id: string; stage_ordinal: number | string;
  stage_kind: "build" | "check" | "signoff" | "plan" | "effect";
  role: "planner" | "builder" | "checker" | "validator" | "effecter";
  worker_id: string; worker_kind: "codex" | "claude-code" | "hermes"; node_id: string; selection_key: string;
  model: string; effort: string; provider: string | null; profile: string | null;
  current_job_id: string; current_attempt_id: string | null; current_lease_id: string | null; state: string;
  max_loops: number | string; handoff_from_result_digest: string | null; allowed_paths: unknown | null;
  maximum_changed_files: number | string | null; maximum_changed_bytes: number | string | null;
  signoff_review_id: string | null; started_at: string | Date | null; finished_at: string | Date | null;
  version: number | string };
const iso = (value: string | Date) => new Date(value).toISOString();

/** The exact signed material for one pipeline stage row. Every writer and
 * every verifier goes through this one function, so a re-signed row can never
 * drift from what production accepts. The bound write-policy columns are bigint
 * and arrive as text from the production driver. */
export function pipelineStageMaterialV1(scope: { tenantId: string }, row: PipelineStageRowV1) {
  const policy = row.stage_kind === "build" && row.allowed_paths !== null
    // The bound columns are bigint, which the production driver returns as text.
    ? pipelineBuildWritePolicySchemaV1.parse({ allowedPaths: row.allowed_paths,
      maximumChangedFiles: row.maximum_changed_files === null ? null : Number(row.maximum_changed_files),
      maximumChangedBytes: row.maximum_changed_bytes === null ? null : Number(row.maximum_changed_bytes) }) : null;
  return { id: `${row.pipeline_run_id}:stage:${Number(row.stage_ordinal)}`,
    tenantId: scope.tenantId, projectId: row.project_id, pipelineRunId: row.pipeline_run_id,
    stageOrdinal: Number(row.stage_ordinal), stageKind: row.stage_kind, role: row.role,
    workerId: row.worker_id, workerKind: row.worker_kind, nodeId: row.node_id,
    selectionKey: row.selection_key, model: row.model, effort: row.effort,
    provider: row.provider, profile: row.profile, currentJobId: row.current_job_id,
    currentAttemptId: row.current_attempt_id, currentLeaseId: row.current_lease_id, state: row.state,
    maxLoops: Number(row.max_loops), handoffFromResultDigest: row.handoff_from_result_digest,
    allowedPaths: policy ? [...policy.allowedPaths] : null,
    maximumChangedFiles: policy?.maximumChangedFiles ?? null,
    maximumChangedBytes: policy?.maximumChangedBytes ?? null,
    signoffReviewId: row.signoff_review_id,
    startedAt: row.started_at === null ? null : iso(row.started_at),
    finishedAt: row.finished_at === null ? null : iso(row.finished_at),
    version: Number(row.version) };
}
