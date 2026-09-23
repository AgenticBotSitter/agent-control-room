import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DOMAIN_CONTRACT_VERSION, authorityEnvelopeSchema, jobRecordSchema, requestRecordSchema,
  workflowRecordSchema, type JobRecord } from "../../domain/v1";
import { CanonicalStore } from "../../persistence/canonical-store";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import type { ScheduledReusableContextV1 } from "../../services/v1/scheduled-task-admission";
import { assertNoSecretMaterial, computeAuthorityDigest, hmacSha256Tag, sha256Digest, type AwaitableRollbackCheckpointStoreV1 } from "../../security";
import { CompletionGateStoreV1, completionAcceptanceProfileSchemaV1, completionReviewSchemaV1,
  completionFindingSchemaV1 } from "../../completion-gate/v1";
import { NativeResultSubmissionService } from "../../completion-gate/v1/native-result-submission";
import type { TaskResultInspectionSourceV1 } from "../../completion-gate/v1/task-result-inspection";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { HERMES_NATIVE_ADAPTER, localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1, CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
  CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1, CONTROLLER_WORKER_REMOTE_START_OPERATION_V1 } from "../../harness/v1/remote-worker-delivery";
import { CODEX_APP_SERVER_ADAPTER, CODEX_APP_SERVER_CAPABILITY, CODEX_APP_SERVER_JOB_TYPE,
  CODEX_START_OPERATION } from "../../harness/codex-v1/delivery-contract";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
  HERMES_021_MACOS_LOCAL_JOB_TYPE_V1, HERMES_021_MACOS_LOCAL_START_OPERATION_V1 } from "../../harness/hermes-021-v1/macos-local-worker";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1,
  CLAUDE_CODE_LOCAL_CAPABILITY_V1, CLAUDE_CODE_LOCAL_JOB_TYPE_V1,
  CLAUDE_CODE_LOCAL_START_OPERATION_V1 } from "../../harness/claude-code-v1/task-planning-contract";
import { parseCanonicalHttpsDestination } from "../../node-policy/v1/network-target-guard";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority } from "./session-authority";
import { WebProjectService } from "./project-service";
import { taskDraftSchema } from "./task-wire";
import { taskRevisionContextSchema, taskRevisionRequestSchema, type TaskRevisionRequest } from "./task-revision-wire";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
/** Server-owned template, never accepted from a browser or worker request. This first planning
 * class describes one approval-required native text turn, not arbitrary tools or a runnable grant. */
export const nativeTaskTemplateSchema = z.object({ id: localId, adapter: z.enum([HERMES_NATIVE_ADAPTER, HERMES_021_MACOS_LOCAL_ADAPTER_V1, CODEX_APP_SERVER_ADAPTER, CLAUDE_CODE_LOCAL_ADAPTER_V1, CONTROLLER_WORKER_REMOTE_ADAPTER_V1]),
  instructions: z.string().max(8192).refine(value => Buffer.byteLength(value, "utf8") <= 8192),
  authority: authorityEnvelopeSchema, acceptanceProfileId: localId, acceptanceProfileDigest: digestSchema,
  connectorProfileDigest: digestSchema.optional(), workspaceIntentDigest: digestSchema.optional(),
}).strict().superRefine((value, context) => {
  const a = value.authority;
  const hermesNative = value.adapter === HERMES_NATIVE_ADAPTER;
  const hermes021 = value.adapter === HERMES_021_MACOS_LOCAL_ADAPTER_V1;
  const claude = value.adapter === CLAUDE_CODE_LOCAL_ADAPTER_V1;
  const remote = value.adapter === CONTROLLER_WORKER_REMOTE_ADAPTER_V1;
  const hermes = hermesNative || hermes021;
  const operation = hermesNative ? "harness.hermes.native.start" : hermes021 ? HERMES_021_MACOS_LOCAL_START_OPERATION_V1
    : claude ? CLAUDE_CODE_LOCAL_START_OPERATION_V1 : remote ? CONTROLLER_WORKER_REMOTE_START_OPERATION_V1 : CODEX_START_OPERATION;
  if (a.allowedExecutor === "executor:unassigned" || a.allowedOperations.length !== 1
    || a.allowedOperations[0] !== operation
    || a.filesystemRoots.length !== (hermes || claude || remote ? 0 : 1) || a.credentialRefs.length !== 1
    || a.networkPolicy !== (hermes ? "allowlist" : "none") || a.allowedNetworkDestinations.length !== (hermes ? 1 : 0)
    || a.effectPolicy !== "approval_required" || a.maxConcurrentEffects !== 1 || a.maxDurationSeconds > 300
    || a.maxCostUsd !== undefined || a.parentDigest !== undefined || a.maxRisk !== "low"
    || computeAuthorityDigest(a) !== a.digest) context.addIssue({ code: "custom", message: "unsupported native task template" });
  // The first local Hermes adapter is the restricted one-turn text-review
  // runner. Its process host cannot be configured above two minutes, so the
  // durable authority must not advertise a longer local effect window.
  if (hermes021 && a.maxDurationSeconds > 120)
    context.addIssue({ code: "custom", message: "unsupported native task template" });
  if (claude && value.connectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1) {
    context.addIssue({ code: "custom", message: "unsupported native task template" });
  }
  if (hermesNative ? value.connectorProfileDigest !== undefined || value.workspaceIntentDigest !== undefined
    : hermes021 ? value.connectorProfileDigest === undefined || value.workspaceIntentDigest !== undefined
      : claude || remote ? value.connectorProfileDigest === undefined || value.workspaceIntentDigest !== undefined
        : value.connectorProfileDigest === undefined || value.workspaceIntentDigest === undefined) {
    context.addIssue({ code: "custom", message: "unsupported native task template" });
  }
  try { for (const destination of a.allowedNetworkDestinations) parseCanonicalHttpsDestination(destination); }
  catch { context.addIssue({ code: "custom", message: "unsupported native destination" }); }
});
export type NativeTaskTemplate = z.infer<typeof nativeTaskTemplateSchema>;
/**
 * Local adapters require installation-specific proof in addition to a normal
 * task template.  This is deliberately server configuration, never a fleet
 * signal, browser value, or worker claim.  It applies only to the adapters
 * that represent a process on this computer; the existing native Hermes
 * adapter remains available for its separately-qualified route.
 */
export const locallyAdmittedTaskAdapterSchema = z.enum([
  HERMES_021_MACOS_LOCAL_ADAPTER_V1,
  CODEX_APP_SERVER_ADAPTER,
  CLAUDE_CODE_LOCAL_ADAPTER_V1,
]);
export type LocallyAdmittedTaskAdapter = z.infer<typeof locallyAdmittedTaskAdapterSchema>;
export const localTaskAdapterAdmissionSchema = z.object({
  enabledAdapters: z.array(locallyAdmittedTaskAdapterSchema).max(3),
}).strict().superRefine((value, context) => {
  if (new Set(value.enabledAdapters).size !== value.enabledAdapters.length)
    context.addIssue({ code: "custom", message: "local adapters ambiguous" });
});
export type LocalTaskAdapterAdmission = z.infer<typeof localTaskAdapterAdmissionSchema>;

function captureLocalTaskAdapterAdmission(value: LocalTaskAdapterAdmission | undefined) {
  if (value === undefined) return undefined;
  const parsed = localTaskAdapterAdmissionSchema.parse(value);
  return Object.freeze({ enabledAdapters: Object.freeze([...parsed.enabledAdapters]) });
}
function requiresLocalAdmission(adapter: NativeTaskTemplate["adapter"]): adapter is LocallyAdmittedTaskAdapter {
  return locallyAdmittedTaskAdapterSchema.safeParse(adapter).success;
}
/** Explicit server configuration only. No fallback template or project-ID substitution. */
export function captureNativeTaskTemplates(config: { template: NativeTaskTemplate; additionalTemplates?: readonly NativeTaskTemplate[] }) {
  const template = nativeTaskTemplateSchema.parse(config.template);
  const additional = config.additionalTemplates === undefined ? []
    : z.array(nativeTaskTemplateSchema).max(15).parse(config.additionalTemplates);
  const all = [template, ...additional];
  for (const value of all) assertNoSecretMaterial(value);
  if (new Set(all.map(value => value.id)).size !== all.length)
    throw new Error("task_execution_templates_ambiguous");
  return { template, ...(config.additionalTemplates === undefined ? {} : { additionalTemplates: additional }) };
}
const initialPlanSchema = z.object({ schema: z.literal("control-room.task-execution-plan/v1"), tenantId: localId,
  projectId: localId, sourceJobId: localId, sourceDigest: digestSchema, sourceInputDigest: digestSchema,
  templateDigest: digestSchema, plannedBy: localId, plannedAt: instant,
  input: z.object({ prompt: z.string().min(1).max(4000), instructions: z.string().max(8192)
    .refine(value => Buffer.byteLength(value, "utf8") <= 8192) }).strict(),
  request: requestRecordSchema, workflow: workflowRecordSchema, job: jobRecordSchema,
  acceptanceProfileId: localId, acceptanceProfileDigest: digestSchema,
}).strict();
const revisionPlanSchema = initialPlanSchema.extend({ schema: z.literal("control-room.task-execution-plan/v2"), revision: taskRevisionContextSchema });
export const codexTaskExecutionPlanSchemaV3 = initialPlanSchema.extend({ schema: z.literal("control-room.task-execution-plan/v3"),
  adapter: z.literal(CODEX_APP_SERVER_ADAPTER), connectorProfileDigest: digestSchema, workspaceIntentDigest: digestSchema });
export type CodexTaskExecutionPlanV3 = z.infer<typeof codexTaskExecutionPlanSchemaV3>;
export const codexTaskExecutionPlanSchemaV4 = codexTaskExecutionPlanSchemaV3.extend({
  schema: z.literal("control-room.task-execution-plan/v4"), revision: taskRevisionContextSchema });
export type CodexTaskExecutionPlanV4 = z.infer<typeof codexTaskExecutionPlanSchemaV4>;
export type CodexTaskExecutionPlan = CodexTaskExecutionPlanV3 | CodexTaskExecutionPlanV4;
export const hermes021TaskExecutionPlanSchemaV5 = initialPlanSchema.extend({
  schema: z.literal("control-room.task-execution-plan/v5"), adapter: z.literal(HERMES_021_MACOS_LOCAL_ADAPTER_V1),
  connectorProfileDigest: digestSchema,
});
export type Hermes021TaskExecutionPlanV5 = z.infer<typeof hermes021TaskExecutionPlanSchemaV5>;
export const hermes021TaskExecutionPlanSchemaV6 = hermes021TaskExecutionPlanSchemaV5.extend({
  schema: z.literal("control-room.task-execution-plan/v6"), revision: taskRevisionContextSchema,
});
export type Hermes021TaskExecutionPlanV6 = z.infer<typeof hermes021TaskExecutionPlanSchemaV6>;
/** The first local Hermes adapter may return review text but may not write a project. */
export const hermes021TaskExecutionPlanSchemaV7 = hermes021TaskExecutionPlanSchemaV5.extend({
  schema: z.literal("control-room.task-execution-plan/v7"), executionClass: z.literal("text_review"),
});
export type Hermes021TaskExecutionPlanV7 = z.infer<typeof hermes021TaskExecutionPlanSchemaV7>;
export const hermes021TaskExecutionPlanSchemaV8 = hermes021TaskExecutionPlanSchemaV7.extend({
  schema: z.literal("control-room.task-execution-plan/v8"), revision: taskRevisionContextSchema,
});
export type Hermes021TaskExecutionPlanV8 = z.infer<typeof hermes021TaskExecutionPlanSchemaV8>;
/** Claude may be planned, but this immutable record is not an admission or launch grant. */
export const claudeCodeLocalTaskExecutionPlanSchemaV9 = initialPlanSchema.extend({
  schema: z.literal("control-room.task-execution-plan/v9"), adapter: z.literal(CLAUDE_CODE_LOCAL_ADAPTER_V1),
  connectorProfileDigest: z.literal(CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1), executionClass: z.literal("text_review"),
});
export type ClaudeCodeLocalTaskExecutionPlanV9 = z.infer<typeof claudeCodeLocalTaskExecutionPlanSchemaV9>;
export const claudeCodeLocalTaskExecutionPlanSchemaV10 = claudeCodeLocalTaskExecutionPlanSchemaV9.extend({
  schema: z.literal("control-room.task-execution-plan/v10"), revision: taskRevisionContextSchema,
});
export type ClaudeCodeLocalTaskExecutionPlanV10 = z.infer<typeof claudeCodeLocalTaskExecutionPlanSchemaV10>;
/** Remote-compatible planning is a durable, non-executing text-review proposal only. */
export const controllerWorkerRemoteTaskExecutionPlanSchemaV11 = initialPlanSchema.extend({
  schema: z.literal("control-room.task-execution-plan/v11"), adapter: z.literal(CONTROLLER_WORKER_REMOTE_ADAPTER_V1),
  connectorProfileDigest: digestSchema, executionClass: z.literal("text_review"),
});
export type ControllerWorkerRemoteTaskExecutionPlanV11 = z.infer<typeof controllerWorkerRemoteTaskExecutionPlanSchemaV11>;
/** A correction keeps the same reviewed remote adapter/profile binding as its
 * source plan. It is a new proposed job, never a reopening of the source. */
export const controllerWorkerRemoteTaskExecutionPlanSchemaV12 = controllerWorkerRemoteTaskExecutionPlanSchemaV11.extend({
  schema: z.literal("control-room.task-execution-plan/v12"), revision: taskRevisionContextSchema,
});
export type ControllerWorkerRemoteTaskExecutionPlanV12 = z.infer<typeof controllerWorkerRemoteTaskExecutionPlanSchemaV12>;
const planSchema = z.discriminatedUnion("schema", [initialPlanSchema, revisionPlanSchema,
  codexTaskExecutionPlanSchemaV3, codexTaskExecutionPlanSchemaV4,
  hermes021TaskExecutionPlanSchemaV5, hermes021TaskExecutionPlanSchemaV6,
  hermes021TaskExecutionPlanSchemaV7, hermes021TaskExecutionPlanSchemaV8,
  claudeCodeLocalTaskExecutionPlanSchemaV9, claudeCodeLocalTaskExecutionPlanSchemaV10,
  controllerWorkerRemoteTaskExecutionPlanSchemaV11, controllerWorkerRemoteTaskExecutionPlanSchemaV12]);
type Plan = z.infer<typeof planSchema>;
export type TaskPlanningTemplateChoice = Readonly<{ id: string; adapter: NativeTaskTemplate["adapter"] }>;
export type TaskPlanningOperation = Readonly<{ tenantId: string; workspaceId: string; plan: TaskExecutionPlanner["plan"];
  supportsProject?: (projectId: string) => boolean; templatesForProject?: (projectId: string) => readonly TaskPlanningTemplateChoice[];
  readSaved?: TaskExecutionPlanner["readSaved"]; readPreparedWorker?: TaskExecutionPlanner["readPreparedWorker"];
  readConfiguredLocalRoute?: TaskExecutionPlanner["readConfiguredLocalRoute"] }>;
type Row = { tenant_id: string; project_id: string; source_job_id: string; job_id: string; plan: unknown; auth_tag: string };
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
const fail = (): never => { throw new Error("task_execution_plan_unavailable"); };
const immutableJob = (job: JobRecord) => ({ ...job, state: "proposed", version: 0, updatedAt: job.createdAt });
export const SCHEDULE_ASSIGNMENT_SERVICE_ACTOR_V1 = "service:schedule-assignment:v1";
export const SCHEDULED_CONTEXT_REFERENCE_BLOCK_V1 = "control-room-scheduled-context-references/v1";
/** Execution-compatible context binding. Empty context preserves the legacy instruction bytes;
 * non-empty context adds only canonical IDs, digests and timestamps in a deterministic block. */
export function bindScheduledContextReferencesV1(instructions: string, contexts: readonly ScheduledReusableContextV1[]) {
  if (contexts.length === 0) return instructions;
  const entries = contexts.map((context, index) => [
    `context.${index}.kind=${context.kind}`, `context.${index}.id=${context.id}`,
    `context.${index}.targetId=${context.targetId}`, `context.${index}.contentHash=${context.contentHash}`,
    `context.${index}.sourceJobId=${context.sourceJobId}`, `context.${index}.sourceRunId=${context.sourceRunId}`,
    `context.${index}.sourceRevision=${context.sourceRevision}`,
    `context.${index}.reviewIds=${context.reviewIds.join(",")}`, `context.${index}.reviewDigest=${context.reviewDigest}`,
    `context.${index}.verificationIds=${context.verificationIds.join(",")}`,
    `context.${index}.verificationDigest=${context.verificationDigest}`, `context.${index}.verifiedAt=${context.verifiedAt}`,
    `context.${index}.expiresAt=${context.expiresAt ?? "none"}`,
  ]).flat();
  const bindingDigest = sha256Digest({ contractVersion: SCHEDULED_CONTEXT_REFERENCE_BLOCK_V1, reusableContexts: contexts });
  const block = [`[${SCHEDULED_CONTEXT_REFERENCE_BLOCK_V1}]`, `bindingDigest=${bindingDigest}`,
    ...entries, `[/${SCHEDULED_CONTEXT_REFERENCE_BLOCK_V1}]`].join("\n");
  const bound = `${instructions}\n\n${block}`;
  if (bound.length > 8192 || Buffer.byteLength(bound, "utf8") > 8192) throw new WebAccessError("conflict");
  return bound;
}

/** Authenticated historical v3 plan read for trusted Codex result persistence. It grants no
 * execution, result-write, review, completion or capacity-release authority. */
export async function readCodexTaskExecutionPlanV3InSession(tx: DatabaseSession, integrityKey: Uint8Array,
  tenantId: string, jobId: string): Promise<CodexTaskExecutionPlan | undefined> {
  try {
    localId.parse(tenantId); localId.parse(jobId);
    const row = (await tx.query<Row>(`SELECT tenant_id,project_id,source_job_id,job_id,plan,auth_tag
      FROM control_task_execution_plans WHERE tenant_id=$1 AND job_id=$2`, [tenantId, jobId])).rows[0];
    if (!row) return undefined;
    const raw = z.object({ schema: z.enum(["control-room.task-execution-plan/v3", "control-room.task-execution-plan/v4"]) }).passthrough().parse(row.plan);
    const plan = raw.schema === "control-room.task-execution-plan/v3"
      ? codexTaskExecutionPlanSchemaV3.parse(row.plan) : codexTaskExecutionPlanSchemaV4.parse(row.plan);
    const expected = Buffer.from(hmacSha256Tag(integrityKey,
      { purpose: plan.schema === "control-room.task-execution-plan/v3" ? "task-execution-plan/v3" : "task-execution-plan/v4", plan }));
    const actual = Buffer.from(row.auth_tag);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
      || row.tenant_id !== plan.tenantId || row.project_id !== plan.projectId
      || row.source_job_id !== plan.sourceJobId || row.job_id !== plan.job.id) fail();
    return plan;
  } catch { return fail(); }
}

/** Privileged control-plane composition only; the existing private-web SQL role cannot use this
 * writer. Current owner permission is still mandatory. The optional web operation exposes only
 * planning and an authenticated historical receipt, never this writer's raw read/bindReview
 * methods or a live executor. */
export class TaskExecutionPlanner {
  private readonly templates: ReadonlyMap<string, NativeTaskTemplate>;
  private readonly projectTemplates: ReadonlyMap<string, readonly NativeTaskTemplate[]>;
  private readonly key: Uint8Array;
  private readonly reviewKey: Uint8Array;
  private readonly checkpoints: AwaitableRollbackCheckpointStoreV1;
  private readonly projects: WebProjectService;
  private readonly revisionSource?: NativeResultSubmissionService | TaskResultInspectionSourceV1;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    config: { template: NativeTaskTemplate; additionalTemplates?: readonly NativeTaskTemplate[]; integrityKey: Uint8Array; reviewIntegrityKey: Uint8Array;
      checkpoints: AwaitableRollbackCheckpointStoreV1; ideaIntegrityKey?: Uint8Array; localAdapterAdmission?: LocalTaskAdapterAdmission }, private readonly clock: () => number = Date.now,
    revisionResults?: ConstructorParameters<typeof NativeResultSubmissionService>[1], revisionSource?: TaskResultInspectionSourceV1) {
    const captured = captureNativeTaskTemplates(config);
    const values = [captured.template, ...(captured.additionalTemplates ?? [])];
    this.templates = new Map(values.map(value => [value.id, value]));
    this.projectTemplates = new Map([...new Set(values.map(value => value.authority.projectId))].map(projectId => [projectId,
      Object.freeze(values.filter(value => value.authority.projectId === projectId))]));
    if (!(config.integrityKey instanceof Uint8Array) || config.integrityKey.length !== 32
      || !(config.reviewIntegrityKey instanceof Uint8Array) || config.reviewIntegrityKey.length !== 32) fail();
    this.key = Uint8Array.from(config.integrityKey); this.reviewKey = Uint8Array.from(config.reviewIntegrityKey);
    this.checkpoints = { read: config.checkpoints.read.bind(config.checkpoints),
      initialize: fail, advance: fail };
    this.localAdapterAdmission = captureLocalTaskAdapterAdmission(config.localAdapterAdmission);
    this.projects = new WebProjectService(db, scope, clock, config.ideaIntegrityKey);
    if (revisionResults) {
      if (revisionResults.integrityKey.length !== this.reviewKey.length || !timingSafeEqual(revisionResults.integrityKey, this.reviewKey)) fail();
      this.revisionSource = new NativeResultSubmissionService(db, { ...revisionResults, checkpoints: this.checkpoints });
    }
    if (revisionSource) this.revisionSource = revisionSource;
  }
  private readonly localAdapterAdmission?: Readonly<{ enabledAdapters: readonly LocallyAdmittedTaskAdapter[] }>;
  private canPrepare(template: NativeTaskTemplate) {
    return !requiresLocalAdmission(template.adapter) || this.localAdapterAdmission === undefined
      || this.localAdapterAdmission.enabledAdapters.includes(template.adapter);
  }
  /** New work only. Historical receipts remain readable for recovery and audit. */
  private requirePrepared(template: NativeTaskTemplate) {
    if (!this.canPrepare(template)) throw new WebAccessError("conflict");
  }
  /** Read-only availability check. It exposes no installation details. */
  isPlanAssignable(plan: Plan) {
    const adapter = plan.schema === "control-room.task-execution-plan/v3" || plan.schema === "control-room.task-execution-plan/v4"
      ? CODEX_APP_SERVER_ADAPTER : plan.schema === "control-room.task-execution-plan/v5"
        || plan.schema === "control-room.task-execution-plan/v6" || plan.schema === "control-room.task-execution-plan/v7"
        || plan.schema === "control-room.task-execution-plan/v8" ? HERMES_021_MACOS_LOCAL_ADAPTER_V1
          : plan.schema === "control-room.task-execution-plan/v9" || plan.schema === "control-room.task-execution-plan/v10"
            ? CLAUDE_CODE_LOCAL_ADAPTER_V1 : plan.schema === "control-room.task-execution-plan/v11" || plan.schema === "control-room.task-execution-plan/v12"
              ? CONTROLLER_WORKER_REMOTE_ADAPTER_V1 : HERMES_NATIVE_ADAPTER;
    return !requiresLocalAdmission(adapter) || this.localAdapterAdmission === undefined
      || this.localAdapterAdmission.enabledAdapters.includes(adapter);
  }
  /** Used by assignment after exact-lease replay is resolved. It is not exposed to the browser. */
  assertPlanAssignable(plan: Plan) {
    if (!this.isPlanAssignable(plan)) throw new WebAccessError("conflict");
  }
  private async inspectRevision(tx: DatabaseSession, tenantId: string, runId: string) {
    const context = await this.revisionSource!.inspectSubmitted(tx, tenantId, runId);
    if ("execution" in context) return context;
    const native = context.run.nativeTask, terminal = context.events.at(-1);
    if (!native || context.result.receipt.schema !== "control-room.native-result-receipt/v1"
      || terminal?.payload.category !== "native_snapshot" || terminal.payload.snapshot.state !== "completed"
      || !context.run.startedAt || !context.run.finishedAt) return fail();
    return { ...context, execution: { leaseId: native.leaseId, leaseEpoch: native.leaseEpoch,
      startedAt: context.run.startedAt, completedAt: context.run.finishedAt, completedBefore: native.deadline } };
  }
  private tag(plan: Plan) { return hmacSha256Tag(this.key, { purpose: plan.schema === "control-room.task-execution-plan/v1"
    ? "task-execution-plan/v1" : plan.schema === "control-room.task-execution-plan/v2"
      ? "task-execution-plan/v2" : plan.schema === "control-room.task-execution-plan/v3"
        ? "task-execution-plan/v3" : plan.schema === "control-room.task-execution-plan/v4"
          ? "task-execution-plan/v4" : plan.schema === "control-room.task-execution-plan/v5"
          ? "task-execution-plan/v5" : plan.schema === "control-room.task-execution-plan/v6"
            ? "task-execution-plan/v6" : plan.schema === "control-room.task-execution-plan/v7"
              ? "task-execution-plan/v7" : plan.schema === "control-room.task-execution-plan/v8"
                ? "task-execution-plan/v8" : plan.schema === "control-room.task-execution-plan/v9"
                  ? "task-execution-plan/v9" : plan.schema === "control-room.task-execution-plan/v10"
                  ? "task-execution-plan/v10" : plan.schema === "control-room.task-execution-plan/v11"
                    ? "task-execution-plan/v11" : "task-execution-plan/v12", plan }); }
  webOperation(): TaskPlanningOperation {
    return Object.freeze({ tenantId: this.scope.tenantId, workspaceId: this.scope.workspaceId, plan: this.plan.bind(this),
      supportsProject: this.supportsProject.bind(this), templatesForProject: this.templatesForProject.bind(this),
      readSaved: this.readSaved.bind(this), readPreparedWorker: this.readPreparedWorker.bind(this) });
  }
  supportsProject(projectId: string) {
    return (this.projectTemplates.get(projectId) ?? []).some(template => this.canPrepare(template));
  }
  /** Safe server-owned choices only. IDs identify reviewed templates, not a host, login or executable. */
  templatesForProject(projectId: string): readonly TaskPlanningTemplateChoice[] {
    localId.parse(projectId);
    return Object.freeze((this.projectTemplates.get(projectId) ?? []).filter(value => this.canPrepare(value))
      .map(value => Object.freeze({ id: value.id, adapter: value.adapter })));
  }
  private selectTemplate(projectId: string, templateId?: string) {
    const candidates = this.projectTemplates.get(projectId) ?? [];
    if (templateId !== undefined) {
      localId.parse(templateId);
      const selected = this.templates.get(templateId);
      if (!selected || selected.authority.projectId !== projectId) throw new WebAccessError("conflict");
      return selected;
    }
    if (candidates.length !== 1) throw new WebAccessError("conflict");
    return candidates[0]!;
  }
  private templateForSavedPlan(projectId: string, templateDigest: string) {
    const candidates = (this.projectTemplates.get(projectId) ?? []).filter(value => sha256Digest(value) === templateDigest);
    if (candidates.length !== 1) throw new WebAccessError("conflict");
    return candidates[0]!;
  }
  /** Historical receipt only; never replans or applies current template expiry to saved evidence. */
  async readSaved(identity: VerifiedWebIdentity, projectId: string, sourceJobId: string) {
    localId.parse(projectId); localId.parse(sourceJobId);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      const job = await this.jobWith(tx, projectId, sourceJobId);
      if (job.jobType !== "task.proposal") return null;
      const source = await this.source(tx, projectId, sourceJobId);
      const row = (await tx.query<Row>("SELECT * FROM control_task_execution_plans WHERE tenant_id=$1 AND source_job_id=$2",
        [this.scope.tenantId, sourceJobId])).rows[0];
      if (!row) return null;
      const plan = this.verify(row);
      if (["control-room.task-execution-plan/v2", "control-room.task-execution-plan/v4", "control-room.task-execution-plan/v6", "control-room.task-execution-plan/v8", "control-room.task-execution-plan/v10", "control-room.task-execution-plan/v12"].includes(plan.schema) || plan.projectId !== projectId
        || plan.sourceJobId !== sourceJobId || plan.sourceDigest !== sha256Digest(source)
        || plan.sourceInputDigest !== source.job.inputDigest) fail();
      await this.checkedJob(tx, plan);
      return this.receipt(plan);
    });
  }
  /** A deliberately small read model for a prepared task page. It verifies the saved plan
   * before translating its adapter to a display category; it never exposes a worker, template,
   * profile, host or credential reference. */
  async readPreparedWorker(identity: VerifiedWebIdentity, projectId: string, jobId: string) {
    localId.parse(projectId); localId.parse(jobId);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      const row = (await tx.query<Row>("SELECT * FROM control_task_execution_plans WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3",
        [this.scope.tenantId, projectId, jobId])).rows[0];
      if (!row) return null;
      const plan = this.verify(row);
      if (plan.projectId !== projectId || plan.job.id !== jobId) fail();
      await this.checkedJob(tx, plan);
      if (plan.schema === "control-room.task-execution-plan/v3" || plan.schema === "control-room.task-execution-plan/v4") return "codex" as const;
      if (plan.schema === "control-room.task-execution-plan/v5" || plan.schema === "control-room.task-execution-plan/v6"
        || plan.schema === "control-room.task-execution-plan/v7" || plan.schema === "control-room.task-execution-plan/v8") return "hermes" as const;
      if (plan.schema === "control-room.task-execution-plan/v9" || plan.schema === "control-room.task-execution-plan/v10") return "claude" as const;
      return "configured_worker" as const;
    });
  }
  /** Server-only conclusion about whether this saved task plan still names one
   * exact locally admitted adapter. It intentionally returns no route detail. */
  async readConfiguredLocalRoute(identity: VerifiedWebIdentity, projectId: string, jobId: string) {
    localId.parse(projectId); localId.parse(jobId);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      const row = (await tx.query<Row>("SELECT * FROM control_task_execution_plans WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3",
        [this.scope.tenantId, projectId, jobId])).rows[0];
      if (!row) return "not_configured" as const;
      const plan = this.verify(row);
      if (plan.projectId !== projectId || plan.job.id !== jobId) fail();
      await this.checkedJob(tx, plan);
      const adapter = plan.schema === "control-room.task-execution-plan/v3" || plan.schema === "control-room.task-execution-plan/v4"
        ? CODEX_APP_SERVER_ADAPTER : plan.schema === "control-room.task-execution-plan/v5"
          || plan.schema === "control-room.task-execution-plan/v6" || plan.schema === "control-room.task-execution-plan/v7"
          || plan.schema === "control-room.task-execution-plan/v8" ? HERMES_021_MACOS_LOCAL_ADAPTER_V1
            : plan.schema === "control-room.task-execution-plan/v9" || plan.schema === "control-room.task-execution-plan/v10"
              ? CLAUDE_CODE_LOCAL_ADAPTER_V1 : undefined;
      if (!adapter || !this.localAdapterAdmission) return "not_configured" as const;
      return this.localAdapterAdmission.enabledAdapters.filter(value => value === adapter).length === 1
        ? "configured" as const : "not_configured" as const;
    });
  }
  private verify(row: Row) {
    const plan = planSchema.parse(row.plan), expected = Buffer.from(this.tag(plan)), actual = Buffer.from(row.auth_tag);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || row.tenant_id !== plan.tenantId
      || row.project_id !== plan.projectId || row.source_job_id !== plan.sourceJobId || row.job_id !== plan.job.id) fail();
    return plan;
  }
  private async profile(tx: DatabaseSession, plan: { tenantId: string; projectId: string; acceptanceProfileId: string;
    acceptanceProfileDigest: string }, at: string) {
    const gate = new CompletionGateStoreV1(joined(tx), this.reviewKey, this.checkpoints);
    const profile = completionAcceptanceProfileSchemaV1.parse(await gate.getRecord(plan.tenantId, plan.acceptanceProfileId, "profile"));
    if (profile.tenantId !== plan.tenantId || profile.projectId !== plan.projectId || profile.targetKind !== "document"
      || sha256Digest(profile) !== plan.acceptanceProfileDigest || Date.parse(profile.createdAt) > Date.parse(at)) fail();
  }
  private async source(tx: DatabaseSession, projectId: string, jobId: string) {
    const job = await this.jobWith(tx, projectId, jobId, true), canonical = new CanonicalStore(joined(tx));
    const workflow = workflowRecordSchema.parse(await canonical.get(this.scope.tenantId, "workflow", job.workflowId));
    const request = requestRecordSchema.parse(await canonical.get(this.scope.tenantId, "request", workflow.requestId));
    const draft = taskDraftSchema.parse({ title: request.title, instructions: request.objective });
    const a = job.authority;
    if (job.tenantId !== this.scope.tenantId || job.projectId !== projectId || job.id !== jobId || job.jobType !== "task.proposal"
      || job.state !== "proposed" || job.version !== 0 || workflow.projectId !== projectId || request.projectId !== projectId
      || workflow.tenantId !== job.tenantId || request.tenantId !== job.tenantId || workflow.jobIds.length !== 1
      || workflow.jobIds[0] !== jobId || workflow.id !== job.workflowId || request.id !== workflow.requestId
      || workflow.state !== "proposed" || request.state !== "draft" || workflow.version !== 0 || request.version !== 0
      || job.inputDigest !== sha256Digest(draft) || a.digest !== computeAuthorityDigest(a)
      || a.allowedExecutor !== "executor:unassigned" || a.networkPolicy !== "none" || a.effectPolicy !== "none"
      || a.credentialRefs.length || a.filesystemRoots.length || a.allowedNetworkDestinations.length || a.maxConcurrentEffects) fail();
    assertNoSecretMaterial({ job, workflow, request });
    return { job, workflow, request };
  }
  /** An owner plans a saved proposal, not new request-supplied instructions or authority. Exact
   * source uniqueness serves as reconciliation identity across browser keys and service restarts. */
  async plan(identity: VerifiedWebIdentity, projectId: string, sourceJobId: string, expectedInputDigest: string, templateId?: string) {
    localId.parse(projectId); localId.parse(sourceJobId); digestSchema.parse(expectedInputDigest);
    let template: NativeTaskTemplate | undefined;
    let materializing = false;
    const requireTemplateTime = () => {
      const now = this.clock();
      if (!template || !Number.isSafeInteger(now) || Date.parse(template.authority.expiresAt) < now + template.authority.maxDurationSeconds * 1000)
        throw new WebAccessError("conflict");
    };
    const db: DatabaseClient = { query: this.db.query.bind(this.db), transaction: this.db.transaction.bind(this.db),
      transactionWithPreCommitCheck: (work, check) => this.db.transactionWithPreCommitCheck(work, async () => {
        await check(); if (materializing) requireTemplateTime();
      }) };
    return new WebSessionAuthority(db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.plan", projectId, true);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      const source = await this.source(tx, projectId, sourceJobId);
      if (source.job.inputDigest !== expectedInputDigest) throw new WebAccessError("conflict");
      template = this.selectTemplate(projectId, templateId);
      const templateDigest = sha256Digest(template), sourceDigest = sha256Digest(source);
      const prior = (await tx.query<Row>("SELECT * FROM control_task_execution_plans WHERE tenant_id=$1 AND source_job_id=$2",
        [this.scope.tenantId, sourceJobId])).rows[0];
      if (prior) {
        const plan = this.verify(prior);
        if (plan.templateDigest !== templateDigest || plan.sourceDigest !== sourceDigest) throw new WebAccessError("conflict");
        await this.checkedJob(tx, plan);
        return { receipt: this.receipt(plan), replayed: true };
      }
      this.requirePrepared(template);
      if (project.lifecycle !== "active" || template.authority.projectId !== projectId)
        throw new WebAccessError("conflict");
      // Identity/source locks may have waited. Sample current time here and again at commit,
      // but do not apply today's template expiry to exact historical reconciliation.
      requireTemplateTime(); materializing = true;
      const suffix = sha256Digest({ tenantId: this.scope.tenantId, sourceJobId }).slice(7);
      const base = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: this.scope.tenantId, version: 0, createdAt: actor.now, updatedAt: actor.now };
      const input = { prompt: source.request.objective, instructions: template.instructions };
      const codex = template.adapter === CODEX_APP_SERVER_ADAPTER;
      const hermes021 = template.adapter === HERMES_021_MACOS_LOCAL_ADAPTER_V1;
      const claude = template.adapter === CLAUDE_CODE_LOCAL_ADAPTER_V1;
      const remote = template.adapter === CONTROLLER_WORKER_REMOTE_ADAPTER_V1;
      const plan = planSchema.parse({ schema: codex ? "control-room.task-execution-plan/v3" : hermes021 ? "control-room.task-execution-plan/v7" : claude ? "control-room.task-execution-plan/v9" : remote ? "control-room.task-execution-plan/v11" : "control-room.task-execution-plan/v1",
        ...(codex ? { adapter: CODEX_APP_SERVER_ADAPTER, connectorProfileDigest: template.connectorProfileDigest,
          workspaceIntentDigest: template.workspaceIntentDigest } : hermes021 ? { adapter: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
          connectorProfileDigest: template.connectorProfileDigest, executionClass: "text_review" } : claude ? {
          adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1, connectorProfileDigest: template.connectorProfileDigest, executionClass: "text_review" } : remote ? {
          adapter: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, connectorProfileDigest: template.connectorProfileDigest, executionClass: "text_review" } : {}), tenantId: this.scope.tenantId,
        projectId, sourceJobId, sourceDigest, sourceInputDigest: expectedInputDigest, templateDigest, plannedBy: actor.id, plannedAt: actor.now, input,
        acceptanceProfileId: template.acceptanceProfileId, acceptanceProfileDigest: template.acceptanceProfileDigest,
        request: { ...base, kind: "request", id: `request:execution:${suffix}`, projectId, title: source.request.title,
          objective: source.request.objective, state: "draft", priority: source.request.priority,
          requestedBy: { actorId: actor.id, actorType: "human" }, idempotencyKey: `execution:${suffix}` },
        workflow: { ...base, kind: "workflow", id: `workflow:execution:${suffix}`, projectId, requestId: `request:execution:${suffix}`,
          definitionVersion: codex ? "codex-task-plan/v1" : hermes021 ? "hermes-021-task-plan/v1" : claude ? "claude-code-local-task-plan/v1" : remote ? "controller-worker-remote-task-plan/v1" : "native-task-plan/v1", definitionDigest: sha256Digest({ sourceDigest, templateDigest }),
          authorityMode: "control_room_native", state: "proposed", jobIds: [`job:execution:${suffix}`] },
        job: { ...base, kind: "job", id: `job:execution:${suffix}`, projectId, workflowId: `workflow:execution:${suffix}`,
          jobType: template.adapter === HERMES_NATIVE_ADAPTER ? "harness.hermes.native.task" : hermes021 ? HERMES_021_MACOS_LOCAL_JOB_TYPE_V1 : claude ? CLAUDE_CODE_LOCAL_JOB_TYPE_V1 : remote ? CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1 : CODEX_APP_SERVER_JOB_TYPE,
          specVersion: "1.0.0", inputDigest: sha256Digest(input), state: "proposed",
          priority: source.job.priority, requiredCapability: template.adapter === HERMES_NATIVE_ADAPTER
            ? "harness.hermes.native.runs.v1" : hermes021 ? HERMES_021_MACOS_LOCAL_CAPABILITY_V1 : claude ? CLAUDE_CODE_LOCAL_CAPABILITY_V1 : remote ? CONTROLLER_WORKER_REMOTE_CAPABILITY_V1 : CODEX_APP_SERVER_CAPABILITY, dependsOnJobIds: [], authority: template.authority,
          retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } } });
      await this.profile(tx, plan, actor.now); assertNoSecretMaterial(plan);
      // The inert-proposal materializer deliberately rejects this richer envelope. Use the existing
      // trusted canonical writer inside our one owner-authorized transaction, without any transition.
      const canonical = new CanonicalStore(joined(tx));
      for (const record of [plan.request, plan.workflow, plan.job]) await canonical.create(record);
      await tx.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [plan.tenantId, projectId, sourceJobId, plan.job.id, JSON.stringify(plan), this.tag(plan)]);
      await appendAuditWith(tx, { id: `audit:execution:${suffix}`, tenantId: plan.tenantId, projectId, actorId: actor.id, actorType: "human",
        action: "tasks.plan", targetType: "job", targetId: plan.job.id, idempotencyKey: `execution:${suffix}`, occurredAt: actor.now,
        safeMetadata: { sourceJobId, sourceDigest, templateDigest, inputDigest: plan.job.inputDigest, startsWork: false } });
      return { receipt: this.receipt(plan), replayed: false };
    });
  }

  /** Server-only scheduled planning. The caller must hold and revalidate one standing-policy
   * transaction around this method. It is intentionally absent from webOperation(). */
  async planScheduledInSession(tx: DatabaseSession, input: Readonly<{ projectId: string; sourceJobId: string;
    expectedInputDigest: string; policyId: string; policyVersion: number; policyDigest: string;
    ownerIdentityDigest: string; reusableContexts: readonly ScheduledReusableContextV1[] }>, assertCurrent: () => void | Promise<void>) {
    const { projectId, sourceJobId, expectedInputDigest, policyId, policyVersion, policyDigest,
      ownerIdentityDigest, reusableContexts } = input;
    localId.parse(projectId); localId.parse(sourceJobId); localId.parse(policyId);
    z.number().int().positive().parse(policyVersion); digestSchema.parse(expectedInputDigest);
    digestSchema.parse(policyDigest); digestSchema.parse(ownerIdentityDigest);
    await assertCurrent();
    const project = (await tx.query<{ lifecycle: string }>(`SELECT h.lifecycle FROM projects p
      JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
      WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 FOR SHARE OF p,h`,
    [this.scope.tenantId, this.scope.workspaceId, projectId])).rows[0];
    if (!project || project.lifecycle !== "active") throw new WebAccessError("conflict");
    const source = await this.source(tx, projectId, sourceJobId);
    if (source.job.inputDigest !== expectedInputDigest) throw new WebAccessError("conflict");
    const template = this.selectTemplate(projectId);
    const nowMs = this.clock();
    if (!Number.isSafeInteger(nowMs)
      || Date.parse(template.authority.expiresAt) < nowMs + template.authority.maxDurationSeconds * 1000) {
      throw new WebAccessError("conflict");
    }
    const plannedAt = new Date(nowMs).toISOString(), templateDigest = sha256Digest(template), sourceDigest = sha256Digest(source);
    const prior = (await tx.query<Row>("SELECT * FROM control_task_execution_plans WHERE tenant_id=$1 AND source_job_id=$2",
      [this.scope.tenantId, sourceJobId])).rows[0];
    if (prior) {
      const plan = this.verify(prior);
      if (plan.templateDigest !== templateDigest || plan.sourceDigest !== sourceDigest
        || plan.plannedBy !== SCHEDULE_ASSIGNMENT_SERVICE_ACTOR_V1) throw new WebAccessError("conflict");
      await this.checkedJob(tx, plan); await assertCurrent();
      return { receipt: this.receipt(plan), replayed: true };
    }
    this.requirePrepared(template);
    const suffix = sha256Digest({ tenantId: this.scope.tenantId, sourceJobId }).slice(7);
    const base = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: this.scope.tenantId, version: 0,
      createdAt: plannedAt, updatedAt: plannedAt };
    const planInput = { prompt: source.request.objective,
      instructions: bindScheduledContextReferencesV1(template.instructions, reusableContexts) };
    const codex = template.adapter === CODEX_APP_SERVER_ADAPTER;
    const hermes021 = template.adapter === HERMES_021_MACOS_LOCAL_ADAPTER_V1;
    const claude = template.adapter === CLAUDE_CODE_LOCAL_ADAPTER_V1;
    const remote = template.adapter === CONTROLLER_WORKER_REMOTE_ADAPTER_V1;
    const plan = planSchema.parse({ schema: codex ? "control-room.task-execution-plan/v3" : hermes021 ? "control-room.task-execution-plan/v5" : claude ? "control-room.task-execution-plan/v9" : remote ? "control-room.task-execution-plan/v11" : "control-room.task-execution-plan/v1",
      ...(codex ? { adapter: CODEX_APP_SERVER_ADAPTER, connectorProfileDigest: template.connectorProfileDigest,
        workspaceIntentDigest: template.workspaceIntentDigest } : hermes021 ? { adapter: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
        connectorProfileDigest: template.connectorProfileDigest } : claude ? { adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1,
        connectorProfileDigest: template.connectorProfileDigest, executionClass: "text_review" } : remote ? { adapter: CONTROLLER_WORKER_REMOTE_ADAPTER_V1,
        connectorProfileDigest: template.connectorProfileDigest, executionClass: "text_review" } : {}), tenantId: this.scope.tenantId,
      projectId, sourceJobId, sourceDigest, sourceInputDigest: expectedInputDigest, templateDigest,
      plannedBy: SCHEDULE_ASSIGNMENT_SERVICE_ACTOR_V1, plannedAt, input: planInput,
      acceptanceProfileId: template.acceptanceProfileId, acceptanceProfileDigest: template.acceptanceProfileDigest,
      request: { ...base, kind: "request", id: `request:execution:${suffix}`, projectId, title: source.request.title,
        objective: source.request.objective, state: "draft", priority: source.request.priority,
        requestedBy: { actorId: SCHEDULE_ASSIGNMENT_SERVICE_ACTOR_V1, actorType: "service" }, idempotencyKey: `execution:${suffix}` },
      workflow: { ...base, kind: "workflow", id: `workflow:execution:${suffix}`, projectId,
        requestId: `request:execution:${suffix}`, definitionVersion: codex ? "codex-task-plan/v1" : hermes021 ? "hermes-021-task-plan/v1" : claude ? "claude-code-local-task-plan/v1" : remote ? "controller-worker-remote-task-plan/v1" : "native-task-plan/v1",
        definitionDigest: sha256Digest({ sourceDigest, templateDigest }), authorityMode: "control_room_native",
        state: "proposed", jobIds: [`job:execution:${suffix}`] },
      job: { ...base, kind: "job", id: `job:execution:${suffix}`, projectId,
        workflowId: `workflow:execution:${suffix}`, jobType: template.adapter === HERMES_NATIVE_ADAPTER
          ? "harness.hermes.native.task" : hermes021 ? HERMES_021_MACOS_LOCAL_JOB_TYPE_V1 : claude ? CLAUDE_CODE_LOCAL_JOB_TYPE_V1 : remote ? CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1 : CODEX_APP_SERVER_JOB_TYPE, specVersion: "1.0.0",
        inputDigest: sha256Digest(planInput), state: "proposed", priority: source.job.priority,
        requiredCapability: template.adapter === HERMES_NATIVE_ADAPTER ? "harness.hermes.native.runs.v1" : hermes021 ? HERMES_021_MACOS_LOCAL_CAPABILITY_V1 : claude ? CLAUDE_CODE_LOCAL_CAPABILITY_V1 : remote ? CONTROLLER_WORKER_REMOTE_CAPABILITY_V1 : CODEX_APP_SERVER_CAPABILITY,
        dependsOnJobIds: [], authority: template.authority,
        retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false,
          ambiguousEffectPolicy: "attention" } } });
    await this.profile(tx, plan, plannedAt); assertNoSecretMaterial(plan); await assertCurrent();
    const canonical = new CanonicalStore(joined(tx));
    for (const record of [plan.request, plan.workflow, plan.job]) await canonical.create(record);
    await tx.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
      VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [plan.tenantId, projectId, sourceJobId, plan.job.id,
      JSON.stringify(plan), this.tag(plan)]);
    await appendAuditWith(tx, { id: `audit:scheduled-plan:${suffix}`, tenantId: plan.tenantId, projectId,
      actorId: SCHEDULE_ASSIGNMENT_SERVICE_ACTOR_V1, actorType: "service", action: "scheduled.tasks.plan",
      targetType: "job", targetId: plan.job.id, idempotencyKey: `scheduled-plan:${suffix}`, occurredAt: plannedAt,
      safeMetadata: { sourceJobId, sourceDigest, templateDigest, policyId, policyVersion, policyDigest,
        ownerIdentityDigest, inputDigest: plan.job.inputDigest, startsWork: false, grantsExecutionAuthority: false } });
    await assertCurrent();
    return { receipt: this.receipt(plan), replayed: false };
  }
  /** Owner-requested durable planning only. This never consumes an old native approval
   * or converts a saved change request into execution permission. */
  async revise(identity: VerifiedWebIdentity, projectId: string, sourceJobId: string, value: TaskRevisionRequest, signal: AbortSignal) {
    identity = { ...identity }; const input = taskRevisionRequestSchema.parse(value); assertNoSecretMaterial(input);
    localId.parse(projectId); localId.parse(sourceJobId);
    if (!this.revisionSource || !(signal instanceof AbortSignal)) return fail();
    let template: NativeTaskTemplate | undefined;
    const started = this.clock(); let highWater = started, materializing = false;
    const current = () => {
      const now = this.clock();
      if (signal.aborted || !Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(now)
        || now < highWater || now - started > 10_000) return fail();
      highWater = now;
      if (materializing && (!template || Date.parse(template.authority.expiresAt) < now + template.authority.maxDurationSeconds * 1000))
        throw new WebAccessError("conflict");
    };
    current();
    const guarded: DatabaseClient = { query: this.db.query.bind(this.db), transaction: this.db.transaction.bind(this.db),
      transactionWithPreCommitCheck: (work, check) => this.db.transactionWithPreCommitCheck(async tx => {
        current(); return work({ async query<T>(sql: string, params?: unknown[]) {
          current(); const result = await tx.query<T>(sql, params); current(); return result;
        } });
      }, async () => { current(); await check(); current(); }) };
    const result = await new WebSessionAuthority(guarded, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.results.read", projectId);
      actor.require("tasks.plan", projectId, true); actor.require("tasks.reviews.record", projectId, true);
      const project = await this.projects.getViewInSession(tx, actor, projectId); current();
      const scoped = await tx.query(`SELECT p.id FROM control_harness_runs r
        JOIN control_jobs j ON j.tenant_id=r.tenant_id AND j.project_id=r.project_id AND j.id=r.job_id
        JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
        WHERE r.tenant_id=$1 AND r.id=$2 AND j.id=$3 AND p.id=$4 AND p.workspace_id=$5 FOR SHARE OF p`,
      [this.scope.tenantId, input.runId, sourceJobId, projectId, this.scope.workspaceId]);
      if (scoped.rows.length !== 1) throw new WebAccessError("not_found");
      // Preserve the accepted lock order: native run/job before Completion Gate state.
      const context = await this.inspectRevision(tx, this.scope.tenantId, input.runId); current();
      if (context.job.id !== sourceJobId || context.run.projectId !== projectId || context.snapshot.target.id !== input.targetId
        || context.snapshot.targetDigest !== input.targetDigest || context.result.receipt.contentHash !== input.contentHash)
        throw new WebAccessError("conflict");
      const sourceRow = (await tx.query<Row>("SELECT * FROM control_task_execution_plans WHERE tenant_id=$1 AND job_id=$2",
        [this.scope.tenantId, sourceJobId])).rows[0];
      if (!sourceRow) return fail();
      const source = this.verify(sourceRow); await this.checkedJob(tx, source); current();
      if (source.projectId !== projectId || source.job.id !== sourceJobId
        || source.acceptanceProfileId !== context.profile.id || source.acceptanceProfileDigest !== sha256Digest(context.profile)) return fail();
      const review = completionReviewSchemaV1.parse(await context.gate.getRecord(this.scope.tenantId, input.reviewId, "review"));
      if (review.reviewer.actorId !== actor.id || review.reviewer.actorType !== "human" || review.authority !== "completion_gate"
        || review.decision !== "changes_requested" || review.targetId !== input.targetId || review.targetDigest !== input.targetDigest
        || review.projectId !== projectId || review.acceptanceProfileId !== context.profile.id
        || review.acceptanceProfileDigest !== source.acceptanceProfileDigest || !review.findingIds.length) throw new WebAccessError("conflict");
      actor.require("tasks.reviews.record", projectId, true, review.effectiveRisk);
      if (Date.parse(review.reviewedAt) > Date.parse(actor.now) || Date.parse(context.result.receipt.receivedAt) > Date.parse(actor.now))
        throw new WebAccessError("conflict");
      const findingIds = [...review.findingIds].sort();
      if (sha256Digest(findingIds) !== sha256Digest([...context.snapshot.openFindingIds].sort())) throw new WebAccessError("conflict");
      for (const findingId of findingIds) {
        const finding = completionFindingSchemaV1.parse(await context.gate.getRecord(this.scope.tenantId, findingId, "finding"));
        if (finding.reviewId !== review.id || finding.targetId !== input.targetId || finding.targetDigest !== input.targetDigest
          || finding.projectId !== projectId || finding.statementDigest !== sha256Digest(input.feedback)) throw new WebAccessError("conflict");
      }
      current(); actor.assertTimeCurrent();
      const revision = taskRevisionContextSchema.parse({ rootSubjectId: context.snapshot.target.subjectId,
        rootTargetId: context.snapshot.target.rootTargetId, fromJobId: sourceJobId, fromRunId: input.runId,
        fromTargetId: input.targetId, fromTargetDigest: input.targetDigest, fromContentHash: input.contentHash,
        reviewId: review.id, reviewDigest: sha256Digest(review), findingIds, feedbackDigest: sha256Digest(input.feedback),
        sourcePlanDigest: sha256Digest(source), revisionNumber: context.snapshot.revisionNumber + 1,
        originalPrompt: source.schema === "control-room.task-execution-plan/v2"
          || source.schema === "control-room.task-execution-plan/v4"
          || source.schema === "control-room.task-execution-plan/v6" || source.schema === "control-room.task-execution-plan/v8"
          || source.schema === "control-room.task-execution-plan/v10" || source.schema === "control-room.task-execution-plan/v12"
          ? source.revision.originalPrompt : source.input.prompt });
      template = this.templateForSavedPlan(projectId, source.templateDigest);
      const codex = source.schema === "control-room.task-execution-plan/v3" || source.schema === "control-room.task-execution-plan/v4";
      const hermes021 = source.schema === "control-room.task-execution-plan/v5" || source.schema === "control-room.task-execution-plan/v6"
        || source.schema === "control-room.task-execution-plan/v7" || source.schema === "control-room.task-execution-plan/v8";
      const claude = source.schema === "control-room.task-execution-plan/v9" || source.schema === "control-room.task-execution-plan/v10";
      const remote = source.schema === "control-room.task-execution-plan/v11" || source.schema === "control-room.task-execution-plan/v12";
      if (!template || template.adapter !== (codex ? CODEX_APP_SERVER_ADAPTER : hermes021 ? HERMES_021_MACOS_LOCAL_ADAPTER_V1 : claude ? CLAUDE_CODE_LOCAL_ADAPTER_V1 : remote ? CONTROLLER_WORKER_REMOTE_ADAPTER_V1 : HERMES_NATIVE_ADAPTER)
        || (remote && template.connectorProfileDigest !== source.connectorProfileDigest))
        throw new WebAccessError("conflict");
      const sourceDigest = sha256Digest(revision), templateDigest = sha256Digest(template);
      const prior = (await tx.query<Row>(`SELECT * FROM control_task_execution_plans
        WHERE tenant_id=$1 AND source_job_id=$2 AND job_id<>$2`,
        [this.scope.tenantId, sourceJobId])).rows[0];
      if (prior) {
        const plan = this.verify(prior);
        if (plan.schema !== (codex ? "control-room.task-execution-plan/v4" : hermes021 ? "control-room.task-execution-plan/v8" : claude ? "control-room.task-execution-plan/v10" : remote ? "control-room.task-execution-plan/v12" : "control-room.task-execution-plan/v2") || plan.sourceDigest !== sourceDigest
          || plan.templateDigest !== templateDigest || plan.plannedBy !== actor.id) throw new WebAccessError("conflict");
        await this.checkedJob(tx, plan); current(); return { receipt: this.revisionReceipt(plan), replayed: true };
      }
      this.requirePrepared(template);
      if (project.lifecycle !== "active" || context.snapshot.status !== "changes_requested"
        || revision.revisionNumber > context.profile.maximumRevisionRounds || !["leased", "running"].includes(context.job.state)
        || template.authority.projectId !== projectId || template.acceptanceProfileId !== context.profile.id
        || template.acceptanceProfileDigest !== source.acceptanceProfileDigest) throw new WebAccessError("conflict");
      materializing = true; current();
      const prompt = JSON.stringify({ originalTask: revision.originalPrompt, previousResult: context.result.text, requestedChanges: input.feedback });
      // Complete-context limit: never silently truncate the previous result or feedback.
      if (prompt.length > 4000) throw new WebAccessError("conflict");
      const suffix = sha256Digest({ tenantId: this.scope.tenantId, sourceJobId, targetDigest: input.targetDigest }).slice(7);
      const base = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: this.scope.tenantId, version: 0, createdAt: actor.now, updatedAt: actor.now };
      const nextInput = { prompt, instructions: template.instructions };
      const candidate = {
        tenantId: this.scope.tenantId,
        projectId, sourceJobId, sourceDigest, sourceInputDigest: context.job.inputDigest, templateDigest, plannedBy: actor.id,
        plannedAt: actor.now, input: nextInput, revision, acceptanceProfileId: context.profile.id,
        acceptanceProfileDigest: source.acceptanceProfileDigest,
        request: { ...base, kind: "request", id: `request:revision:${suffix}`, projectId, title: source.request.title,
          objective: prompt, state: "draft", priority: source.request.priority,
          requestedBy: { actorId: actor.id, actorType: "human" }, idempotencyKey: `revision:${suffix}` },
        workflow: { ...base, kind: "workflow", id: `workflow:revision:${suffix}`, projectId, requestId: `request:revision:${suffix}`,
          definitionVersion: codex ? "codex-task-revision-plan/v1" : hermes021 ? "hermes-021-task-revision-plan/v1" : claude ? "claude-code-local-task-revision-plan/v1" : remote ? "controller-worker-remote-task-revision-plan/v1" : "native-task-revision-plan/v1",
          definitionDigest: sha256Digest({ sourceDigest, templateDigest }),
          authorityMode: "control_room_native", state: "proposed", jobIds: [`job:revision:${suffix}`] },
        job: { ...base, kind: "job", id: `job:revision:${suffix}`, projectId, workflowId: `workflow:revision:${suffix}`,
          jobType: codex ? CODEX_APP_SERVER_JOB_TYPE : hermes021 ? HERMES_021_MACOS_LOCAL_JOB_TYPE_V1 : claude ? CLAUDE_CODE_LOCAL_JOB_TYPE_V1 : remote ? CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1 : "harness.hermes.native.task", specVersion: "1.0.0",
          inputDigest: sha256Digest(nextInput), state: "proposed", priority: source.job.priority,
          requiredCapability: codex ? CODEX_APP_SERVER_CAPABILITY : hermes021 ? HERMES_021_MACOS_LOCAL_CAPABILITY_V1 : claude ? CLAUDE_CODE_LOCAL_CAPABILITY_V1 : remote ? CONTROLLER_WORKER_REMOTE_CAPABILITY_V1 : "harness.hermes.native.runs.v1",
          dependsOnJobIds: [], authority: template.authority,
          retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } } };
      const plan = codex ? codexTaskExecutionPlanSchemaV4.parse({ ...candidate, schema: "control-room.task-execution-plan/v4",
        adapter: CODEX_APP_SERVER_ADAPTER, connectorProfileDigest: template.connectorProfileDigest,
        workspaceIntentDigest: template.workspaceIntentDigest })
        : hermes021 ? hermes021TaskExecutionPlanSchemaV8.parse({ ...candidate, schema: "control-room.task-execution-plan/v8",
          adapter: HERMES_021_MACOS_LOCAL_ADAPTER_V1, connectorProfileDigest: template.connectorProfileDigest, executionClass: "text_review" })
          : claude ? claudeCodeLocalTaskExecutionPlanSchemaV10.parse({ ...candidate, schema: "control-room.task-execution-plan/v10",
            adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1, connectorProfileDigest: template.connectorProfileDigest, executionClass: "text_review" })
            : remote ? controllerWorkerRemoteTaskExecutionPlanSchemaV12.parse({ ...candidate, schema: "control-room.task-execution-plan/v12",
              adapter: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, connectorProfileDigest: template.connectorProfileDigest, executionClass: "text_review" })
              : revisionPlanSchema.parse({ ...candidate, schema: "control-room.task-execution-plan/v2" });
      assertNoSecretMaterial(plan); current();
      const canonical = new CanonicalStore(joined(tx));
      for (const record of [plan.request, plan.workflow, plan.job]) { await canonical.create(record); current(); }
      await tx.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [plan.tenantId, projectId, sourceJobId, plan.job.id, JSON.stringify(plan), this.tag(plan)]);
      await appendAuditWith(tx, { id: `audit:revision:${suffix}`, tenantId: plan.tenantId, projectId, actorId: actor.id, actorType: "human",
        action: "tasks.revisions.plan", targetType: "job", targetId: plan.job.id, idempotencyKey: `revision:${suffix}`, occurredAt: actor.now,
        safeMetadata: { sourceJobId, fromTargetId: input.targetId, sourceDigest, templateDigest, inputDigest: plan.job.inputDigest, startsWork: false } });
      current(); return { receipt: this.revisionReceipt(plan), replayed: false };
    });
    // Commit acknowledgement may arrive after cancellation or the operation budget.
    // Preserve the durable bundle for exact reconciliation, but do not report timely success.
    current(); return result;
  }
  private revisionReceipt(plan: z.infer<typeof revisionPlanSchema> | CodexTaskExecutionPlanV4 | Hermes021TaskExecutionPlanV6 | Hermes021TaskExecutionPlanV8 | ClaudeCodeLocalTaskExecutionPlanV10 | ControllerWorkerRemoteTaskExecutionPlanV12) { return { ...this.receipt(plan),
    rootSubjectId: plan.revision.rootSubjectId, rootTargetId: plan.revision.rootTargetId,
    fromRunId: plan.revision.fromRunId, fromTargetDigest: plan.revision.fromTargetDigest,
    fromContentHash: plan.revision.fromContentHash, reviewId: plan.revision.reviewId, feedbackDigest: plan.revision.feedbackDigest,
    fromTargetId: plan.revision.fromTargetId, revisionNumber: plan.revision.revisionNumber,
    executionAvailability: "requires_separate_assignment_and_approval" as const }; }
  private receipt(plan: Plan) { return { projectId: plan.projectId, sourceJobId: plan.sourceJobId, jobId: plan.job.id,
    sourceInputDigest: plan.sourceInputDigest, inputDigest: plan.job.inputDigest, plannedAt: plan.plannedAt,
    startsWork: false as const, grantsExecutionAuthority: false as const }; }
  private async jobWith(tx: DatabaseSession, projectId: string, jobId: string, lock = false) {
    const row = (await tx.query<{ payload: unknown; state: string; version: number; workflow_id: string;
      created_at: string | Date; updated_at: string | Date }>(`SELECT payload,state,version,workflow_id,created_at,updated_at
      FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`,
    [this.scope.tenantId, projectId, jobId])).rows[0];
    if (!row) throw new WebAccessError("not_found");
    const job = jobRecordSchema.parse(row.payload);
    if (job.id !== jobId || job.projectId !== projectId || job.tenantId !== this.scope.tenantId || job.state !== row.state
      || job.version !== Number(row.version) || job.workflowId !== row.workflow_id
      || job.createdAt !== new Date(row.created_at).toISOString() || job.updatedAt !== new Date(row.updated_at).toISOString()) fail();
    return job;
  }
  private async checkedJob(tx: DatabaseSession, plan: Plan) {
    const job = await this.jobWith(tx, plan.projectId, plan.job.id), canonical = new CanonicalStore(joined(tx));
    const workflow = workflowRecordSchema.parse(await canonical.get(plan.tenantId, "workflow", plan.workflow.id));
    const request = requestRecordSchema.parse(await canonical.get(plan.tenantId, "request", plan.request.id));
    if (sha256Digest(immutableJob(job)) !== sha256Digest(plan.job) || sha256Digest(plan.input) !== job.inputDigest) fail();
    if (sha256Digest({ ...workflow, state: "proposed", version: 0, updatedAt: workflow.createdAt }) !== sha256Digest(plan.workflow)
      || sha256Digest({ ...request, state: "draft", version: 0, updatedAt: request.createdAt }) !== sha256Digest(plan.request)) fail();
    await this.profile(tx, plan, plan.plannedAt);
    return job;
  }
  /** Trusted coordinator read. Returns a plan, not admission/approval. Recheck active scope, expiry,
   * node ceiling, capability and current lease at the later admission boundary. Never expose as HTTP. */
  async read(jobId: string) {
    return this.db.transaction(tx => this.readInSession(tx, jobId));
  }
  /** Trusted coordinator only: keep plan verification inside the assignment's locking transaction. */
  async readInSession(tx: DatabaseSession, jobId: string) {
    localId.parse(jobId);
    const row = (await tx.query<Row>("SELECT * FROM control_task_execution_plans WHERE tenant_id=$1 AND job_id=$2", [this.scope.tenantId, jobId])).rows[0];
    if (!row) return undefined;
    const plan = this.verify(row);
    await this.checkedJob(tx, plan); return plan;
  }
  /** Joined result transactions must lock the authenticated predecessor before any profile
   * read takes the tenant Gate lock. This only acquires locks; bindReview still verifies
   * the complete plan, canonical records, profile and predecessor result afterward. */
  async lockReviewPredecessorInSession(tx: DatabaseSession, projectId: string, jobId: string) {
    localId.parse(projectId); localId.parse(jobId);
    const row = (await tx.query<Row>("SELECT * FROM control_task_execution_plans WHERE tenant_id=$1 AND job_id=$2",
      [this.scope.tenantId, jobId])).rows[0];
    if (!row) return fail();
    const plan = this.verify(row);
    if (plan.tenantId !== this.scope.tenantId || plan.projectId !== projectId || plan.job.id !== jobId) return fail();
    if (plan.schema !== "control-room.task-execution-plan/v2" && plan.schema !== "control-room.task-execution-plan/v4"
      && plan.schema !== "control-room.task-execution-plan/v12") return;
    const { fromRunId, fromJobId } = plan.revision;
    const run = await tx.query(`SELECT id FROM control_harness_runs
      WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND job_id=$4 FOR UPDATE`,
    [this.scope.tenantId, projectId, fromRunId, fromJobId]);
    const job = await tx.query(`SELECT id FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
      [this.scope.tenantId, projectId, fromJobId]);
    if (run.rows.length !== 1 || job.rows.length !== 1) return fail();
  }
  /** After separately accepted admission/registration, carry the saved profile to the existing
   * submission service. Neither helper constructs an attempt nor fabricates native-start evidence. */
  async bindReview(jobId: string, runId: string, harnessIntegrityKey: Uint8Array,
    submission: Pick<NativeResultSubmissionService, "register"> & Partial<Pick<NativeResultSubmissionService, "registerRevision">>) {
    const plan = await this.read(jobId); if (!plan) return fail();
    // Codex delivery evidence is not a Hermes native run. Its result adapter will
    // bind the delivery receipt to review in a later, explicit integration step.
    if (plan.schema === "control-room.task-execution-plan/v3" || plan.schema === "control-room.task-execution-plan/v4") return fail();
    const inspected = await new HarnessRunStoreV1(this.db, harnessIntegrityKey).inspect(plan.tenantId, runId);
    if (!inspected?.run.nativeTask || inspected.run.jobId !== jobId || inspected.run.projectId !== plan.projectId
      || inspected.run.nativeTask.inputDigest !== plan.job.inputDigest || Date.parse(inspected.run.createdAt) < Date.parse(plan.plannedAt)) return fail();
    const request = { tenantId: plan.tenantId, runId, acceptanceProfileId: plan.acceptanceProfileId,
      acceptanceProfileDigest: plan.acceptanceProfileDigest, plannedAt: inspected.run.createdAt };
    if (plan.schema === "control-room.task-execution-plan/v2" || plan.schema === "control-room.task-execution-plan/v12") {
      if (!submission.registerRevision) return fail();
      return submission.registerRevision({ ...request, revision: plan.revision });
    }
    return submission.register(request);
  }
}
