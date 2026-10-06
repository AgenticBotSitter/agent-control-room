import { z } from "zod";

export const pipelineAdvanceReasonSchemaV1 = z.enum([
  "unattended_disabled", "unattended_not_authorized", "run_not_active", "stage_not_eligible", "stage_uncertain",
  "waiting_approval", "dependency_not_accepted", "selection_not_current", "execution_authority_missing",
  "policy_inactive", "policy_action_not_permitted", "policy_route_mismatch", "policy_risk_exceeded",
  "policy_task_allowance_exhausted", "policy_cost_allowance_exhausted", "policy_cost_unknown",
  "policy_concurrency_exhausted", "deadline_reached", "advance_conflict", "pipeline_integrity_failed",
  "stage_loop_limit_reached", "run_loop_limit_reached", "installation_allowance_missing",
  "installation_runs_per_hour_exhausted", "installation_agent_runs_per_day_exhausted",
  "installation_agent_process_ceiling_reached", "installation_db_cluster_ceiling_reached",
  "installation_cluster_count_unknown", "installation_cost_ceiling_exhausted",
]);
export type PipelineAdvanceSafeReasonV1 = z.infer<typeof pipelineAdvanceReasonSchemaV1>;
export const pipelineAdvanceFailureSchemaV1 = z.object({ error: z.literal("pipeline_advance_refused"),
  safeReason: pipelineAdvanceReasonSchemaV1 }).strict();

export const PIPELINE_ADVANCE_REASON_TEXT_V1: Record<PipelineAdvanceSafeReasonV1, string> = {
  unattended_disabled: "Automatic continuation is switched off on this installation.",
  unattended_not_authorized: "The run's saved consent is no longer current. Review its delegation policy before enabling continuation again.",
  run_not_active: "This run is no longer active.",
  stage_not_eligible: "The stage is waiting for its current work to finish.",
  stage_uncertain: "The stage's last attempt could not be confirmed. Check the ordinary task before retrying.",
  waiting_approval: "The stage is waiting for approval.",
  dependency_not_accepted: "The preceding stage has no current accepted result.",
  selection_not_current: "The stage's selected model has changed or its worker is not ready. Check the worker and saved model before continuing.",
  execution_authority_missing: "The stage has no current execution authority. Review the ordinary task.",
  policy_inactive: "The delegation policy is inactive or expired.",
  policy_action_not_permitted: "The delegation policy does not permit this stage action.",
  policy_route_mismatch: "The stage's worker or route no longer matches the delegation policy.",
  policy_risk_exceeded: "The stage exceeds the delegation policy's risk limit.",
  policy_task_allowance_exhausted: "The delegation policy's task allowance has been reached.",
  policy_cost_allowance_exhausted: "The delegation policy's cost allowance has been reached.",
  policy_cost_unknown: "The next stage's cost is unreported, so its cost allowance cannot be checked.",
  policy_concurrency_exhausted: "The delegation policy's concurrent task limit has been reached. Continuation will wait.",
  deadline_reached: "The run or its execution authority has reached its deadline.",
  advance_conflict: "The saved run changed during continuation. Refresh it before retrying.",
  pipeline_integrity_failed: "The pipeline's saved authority could not be verified. Continuation stopped.",
  stage_loop_limit_reached: "The stage has reached its correction round limit.",
  run_loop_limit_reached: "The run has reached its total correction round limit.",
  installation_allowance_missing: "This installation has no recorded run allowance. Record its limits before continuing.",
  installation_runs_per_hour_exhausted: "The installation's hourly run limit has been reached. Continuation will wait for the next allowance.",
  installation_agent_runs_per_day_exhausted: "This worker has reached its daily run limit. Continuation will wait for the next allowance.",
  installation_agent_process_ceiling_reached: "The machine's active worker limit has been reached. Continuation will wait for a slot.",
  installation_db_cluster_ceiling_reached: "The machine's database cluster limit has been reached. Check its recorded capacity.",
  installation_cluster_count_unknown: "The machine's database cluster count is missing or stale. Record its current capacity.",
  installation_cost_ceiling_exhausted: "The installation's recorded cost limit has been reached.",
};

/** Capacity/dependency waits remain retryable; the sweep returns their reason without creating attention. */
export function pipelineRefusalNeedsAttentionV1(reason: PipelineAdvanceSafeReasonV1): boolean {
  return !["stage_not_eligible", "waiting_approval", "dependency_not_accepted", "policy_concurrency_exhausted",
    "installation_agent_process_ceiling_reached", "advance_conflict", "run_not_active",
    "stage_loop_limit_reached", "run_loop_limit_reached"].includes(reason);
}
