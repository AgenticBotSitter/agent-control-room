import { z } from "zod";
import { localId } from "../../harness/v1/native-run-identifiers";
import { validatePrivateTaskStartupConfiguration, type PrivateTaskStartupConfiguration } from "./private-task-startup";
import type { PrivateStartupConfiguration } from "./private-startup";
import type { PrivatePostgresConfiguration } from "./private-postgres";
import type { TaskAssignmentRoute, NativeApprovalEnrollment, CodexPermitConfiguration } from "./task-assignment-coordinator";
import type { NativeTaskTemplate } from "./task-execution-planner";
import type { TaskQualityConfiguration } from "./task-quality-coordinator";
import type { NativeEvidenceSettings } from "./native-evidence-receiver";
import type { ManagedNativeSessionSettings } from "./managed-native-sessions";
import type { NativeHttpSettings } from "./native-http-host";
import type { CodexResultIntakeSettingsV1 } from "./codex-result-intake";
import type { NewsStartupConfiguration } from "./news-startup-configuration";
import type { PrivateArtifactStorageConfigurationV1 } from "./private-artifact-storage";
import type { AwaitableRollbackCheckpointStoreV1 } from "../../security";

/** Pure operator-side assembly. This module performs no environment, filesystem,
 * network, listener, credential-store or database access: it only shapes
 * already-captured inputs and delegates to validatePrivateTaskStartupConfiguration. */

export const AGENT_TASK_OPERATOR_SETTINGS_SCHEMA_V1 = "control-room.agent-task-operator-settings/v1" as const;

const databaseRoleSchema = z.object({
  host: z.string(),
  port: z.number(),
  database: z.string(),
  username: z.string(),
  password: z.string(),
  majorVersion: z.number(),
}).strict();

const operatorSettingsSchema = z.object({
  schema: z.literal(AGENT_TASK_OPERATOR_SETTINGS_SCHEMA_V1),
  /** Plain integer port only. Strings, paths and URLs never convert to a port. */
  port: z.number().int().min(1).max(65535),
  tenantId: localId,
  databaseRoles: z.object({
    coordinator: databaseRoleSchema,
    results: databaseRoleSchema.optional(),
    evidence: databaseRoleSchema.optional(),
    sessions: databaseRoleSchema.optional(),
    queueWorker: databaseRoleSchema.optional(),
    ideaCreation: databaseRoleSchema.optional(),
    ideaRuntime: databaseRoleSchema.optional(),
    newsCoordinator: databaseRoleSchema.optional(),
    newsIngestion: databaseRoleSchema.optional(),
    newsWorker: databaseRoleSchema.optional(),
  }).strict(),
  queueWorkerConcurrency: z.number().int().min(1).max(8).optional(),
  features: z.object({
    nativeQueue: z.boolean(),
    nativeQueueRecovery: z.boolean().optional(),
    revisionPlanning: z.boolean().optional(),
    quality: z.boolean().optional(),
    evidence: z.boolean().optional(),
    sessions: z.boolean().optional(),
    queueWorker: z.boolean().optional(),
    codex: z.boolean().optional(),
    codexResultReturn: z.boolean().optional(),
    nativeHttp: z.boolean().optional(),
    artifactStorage: z.boolean().optional(),
    idea: z.boolean().optional(),
    news: z.boolean().optional(),
  }).strict(),
}).strict();

export type AgentTaskOperatorSettingsV1 = z.infer<typeof operatorSettingsSchema>;

export type AgentTaskOperatorTrustedInputs = {
  web: PrivateStartupConfiguration;
  planning: {
    template: NativeTaskTemplate;
    additionalTemplates?: readonly NativeTaskTemplate[];
    integrityKey: Uint8Array;
    reviewIntegrityKey: Uint8Array;
    ideaIntegrityKey?: Uint8Array;
    checkpoints: AwaitableRollbackCheckpointStoreV1;
  };
  routes: readonly TaskAssignmentRoute[];
  approvalEnrollments: readonly NativeApprovalEnrollment[];
  approvalStore: {
    acceptInSession: (...args: never[]) => unknown;
    readInSession: (...args: never[]) => unknown;
    receiveDeliveryReceipt?: (...args: never[]) => unknown;
  };
  quality?: Omit<TaskQualityConfiguration, "integrityKey"> & { integrityKey: Uint8Array };
  evidence?: NativeEvidenceSettings;
  sessions?: ManagedNativeSessionSettings;
  codex?: CodexPermitConfiguration;
  codexResultReturn?: CodexResultIntakeSettingsV1;
  nativeHttp?: NativeHttpSettings;
  artifactStorage?: PrivateArtifactStorageConfigurationV1;
  idea?: {
    creation: { integrityKey: Uint8Array; participants: unknown[] };
    runtime?: {
      database: PrivatePostgresConfiguration;
      close: (...args: never[]) => unknown;
      runtime: {
        resolve: (...args: never[]) => unknown;
        driver: { mode: string; invoke: (...args: never[]) => unknown };
        evidenceAuthority: { verify: (...args: never[]) => unknown };
        admissionAuthority: { consume: (...args: never[]) => unknown };
      };
    };
  };
  news?: {
    configuration: unknown;
    integrityKey: Uint8Array;
    authority: NewsStartupConfiguration["authority"];
    transport: NewsStartupConfiguration["transport"];
    concurrency?: number;
  };
};

function refuse(code: string): never {
  throw new Error(`agent_task_operator_config_invalid:${code}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const copyKey = (value: unknown, code: string): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.length !== 32) refuse(code);
  return Uint8Array.from(value);
};

/** Assemble one immutable agent-task startup configuration from plain operator
 * settings plus already-constructed trusted inputs. Every refusal throws before
 * any value is returned; a returned configuration passed the production gate. */
export function assemblePrivateAgentTaskOperatorConfiguration(
  settings: unknown,
  trusted: unknown,
): ReturnType<typeof validatePrivateTaskStartupConfiguration> {
  let parsed: AgentTaskOperatorSettingsV1;
  try {
    parsed = operatorSettingsSchema.parse(settings);
  } catch {
    refuse("settings_invalid");
  }
  if (!isRecord(trusted)) refuse("trusted_inputs_invalid");
  const t = trusted as Partial<AgentTaskOperatorTrustedInputs>;
  if (!isRecord(t.web) || !isRecord(t.planning) || !Array.isArray(t.routes)
    || !Array.isArray(t.approvalEnrollments) || !isRecord(t.approvalStore)) refuse("trusted_inputs_invalid");

  // The web profile is the restricted startup shape: planning-style keys belong
  // to the operator layer, never to website settings arriving here.
  for (const name of ["planning", "assignment", "approvals", "submission", "queueAttention", "revisions", "ideaCreation", "newsCollections"])
    if (name in (t.web as Record<string, unknown>)) refuse(`website_setting_rejected:${name}`);

  if (parsed.tenantId !== (t.web as { tenantId?: unknown }).tenantId) refuse("tenant_mismatch");

  const f = parsed.features;
  const need = (flag: boolean | undefined, input: unknown, name: string) => {
    if (flag && input === undefined) refuse(`missing_trusted_input:${name}`);
    if (!flag && input !== undefined) refuse(`unexpected_trusted_input:${name}`);
  };
  need(f.quality, t.quality, "quality");
  need(f.evidence, t.evidence, "evidence");
  need(f.sessions, t.sessions, "sessions");
  need(f.codex, t.codex, "codex");
  need(f.codexResultReturn, t.codexResultReturn, "codexResultReturn");
  need(f.nativeHttp, t.nativeHttp, "nativeHttp");
  need(f.artifactStorage, t.artifactStorage, "artifactStorage");
  need(f.idea, t.idea, "idea");
  need(f.news, t.news, "news");
  if (f.queueWorker && parsed.databaseRoles.queueWorker === undefined) refuse("missing_database_role:queueWorker");
  if (!f.queueWorker && parsed.databaseRoles.queueWorker !== undefined) refuse("unexpected_database_role:queueWorker");

  // Feature dependency chains mirror the production gate: refuse early here so a
  // disabled prerequisite can never be silently backfilled downstream.
  if (f.nativeQueueRecovery && !f.nativeQueue) refuse("feature_chain:nativeQueueRecovery_requires_nativeQueue");
  if (f.evidence && (!f.quality || parsed.databaseRoles.results === undefined)) refuse("feature_chain:evidence_requires_quality_and_results_role");
  if (f.sessions && !f.evidence) refuse("feature_chain:sessions_requires_evidence");
  if (f.queueWorker && (!f.nativeQueue || !f.sessions)) refuse("feature_chain:queueWorker_requires_nativeQueue_and_sessions");
  if (f.codex && (!f.nativeQueue || !f.sessions)) refuse("feature_chain:codex_requires_nativeQueue_and_sessions");
  if (f.codexResultReturn && (!f.codex || !f.quality || !f.artifactStorage || !f.sessions
    || parsed.databaseRoles.results === undefined)) refuse("feature_chain:codexResultReturn_requires_full_composition");
  if (f.nativeHttp && !f.sessions) refuse("feature_chain:nativeHttp_requires_sessions");
  if (f.revisionPlanning && !f.quality) refuse("feature_chain:revisionPlanning_requires_quality");
  if (f.artifactStorage && (!f.quality || !f.evidence || parsed.databaseRoles.results === undefined)) refuse("feature_chain:artifactStorage_requires_quality_evidence_results");

  // Database roles: one host/database, pairwise-distinct usernames, none reusing
  // the web pool login. Exact credential validation stays downstream.
  const roles: Array<[string, PrivatePostgresConfiguration]> = [["coordinator", parsed.databaseRoles.coordinator as PrivatePostgresConfiguration]];
  const roleFor = (name: "results" | "evidence" | "sessions" | "queueWorker" | "ideaCreation" | "ideaRuntime"
    | "newsCoordinator" | "newsIngestion" | "newsWorker") => {
    const role = parsed.databaseRoles[name];
    if (role !== undefined) roles.push([name, role as PrivatePostgresConfiguration]);
  };
  roleFor("results"); roleFor("evidence"); roleFor("sessions"); roleFor("queueWorker");
  roleFor("ideaCreation"); roleFor("ideaRuntime");
  roleFor("newsCoordinator"); roleFor("newsIngestion"); roleFor("newsWorker");
  const [primaryHost, primaryPort, primaryDatabase] = [
    parsed.databaseRoles.coordinator.host, parsed.databaseRoles.coordinator.port, parsed.databaseRoles.coordinator.database];
  const webUsername = (t.web as { database?: { username?: unknown } }).database?.username;
  const seen = new Set<string>();
  for (const [name, role] of roles) {
    if (!isRecord(role) || role.host !== primaryHost || role.port !== primaryPort || role.database !== primaryDatabase)
      refuse(`database_role_mismatch:${name}`);
    if (typeof role.username !== "string" || seen.has(role.username) || role.username === webUsername)
      refuse(`database_role_reuse:${name}`);
    seen.add(role.username);
  }
  if (f.evidence && parsed.databaseRoles.evidence === undefined) refuse("missing_database_role:evidence");
  if (f.sessions && parsed.databaseRoles.sessions === undefined) refuse("missing_database_role:sessions");

  // Exact credential validation stays downstream; the cast only aligns the
  // zod-parsed shape with the typed role the production gate re-validates.
  const dbRole = (name: keyof AgentTaskOperatorSettingsV1["databaseRoles"]): PrivatePostgresConfiguration | undefined => {
    const role = parsed.databaseRoles[name];
    return role === undefined ? undefined : (role as PrivatePostgresConfiguration);
  };

  const planning = t.planning as AgentTaskOperatorTrustedInputs["planning"];
  const store = t.approvalStore as NonNullable<AgentTaskOperatorTrustedInputs["approvalStore"]>;
  if (typeof store.acceptInSession !== "function" || typeof store.readInSession !== "function") refuse("approval_store_invalid");
  if (f.sessions && typeof store.receiveDeliveryReceipt !== "function") refuse("approval_store_missing_delivery_receipt");

  const coordinator: PrivateTaskStartupConfiguration["coordinator"] = {
    planning: {
      template: planning.template,
      ...(planning.additionalTemplates === undefined ? {} : { additionalTemplates: [...planning.additionalTemplates] }),
      integrityKey: copyKey(planning.integrityKey, "planning_integrity_key_invalid"),
      reviewIntegrityKey: copyKey(planning.reviewIntegrityKey, "planning_review_key_invalid"),
      ...(planning.ideaIntegrityKey === undefined ? {} : { ideaIntegrityKey: copyKey(planning.ideaIntegrityKey, "planning_idea_key_invalid") }),
      checkpoints: planning.checkpoints,
    },
    routes: [...t.routes],
    approvals: {
      enrollments: [...t.approvalEnrollments],
      store: store as unknown as NonNullable<NonNullable<PrivateTaskStartupConfiguration["coordinator"]["approvals"]>["store"]>,
    },
    database: dbRole("coordinator") as PrivatePostgresConfiguration,
    ...(f.nativeQueue ? { nativeQueue: true as const } : {}),
    ...(f.nativeQueueRecovery ? { nativeQueueRecovery: true as const } : {}),
    ...(f.revisionPlanning ? { revisionPlanning: true as const } : {}),
    ...(f.quality && t.quality ? {
      quality: {
        integrityKey: copyKey(t.quality.integrityKey, "quality_key_invalid"),
        harnessIntegrityKey: copyKey(t.quality.harnessIntegrityKey, "quality_harness_key_invalid"),
        scenarios: [...(t.quality.scenarios ?? [])],
        results: t.quality.results,
        checkpoints: t.quality.checkpoints,
      },
    } : {}),
    ...(parsed.databaseRoles.results ? { resultDatabase: dbRole("results") as PrivatePostgresConfiguration } : {}),
    ...(f.evidence && t.evidence ? {
      evidence: {
        integrityKey: copyKey(t.evidence.integrityKey, "evidence_key_invalid"),
        enrollments: [...t.evidence.enrollments],
        storage: t.evidence.storage,
        database: dbRole("evidence") as PrivatePostgresConfiguration,
      },
    } : {}),
    ...(f.sessions && t.sessions ? { sessions: { nodes: [...t.sessions.nodes], sign: t.sessions.sign, database: dbRole("sessions") as PrivatePostgresConfiguration } } : {}),
    ...(parsed.databaseRoles.queueWorker && f.queueWorker ? {
      queueWorker: {
        database: dbRole("queueWorker") as PrivatePostgresConfiguration,
        ...(parsed.queueWorkerConcurrency === undefined ? {} : { concurrency: parsed.queueWorkerConcurrency }),
      },
    } : {}),
    ...(f.codex && t.codex ? { codex: { integrityKey: copyKey(t.codex.integrityKey, "codex_key_invalid"), enrollments: [...t.codex.enrollments] } } : {}),
    ...(f.codexResultReturn && t.codexResultReturn ? { codexResultReturn: t.codexResultReturn } : {}),
    ...(f.nativeHttp && t.nativeHttp ? { nativeHttp: t.nativeHttp } : {}),
    ...(f.idea && t.idea ? {
      ideaCreation: {
        database: dbRole("ideaCreation") ?? dbRole("coordinator") as PrivatePostgresConfiguration,
        integrityKey: copyKey(t.idea.creation.integrityKey, "idea_key_invalid"),
        participants: t.idea.creation.participants,
      },
      ...(t.idea.runtime ? { ideaRuntime: t.idea.runtime as PrivateTaskStartupConfiguration["coordinator"] extends { ideaRuntime?: infer R } ? R : never } : {}),
    } : {}),
  };

  if (f.news && t.news && (parsed.databaseRoles.newsCoordinator === undefined
    || parsed.databaseRoles.newsIngestion === undefined || parsed.databaseRoles.newsWorker === undefined))
    refuse("missing_database_role:news");

  const full: PrivateTaskStartupConfiguration = {
    web: t.web as PrivateStartupConfiguration,
    coordinator,
    ...(f.artifactStorage && t.artifactStorage ? { artifactStorage: t.artifactStorage } : {}),
    ...(f.news && t.news ? {
      news: {
        configuration: t.news.configuration,
        coordinatorDatabase: dbRole("newsCoordinator") as PrivatePostgresConfiguration,
        ingestionDatabase: dbRole("newsIngestion") as PrivatePostgresConfiguration,
        workerDatabase: dbRole("newsWorker") as PrivatePostgresConfiguration,
        integrityKey: copyKey(t.news.integrityKey, "news_key_invalid"),
        authority: t.news.authority,
        transport: t.news.transport,
        ...(t.news.concurrency === undefined ? {} : { concurrency: t.news.concurrency }),
      },
    } : {}),
  };

  let validated: ReturnType<typeof validatePrivateTaskStartupConfiguration>;
  try {
    validated = validatePrivateTaskStartupConfiguration(full);
  } catch {
    refuse("production_gate_refused");
  }
  return Object.freeze({ ...validated });
}
