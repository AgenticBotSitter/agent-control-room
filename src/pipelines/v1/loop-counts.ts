import { hmacSha256Tag, sha256Digest } from "../../security";
import { PIPELINE_MAX_LOOPS_CEILING_V1, PIPELINE_MAX_TOTAL_LOOPS_CEILING_V1 } from "./schemas";

/** The effective ceilings unattended advance enforces. A template may set a
 * stage's `max_loops` and a run's `max_total_loops` anywhere inside the stored
 * column ranges, but only ever lower these two. */
export const pipelineEffectiveMaxLoopsV1 = (stored: number) =>
  Math.min(stored, PIPELINE_MAX_LOOPS_CEILING_V1);
export const pipelineEffectiveMaxTotalLoopsV1 = (stored: number) =>
  Math.min(stored, PIPELINE_MAX_TOTAL_LOOPS_CEILING_V1);

export type PipelineLoopCountRowV1 = { pipeline_run_id: string; stage_ordinal: number | string;
  worker_id: string; loop_index: number | string; max_loops: number | string; max_total_loops: number | string;
  run_total_loops: number | string; reason_code: string; recorded_at: string | Date };

/** The signed material for one counted round. The receipt digest is inside it,
 * so a count row cannot outlive or rename the receipt that justified it. */
export function pipelineLoopCountMaterialV1(input: { tenantId: string; projectId: string; runId: string;
  stageOrdinal: number; workerId: string; loopIndex: number; maxLoops: number; maxTotalLoops: number;
  runTotalLoops: number; reasonCode: "stage_advanced" | "stage_loop_limit_reached" | "run_loop_limit_reached";
  receiptId: string; receiptDigest: string; requestDigest: string; recordedAt: string }) {
  return { schema: "control-room.pipeline-stage-loop-count/v1" as const, tenantId: input.tenantId,
    projectId: input.projectId, pipelineRunId: input.runId, stageOrdinal: input.stageOrdinal,
    workerId: input.workerId, loopIndex: input.loopIndex, maxLoops: input.maxLoops,
    maxTotalLoops: input.maxTotalLoops, runTotalLoops: input.runTotalLoops, reasonCode: input.reasonCode,
    receiptId: input.receiptId, receiptDigest: input.receiptDigest, requestDigest: input.requestDigest,
    recordedAt: input.recordedAt };
}
export function pipelineLoopCountDigestV1(material: unknown) { return sha256Digest(material); }
export function pipelineLoopCountTagV1(key: Uint8Array, material: unknown) {
  return hmacSha256Tag(key, { purpose: "pipeline-stage-loop-count/v1", record: material });
}

/** The owner's Needs Attention item when a run stops at a loop ceiling. It
 * names the run and the stage, carries the receipts as evidence, and offers
 * exactly one legal response: look at it. */
export function pipelineLoopAttentionItemV1(input: { tenantId: string; projectId: string; runId: string;
  stageOrdinal: number; stageKind: string; reasonCode: "pipeline_stage_loop_limit_reached"
  | "pipeline_run_loop_limit_reached"; loopIndex: number; maxLoops: number; maxTotalLoops: number;
  runTotalLoops: number; receiptIds: readonly string[]; createdAt: string }) {
  return { id: `attention:pipeline-loop:${input.runId}`, tenantId: input.tenantId, projectId: input.projectId,
    workItemId: `${input.runId}:stage:${input.stageOrdinal}`, kind: "question" as const, state: "open" as const,
    schema: "control-room.pipeline-loop-attention/v1" as const, pipelineRunId: input.runId,
    stageOrdinal: input.stageOrdinal, stageKind: input.stageKind, reasonCode: input.reasonCode,
    requestedAction: input.reasonCode === "pipeline_run_loop_limit_reached"
      ? "Pipeline stopped: this run reached its loop limit"
      : "Pipeline stopped: this stage reached its loop limit",
    blockedWorkItemIds: [],
    legalResponses: [{ id: `open:${input.runId}:stage:${input.stageOrdinal}`, kind: "open_source" as const,
      label: "Open the pipeline run", requiresConfirmation: false, available: true }],
    evidence: input.receiptIds.map(receiptId => ({ id: receiptId, kind: "audit" as const, observedAt: input.createdAt })),
    loopIndex: input.loopIndex, maxLoops: input.maxLoops, maxTotalLoops: input.maxTotalLoops,
    runTotalLoops: input.runTotalLoops,
    createdAt: input.createdAt, deliveryState: "not_requested" as const };
}
