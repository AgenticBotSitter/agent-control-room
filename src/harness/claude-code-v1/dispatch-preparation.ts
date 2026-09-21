import { z } from "zod";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema } from "../../domain/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { sha256Digest } from "../../security";
import { controllerWorkerDeliverySchemaV1, createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../v1/controller-worker-delivery";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from "./result-publication";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1, CLAUDE_CODE_LOCAL_CAPABILITY_V1, CLAUDE_CODE_LOCAL_JOB_TYPE_V1 } from "./task-planning-contract";
import { claudeCodeLocalTaskExecutionPlanSchemaV10, claudeCodeLocalTaskExecutionPlanSchemaV9, type TaskExecutionPlanner } from "../../web/v1/task-execution-planner";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const unavailable = (): never => { throw new Error("claude_code_local_dispatch_preparation_unavailable"); };

export const CLAUDE_CODE_LOCAL_DISPATCH_PREPARATION_V1 =
  "control-room.claude-code-local-dispatch-preparation/v1" as const;

/** Private installation facts. They contain no command, profile, credential or workspace path. */
export type ClaudeCodeLocalDispatchBindingV1 = Readonly<{ workerId: string; adapterRevision: string }>;
export type ClaudeCodeLocalDispatchReferenceV1 = Readonly<{
  tenantId: string; projectId: string; jobId: string; attemptId: string; leaseId: string; inputDigest: string;
}>;
export type ClaudeCodeLocalPreparedDispatchV1 = Readonly<{
  schema: typeof CLAUDE_CODE_LOCAL_DISPATCH_PREPARATION_V1;
  delivery: ControllerWorkerDeliveryV1;
  workflowId: string;
  route: Readonly<{ kind: "local"; workerId: string }>;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

const referenceSchema = z.object({ tenantId: id, projectId: id, jobId: id, attemptId: id, leaseId: id, inputDigest: digest }).strict();
const preparedSchema = z.object({
  schema: z.literal(CLAUDE_CODE_LOCAL_DISPATCH_PREPARATION_V1), delivery: controllerWorkerDeliverySchemaV1,
  workflowId: id, route: z.object({ kind: z.literal("local"), workerId: id }).strict(),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();

function bindingDigest(prepared: ClaudeCodeLocalPreparedDispatchV1) {
  return sha256Digest({ workflowId: prepared.workflowId, route: prepared.route, identity: prepared.delivery.identity,
    worker: prepared.delivery.worker, input: prepared.delivery.input, authorityDigest: prepared.delivery.authorityDigest,
    connectorProfileDigest: prepared.delivery.connectorProfileDigest,
    acceptanceProfileId: prepared.delivery.acceptanceProfileId,
    acceptanceProfileDigest: prepared.delivery.acceptanceProfileDigest, expiresAt: prepared.delivery.expiresAt });
}

/**
 * Reconstructs one signed-delivery input from a current, already leased Claude
 * task. This is a read-and-verify seam only: it creates no queue record,
 * process, session, receipt, result, or execution authority.
 */
export class ClaudeCodeLocalDispatchPreparationV1 {
  private readonly binding: Readonly<{ workerId: string; adapterRevision: string }>;
  constructor(private readonly db: DatabaseClient, private readonly planner: Pick<TaskExecutionPlanner, "readInSession">,
    bindingValue: unknown, private readonly clock: () => number = Date.now) {
    const binding = z.object({ workerId: id, adapterRevision: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/) }).strict().parse(bindingValue);
    if (!db || typeof db.transaction !== "function" || !planner || typeof planner.readInSession !== "function" || typeof clock !== "function") unavailable();
    this.binding = Object.freeze(binding);
  }

  async prepare(value: ClaudeCodeLocalDispatchReferenceV1): Promise<ClaudeCodeLocalPreparedDispatchV1> {
    const reference = referenceSchema.parse(value);
    return this.db.transaction(tx => this.prepareInSession(tx, reference));
  }

  /** A fresh packet must still point to the exact same canonical task, worker and authority. */
  async assertCurrent(value: ClaudeCodeLocalDispatchReferenceV1, preparedValue: unknown): Promise<void> {
    const reference = referenceSchema.parse(value);
    const prepared = preparedSchema.parse(preparedValue) as ClaudeCodeLocalPreparedDispatchV1;
    const current = await this.db.transaction(tx => this.prepareInSession(tx, reference));
    if (bindingDigest(prepared) !== bindingDigest(current)) unavailable();
  }

  private async prepareInSession(tx: DatabaseSession, reference: ClaudeCodeLocalDispatchReferenceV1): Promise<ClaudeCodeLocalPreparedDispatchV1> {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) unavailable();
    const jobRow = (await tx.query<{ payload: unknown; state: string; version: number; project_id: string }>(
      "SELECT payload,state,version,project_id FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
      [reference.tenantId, reference.projectId, reference.jobId])).rows[0];
    const attemptRow = (await tx.query<{ payload: unknown; state: string; version: number; job_id: string; node_id: string }>(
      "SELECT payload,state,version,job_id,node_id FROM control_attempts WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [reference.tenantId, reference.attemptId])).rows[0];
    const leaseRow = (await tx.query<{ payload: unknown; state: string; version: number; attempt_id: string; job_id: string; node_id: string; expires_at: string | Date }>(
      "SELECT payload,state,version,attempt_id,job_id,node_id,expires_at FROM control_leases WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [reference.tenantId, reference.leaseId])).rows[0];
    if (!jobRow || !attemptRow || !leaseRow) unavailable();
    const job = jobRecordSchema.parse(jobRow.payload), attempt = attemptRecordSchema.parse(attemptRow.payload), lease = leaseRecordSchema.parse(leaseRow.payload);
    const rawPlan = await this.planner.readInSession(tx, reference.jobId);
    const plan = rawPlan?.schema === "control-room.task-execution-plan/v9"
      ? claudeCodeLocalTaskExecutionPlanSchemaV9.parse(rawPlan)
      : rawPlan?.schema === "control-room.task-execution-plan/v10"
        ? claudeCodeLocalTaskExecutionPlanSchemaV10.parse(rawPlan) : unavailable();
    if (plan.adapter !== CLAUDE_CODE_LOCAL_ADAPTER_V1 || plan.connectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1
      || plan.tenantId !== reference.tenantId || plan.projectId !== reference.projectId || plan.job.id !== reference.jobId
      || jobRow.state !== job.state || jobRow.version !== job.version || jobRow.project_id !== job.projectId
      || attemptRow.state !== attempt.state || attemptRow.version !== attempt.version || attemptRow.job_id !== attempt.jobId || attemptRow.node_id !== attempt.nodeId
      || leaseRow.state !== lease.state || leaseRow.version !== lease.version || leaseRow.attempt_id !== lease.attemptId || leaseRow.job_id !== lease.jobId
      || leaseRow.node_id !== lease.nodeId || new Date(leaseRow.expires_at).toISOString() !== lease.expiresAt
      || job.state !== "leased" || attempt.state !== "leased" || lease.state !== "active"
      || job.inputDigest !== reference.inputDigest || plan.job.inputDigest !== reference.inputDigest
      || plan.executionClass !== "text_review" || job.jobType !== CLAUDE_CODE_LOCAL_JOB_TYPE_V1
      || job.requiredCapability !== CLAUDE_CODE_LOCAL_CAPABILITY_V1 || attempt.jobId !== job.id || lease.jobId !== job.id
      || lease.attemptId !== attempt.id || lease.nodeId !== attempt.nodeId || Date.parse(lease.expiresAt) <= now
      || Date.parse(job.authority.expiresAt) <= now) unavailable();
    const expiresAt = new Date(Math.min(Date.parse(lease.expiresAt), Date.parse(job.authority.expiresAt))).toISOString();
    const runId = `run:claude-code-local:${sha256Digest({ tenantId: reference.tenantId, jobId: reference.jobId,
      attemptId: reference.attemptId, leaseId: reference.leaseId, planDigest: sha256Digest(plan) }).slice(7)}`;
    const delivery = createControllerWorkerDeliveryV1({ identity: { tenantId: reference.tenantId, projectId: reference.projectId,
      jobId: reference.jobId, attemptId: reference.attemptId, runId, nodeId: id.parse(attempt.nodeId) }, worker: {
      workerId: this.binding.workerId, adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, adapterRevision: this.binding.adapterRevision },
      input: plan.input, authorityDigest: job.authority.digest, connectorProfileDigest: plan.connectorProfileDigest,
      acceptanceProfileId: plan.acceptanceProfileId, acceptanceProfileDigest: plan.acceptanceProfileDigest,
      issuedAt: new Date(now).toISOString(), expiresAt });
    return Object.freeze({ schema: CLAUDE_CODE_LOCAL_DISPATCH_PREPARATION_V1, delivery, workflowId: job.workflowId,
      route: Object.freeze({ kind: "local" as const, workerId: this.binding.workerId }),
      startsWork: false as const, grantsExecutionAuthority: false as const });
  }
}
