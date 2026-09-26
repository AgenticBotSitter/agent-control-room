import { z } from "zod";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema } from "../../domain/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { sha256Digest } from "../../security";
import { HERMES_LOCAL_ADAPTER_V1, HERMES_LOCAL_CAPABILITY_V1, HERMES_LOCAL_JOB_TYPE_V1 } from "./task-planning-contract";
import { controllerWorkerDeliverySchemaV1, createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../v1/controller-worker-delivery";
import { hermesLocalTaskExecutionPlanSchemaV15, hermesLocalTaskExecutionPlanSchemaV16,
  type TaskExecutionPlanner } from "../../web/v1/task-execution-planner";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{8,64}$/);
function unavailable(): never { throw new Error("hermes_local_dispatch_preparation_unavailable"); }

export type HermesLocalDispatchReferenceV1 = Readonly<{
  tenantId: string; projectId: string; jobId: string; attemptId: string; leaseId: string; inputDigest: string;
}>;
export type HermesLocalPreparedDispatchV1 = Readonly<{
  schema: "control-room.hermes-macos-local-dispatch-preparation/v1";
  delivery: ControllerWorkerDeliveryV1;
  workflowId: string;
  route: Readonly<{ kind: "local"; workerId: string }>;
  executionClass: "text_review";
  startsWork: false;
  grantsExecutionAuthority: false;
}>;
const referenceSchema = z.object({ tenantId: id, projectId: id, jobId: id, attemptId: id, leaseId: id, inputDigest: digest }).strict();
const preparedSchema = z.object({
  schema: z.literal("control-room.hermes-macos-local-dispatch-preparation/v1"), delivery: controllerWorkerDeliverySchemaV1,
  workflowId: id, route: z.object({ kind: z.literal("local"), workerId: id }).strict(), executionClass: z.literal("text_review"),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
const bindingSchema = z.object({ workerId: id, adapterRevision: revision }).strict();

/** Turns one already leased current-Hermes task into the shared controller
 * delivery packet. It neither runs Hermes nor creates a queue, receipt, or
 * result. The connector profile digest remains the exact qualified build. */
export class HermesLocalDispatchPreparationV1 {
  private readonly binding: z.infer<typeof bindingSchema>;
  constructor(private readonly db: DatabaseClient, private readonly planner: Pick<TaskExecutionPlanner, "readInSession">,
    bindingValue: unknown, private readonly clock: () => number = Date.now) {
    this.binding = bindingSchema.parse(bindingValue);
    if (!db || typeof db.transaction !== "function" || !planner || typeof planner.readInSession !== "function"
      || typeof clock !== "function") unavailable();
  }
  async prepare(value: HermesLocalDispatchReferenceV1): Promise<HermesLocalPreparedDispatchV1> {
    const ref = referenceSchema.parse(value);
    return this.db.transaction(tx => this.prepareInSession(tx, ref));
  }
  async assertCurrent(value: HermesLocalDispatchReferenceV1, preparedValue: unknown): Promise<void> {
    const ref = referenceSchema.parse(value);
    const prepared = preparedSchema.parse(preparedValue) as HermesLocalPreparedDispatchV1;
    const current = await this.db.transaction(tx => this.prepareInSession(tx, ref));
    const material = (item: HermesLocalPreparedDispatchV1) => sha256Digest({ identity: item.delivery.identity,
      worker: item.delivery.worker, input: item.delivery.input, authorityDigest: item.delivery.authorityDigest,
      connectorProfileDigest: item.delivery.connectorProfileDigest, acceptanceProfileId: item.delivery.acceptanceProfileId,
      acceptanceProfileDigest: item.delivery.acceptanceProfileDigest, expiresAt: item.delivery.expiresAt, route: item.route });
    if (material(prepared) !== material(current)) unavailable();
  }
  private async prepareInSession(tx: DatabaseSession, ref: HermesLocalDispatchReferenceV1): Promise<HermesLocalPreparedDispatchV1> {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) unavailable();
    const jobRow = (await tx.query<{ payload: unknown; state: string; version: number; project_id: string }>(`SELECT payload,state,version,project_id
      FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`, [ref.tenantId, ref.projectId, ref.jobId])).rows[0];
    const attemptRow = (await tx.query<{ payload: unknown; state: string; version: number; job_id: string; node_id: string }>(`SELECT payload,state,version,job_id,node_id
      FROM control_attempts WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [ref.tenantId, ref.attemptId])).rows[0];
    const leaseRow = (await tx.query<{ payload: unknown; state: string; version: number; attempt_id: string; job_id: string; node_id: string; expires_at: string | Date }>(`SELECT payload,state,version,attempt_id,job_id,node_id,expires_at
      FROM control_leases WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [ref.tenantId, ref.leaseId])).rows[0];
    if (!jobRow || !attemptRow || !leaseRow) unavailable();
    const job = jobRecordSchema.parse(jobRow.payload), attempt = attemptRecordSchema.parse(attemptRow.payload), lease = leaseRecordSchema.parse(leaseRow.payload);
    const rawPlan = await this.planner.readInSession(tx, ref.jobId);
    const plan = rawPlan?.schema === "control-room.task-execution-plan/v15" ? hermesLocalTaskExecutionPlanSchemaV15.parse(rawPlan)
      : rawPlan?.schema === "control-room.task-execution-plan/v16" ? hermesLocalTaskExecutionPlanSchemaV16.parse(rawPlan) : unavailable();
    if (plan.adapter !== HERMES_LOCAL_ADAPTER_V1 || plan.tenantId !== ref.tenantId || plan.projectId !== ref.projectId
      || plan.job.id !== ref.jobId || jobRow.state !== job.state || jobRow.version !== job.version || jobRow.project_id !== job.projectId
      || attemptRow.state !== attempt.state || attemptRow.version !== attempt.version || attemptRow.job_id !== attempt.jobId || attemptRow.node_id !== attempt.nodeId
      || leaseRow.state !== lease.state || leaseRow.version !== lease.version || leaseRow.attempt_id !== lease.attemptId
      || leaseRow.job_id !== lease.jobId || leaseRow.node_id !== lease.nodeId || new Date(leaseRow.expires_at).toISOString() !== lease.expiresAt
      || job.state !== "leased" || attempt.state !== "leased" || lease.state !== "active" || job.inputDigest !== ref.inputDigest
      || plan.job.inputDigest !== ref.inputDigest || job.jobType !== HERMES_LOCAL_JOB_TYPE_V1
      || job.requiredCapability !== HERMES_LOCAL_CAPABILITY_V1 || attempt.jobId !== job.id || lease.jobId !== job.id
      || lease.attemptId !== attempt.id || lease.nodeId !== attempt.nodeId || Date.parse(lease.expiresAt) <= now
      || Date.parse(job.authority.expiresAt) <= now) unavailable();
    const expiresAt = new Date(Math.min(Date.parse(lease.expiresAt), Date.parse(job.authority.expiresAt))).toISOString();
    const runId = `run:hermes-local:${sha256Digest({ tenantId: ref.tenantId, jobId: ref.jobId, attemptId: ref.attemptId,
      leaseId: ref.leaseId, planDigest: sha256Digest(plan) }).slice(7)}`;
    const delivery = createControllerWorkerDeliveryV1({ identity: { tenantId: ref.tenantId, projectId: ref.projectId,
      jobId: ref.jobId, attemptId: ref.attemptId, runId, nodeId: attempt.nodeId }, worker: { workerId: this.binding.workerId,
      adapterId: HERMES_LOCAL_ADAPTER_V1, adapterRevision: this.binding.adapterRevision }, input: plan.input,
      authorityDigest: job.authority.digest, connectorProfileDigest: plan.connectorProfileDigest,
      acceptanceProfileId: plan.acceptanceProfileId, acceptanceProfileDigest: plan.acceptanceProfileDigest,
      issuedAt: new Date(now).toISOString(), expiresAt });
    return Object.freeze({ schema: "control-room.hermes-macos-local-dispatch-preparation/v1", delivery,
      workflowId: job.workflowId, route: Object.freeze({ kind: "local" as const, workerId: this.binding.workerId }),
      executionClass: "text_review" as const, startsWork: false as const, grantsExecutionAuthority: false as const });
  }
}
