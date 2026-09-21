import { z } from "zod";
import { captureLocalAdapterInstallationPortsV1, type LocalAdapterInstallationPortsV1 } from "../../harness/v1/local-adapter-installation";
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
import type { TaskCoordinatorConfiguration } from "./task-coordinator-lifecycle";
import { summarizeInstallationReadinessV1, verifyInstallationReadinessV1,
  type InstallationReadinessV1 } from "../../harness/v1/installation-readiness";
import { localBackupRestoreEvidenceDigestForInstallationPlanV1 } from "../../harness/v1/local-backup-restore-readiness";

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
    /** A local Hermes delivery callback supplied by the installation, never by the browser. */
    hermes021Local: z.boolean().optional(),
    artifactStorage: z.boolean().optional(),
    idea: z.boolean().optional(),
    news: z.boolean().optional(),
  }).strict(),
}).strict();

export type AgentTaskOperatorSettingsV1 = z.infer<typeof operatorSettingsSchema>;

export type AgentTaskOperatorTrustedInputs = {
  web: PrivateStartupConfiguration;
  /** Prepared source-only compositions, retained without enabling delivery. */
  preparedLocalAdapters?: LocalAdapterInstallationPortsV1;
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
  /** Already-built, installation-owned local Hermes executor. It contains no browser input. */
  hermes021Local?: NonNullable<TaskCoordinatorConfiguration["hermes021Local"]>;
  /** Verified, plan-bound evidence from an owner-run disposable local restore.
   * It is installation-only input, never browser data or a task record. */
  localBackupRestoreReadiness?: unknown;
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

/**
 * A local runner is an explicit installation-owned enablement choice, never a
 * consequence of merely supplying a callback. Require the local proof set but
 * do not require remote proofs: a unified installation may prepare a remote
 * worker later without disabling an already-proved local worker.
 */
function requireReadyLocalHermesInstallation(web: PrivateStartupConfiguration, backupRestoreProof: unknown) {
  if (web.installationTopologyPlan === undefined || web.installationReadiness === undefined)
    refuse("hermes021Local_installation_proof_missing");
  let summary: ReturnType<typeof summarizeInstallationReadinessV1>;
  try { summary = summarizeInstallationReadinessV1(web.installationTopologyPlan, web.installationReadiness); }
  catch { refuse("hermes021Local_installation_proof_invalid"); }
  const passed = new Set(summary.proofs.filter(item => item.state === "passed").map(item => item.proof));
  for (const proof of ["backup_restore", "local_owner_qualification", "local_runner_bridge"] as const) {
    if (!summary.plan.requiredProofs.includes(proof) || !passed.has(proof))
      refuse("hermes021Local_installation_not_ready");
  }
  let recorded: InstallationReadinessV1;
  let derivedBackupEvidenceDigest: string;
  try {
    recorded = verifyInstallationReadinessV1(web.installationReadiness);
    derivedBackupEvidenceDigest = localBackupRestoreEvidenceDigestForInstallationPlanV1(
      web.installationTopologyPlan, backupRestoreProof);
  } catch { refuse("hermes021Local_backup_restore_proof_invalid"); }
  const recordedBackup = recorded.proofs.find(item => item.proof === "backup_restore");
  if (recordedBackup?.state !== "passed" || recordedBackup.evidenceDigest !== derivedBackupEvidenceDigest)
    refuse("hermes021Local_backup_restore_proof_mismatch");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const copyKey = (value: unknown, code: string): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.length !== 32) refuse(code);
  return Uint8Array.from(value);
};

/** Detach and freeze the trusted input into a host-owned copy. Plain objects
 * and arrays are recursively copied so the captured value cannot reference
 * caller-owned objects. `Uint8Array` (and any `ArrayBufferView`) values are
 * copied byte-for-byte so post-assembly mutation of the source buffer does
 * not leak into the returned configuration. Functions are frozen but their
 * `.prototype` is left alone. The result is a fresh object graph the host
 * can rely on as immutable input. Class instances other than
 * `Uint8Array`/`ArrayBufferView` are returned as frozen references — the
 * trusted inputs contract treats them as opaque. */
function deepDetach<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0)) as unknown as T;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as ArrayBufferView;
    const copy = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return new Uint8Array(copy) as unknown as T;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(deepDetach(item));
    Object.freeze(out);
    return out as unknown as T;
  }
  if (typeof value === "function") {
    Object.freeze(value);
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = deepDetach((value as Record<string, unknown>)[key]);
  }
  Object.freeze(out);
  return out as unknown as T;
};

/** Capture the supported web-tasks fields from a structurally valid tasks
 * object regardless of its prototype. The production gate accepts any
 * structurally valid `tasks` (plain object, class instance, or shallow-frozen
 * object), so the assembler cannot rely on `deepDetach`'s prototype short-
 * circuit to fully detach it. This helper reads the well-known supported
 * fields by name, byte-copies every binary integrity key, and preserves the
 * trusted service callbacks as frozen references — so a caller-owned `tasks`
 * with a non-`Object.prototype` prototype cannot leak its buffers into the
 * returned configuration. */
function captureWebTasks(input: unknown): Readonly<{
  harnessIntegrityKey: Uint8Array;
  results?: { integrityKey: Uint8Array; storageClass: "local" | "r2"; storage: unknown;
    storageIoMs?: number };
  reviews?: { integrityKey: Uint8Array; checkpoints: unknown };
  ownerReviews?: { integrityKey: Uint8Array; [key: string]: unknown };
  manualVerificationScenarios?: readonly unknown[];
}> {
  if (!isRecord(input)) refuse("website_setting_rejected:tasks");
  const rawHarness = input.harnessIntegrityKey;
  if (!(rawHarness instanceof Uint8Array) || rawHarness.length !== 32) refuse("website_setting_rejected:tasks.harnessIntegrityKey");
  const out: Record<string, unknown> = {
    harnessIntegrityKey: new Uint8Array(rawHarness),
  };
  const rawResults = input.results;
  if (rawResults !== undefined) {
    if (!isRecord(rawResults) || !(rawResults.integrityKey instanceof Uint8Array)
      || rawResults.integrityKey.length !== 32
      || (rawResults.storageClass !== "local" && rawResults.storageClass !== "r2"))
      refuse("website_setting_rejected:tasks.results");
    out.results = Object.freeze({
      integrityKey: new Uint8Array(rawResults.integrityKey),
      storageClass: rawResults.storageClass,
      storage: deepDetach(rawResults.storage),
      ...(rawResults.storageIoMs === undefined ? {} : { storageIoMs: rawResults.storageIoMs }),
    });
  }
  const rawReviews = input.reviews;
  if (rawReviews !== undefined) {
    if (!isRecord(rawReviews) || !(rawReviews.integrityKey instanceof Uint8Array)
      || rawReviews.integrityKey.length !== 32
      || !isRecord(rawReviews.checkpoints))
      refuse("website_setting_rejected:tasks.reviews");
    out.reviews = Object.freeze({
      integrityKey: new Uint8Array(rawReviews.integrityKey),
      checkpoints: deepDetach(rawReviews.checkpoints),
    });
  }
  const rawOwnerReviews = input.ownerReviews;
  if (rawOwnerReviews !== undefined) {
    if (!isRecord(rawOwnerReviews) || !(rawOwnerReviews.integrityKey instanceof Uint8Array)
      || rawOwnerReviews.integrityKey.length !== 32)
      refuse("website_setting_rejected:tasks.ownerReviews");
    const ownerShape: Record<string, unknown> = { integrityKey: new Uint8Array(rawOwnerReviews.integrityKey) };
    for (const key of Object.keys(rawOwnerReviews)) {
      if (key === "integrityKey") continue;
      ownerShape[key] = deepDetach(rawOwnerReviews[key]);
    }
    out.ownerReviews = Object.freeze(ownerShape);
  }
  const rawScenarios = input.manualVerificationScenarios;
  if (rawScenarios !== undefined) {
    if (!Array.isArray(rawScenarios)) refuse("website_setting_rejected:tasks.manualVerificationScenarios");
    const copied = Object.freeze(rawScenarios.map(item => deepDetach(item)));
    out.manualVerificationScenarios = copied;
  }
  return Object.freeze(out) as Readonly<{
    harnessIntegrityKey: Uint8Array;
    results?: { integrityKey: Uint8Array; storageClass: "local" | "r2"; storage: unknown;
      storageIoMs?: number };
    reviews?: { integrityKey: Uint8Array; checkpoints: unknown };
    ownerReviews?: { integrityKey: Uint8Array; [key: string]: unknown };
    manualVerificationScenarios?: readonly unknown[];
  }>;
}

/** Capture the supported web profile fields from a validated private startup
 * input. The profile carries a `loadKeys` callback and optional nested
 * service references (`secondaryAccess`, `gatewayAssertionProfile`,
 * `herdrObservations`, `newsCollections`, `ideaCreation`, `connections`,
 * `productConfiguration`, `installationTopologyPlan`, `installationReadiness`, `localBackupRestoreReadiness`,
 * `codexMacosCustodyReadiness`, `claudeCodeLocalProcessReadiness`, `ideaProjects`, `news`); those trusted callbacks
 * must be preserved as frozen references, not deep-cloned. The `tasks`
 * field is captured through `captureWebTasks` because the production gate
 * accepts it as a structurally valid object with any prototype. Every
 * binary integrity key is byte-copied so post-assembly mutation of the
 * caller's buffers cannot leak into the returned configuration. */
function captureWebProfile(input: PrivateStartupConfiguration): PrivateStartupConfiguration {
  const out: Record<string, unknown> = {
    origin: input.origin, issuer: input.issuer, audience: input.audience,
    tenantId: input.tenantId, workspaceId: input.workspaceId,
    ownerIdentityId: input.ownerIdentityId, maxSessionSeconds: input.maxSessionSeconds,
    loadKeys: deepDetach(input.loadKeys),
    database: deepDetach(input.database),
    ...(input.secondaryAccess === undefined ? {} : { secondaryAccess: deepDetach(input.secondaryAccess) }),
    ...(input.gatewayAssertionProfile === undefined ? {} : {
      gatewayAssertionProfile: deepDetach(input.gatewayAssertionProfile) }),
    ...(input.herdrObservations === undefined ? {} : {
      herdrObservations: deepDetach(input.herdrObservations) }),
    ...(input.ideaProjects === undefined ? {} : {
      ideaProjects: deepDetach(input.ideaProjects) }),
    ...(input.news === undefined ? {} : { news: deepDetach(input.news) }),
    ...(input.productConfiguration === undefined ? {} : {
      productConfiguration: deepDetach(input.productConfiguration) }),
    ...(input.installationTopologyPlan === undefined ? {} : {
      installationTopologyPlan: deepDetach(input.installationTopologyPlan) }),
    ...(input.installationReadiness === undefined ? {} : {
      installationReadiness: deepDetach(input.installationReadiness) }),
    ...(input.localBackupRestoreReadiness === undefined ? {} : {
      localBackupRestoreReadiness: deepDetach(input.localBackupRestoreReadiness) }),
    ...(input.codexMacosCustodyReadiness === undefined ? {} : {
      codexMacosCustodyReadiness: deepDetach(input.codexMacosCustodyReadiness) }),
    ...(input.claudeCodeLocalProcessReadiness === undefined ? {} : {
      claudeCodeLocalProcessReadiness: deepDetach(input.claudeCodeLocalProcessReadiness) }),
    ...(input.connections === undefined ? {} : { connections: deepDetach(input.connections) }),
    ...(input.tasks === undefined ? {} : { tasks: captureWebTasks(input.tasks) }),
  };
  Object.freeze(out);
  return out as unknown as PrivateStartupConfiguration;
}

/** Assemble one immutable agent-task startup configuration from plain operator
 * settings plus already-constructed trusted inputs. Every refusal throws before
 * any value is returned; a returned configuration passed the production gate. */
export function assemblePrivateAgentTaskOperatorConfiguration(
  settings: unknown,
  trusted: unknown,
): { readonly configuration: PrivateTaskStartupConfiguration;
    readonly port: number } {
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
  need(f.hermes021Local, t.hermes021Local, "hermes021Local");
  need(f.hermes021Local, t.localBackupRestoreReadiness, "localBackupRestoreReadiness");
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
  if (f.queueWorker && (!f.nativeQueue || (!f.sessions && !f.hermes021Local)))
    refuse("feature_chain:queueWorker_requires_nativeQueue_and_worker_delivery");
  if (f.codex && (!f.nativeQueue || !f.sessions)) refuse("feature_chain:codex_requires_nativeQueue_and_sessions");
  if (f.codexResultReturn && (!f.codex || !f.quality || !f.artifactStorage || !f.sessions
    || parsed.databaseRoles.results === undefined)) refuse("feature_chain:codexResultReturn_requires_full_composition");
  if (f.nativeHttp && !f.sessions) refuse("feature_chain:nativeHttp_requires_sessions");
  if (f.revisionPlanning && !f.quality) refuse("feature_chain:revisionPlanning_requires_quality");
  if (f.artifactStorage && (!f.quality || !f.evidence || parsed.databaseRoles.results === undefined)) refuse("feature_chain:artifactStorage_requires_quality_evidence_results");
  if (f.hermes021Local && (!f.nativeQueue || !f.queueWorker || !f.quality || !f.evidence || !f.artifactStorage
    || parsed.databaseRoles.results === undefined || parsed.databaseRoles.evidence === undefined))
    refuse("feature_chain:hermes021Local_requires_queue_results_and_artifacts");

  // Database roles: one host/database, pairwise-distinct usernames, none reusing
  // the web pool login. Exact credential validation stays downstream.
  // `ideaRuntime` is intentionally excluded here: it is validated against the
  // declared role and the runtime database below, where a same-username match
  // to itself is the correct (passing) case rather than a duplicate.
  const roles: Array<[string, PrivatePostgresConfiguration]> = [["coordinator", parsed.databaseRoles.coordinator as PrivatePostgresConfiguration]];
  const roleFor = (name: "results" | "evidence" | "sessions" | "queueWorker" | "ideaCreation"
    | "newsCoordinator" | "newsIngestion" | "newsWorker") => {
    const role = parsed.databaseRoles[name];
    if (role !== undefined) roles.push([name, role as PrivatePostgresConfiguration]);
  };
  roleFor("results"); roleFor("evidence"); roleFor("sessions"); roleFor("queueWorker");
  roleFor("ideaCreation");
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

  // Frozen approval-store capture. Every method is bound to the ORIGINAL trusted
  // store receiver so that post-assembly mutation of the caller's `store`
  // reference cannot leak into a captured configuration, and the captured shape
  // is frozen so the trusted methods cannot be replaced or extended on the
  // returned assembly. The downstream production gate accepts this exact shape.
  const capturedStore = Object.freeze(deepDetach({
    acceptInSession: store.acceptInSession.bind(store),
    readInSession: store.readInSession.bind(store),
    ...(store.receiveDeliveryReceipt === undefined ? {} : {
      receiveDeliveryReceipt: store.receiveDeliveryReceipt.bind(store),
    }),
  }));

  // Idea runtime role binding: when `f.idea && t.idea.runtime` is supplied, the
  // declared role must exist AND the trusted runtime database must match it.
  // Without this, a caller could pass any runtime database and bypass the
  // declared role contract.
  if (f.idea && t.idea?.runtime) {
    if (parsed.databaseRoles.ideaRuntime === undefined) {
      refuse("missing_database_role:ideaRuntime");
    }
    const declaredRuntimeRole = parsed.databaseRoles.ideaRuntime as PrivatePostgresConfiguration;
    const trustedRuntimeDb = t.idea.runtime.database;
    if (!isRecord(trustedRuntimeDb)
      || trustedRuntimeDb.host !== primaryHost
      || trustedRuntimeDb.port !== primaryPort
      || trustedRuntimeDb.database !== primaryDatabase) {
      refuse("idea_runtime_role_mismatch");
    }
    if (typeof trustedRuntimeDb.username !== "string"
      || seen.has(trustedRuntimeDb.username) || trustedRuntimeDb.username === webUsername) {
      refuse("idea_runtime_role_mismatch:reuse");
    }
    seen.add(trustedRuntimeDb.username);
    if (trustedRuntimeDb.host !== declaredRuntimeRole.host
      || trustedRuntimeDb.port !== declaredRuntimeRole.port
      || trustedRuntimeDb.database !== declaredRuntimeRole.database
      || trustedRuntimeDb.username !== declaredRuntimeRole.username) {
      refuse("idea_runtime_role_mismatch:declared");
    }
    // Password and majorVersion must also agree. Without these checks, a
    // caller could declare role A with one credential and silently connect
    // the runtime with another, and downstream evidence would be issued under
    // a role the operator never recorded. The full connection identity must
    // match declared so the runtime cannot drift from the operator contract.
    if (trustedRuntimeDb.password !== declaredRuntimeRole.password) {
      refuse("idea_runtime_role_mismatch:password");
    }
    if (trustedRuntimeDb.majorVersion !== declaredRuntimeRole.majorVersion) {
      refuse("idea_runtime_role_mismatch:major_version");
    }
  }

  // Session signer binding: capture the original trusted sessions object as
  // the receiver so the captured `sign` cannot be replaced or unbound when
  // the trusted sessions object is later mutated.
  const trustedSessions = t.sessions as NonNullable<AgentTaskOperatorTrustedInputs["sessions"]>;
  const capturedSessions = f.sessions && trustedSessions ? Object.freeze({
    nodes: [...trustedSessions.nodes],
    sign: trustedSessions.sign.bind(trustedSessions),
  }) : undefined;
  deepDetach(capturedSessions);

  // The local Hermes executor is a private installation boundary. Capture only
  // its original callable receiver, not a worker ID, command, path, provider,
  // model or any browser-selected setting. Constructing this configuration
  // remains inert: queue pickup is the first possible delivery attempt.
  const trustedHermes = t.hermes021Local as NonNullable<AgentTaskOperatorTrustedInputs["hermes021Local"]> | undefined;
  if (f.hermes021Local && (!trustedHermes || typeof trustedHermes.deliver !== "function")) refuse("hermes021Local_invalid");
  if (f.hermes021Local) requireReadyLocalHermesInstallation(
    t.web as PrivateStartupConfiguration, t.localBackupRestoreReadiness);
  const capturedHermes = f.hermes021Local && trustedHermes
    ? Object.freeze({ deliver: trustedHermes.deliver.bind(trustedHermes) }) : undefined;

  const coordinator: PrivateTaskStartupConfiguration["coordinator"] = {
    planning: {
      template: planning.template,
      ...(planning.additionalTemplates === undefined ? {} : { additionalTemplates: [...planning.additionalTemplates] }),
      integrityKey: copyKey(planning.integrityKey, "planning_integrity_key_invalid"),
      reviewIntegrityKey: copyKey(planning.reviewIntegrityKey, "planning_review_key_invalid"),
      ...(planning.ideaIntegrityKey === undefined ? {} : { ideaIntegrityKey: copyKey(planning.ideaIntegrityKey, "planning_idea_key_invalid") }),
      checkpoints: planning.checkpoints,
    },
    routes: deepDetach([...t.routes]),
    approvals: {
      enrollments: deepDetach([...t.approvalEnrollments]),
      store: capturedStore as unknown as NonNullable<NonNullable<PrivateTaskStartupConfiguration["coordinator"]["approvals"]>["store"]>,
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
    ...(capturedSessions ? {
      sessions: {
        nodes: [...capturedSessions.nodes],
        sign: capturedSessions.sign,
        database: dbRole("sessions") as PrivatePostgresConfiguration,
      },
    } : {}),
    ...(parsed.databaseRoles.queueWorker && f.queueWorker ? {
      queueWorker: {
        database: dbRole("queueWorker") as PrivatePostgresConfiguration,
        ...(parsed.queueWorkerConcurrency === undefined ? {} : { concurrency: parsed.queueWorkerConcurrency }),
      },
    } : {}),
    ...(f.codex && t.codex ? { codex: { integrityKey: copyKey(t.codex.integrityKey, "codex_key_invalid"), enrollments: [...t.codex.enrollments] } } : {}),
    ...(f.codexResultReturn && t.codexResultReturn ? { codexResultReturn: t.codexResultReturn } : {}),
    ...(f.nativeHttp && t.nativeHttp ? { nativeHttp: t.nativeHttp } : {}),
    ...(capturedHermes ? { hermes021Local: capturedHermes } : {}),
    ...(f.idea && t.idea ? {
      ideaCreation: {
        database: dbRole("ideaCreation") ?? dbRole("coordinator") as PrivatePostgresConfiguration,
        integrityKey: copyKey(t.idea.creation.integrityKey, "idea_key_invalid"),
        participants: t.idea.creation.participants,
      },
      ...(t.idea.runtime ? {
        ideaRuntime: {
          ...(t.idea.runtime as Omit<NonNullable<TaskCoordinatorConfiguration["ideaRuntime"]>, "database">),
          database: dbRole("ideaRuntime") as PrivatePostgresConfiguration,
        },
      } : {}),
    } : {}),
  };

  if (f.news && t.news && (parsed.databaseRoles.newsCoordinator === undefined
    || parsed.databaseRoles.newsIngestion === undefined || parsed.databaseRoles.newsWorker === undefined))
    refuse("missing_database_role:news");

  const full: PrivateTaskStartupConfiguration = {
    ...(t.preparedLocalAdapters === undefined ? {} : {
      preparedLocalAdapters: captureLocalAdapterInstallationPortsV1(t.preparedLocalAdapters as LocalAdapterInstallationPortsV1),
    }),
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
  // Host-compatible capture. Detach and freeze every nested object the trusted
  // inputs contributed (web profile, evidence storage, codex enrollments, etc.)
  // so the caller cannot mutate the captured shape after assembly. Each capture
  // is a fresh object graph: the assembler never returns a reference to any
  // caller-owned object, including binary fields like `Uint8Array`. The
  // production gate already validated `full`; `hostCompatible` is the same
  // configuration in the host-shaped wrapper, owned by the host.
  const coordinatorShape = deepDetach(full.coordinator);
  const webShape = captureWebProfile(full.web);
  const artifactStorageShape = full.artifactStorage === undefined ? undefined : deepDetach(full.artifactStorage);
  const newsShape = full.news === undefined ? undefined : deepDetach(full.news);
  const hostCompatible: PrivateTaskStartupConfiguration = {
    ...(full.preparedLocalAdapters === undefined ? {} : { preparedLocalAdapters: full.preparedLocalAdapters }),
    web: webShape,
    ...(artifactStorageShape !== undefined ? { artifactStorage: artifactStorageShape } : {}),
    ...(newsShape !== undefined ? { news: newsShape } : {}),
    coordinator: {
      planning: coordinatorShape.planning,
      routes: coordinatorShape.routes,
      approvals: coordinatorShape.approvals!,
      ...(coordinatorShape.quality ? { quality: coordinatorShape.quality } : {}),
      ...(coordinatorShape.revisionPlanning ? { revisionPlanning: coordinatorShape.revisionPlanning } : {}),
      ...(coordinatorShape.nativeHttp ? { nativeHttp: coordinatorShape.nativeHttp } : {}),
      ...(coordinatorShape.hermes021Local ? { hermes021Local: coordinatorShape.hermes021Local } : {}),
      ...(coordinatorShape.codex ? { codex: coordinatorShape.codex } : {}),
      ...(coordinatorShape.nativeQueue ? { nativeQueue: coordinatorShape.nativeQueue } : {}),
      ...(coordinatorShape.nativeQueueRecovery ? { nativeQueueRecovery: coordinatorShape.nativeQueueRecovery } : {}),
      ...(coordinatorShape.queueWorker ? { queueWorker: coordinatorShape.queueWorker } : {}),
      database: coordinatorShape.database,
      ...(coordinatorShape.resultDatabase ? { resultDatabase: coordinatorShape.resultDatabase } : {}),
      ...(coordinatorShape.ideaCreation ? { ideaCreation: coordinatorShape.ideaCreation } : {}),
      ...(coordinatorShape.ideaRuntime ? { ideaRuntime: coordinatorShape.ideaRuntime } : {}),
      ...(coordinatorShape.evidence ? { evidence: coordinatorShape.evidence } : {}),
      ...(coordinatorShape.sessions ? { sessions: coordinatorShape.sessions } : {}),
      ...(coordinatorShape.codexResultReturn ? { codexResultReturn: coordinatorShape.codexResultReturn } : {}),
    },
  };
  return Object.freeze({ configuration: deepDetach(hostCompatible), port: parsed.port });
}
