import { z } from "zod";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema } from "../../domain/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { sha256Digest } from "../../security";
import { HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1 } from "./connector-profile";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
  HERMES_021_MACOS_LOCAL_JOB_TYPE_V1, hermes021MacosLocalBindingSchemaV1 } from "./macos-local-worker";
import { createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../v1/controller-worker-delivery";
import { hermes021TaskExecutionPlanSchemaV5, hermes021TaskExecutionPlanSchemaV6,
  type TaskExecutionPlanner } from "../../web/v1/task-execution-planner";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const unavailable = (): never => { throw new Error("hermes_021_macos_dispatch_preparation_unavailable"); };

export const HERMES_021_MACOS_DISPATCH_PREPARATION_V1 =
  "control-room.hermes-021-macos-dispatch-preparation/v1" as const;

export type Hermes021MacosDispatchReferenceV1 = Readonly<{
  tenantId: string; projectId: string; jobId: string; attemptId: string; leaseId: string; inputDigest: string;
}>;

/**
 * Reads an already-assigned canonical task and creates the shared packet for
 * Marvin. This is deliberately a preparation reader: it does not create an
 * assignment, queue, run, receipt, policy, or Hermes process. The caller
 * must pass its result straight to the local delivery composition while the
 * packet remains inside its short lease/authority window.
 */
export class Hermes021MacosDispatchPreparationV1 {
  private readonly binding: z.infer<typeof hermes021MacosLocalBindingSchemaV1>;
  constructor(private readonly db: DatabaseClient, private readonly planner: Pick<TaskExecutionPlanner, "readInSession">,
    bindingValue: unknown, private readonly clock: () => number = Date.now) {
    this.binding = hermes021MacosLocalBindingSchemaV1.parse(bindingValue);
    if (!db || typeof db.transaction !== "function" || !planner || typeof planner.readInSession !== "function"
      || typeof clock !== "function") unavailable();
  }

  async prepare(value: Hermes021MacosDispatchReferenceV1): Promise<Readonly<{
    schema: typeof HERMES_021_MACOS_DISPATCH_PREPARATION_V1; delivery: ControllerWorkerDeliveryV1;
    route: Readonly<{ kind: "local"; workerId: string }>; startsWork: false; grantsExecutionAuthority: false;
  }>> {
    const ref = z.object({ tenantId: id, projectId: id, jobId: id, attemptId: id, leaseId: id, inputDigest: digest }).strict().parse(value);
    return this.db.transaction(async tx => this.prepareInSession(tx, ref));
  }

  private async prepareInSession(tx: DatabaseSession, ref: Hermes021MacosDispatchReferenceV1) {
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
    const plan = rawPlan?.schema === "control-room.task-execution-plan/v5"
      ? hermes021TaskExecutionPlanSchemaV5.parse(rawPlan)
      : rawPlan?.schema === "control-room.task-execution-plan/v6"
        ? hermes021TaskExecutionPlanSchemaV6.parse(rawPlan)
        : unavailable();
    if (plan.adapter !== HERMES_021_MACOS_LOCAL_ADAPTER_V1 || plan.connectorProfileDigest !== HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1
      || plan.tenantId !== ref.tenantId || plan.projectId !== ref.projectId || plan.job.id !== ref.jobId
      || jobRow.state !== job.state || jobRow.version !== job.version || jobRow.project_id !== job.projectId
      || attemptRow.state !== attempt.state || attemptRow.version !== attempt.version || attemptRow.job_id !== attempt.jobId || attemptRow.node_id !== attempt.nodeId
      || leaseRow.state !== lease.state || leaseRow.version !== lease.version || leaseRow.attempt_id !== lease.attemptId
      || leaseRow.job_id !== lease.jobId || leaseRow.node_id !== lease.nodeId || new Date(leaseRow.expires_at).toISOString() !== lease.expiresAt
      || job.state !== "leased" || attempt.state !== "leased" || lease.state !== "active"
      || job.inputDigest !== ref.inputDigest || plan.job.inputDigest !== ref.inputDigest || job.jobType !== HERMES_021_MACOS_LOCAL_JOB_TYPE_V1
      || job.requiredCapability !== HERMES_021_MACOS_LOCAL_CAPABILITY_V1 || attempt.jobId !== job.id || lease.jobId !== job.id
      || lease.attemptId !== attempt.id || lease.nodeId !== attempt.nodeId || Date.parse(lease.expiresAt) <= now
      || Date.parse(job.authority.expiresAt) <= now) unavailable();
    const expiresAt = new Date(Math.min(Date.parse(lease.expiresAt), Date.parse(job.authority.expiresAt))).toISOString();
    const runId = `run:hermes-021:${sha256Digest({ tenantId: ref.tenantId, jobId: ref.jobId, attemptId: ref.attemptId,
      leaseId: ref.leaseId, planDigest: sha256Digest(plan) }).slice(7)}`;
    const workerId = id.parse(this.binding.workerId);
    const adapterRevision = z.string().regex(/^[a-f0-9]{8,64}$/).parse(this.binding.sourceRevision);
    const nodeId = id.parse(attempt.nodeId);
    const delivery = createControllerWorkerDeliveryV1({ identity: { tenantId: ref.tenantId, projectId: ref.projectId,
      jobId: ref.jobId, attemptId: ref.attemptId, runId, nodeId }, worker: { workerId,
      adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision }, input: plan.input,
      authorityDigest: job.authority.digest, connectorProfileDigest: plan.connectorProfileDigest,
      acceptanceProfileId: plan.acceptanceProfileId, acceptanceProfileDigest: plan.acceptanceProfileDigest,
      issuedAt: new Date(now).toISOString(), expiresAt });
    return Object.freeze({ schema: HERMES_021_MACOS_DISPATCH_PREPARATION_V1, delivery,
      route: Object.freeze({ kind: "local" as const, workerId }),
      startsWork: false as const, grantsExecutionAuthority: false as const });
  }
}
