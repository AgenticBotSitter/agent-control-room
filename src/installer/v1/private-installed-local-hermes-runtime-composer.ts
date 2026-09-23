import { timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import { createDurableReservationPostgresPortV1 } from
  "../../artifacts/v1/neutral-reservation-postgres";
import { PersistentLocalArtifactStorageV1 } from "../../artifacts/v1/persistent-local-storage";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { DurableResultReviewSubmissionServiceV1 } from "../../completion-gate/v1/durable-result-review-submission";
import { DurableLocalResultInspectionServiceV1 } from "../../completion-gate/v1/durable-local-result-inspection";
import type { AwaitableRollbackCheckpointStoreV1 } from "../../security/rollback-checkpoint";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";
import { HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1, HERMES_021_SOURCE_REVISION_V1 } from
  "../../harness/hermes-021-v1/connector-profile";
import { Hermes021MacosDispatchPreparationV1 } from "../../harness/hermes-021-v1/dispatch-preparation";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
  hermes021MacosLocalBindingSchemaV1 } from "../../harness/hermes-021-v1/macos-local-worker";
import { captureHermes021MacosSubprocessHostConfigurationV1 } from
  "../../harness/hermes-021-v1/subprocess-stream-json-host";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { capturePrivateArtifactStorageConfigurationV1 } from "../../web/v1/private-artifact-storage";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration,
  type PrivatePostgresConfiguration } from "../../web/v1/private-postgres";
import { installPrivateApplication } from "../../web/v1/private-process";
import { createInstalledNativeQueueFactories } from "../../web/v1/installed-native-queue";
import { createPrivateHermes021LocalInstalledCompositionDeliveryV1,
  createPrivateHermes021LocalStartupAdmissionBindingV1,
  PRIVATE_HERMES_021_INSTALLED_COMPOSITION_IDENTITY_V1 } from
  "../../web/v1/hermes-021-private-installation-composition";
import { nativeTaskTemplateSchema, TaskExecutionPlanner } from "../../web/v1/task-execution-planner";
import { validatePrivateTaskStartupConfiguration } from "../../web/v1/private-task-startup";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { localHermesRunnerConfigurationDigestV1, verifyLocalHermesInstallationBindingV1 } from
  "./local-hermes-installation-binding";
import { verifyInstallationPlanV1 } from "./installation-plan";
import { PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 } from
  "./private-installed-configuration-custody";

/**
 * Pure installed-data -> callable-graph composition.  It deliberately stops
 * before journal construction: the v2 reader proves data custody, but only the
 * separately reviewed held native session can authorize journal operations.
 */
export const PRIVATE_INSTALLED_LOCAL_HERMES_RUNTIME_COMPOSER_V1 =
  "control-room.private-installed-local-hermes-runtime-composer/v1" as const;
export const PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1 =
  "control-room.private-installed-local-hermes-configuration/v1" as const;
export const PRIVATE_INSTALLED_LOCAL_HERMES_AGENT_SOURCE_V1 =
  "control-room.private-installed-local-hermes-agent-source/v1" as const;
export const PRIVATE_INSTALLED_LOCAL_HERMES_REVIEWED_GRAPH_CAPABILITY_V1 =
  "control-room.private-installed-local-hermes-reviewed-graph-capability/v1" as const;

type ReviewedHermesGraph = Readonly<{ tenantId: string; execution: unknown; results: unknown;
  assertAuthority: (delivery: unknown) => void; subprocess: unknown; installedCompositionIdentity: unknown }>;
const reviewedHermesGraphs = new WeakMap<object, ReviewedHermesGraph>();

function mintReviewedHermesGraph(graph: ReviewedHermesGraph): object {
  const capability = Object.freeze({ schema: PRIVATE_INSTALLED_LOCAL_HERMES_REVIEWED_GRAPH_CAPABILITY_V1 });
  reviewedHermesGraphs.set(capability, graph); return capability;
}

/** Internal cross-module consumption seam. A capability is minted only after
 * this composer has captured and constructed the complete reviewed graph, and
 * is consumed exactly once by the delivery module. */
export function consumePrivateInstalledLocalHermesReviewedGraphV1(capability: unknown): ReviewedHermesGraph {
  if (!capability || typeof capability !== "object" || types.isProxy(capability)) return refused();
  const graph = reviewedHermesGraphs.get(capability);
  if (!graph || !reviewedHermesGraphs.delete(capability)) return refused();
  return graph;
}

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifier = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);
const safeRole = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const databaseIdentitySchema = z.object({ host: z.literal("127.0.0.1"), port: z.number().int().min(1).max(65_535),
  database: safeRole, majorVersion: z.literal(17), roles: z.object({ web: safeRole, coordinator: safeRole,
    results: safeRole, evidence: safeRole, queueWorker: safeRole }).strict(),
  queueConcurrency: z.number().int().min(1).max(8) }).strict();
const taskPolicySchema = z.object({ adapter: z.literal(HERMES_021_MACOS_LOCAL_ADAPTER_V1),
  connectorProfileDigest: z.literal(HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1),
  taskClass: z.literal("text_review"), tools: z.literal("none"), maximumTurns: z.literal(1),
  maximumRunBudgetSeconds: z.number().int().min(15).max(120) }).strict();
const sidecarSchema = z.object({
  schema: z.literal(PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1),
  releaseVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  portableReleaseManifestSha256: digest, outerLauncherManifestSha256: digest,
  sidecarManifestSha256: digest, archiveSha256: digest, artifactManifestSha256: digest,
  executableSha256: digest, platform: z.literal("darwin"), protocol: z.literal("ACRJNL1"),
  architecture: z.enum(["arm64", "x64"]),
}).strict();
const stages = Object.freeze(["database_authority", "protected_data", "first_owner", "recovery",
  "platform_service", "agent_readiness", "final_review"] as const);
type Stage = typeof stages[number];

type DeferredStorage = Readonly<{
  port: ArtifactStoragePortV1 & ArtifactReadPortV1;
  bind(value: unknown): void;
}>;

const refused = (): never => {
  const error = new Error("private_installed_local_hermes_runtime_composer_refused");
  error.stack = undefined;
  throw error;
};

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(name => !names.includes(name))
    || names.some(name => !Object.prototype.hasOwnProperty.call(value, name)) || keys.some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refused();
  return value as Readonly<Record<string, unknown>>;
}

function allowed(value: unknown, required: readonly string[], optional: readonly string[] = []): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value), permitted = [...required, ...optional];
  if (keys.some(name => !permitted.includes(name)) || required.some(name => !keys.includes(name)) || keys.some(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
  })) return refused();
  return value as Readonly<Record<string, unknown>>;
}

/** Reject every capability shape before canonical JSON is evaluated. */
function captureJson(value: unknown, path = "configuration", active = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : refused();
  if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) return refused();
  active.add(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || names.length !== lengthDescriptor.value + 1) return refused();
    const result: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
      result.push(captureJson(descriptor.value, `${path}[${index}]`, active));
    }
    if (names.some(name => name !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(name))) return refused();
    active.delete(value); return Object.freeze(result);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const result: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    if (/^(?:password|secret|token|api[_-]?key|private[_-]?key|credential)$/iu.test(name)) return refused();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    result[name] = captureJson(descriptor.value, `${path}.${name}`, active);
  }
  active.delete(value); return Object.freeze(result);
}

/** Plain records may carry reviewed callbacks, but never hidden getters or proxies. */
function assertCapabilityGraph(value: unknown, active = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    || value === undefined) return;
  if ((typeof value !== "object" && typeof value !== "function") || types.isProxy(value)) return refused();
  if (typeof value === "function" || value instanceof Uint8Array || value instanceof AbortSignal) return;
  if (active.has(value as object)) return refused();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return;
  active.add(value as object);
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    if (Array.isArray(value) && name === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    assertCapabilityGraph(descriptor.value, active);
  }
  active.delete(value as object);
}

function copyKey(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) return refused();
  return Uint8Array.from(value);
}

function sameKey(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function databaseIdentity(value: PrivatePostgresConfiguration) {
  const parsed = validatePrivatePostgresConfiguration(value);
  return Object.freeze({ host: parsed.host, port: parsed.port, database: parsed.database,
    username: parsed.username, majorVersion: parsed.majorVersion });
}

function createDeferredDatabase(): Readonly<{ client: DatabaseClient; bind(value: unknown): void }> {
  let target: DatabaseClient | undefined;
  const requireTarget = () => target ?? refused();
  const client: DatabaseClient = Object.freeze({
    query<T>(sql: string, values?: unknown[]) { return requireTarget().query<T>(sql, values); },
    transaction<T>(work: (tx: DatabaseSession) => Promise<T>) { return requireTarget().transaction(work); },
    transactionWithPreCommitCheck<T>(work: (tx: DatabaseSession) => Promise<T>, check: () => Promise<void> | void) {
      return requireTarget().transactionWithPreCommitCheck(work, check);
    },
  });
  return Object.freeze({ client, bind(value: unknown) {
    if (target || !value || typeof value !== "object" || types.isProxy(value)) return refused();
    const db = value as DatabaseClient;
    if (typeof db.query !== "function" || typeof db.transaction !== "function"
      || typeof db.transactionWithPreCommitCheck !== "function") return refused();
    target = Object.freeze({ query: db.query.bind(value), transaction: db.transaction.bind(value),
      transactionWithPreCommitCheck: db.transactionWithPreCommitCheck.bind(value) });
  } });
}

function createDeferredStorage(): DeferredStorage {
  type StoragePort = ArtifactStoragePortV1 & ArtifactReadPortV1;
  let target: StoragePort | undefined;
  const requireTarget = () => target ?? refused();
  const port: StoragePort = Object.freeze({
    put(input: Parameters<ArtifactStoragePortV1["put"]>[0]) { return requireTarget().put(input); },
    read(artifactId: string, signal?: AbortSignal) { return requireTarget().read(artifactId, signal); },
  });
  return Object.freeze({ port, bind(value: unknown) {
    if (target || !value || typeof value !== "object" || types.isProxy(value)) return refused();
    const storage = value as StoragePort;
    if (typeof storage.put !== "function" || typeof storage.read !== "function") return refused();
    target = Object.freeze({ put: storage.put.bind(value), read: storage.read.bind(value) });
  } });
}

function captureStageMap(value: unknown): Readonly<Record<Stage, unknown>> {
  const map = exact(value, stages), result: Record<string, unknown> = {};
  for (const stage of stages) result[stage] = map[stage];
  return Object.freeze(result) as Readonly<Record<Stage, unknown>>;
}

function captureRuntimePort(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || types.isProxy(value)) return refused();
  const outerNames = Object.getOwnPropertyNames(value);
  if (outerNames.length !== 1) return refused();
  const outer = Object.getOwnPropertyDescriptor(value, outerNames[0]!);
  if (!outer || outer.enumerable !== true || !("value" in outer)) return refused();
  const port = outer.value;
  if (!port || typeof port !== "object" || types.isProxy(port)) return refused();
  const captured: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(port)) {
    const descriptor = Object.getOwnPropertyDescriptor(port, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    if (types.isProxy(descriptor.value)) return refused();
    captured[name] = typeof descriptor.value === "function"
      ? Function.prototype.bind.call(descriptor.value, port) : descriptor.value;
  }
  return Object.freeze({ [outerNames[0]!]: Object.freeze(captured) });
}

function parsePreparation(value: unknown) {
  const prepared = exact(value, ["schema", "installationId", "privateConfigurationData", "journal", "nativeSidecar",
    "dataOnly", "opensJournal", "constructsJournal", "stagesNativeSidecar", "performsNativeOperation",
    "writesInstalledManifest", "autoUpgradesManifest"]);
  if (prepared.schema !== PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1
    || prepared.dataOnly !== true || prepared.opensJournal !== false || prepared.constructsJournal !== false
    || prepared.stagesNativeSidecar !== false || prepared.performsNativeOperation !== false
    || prepared.writesInstalledManifest !== false || prepared.autoUpgradesManifest !== false) return refused();
  const id = installationId.parse(prepared.installationId);
  const journal = exact(prepared.journal, ["rootPath", "expectedRootIdentity", "expectedOwnerUid", "expectedRootMode"]);
  const identity = exact(journal.expectedRootIdentity, ["device", "inode"]);
  if (typeof journal.rootPath !== "string" || !Number.isSafeInteger(identity.device) || !Number.isSafeInteger(identity.inode)
    || !Number.isSafeInteger(journal.expectedOwnerUid) || journal.expectedRootMode !== 0o700) return refused();
  const nativeSidecar = Object.freeze(sidecarSchema.parse(captureJson(prepared.nativeSidecar, "nativeSidecar")));
  return Object.freeze({ installationId: id, privateConfigurationData: captureJson(prepared.privateConfigurationData),
    journal: Object.freeze({ rootPath: journal.rootPath, expectedRootIdentity: Object.freeze({ device: identity.device as number,
      inode: identity.inode as number }), expectedOwnerUid: journal.expectedOwnerUid as number, expectedRootMode: 0o700 as const }),
    nativeSidecar });
}

function parseConfiguration(value: unknown, prepared: ReturnType<typeof parsePreparation>) {
  const config = exact(value, ["schema", "installationId", "releaseDigest", "installedManifestBindingDigest",
    "runtimeIdentityDigest", "prerequisiteInput", "settledInstallationPlan", "hermes", "operator", "database",
    "artifactStorage", "setupSources"]);
  if (config.schema !== PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1
    || installationId.parse(config.installationId) !== prepared.installationId) return refused();
  const releaseDigest = digest.parse(config.releaseDigest);
  if (releaseDigest !== prepared.nativeSidecar.portableReleaseManifestSha256) return refused();
  const prerequisite = exact(config.prerequisiteInput,
    ["installationId", "topologyPlan", "releaseDigest", "releasePreflight", "privatePlacement"]);
  const topology = verifyInstallationTopologyPlanV1(prerequisite.topologyPlan);
  if (prerequisite.installationId !== prepared.installationId || prerequisite.releaseDigest !== releaseDigest) return refused();
  const settledInstallationPlan = verifyInstallationPlanV1(config.settledInstallationPlan);
  const agentIndex = settledInstallationPlan.stages.findIndex(stage => stage.stage === "agent_readiness");
  const formsAgentReadiness = agentIndex >= 0
    && settledInstallationPlan.stages[agentIndex]!.state === "running"
    && settledInstallationPlan.stages.slice(0, agentIndex).every(stage => stage.state === "passed")
    && settledInstallationPlan.stages.slice(agentIndex + 1).every(stage => stage.state === "not_started");
  if (settledInstallationPlan.releaseDigest !== releaseDigest
    || settledInstallationPlan.topologyPlanDigest !== topology.planDigest
    || (!formsAgentReadiness && settledInstallationPlan.stages.some(stage => stage.state !== "passed"))) return refused();
  const hermes = exact(config.hermes, ["admissionPreparationInput", "admissionRequestDigest", "runnerConfiguration", "taskPolicy"]);
  const admission = exact(hermes.admissionPreparationInput, ["installationId", "installationPlan", "topologyInput",
    "workerBinding", "installationBinding", "installationBindingInput"]);
  const plan = verifyInstallationPlanV1(admission.installationPlan);
  const workerBinding = Object.freeze(hermes021MacosLocalBindingSchemaV1.parse(admission.workerBinding));
  const runnerConfiguration = captureHermes021MacosSubprocessHostConfigurationV1(hermes.runnerConfiguration);
  const taskPolicy = Object.freeze(taskPolicySchema.parse(hermes.taskPolicy));
  if (admission.installationId !== prepared.installationId || plan.releaseDigest !== releaseDigest
    || plan.topologyPlanDigest !== topology.planDigest || workerBinding.sourceRevision !== HERMES_021_SOURCE_REVISION_V1
    || runnerConfiguration.taskClass !== "text_review" || runnerConfiguration.maximumTurns !== 1
    || runnerConfiguration.maximumRunBudgetSeconds !== taskPolicy.maximumRunBudgetSeconds) return refused();
  const bindingInput = admission.installationBindingInput as Parameters<typeof verifyLocalHermesInstallationBindingV1>[1];
  const binding = verifyLocalHermesInstallationBindingV1(admission.installationBinding, bindingInput);
  if (binding.installationPlanDigest !== plan.planDigest || binding.releaseDigest !== releaseDigest
    || binding.runnerConfigurationDigest !== localHermesRunnerConfigurationDigestV1(runnerConfiguration)) return refused();
  const expectedRuntimeIdentityDigest = sha256Digest({ purpose: "private-installed-local-hermes-runtime-identity/v1",
    installationId: prepared.installationId, releaseDigest,
    nativeSidecarIdentityDigest: sha256Digest(prepared.nativeSidecar),
    workerBindingDigest: sha256Digest(workerBinding), runnerConfigurationDigest: binding.runnerConfigurationDigest });
  if (digest.parse(config.runtimeIdentityDigest) !== expectedRuntimeIdentityDigest) return refused();
  const agentSource = exact((captureStageMap(config.setupSources)).agent_readiness, ["schema"]);
  if (agentSource.schema !== PRIVATE_INSTALLED_LOCAL_HERMES_AGENT_SOURCE_V1) return refused();
  const database = Object.freeze(databaseIdentitySchema.parse(config.database));
  const roles = Object.values(database.roles);
  if (new Set(roles).size !== roles.length) return refused();
  const operator = exact(config.operator, ["port", "templateId"]);
  if (!Number.isSafeInteger(operator.port) || (operator.port as number) < 1 || (operator.port as number) > 65_535)
    return refused();
  const templateId = identifier.parse(operator.templateId);
  const artifactStorage = capturePrivateArtifactStorageConfigurationV1(config.artifactStorage as never);
  if (artifactStorage.local.maximumFileBytes !== 65_536) return refused();
  const setupSources = captureStageMap(config.setupSources);
  const { installedManifestBindingDigest: _installed, ...configurationWithoutBinding } = config;
  const expectedManifestBinding = sha256Digest({ purpose: "private-installed-local-hermes-configuration-binding/v1",
    installationId: prepared.installationId, journal: prepared.journal, nativeSidecar: prepared.nativeSidecar,
    configuration: configurationWithoutBinding });
  if (digest.parse(config.installedManifestBindingDigest) !== expectedManifestBinding) return refused();
  if (Buffer.byteLength(canonicalJson(config), "utf8") > 256 * 1024) return refused();
  return Object.freeze({ installationId: prepared.installationId, releaseDigest, prerequisiteInput: prerequisite,
    topology, plan, settledInstallationPlan, admission, admissionRequestDigest: digest.parse(hermes.admissionRequestDigest),
    workerBinding, runnerConfiguration, taskPolicy, database, operatorPort: operator.port as number, templateId,
    artifactStorage, setupSources, installedManifestBindingDigest: expectedManifestBinding,
    runtimeIdentityDigest: expectedRuntimeIdentityDigest });
}

function assertDatabaseBindings(config: ReturnType<typeof parseConfiguration>, startup: ReturnType<typeof validatePrivateTaskStartupConfiguration>) {
  const c = startup, expected = config.database;
  const actual = { web: databaseIdentity(c.web.database), coordinator: databaseIdentity(c.database),
    results: databaseIdentity(c.resultDatabase!), evidence: databaseIdentity(c.evidence!.database),
    queueWorker: databaseIdentity(c.queueWorker!.database) };
  for (const [name, value] of Object.entries(actual)) {
    if (value.host !== expected.host || value.port !== expected.port || value.database !== expected.database
      || value.majorVersion !== expected.majorVersion
      || value.username !== expected.roles[name as keyof typeof expected.roles]) return refused();
  }
  if (c.queueWorker!.concurrency !== expected.queueConcurrency) return refused();
}

function compose(preparationValue: unknown, portsValue: unknown) {
  const prepared = parsePreparation(preparationValue);
  const config = parseConfiguration(prepared.privateConfigurationData, prepared);
  const ports = exact(portsValue, ["startupBase", "deliveryIntegrityKey", "assertCurrentDelivery", "setupRuntimes"]);
  assertCapabilityGraph(ports.startupBase); assertCapabilityGraph(ports.setupRuntimes);
  if (typeof ports.assertCurrentDelivery !== "function" || types.isProxy(ports.assertCurrentDelivery)) return refused();
  const assertCurrentDelivery = Function.prototype.bind.call(ports.assertCurrentDelivery, portsValue) as (delivery: unknown) => void;
  const deliveryIntegrityKey = copyKey(ports.deliveryIntegrityKey);
  const rawBase = exact(ports.startupBase, ["web", "coordinator"]);
  const rawCoordinator = allowed(rawBase.coordinator, ["planning", "routes", "approvals", "quality",
    "database", "resultDatabase", "evidence", "queueWorker"], ["revisionPlanning"]);
  if (!rawCoordinator.approvals || !rawCoordinator.quality || !rawCoordinator.resultDatabase
    || !rawCoordinator.evidence || !rawCoordinator.queueWorker) return refused();
  const planning = allowed(rawCoordinator.planning,
    ["template", "integrityKey", "reviewIntegrityKey", "checkpoints"],
    ["additionalTemplates", "ideaIntegrityKey"]);
  const templates = [planning.template, ...((planning.additionalTemplates as unknown[] | undefined) ?? [])]
    .map(value => nativeTaskTemplateSchema.parse(value));
  const selected = templates.find(value => value.id === config.templateId);
  if (!selected || selected.adapter !== HERMES_021_MACOS_LOCAL_ADAPTER_V1
    || selected.connectorProfileDigest !== HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1) return refused();
  const baseRoutes = rawCoordinator.routes as readonly { capabilityProbeId?: unknown }[];
  if (!Array.isArray(baseRoutes)) return refused();
  const routes = Object.freeze(baseRoutes.some(route => route?.capabilityProbeId === HERMES_021_MACOS_LOCAL_CAPABILITY_V1)
    ? [...baseRoutes] : [...baseRoutes, Object.freeze({ nodeId: config.workerBinding.workerId,
      executorId: selected.authority.allowedExecutor, capabilityProbeId: HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
      maxConcurrentTasks: 1, requiredScratchBytes: 0, leaseSeconds: 60 })]);

  const deferredDatabase = createDeferredDatabase(), deferredStorage = createDeferredStorage();
  const web = exact(rawBase.web, Object.getOwnPropertyNames(rawBase.web as object));
  const tenantId = identifier.parse(web.tenantId), workspaceId = identifier.parse(web.workspaceId);
  const bindingInput = config.admission.installationBindingInput as Record<string, unknown>;
  const composedWeb = Object.freeze({ ...web,
    installationTopologyPlan: config.topology,
    installationReadiness: bindingInput.installationReadiness,
    localBackupRestoreReadiness: bindingInput.backupRestoreProof,
    localSupervisorReadiness: bindingInput.supervisorReadiness,
    installationPlan: config.settledInstallationPlan,
  });
  const composedPlanning = Object.freeze({ ...planning,
    localAdapterAdmission: Object.freeze({ enabledAdapters: Object.freeze([HERMES_021_MACOS_LOCAL_ADAPTER_V1]) }) });
  const resultKey = copyKey((rawCoordinator.quality as { results?: { integrityKey?: unknown } }).results?.integrityKey);
  const reviewKey = copyKey((rawCoordinator.quality as { integrityKey?: unknown }).integrityKey);
  const reviewCheckpoints = (rawCoordinator.quality as { checkpoints?: AwaitableRollbackCheckpointStoreV1 }).checkpoints;
  const harnessKey = copyKey((composedWeb as { tasks?: { harnessIntegrityKey?: unknown } }).tasks?.harnessIntegrityKey);
  if (!reviewCheckpoints || typeof reviewCheckpoints.read !== "function" || typeof reviewCheckpoints.advance !== "function"
    || typeof reviewCheckpoints.initialize !== "function" || sameKey(resultKey, reviewKey) || sameKey(resultKey, deliveryIntegrityKey)) return refused();
  const planner = new TaskExecutionPlanner(deferredDatabase.client, { tenantId, workspaceId },
    composedPlanning as never);
  const execution = Object.freeze({ preparation: new Hermes021MacosDispatchPreparationV1(deferredDatabase.client, planner,
      config.workerBinding), runs: new HarnessRunStoreV1(deferredDatabase.client, harnessKey),
    delivery: Object.freeze({ db: deferredDatabase.client, integrityKey: deliveryIntegrityKey,
      binding: config.workerBinding, policy: Object.freeze({ assertAdmitted() { return refused(); } }),
      terminalResultStorage: deferredStorage.port }) });
  // This is a read-only bridge from the authenticated local Hermes receipt to
  // the already-existing review, correction, and capacity lifecycle. It has
  // no delivery, queue, database-write, or retry authority of its own.
  const resultInspectionSource = new DurableLocalResultInspectionServiceV1(deferredDatabase.client, {
    integrityKey: resultKey, reviewIntegrityKey: reviewKey, harnessIntegrityKey: harnessKey,
    deliveryIntegrityKeys: { hermes: deliveryIntegrityKey }, checkpoints: reviewCheckpoints,
    storageClass: "local", storage: deferredStorage.port,
  });
  const installedCompositionIdentity = Object.freeze({ schema: PRIVATE_HERMES_021_INSTALLED_COMPOSITION_IDENTITY_V1,
    installationId: config.installationId, releaseDigest: config.releaseDigest,
    nativeSidecarIdentityDigest: sha256Digest(prepared.nativeSidecar),
    runtimeIdentityDigest: config.runtimeIdentityDigest });
  const assertAuthority = (deliveryValue: unknown) => { assertCurrentDelivery(deliveryValue); };
  const reviewedGraphCapability = mintReviewedHermesGraph(Object.freeze({
    tenantId, execution,
    results: Object.freeze({ db: deferredDatabase.client, integrityKey: resultKey, reviewKey,
      storage: deferredStorage.port, storageClass: "local", reservations: createDurableReservationPostgresPortV1(),
      reviewSubmission: new DurableResultReviewSubmissionServiceV1(deferredDatabase.client, {
        integrityKey: resultKey, reviewIntegrityKey: reviewKey, checkpoints: reviewCheckpoints,
        storageClass: "local", storage: deferredStorage.port,
      }) }),
    assertAuthority, subprocess: config.runnerConfiguration, installedCompositionIdentity,
  }));
  const delivery = createPrivateHermes021LocalInstalledCompositionDeliveryV1(reviewedGraphCapability);
  const queueWorker = rawCoordinator.queueWorker as { database: PrivatePostgresConfiguration; concurrency?: number };
  const startupAdmissionBinding = createPrivateHermes021LocalStartupAdmissionBindingV1({ delivery, queueWorker,
    installationBinding: config.admission.installationBinding, topologyPlanDigest: config.topology.planDigest,
    releaseDigest: config.releaseDigest, admissionRequestDigest: config.admissionRequestDigest });
  const composedCoordinator = Object.freeze({ planning: composedPlanning, routes,
    approvals: rawCoordinator.approvals, quality: rawCoordinator.quality, revisionPlanning: rawCoordinator.revisionPlanning,
    nativeQueue: true as const, nativeQueueRecovery: true as const, database: rawCoordinator.database,
    resultDatabase: rawCoordinator.resultDatabase, evidence: rawCoordinator.evidence, queueWorker,
    hermes021Local: delivery, resultInspectionSource });
  const candidateStartupConfiguration = Object.freeze({ web: composedWeb,
    artifactStorage: config.artifactStorage, coordinator: composedCoordinator });
  const startup = validatePrivateTaskStartupConfiguration(candidateStartupConfiguration as never);
  assertDatabaseBindings(config, startup);
  const approvalStore = startup.approvals!.store;
  const capturedApprovals = Object.freeze({ enrollments: Object.freeze(startup.approvals!.enrollments.map(value =>
      Object.freeze({ ...value, enrollment: Object.freeze({ ...value.enrollment }) }))),
    store: Object.freeze({ acceptInSession: approvalStore.acceptInSession.bind(approvalStore),
      readInSession: approvalStore.readInSession.bind(approvalStore) }) });
  const privateStartupConfiguration = Object.freeze({ web: startup.web, artifactStorage: startup.artifactStorage,
    coordinator: Object.freeze({ planning: Object.freeze(startup.planning), routes: startup.routes,
      approvals: capturedApprovals, quality: startup.quality,
      ...(startup.resultInspectionSource ? { resultInspectionSource: startup.resultInspectionSource } : {}),
      ...(startup.revisionPlanning ? { revisionPlanning: startup.revisionPlanning } : {}),
      nativeQueue: true as const, nativeQueueRecovery: true as const, database: startup.database,
      resultDatabase: startup.resultDatabase, evidence: startup.evidence,
      queueWorker: startup.queueWorker, hermes021Local: delivery }) });
  const { database: _evidenceDatabase, ...evidence } = startup.evidence!;
  const settings = Object.freeze({ schema: "control-room.agent-task-operator-settings/v1" as const,
    port: config.operatorPort, tenantId: startup.web.tenantId,
    databaseRoles: Object.freeze({ coordinator: startup.database, results: startup.resultDatabase,
      evidence: startup.evidence!.database, queueWorker: startup.queueWorker!.database }),
    queueWorkerConcurrency: startup.queueWorker!.concurrency,
    features: Object.freeze({ nativeQueue: true, nativeQueueRecovery: true,
      ...(startup.revisionPlanning ? { revisionPlanning: true } : {}), quality: true, evidence: true,
      queueWorker: true, artifactStorage: true, hermes021Local: true }),
  });
  const trusted = Object.freeze({ web: Object.freeze({ ...startup.web, installationPlan: config.settledInstallationPlan }),
    planning: startup.planning, routes: startup.routes, approvalEnrollments: capturedApprovals.enrollments,
    approvalStore: capturedApprovals.store, quality: startup.quality, evidence,
    artifactStorage: startup.artifactStorage, hermes021Local: delivery,
    localBackupRestoreReadiness: startup.web.localBackupRestoreReadiness });
  const runnerInput = Object.freeze({ admissionPreparationInput: config.admission,
    privateStartupConfiguration, startupAdmissionBinding });
  const queueFactories = createInstalledNativeQueueFactories({ openWorkerDatabase: createPrivatePostgresDatabase });
  const expectedCoordinator = databaseIdentity(startup.database);
  const startupDependencies = Object.freeze({
    openDatabase(database: PrivatePostgresConfiguration) {
      const raw = createPrivatePostgresDatabase(database);
      const actual = databaseIdentity(database);
      if (canonicalJson(actual) === canonicalJson(expectedCoordinator)) deferredDatabase.bind(raw.client);
      return raw;
    },
    install: installPrivateApplication,
    prepareNativeSubmission: queueFactories.prepareNativeSubmission,
    startNativeWorker: queueFactories.startNativeWorker,
    async openArtifactStorage(configuration: Parameters<typeof PersistentLocalArtifactStorageV1.create>[0]) {
      const storage = await PersistentLocalArtifactStorageV1.create(configuration);
      deferredStorage.bind(storage); return deferredStorage.port;
    },
  });
  const suppliedRuntimes = captureStageMap(ports.setupRuntimes), setupRuntimes: Record<string, unknown> = {};
  for (const stage of stages) setupRuntimes[stage] = captureRuntimePort(suppliedRuntimes[stage]);
  const setupSources = Object.freeze({ ...config.setupSources, agent_readiness: runnerInput });
  const loaded = Object.freeze({ prerequisiteInput: config.prerequisiteInput,
    assemblyInput: Object.freeze({ runnerInput, operatorSettings: settings, operatorTrustedInputs: trusted }),
    startupDependencies, setupSources, setupRuntimes: Object.freeze(setupRuntimes) });
  return Object.freeze({ prepared, config, loaded });
}

export function createPrivateInstalledLocalHermesRuntimeComposerV1(preparationValue: unknown, portsValue: unknown) {
  let composed: ReturnType<typeof compose>;
  try { composed = compose(preparationValue, portsValue); }
  catch { return refused(); }
  const contracts = Object.freeze({
    taskClass: "text_review" as const,
    delivery: "control-room.private-hermes-021-local-installation-delivery/v1" as const,
    resultStaging: "control-room.hermes-021-macos-terminal-stage/v1" as const,
    queue: "pg-boss/postgres" as const,
    startup: "control-room.private-task-startup" as const,
    setup: "control-room.private-local-setup-orchestrator/v1" as const,
  });
  return Object.freeze({ schema: PRIVATE_INSTALLED_LOCAL_HERMES_RUNTIME_COMPOSER_V1,
    status: "configuration_graph_ready" as const,
    custody: Object.freeze({ async loadPrivateConfiguration() { return composed.loaded; } }),
    operatorComposition: Object.freeze({ status: "blocked" as const,
      blocker: "native_journal_operation_custody_missing" as const }),
    contracts,
    performsEffect: false as const, opensDatabase: false as const, opensArtifactStore: false as const,
    startsService: false as const, startsWorker: false as const, invokesHermes: false as const,
    stagesNativeSidecar: false as const, constructsJournal: false as const,
  });
}
