import { z } from "zod";
import {
  DOMAIN_CONTRACT_VERSION,
  jobRecordSchema,
  requestRecordSchema,
  scheduleRecordSchema,
  workflowRecordSchema,
  type AuthorityEnvelope,
  type JobRecord,
  type RequestRecord,
  type ScheduleRecord,
  type WorkflowRecord,
} from "../../domain/v1";
import { CanonicalStore, type ProposedWorkBundle } from "../../persistence/canonical-store";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, computeAuthorityDigest, sha256Digest } from "../../security";
import { ScheduleOccurrenceStore } from "./occurrence-store";

const safeId = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const sourceSchema = z.object({
  requestId: safeId,
  workflowId: safeId,
  jobId: safeId,
  bundleDigest: digest,
}).strict();

export const scheduledReusableContextSchemaV1 = z.object({
  kind: z.enum(["result", "artifact"]),
  id: safeId,
  contentHash: digest,
  sourceJobId: safeId,
  sourceRunId: safeId,
  sourceRevision: z.number().int().nonnegative().max(100),
  reviewId: safeId,
  reviewDigest: digest,
  verificationDigest: digest,
  verifiedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type ScheduledReusableContextV1 = z.infer<typeof scheduledReusableContextSchemaV1>;

const contextBindingSchema = z.object({
  reusableContexts: z.array(scheduledReusableContextSchemaV1).max(16),
  bindingDigest: digest,
}).strict();

const admissionInputSchema = z.object({
  tenantId: safeId,
  workspaceId: safeId,
  projectId: safeId,
  scheduleId: safeId,
  occurrenceKey: safeId,
  scheduleDefinitionDigest: digest,
  source: sourceSchema,
  contextBinding: contextBindingSchema,
}).strict();

const cancellationInputSchema = z.object({
  tenantId: safeId,
  workspaceId: safeId,
  projectId: safeId,
  scheduleId: safeId,
  occurrenceKey: safeId,
  scheduleDefinitionDigest: digest,
  sourceJobId: safeId,
}).strict();

const receiptSchema = z.object({
  contractVersion: z.literal("control-room-scheduled-task-admission/v1"),
  tenantId: safeId,
  workspaceId: safeId,
  projectId: safeId,
  scheduleId: safeId,
  occurrenceKey: safeId,
  occurrenceScheduledFor: z.string().datetime({ offset: true }),
  scheduleDefinitionDigest: digest,
  source: z.object({
    requestId: safeId,
    requestDigest: digest,
    workflowId: safeId,
    workflowDigest: digest,
    jobId: safeId,
    jobDigest: digest,
    bundleDigest: digest,
  }).strict(),
  contextBinding: contextBindingSchema,
  destination: z.object({
    requestId: safeId,
    requestDigest: digest,
    workflowId: safeId,
    workflowDigest: digest,
    jobId: safeId,
    jobDigest: digest,
    bundleDigest: digest,
  }).strict(),
  admittedAt: z.string().datetime({ offset: true }),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsAssignment: z.literal(false),
  permitsRetry: z.literal(false),
  permitsCancellation: z.literal(false),
  receiptDigest: digest,
}).strict();

export type ScheduledTaskAdmissionInputV1 = z.infer<typeof admissionInputSchema>;
export type ScheduledTaskAdmissionReceiptV1 = z.infer<typeof receiptSchema>;
export type ScheduledTaskCancellationInputV1 = z.infer<typeof cancellationInputSchema>;
export function parseScheduledTaskAdmissionReceiptV1(value: unknown): ScheduledTaskAdmissionReceiptV1 {
  return frozenReceipt(value);
}

export const EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1 = sha256Digest({
  contractVersion: "control-room-scheduled-context-binding/v1",
  reusableContexts: [],
});

export class ScheduledTaskAdmissionError extends Error {
  constructor(readonly safeCode:
    | "invalid_admission"
    | "binding_mismatch"
    | "schedule_not_active"
    | "occurrence_cancelled"
    | "occurrence_conflict"
    | "source_bundle_conflict"
    | "context_binding_conflict"
    | "recovery_window_expired"
    | "admission_conflict"
    | "admission_already_committed"
    | "outbox_not_delivered") {
    super(safeCode);
  }
}

export function computeScheduledTaskDefinitionDigestV1(value: ScheduleRecord): string {
  const schedule = scheduleRecordSchema.parse(value);
  return sha256Digest({
    contractVersion: "control-room-schedule-definition/v1",
    tenantId: schedule.tenantId,
    scheduleId: schedule.id,
    projectId: schedule.projectId,
    scheduleType: schedule.scheduleType,
    expression: schedule.expression,
    timezone: schedule.timezone,
    targetType: schedule.targetType,
    targetId: schedule.targetId,
    idempotencyWindowSeconds: schedule.idempotencyWindowSeconds,
  });
}

export function computeScheduledTaskSourceBundleDigestV1(value: ProposedWorkBundle): string {
  const request = requestRecordSchema.parse(value.request);
  const workflow = workflowRecordSchema.parse(value.workflow);
  const job = jobRecordSchema.parse(value.job);
  return sha256Digest({ contractVersion: "control-room-scheduled-source-bundle/v1", request, workflow, job });
}

function joined(tx: DatabaseSession): DatabaseClient {
  return Object.freeze({
    query: tx.query.bind(tx),
    transaction: async <T>(run: (session: DatabaseSession) => Promise<T>) => run(tx),
    transactionWithPreCommitCheck: async <T>(run: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) => {
      const result = await run(tx);
      await check();
      return result;
    },
  });
}

function requireClockInstant(now: () => number): string {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new ScheduledTaskAdmissionError("invalid_admission");
  return new Date(value).toISOString();
}

function fail(code: ScheduledTaskAdmissionError["safeCode"]): never {
  throw new ScheduledTaskAdmissionError(code);
}

function frozenReceipt(value: unknown): ScheduledTaskAdmissionReceiptV1 {
  const receipt = receiptSchema.parse(value);
  Object.freeze(receipt.source);
  for (const context of receipt.contextBinding.reusableContexts) Object.freeze(context);
  Object.freeze(receipt.contextBinding.reusableContexts);
  Object.freeze(receipt.contextBinding);
  Object.freeze(receipt.destination);
  return Object.freeze(receipt);
}

function receiptDigest(value: Omit<ScheduledTaskAdmissionReceiptV1, "receiptDigest">): string {
  return sha256Digest(value);
}

interface OccurrenceRow {
  tenant_id: string;
  schedule_id: string;
  occurrence_key: string;
  target_type: "workflow" | "job" | "service_check";
  target_id: string;
  definition_digest: string;
  scheduled_for: string | Date;
  local_time: string;
  state: "pending" | "dispatched" | "cancelled";
  created_at: string | Date;
}

interface AdmissionRow {
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  schedule_id: string;
  occurrence_key: string;
  source_bundle_digest: string;
  schedule_definition_digest: string;
  context_binding_digest: string;
  destination_job_id: string;
  receipt_digest: string;
  payload: unknown;
}

function destinationIds(input: ScheduledTaskAdmissionInputV1) {
  const key = sha256Digest({
    contractVersion: "control-room-scheduled-destination/v1",
    tenantId: input.tenantId,
    scheduleId: input.scheduleId,
    occurrenceKey: input.occurrenceKey,
    scheduleDefinitionDigest: input.scheduleDefinitionDigest,
    sourceBundleDigest: input.source.bundleDigest,
  }).slice("sha256:".length);
  return { requestId: `request:schedule:${key}`, workflowId: `workflow:schedule:${key}`, jobId: `job:schedule:${key}` };
}

function destinationBundle(input: ScheduledTaskAdmissionInputV1, schedule: ScheduleRecord, occurrence: OccurrenceRow,
  source: ProposedWorkBundle): ProposedWorkBundle {
  const ids = destinationIds(input);
  const createdAt = new Date(occurrence.created_at).toISOString();
  const recoveryEndsAt = new Date(Date.parse(new Date(occurrence.scheduled_for).toISOString())
    + schedule.idempotencyWindowSeconds * 1_000).toISOString();
  const authority: AuthorityEnvelope = {
    projectId: input.projectId,
    allowedExecutor: "executor:unassigned",
    allowedOperations: ["task.propose"],
    credentialRefs: [],
    filesystemRoots: [],
    networkPolicy: "none",
    allowedNetworkDestinations: [],
    effectPolicy: "none",
    maxRisk: "low",
    maxDurationSeconds: Math.min(schedule.idempotencyWindowSeconds, 300),
    maxConcurrentEffects: 0,
    maxCostUsd: 0,
    expiresAt: recoveryEndsAt,
    digest: "",
  };
  authority.digest = computeAuthorityDigest(authority);
  return {
    request: {
      ...source.request,
      id: ids.requestId,
      projectId: input.projectId,
      state: "draft",
      version: 0,
      createdAt,
      updatedAt: createdAt,
      requestedBy: { actorId: input.scheduleId, actorType: "service" },
      idempotencyKey: sha256Digest({ contractVersion: "control-room-scheduled-request/v1", ...ids }),
    },
    workflow: {
      ...source.workflow,
      id: ids.workflowId,
      requestId: ids.requestId,
      projectId: input.projectId,
      definitionVersion: "scheduled-task-occurrence/v1",
      definitionDigest: sha256Digest({ contractVersion: "control-room-scheduled-workflow/v1", ...ids,
        scheduleDefinitionDigest: input.scheduleDefinitionDigest, sourceBundleDigest: input.source.bundleDigest }),
      state: "proposed",
      version: 0,
      jobIds: [ids.jobId],
      createdAt,
      updatedAt: createdAt,
    },
    job: {
      ...source.job,
      id: ids.jobId,
      workflowId: ids.workflowId,
      projectId: input.projectId,
      state: "proposed",
      version: 0,
      dependsOnJobIds: [],
      authority,
      retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [],
        retryAfterOrphan: false, ambiguousEffectPolicy: "attention" },
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function validateSource(input: ScheduledTaskAdmissionInputV1, requestValue: unknown, workflowValue: unknown,
  jobValue: unknown): ProposedWorkBundle {
  const request = requestRecordSchema.parse(requestValue) as RequestRecord;
  const workflow = workflowRecordSchema.parse(workflowValue) as WorkflowRecord;
  const job = jobRecordSchema.parse(jobValue) as JobRecord;
  const bundle = { request, workflow, job };
  try { assertNoSecretMaterial(bundle, "scheduled source bundle"); } catch { fail("source_bundle_conflict"); }
  if (request.id !== input.source.requestId || workflow.id !== input.source.workflowId || job.id !== input.source.jobId
    || request.tenantId !== input.tenantId || workflow.tenantId !== input.tenantId || job.tenantId !== input.tenantId
    || request.projectId !== input.projectId || workflow.projectId !== input.projectId || job.projectId !== input.projectId
    || workflow.requestId !== request.id || job.workflowId !== workflow.id
    || workflow.jobIds.length !== 1 || workflow.jobIds[0] !== job.id || job.dependsOnJobIds.length !== 0
    || request.state !== "draft" || workflow.state !== "proposed" || job.state !== "proposed"
    || computeScheduledTaskSourceBundleDigestV1(bundle) !== input.source.bundleDigest) fail("source_bundle_conflict");
  return bundle;
}

function validateStoredReceipt(row: AdmissionRow, input: ScheduledTaskAdmissionInputV1): ScheduledTaskAdmissionReceiptV1 {
  let receipt: ScheduledTaskAdmissionReceiptV1;
  try { receipt = receiptSchema.parse(row.payload); } catch { fail("admission_conflict"); }
  const { receiptDigest: _storedDigest, ...unsigned } = receipt;
  if (receiptDigest(unsigned) !== receipt.receiptDigest || row.receipt_digest !== receipt.receiptDigest
    || row.tenant_id !== receipt.tenantId || row.workspace_id !== receipt.workspaceId || row.project_id !== receipt.projectId
    || row.schedule_id !== receipt.scheduleId || row.occurrence_key !== receipt.occurrenceKey
    || row.source_bundle_digest !== receipt.source.bundleDigest
    || row.schedule_definition_digest !== receipt.scheduleDefinitionDigest
    || row.context_binding_digest !== receipt.contextBinding.bindingDigest
    || row.destination_job_id !== receipt.destination.jobId
    || receipt.tenantId !== input.tenantId || receipt.workspaceId !== input.workspaceId || receipt.projectId !== input.projectId
    || receipt.scheduleId !== input.scheduleId || receipt.occurrenceKey !== input.occurrenceKey
    || receipt.scheduleDefinitionDigest !== input.scheduleDefinitionDigest
    || receipt.source.requestId !== input.source.requestId || receipt.source.workflowId !== input.source.workflowId
    || receipt.source.jobId !== input.source.jobId || receipt.source.bundleDigest !== input.source.bundleDigest
    || receipt.contextBinding.bindingDigest !== input.contextBinding.bindingDigest
    || sha256Digest(receipt.contextBinding.reusableContexts) !== sha256Digest(input.contextBinding.reusableContexts)) fail("admission_conflict");
  return receipt;
}

async function verifyDestination(tx: DatabaseSession, receipt: ScheduledTaskAdmissionReceiptV1): Promise<void> {
  const [requestRow, workflowRow, jobRow] = await Promise.all([
    tx.query<{ payload: unknown }>("SELECT payload FROM control_requests WHERE tenant_id=$1 AND id=$2", [receipt.tenantId, receipt.destination.requestId]),
    tx.query<{ payload: unknown }>("SELECT payload FROM control_workflows WHERE tenant_id=$1 AND id=$2", [receipt.tenantId, receipt.destination.workflowId]),
    tx.query<{ payload: unknown }>("SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2", [receipt.tenantId, receipt.destination.jobId]),
  ]);
  let bundle: ProposedWorkBundle;
  try {
    bundle = {
      request: requestRecordSchema.parse(requestRow.rows[0]?.payload) as RequestRecord,
      workflow: workflowRecordSchema.parse(workflowRow.rows[0]?.payload) as WorkflowRecord,
      job: jobRecordSchema.parse(jobRow.rows[0]?.payload) as JobRecord,
    };
  } catch { fail("admission_conflict"); }
  if (sha256Digest(bundle.request) !== receipt.destination.requestDigest
    || sha256Digest(bundle.workflow) !== receipt.destination.workflowDigest
    || sha256Digest(bundle.job) !== receipt.destination.jobDigest
    || sha256Digest({ contractVersion: "control-room-scheduled-destination-bundle/v1", ...bundle }) !== receipt.destination.bundleDigest
    || bundle.request.id !== receipt.destination.requestId || bundle.workflow.id !== receipt.destination.workflowId
    || bundle.job.id !== receipt.destination.jobId || bundle.workflow.requestId !== bundle.request.id
    || bundle.job.workflowId !== bundle.workflow.id || bundle.job.state !== "proposed") fail("admission_conflict");
}

/**
 * Maps an already-materialized exact schedule occurrence to one inert canonical
 * proposal. The durable receipt is the replay boundary; delivery acknowledgement
 * happens afterwards and never means that work started.
 */
export class ScheduledTaskAdmissionServiceV1 {
  readonly #occurrences: ScheduleOccurrenceStore;

  constructor(private readonly db: DatabaseClient, private readonly now: () => number) {
    this.#occurrences = new ScheduleOccurrenceStore(db);
  }

  async admit(value: unknown): Promise<{ receipt: ScheduledTaskAdmissionReceiptV1; replayed: boolean }> {
    const parsed = admissionInputSchema.safeParse(value);
    if (!parsed.success) fail("invalid_admission");
    const input = parsed.data;
    if (new Set(input.contextBinding.reusableContexts.map(item => `${item.kind}:${item.id}`)).size
      !== input.contextBinding.reusableContexts.length
      || sha256Digest({ contractVersion: "control-room-scheduled-context-binding/v1",
        reusableContexts: input.contextBinding.reusableContexts }) !== input.contextBinding.bindingDigest) {
      fail("context_binding_conflict");
    }
    const admittedAt = requireClockInstant(this.now);
    let recoveryEndsAtForCommit: number | undefined;
    const result = await this.db.transactionWithPreCommitCheck(async (tx) => {
      const scheduleRow = (await tx.query<{ project_id: string; state: string; payload: unknown }>(
        "SELECT project_id,state,payload FROM control_schedules WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [input.tenantId, input.scheduleId],
      )).rows[0];
      if (!scheduleRow) fail("binding_mismatch");
      let schedule: ScheduleRecord;
      try { schedule = scheduleRecordSchema.parse(scheduleRow.payload) as ScheduleRecord; } catch { fail("binding_mismatch"); }
      if (schedule.id !== input.scheduleId || schedule.tenantId !== input.tenantId
        || schedule.projectId !== input.projectId || scheduleRow.project_id !== input.projectId
        || scheduleRow.state !== schedule.state) fail("binding_mismatch");
      const occurrence = (await tx.query<OccurrenceRow>(
        "SELECT * FROM control_schedule_occurrences WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 FOR UPDATE",
        [input.tenantId, input.scheduleId, input.occurrenceKey],
      )).rows[0];
      if (!occurrence) fail("binding_mismatch");
      const prior = (await tx.query<AdmissionRow>(
        "SELECT * FROM control_scheduled_task_admissions WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3",
        [input.tenantId, input.scheduleId, input.occurrenceKey],
      )).rows[0];
      if (prior) {
        const receipt = validateStoredReceipt(prior, input);
        await verifyDestination(tx, receipt);
        return { receipt: frozenReceipt(receipt), replayed: true };
      }
      if (occurrence.state === "cancelled") fail("occurrence_cancelled");
      if (schedule.state !== "active") fail("schedule_not_active");
      const definitionDigest = computeScheduledTaskDefinitionDigestV1(schedule);
      if (schedule.targetType !== "job" || schedule.targetId !== input.source.jobId
        || occurrence.tenant_id !== input.tenantId || occurrence.schedule_id !== input.scheduleId
        || occurrence.occurrence_key !== input.occurrenceKey || occurrence.target_type !== "job"
        || occurrence.target_id !== input.source.jobId || occurrence.definition_digest !== input.scheduleDefinitionDigest
        || definitionDigest !== input.scheduleDefinitionDigest) fail("occurrence_conflict");
      const project = (await tx.query<{ id: string }>(
        "SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE",
        [input.tenantId, input.workspaceId, input.projectId],
      )).rows[0];
      if (!project) fail("binding_mismatch");
      const recoveryEndsAt = Date.parse(new Date(occurrence.scheduled_for).toISOString())
        + schedule.idempotencyWindowSeconds * 1_000;
      if (Date.parse(admittedAt) >= recoveryEndsAt || Date.parse(new Date(occurrence.created_at).toISOString()) >= recoveryEndsAt) {
        fail("recovery_window_expired");
      }
      recoveryEndsAtForCommit = recoveryEndsAt;
      const delivered = await tx.query<{ id: string }>(`SELECT id FROM control_outbox
        WHERE tenant_id=$1 AND topic='schedule.occurrence.created' AND aggregate_type='schedule_occurrence'
          AND aggregate_id=$2 AND idempotency_key=$2 AND status='delivered'
          AND payload=jsonb_build_object('scheduleId',$3::text,'occurrenceKey',$2::text,'targetType','job',
            'targetId',$4::text,'scheduledFor',to_char($5::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'definitionDigest',$6::text)
        FOR UPDATE`, [input.tenantId, input.occurrenceKey, input.scheduleId, input.source.jobId,
        occurrence.scheduled_for, input.scheduleDefinitionDigest]);
      if (!delivered.rows[0]) fail("outbox_not_delivered");
      const sources = await Promise.all([
        tx.query<{ payload: unknown }>("SELECT payload FROM control_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.source.requestId]),
        tx.query<{ payload: unknown }>("SELECT payload FROM control_workflows WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.source.workflowId]),
        tx.query<{ payload: unknown }>("SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.source.jobId]),
      ]);
      let source: ProposedWorkBundle;
      try { source = validateSource(input, sources[0].rows[0]?.payload, sources[1].rows[0]?.payload, sources[2].rows[0]?.payload); }
      catch (error) { if (error instanceof ScheduledTaskAdmissionError) throw error; fail("source_bundle_conflict"); }
      const bundle = destinationBundle(input, schedule, occurrence, source);
      await new CanonicalStore(joined(tx)).createProposedWorkBundle(bundle);
      const unsigned = {
        contractVersion: "control-room-scheduled-task-admission/v1" as const,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        scheduleId: input.scheduleId,
        occurrenceKey: input.occurrenceKey,
        occurrenceScheduledFor: new Date(occurrence.scheduled_for).toISOString(),
        scheduleDefinitionDigest: input.scheduleDefinitionDigest,
        source: {
          requestId: source.request.id, requestDigest: sha256Digest(source.request),
          workflowId: source.workflow.id, workflowDigest: sha256Digest(source.workflow),
          jobId: source.job.id, jobDigest: sha256Digest(source.job), bundleDigest: input.source.bundleDigest,
        },
        contextBinding: input.contextBinding,
        destination: {
          requestId: bundle.request.id, requestDigest: sha256Digest(bundle.request),
          workflowId: bundle.workflow.id, workflowDigest: sha256Digest(bundle.workflow),
          jobId: bundle.job.id, jobDigest: sha256Digest(bundle.job),
          bundleDigest: sha256Digest({ contractVersion: "control-room-scheduled-destination-bundle/v1", ...bundle }),
        },
        admittedAt,
        startsWork: false as const,
        grantsExecutionAuthority: false as const,
        permitsAssignment: false as const,
        permitsRetry: false as const,
        permitsCancellation: false as const,
      };
      const receipt = frozenReceipt({ ...unsigned, receiptDigest: receiptDigest(unsigned) });
      await tx.query(`INSERT INTO control_scheduled_task_admissions(
        tenant_id,workspace_id,project_id,schedule_id,occurrence_key,source_request_id,source_workflow_id,source_job_id,
        source_bundle_digest,schedule_definition_digest,context_binding_digest,destination_request_id,
        destination_workflow_id,destination_job_id,receipt_digest,payload,admitted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
      [receipt.tenantId, receipt.workspaceId, receipt.projectId, receipt.scheduleId, receipt.occurrenceKey,
        receipt.source.requestId, receipt.source.workflowId, receipt.source.jobId, receipt.source.bundleDigest,
        receipt.scheduleDefinitionDigest, receipt.contextBinding.bindingDigest, receipt.destination.requestId,
        receipt.destination.workflowId, receipt.destination.jobId, receipt.receiptDigest, JSON.stringify(receipt), receipt.admittedAt]);
      return { receipt, replayed: false };
    }, () => {
      if (recoveryEndsAtForCommit !== undefined && Date.parse(requireClockInstant(this.now)) >= recoveryEndsAtForCommit) {
        fail("recovery_window_expired");
      }
    });
    await this.#occurrences.acknowledgeDelivery({ tenantId: input.tenantId, scheduleId: input.scheduleId,
      occurrenceKey: input.occurrenceKey, deliveredAt: admittedAt });
    return result;
  }

  async cancelPending(value: unknown): Promise<{ cancelled: true; replayed: boolean; cancelsTask: false }> {
    const parsed = cancellationInputSchema.safeParse(value);
    if (!parsed.success) fail("invalid_admission");
    const input = parsed.data;
    return this.db.transaction(async (tx) => {
      const schedule = (await tx.query<{ project_id: string }>(
        "SELECT project_id FROM control_schedules WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [input.tenantId, input.scheduleId],
      )).rows[0];
      if (!schedule || schedule.project_id !== input.projectId) fail("binding_mismatch");
      const project = (await tx.query<{ id: string }>(
        "SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE",
        [input.tenantId, input.workspaceId, input.projectId],
      )).rows[0];
      if (!project) fail("binding_mismatch");
      const occurrence = (await tx.query<OccurrenceRow>(
        "SELECT * FROM control_schedule_occurrences WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 FOR UPDATE",
        [input.tenantId, input.scheduleId, input.occurrenceKey],
      )).rows[0];
      if (!occurrence || occurrence.definition_digest !== input.scheduleDefinitionDigest
        || occurrence.target_type !== "job" || occurrence.target_id !== input.sourceJobId) fail("occurrence_conflict");
      const prior = await tx.query<{ occurrence_key: string }>(
        "SELECT occurrence_key FROM control_scheduled_task_admissions WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3",
        [input.tenantId, input.scheduleId, input.occurrenceKey],
      );
      if (prior.rows[0]) fail("admission_already_committed");
      if (occurrence.state === "cancelled") return { cancelled: true, replayed: true, cancelsTask: false };
      if (occurrence.state !== "pending") fail("occurrence_conflict");
      const changed = await tx.query<{ occurrence_key: string }>(`UPDATE control_schedule_occurrences SET state='cancelled'
        WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 AND state='pending' RETURNING occurrence_key`,
      [input.tenantId, input.scheduleId, input.occurrenceKey]);
      if (!changed.rows[0]) fail("occurrence_conflict");
      return { cancelled: true, replayed: false, cancelsTask: false };
    });
  }
}
